import { get, issueSignedToken, presignUrl, put } from '@vercel/blob';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {dispatchHotspotWorker,preflightHotspotWorker} from './_hotspot-dispatch.mjs';
import { readJSON, requireAuth, requestId, sameOrigin, sendJSON } from './_security.mjs';

const PROGRAMS=new Set(['living_conversation','living_reading','living_tv','living_dining']);
const PROVIDERS=new Set(['openai','muse']);
const SURFACES=new Set(['preserve','replace']);
const PROGRAM_ROLES={
  living_conversation:['sofa','armchair','coffee_table','rug','floor_lamp','decorative_object'],
  living_reading:['armchair','side_table','floor_lamp','rug','bookcase','table_lamp'],
  living_tv:['sofa','armchair','coffee_table','rug','floor_lamp','tv_unit'],
  living_dining:['sofa','coffee_table','rug','dining_table','dining_chair','pendant'],
};
const MAX_SOURCE_BYTES=3_700_000;
const MAX_REFERENCE_BYTES=6_000_000;
const MAX_TOTAL_REFERENCE_BYTES=42_000_000;
const MAX_RESULT_BYTES=20_000_000;
const ALLOWED_IMAGE_HOSTS=new Set(['interieur-ia.aurimmo.fr','m.media-amazon.com']);
let catalogueCache;

async function catalogue() {
  if(catalogueCache)return catalogueCache;
  const value=JSON.parse(await readFile(new URL('../public/catalogue.json',import.meta.url),'utf8'));
  catalogueCache={value,index:new Map(value.products.map(product=>[product.catalog_id,product]))};
  return catalogueCache;
}

function sha(value){return createHash('sha256').update(value).digest('hex');}
function dataURL(bytes,type){return `data:${type};base64,${bytes.toString('base64')}`;}
function canonicalSelection(body,products){return JSON.stringify({program:body.program,include_tv:Boolean(body.include_tv),surfaces:body.surfaces,products:products.map(x=>({catalog_id:x.catalog_id,role:x.role,quantity:x.quantity}))});}
function expectedRoles(body){const roles=[...PROGRAM_ROLES[body.program]];if(body.program==='living_dining'&&body.include_tv)roles.push('tv_unit');if(body.surfaces.floor==='replace')roles.push('floor_finish');if(body.surfaces.walls==='replace')roles.push('wall_finish');return roles;}

function validateBody(body,index) {
  if(process.env.GENERATION_ENABLED!=='true')throw Object.assign(new Error('Les générations sont désactivées.'),{status:503});
  if(body.confirm_paid_generation!==true)throw Object.assign(new Error('Confirmation payante explicite requise.'),{status:409});
  if(!PROVIDERS.has(body.provider)||!PROGRAMS.has(body.program)||typeof body.include_tv!=='boolean'||body.include_tv&&body.program!=='living_dining')throw Object.assign(new Error('Moteur, programme ou option TV invalide.'),{status:400});
  if(!body.surfaces||!SURFACES.has(body.surfaces.floor)||!SURFACES.has(body.surfaces.walls))throw Object.assign(new Error('Choix de surfaces invalide.'),{status:400});
  if(typeof body.room_path!=='string'||!/^uploads\/[a-zA-Z0-9._-]+$/.test(body.room_path))throw Object.assign(new Error('Photo privée invalide.'),{status:400});
  if(!Number.isInteger(body.width)||!Number.isInteger(body.height)||body.width<320||body.height<320||body.width>5000||body.height>5000)throw Object.assign(new Error('Dimensions de photo invalides.'),{status:400});
  if(!Array.isArray(body.product_ids)||body.product_ids.length<3||body.product_ids.length>9||new Set(body.product_ids).size!==body.product_ids.length)throw Object.assign(new Error('Sélection catalogue invalide.'),{status:400});
  const products=body.product_ids.map(id=>index.get(id));
  if(products.some(product=>!product))throw Object.assign(new Error('Référence catalogue inconnue.'),{status:400});
  const required=expectedRoles(body),actual=products.map(product=>product.role);
  if(required.length!==actual.length||required.some(role=>actual.filter(value=>value===role).length!==1)||actual.some(role=>!required.includes(role)))throw Object.assign(new Error('Les rôles catalogue ne couvrent pas exactement le programme et les surfaces.'),{status:409});
  const expected=sha(canonicalSelection(body,products));
  if(body.selection_fingerprint!==expected)throw Object.assign(new Error('La sélection figée a changé.'),{status:409});
  if(typeof body.authorization_id!=='string'||!/^[a-f0-9-]{36}$/.test(body.authorization_id))throw Object.assign(new Error('Autorisation de génération invalide.'),{status:400});
  return products;
}

async function blobBytes(pathname,maxBytes) {
  const result=await get(pathname,{access:'private',useCache:false});
  if(!result||result.statusCode!==200||result.blob.size>maxBytes)throw Object.assign(new Error('Photo privée absente ou trop volumineuse.'),{status:400});
  return {bytes:Buffer.from(await new Response(result.stream).arrayBuffer()),type:result.blob.contentType};
}

async function referenceBytes(product) {
  let url;
  try{url=new URL(product.image_url);}catch{throw Object.assign(new Error('Photo catalogue invalide.'),{status:409});}
  if(url.protocol!=='https:'||!ALLOWED_IMAGE_HOSTS.has(url.hostname))throw Object.assign(new Error('Hôte photo catalogue non autorisé.'),{status:409});
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
  const type=String(response.headers.get('content-type')??'').split(';')[0];
  const announced=Number(response.headers.get('content-length')??0);
  if(!response.ok||!['image/jpeg','image/png','image/webp'].includes(type)||announced>MAX_REFERENCE_BYTES)throw Object.assign(new Error(`Photo catalogue indisponible : ${product.catalog_id}.`),{status:409});
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length<1000||bytes.length>MAX_REFERENCE_BYTES)throw Object.assign(new Error(`Photo catalogue invalide : ${product.catalog_id}.`),{status:409});
  return {bytes,type};
}

function promptFor(body,products) {
  const program={living_conversation:'salon de conversation convivial sans télévision',living_reading:'coin lecture calme et confortable sans télévision',living_tv:'salon orienté vers une télévision générique',living_dining:`salon et espace repas${body.include_tv?' avec télévision générique':''}`}[body.program];
  const mapping=products.map((product,index)=>`Image ${index+2}: ${product.role}, quantité ${product.quantity}, référence ${product.catalog_id}, ${product.product_name}.`).join('\n');
  const surfaces=`Sol: ${body.surfaces.floor==='preserve'?'conserver exactement le sol existant':'remplacer uniquement son apparence avec la référence floor_finish fournie'}. Murs: ${body.surfaces.walls==='preserve'?'conserver exactement les murs existants':'remplacer uniquement leur finition avec la référence wall_finish fournie'}.`;
  const tv=(body.program==='living_tv'||body.program==='living_dining'&&body.include_tv)?'Créer exactement une télévision générique, sans marque ni faux produit, posée ou fixée au-dessus du meuble TV catalogue sélectionné. Orienter les assises vers elle.':'Ne créer aucune télévision.';
  return `SOURCE LOCK\nImage 1 est l'unique autorité pour l'architecture, les ouvertures, le point de vue, le cadrage, la géométrie, la lumière et toutes les installations fixes. Préserver intégralement poêle, conduit, radiateurs, prises, interrupteurs, menuiseries et équipements intégrés. Retirer et remplacer les meubles et objets décoratifs mobiles visibles.\n\nDESIGN INTENT\nCréer un intérieur Japandi photoréaliste pour le programme suivant : ${program}. ${surfaces} ${tv}\n\nREFERENCE MAPPING\nLes images 2 et suivantes décrivent uniquement l'apparence des produits. Ne jamais reprendre leurs décors marchands, leurs murs, leurs sols, leurs accessoires ou leur éclairage.\n${mapping}\n\nPHYSICAL CONSTRAINTS\nRespecter les quantités, l'échelle adulte, les contacts au sol, les passages, les supports et la cohérence fonctionnelle. Utiliser chaque référence sélectionnée et ne pas inventer de produit commercial supplémentaire.\n\nFINAL PRIORITY\n1. Architecture, cadrage et installations fixes inchangés. 2. Programme et fonctions respectés. 3. Produits catalogue reconnaissables et quantités exactes. 4. Composition Japandi réaliste. Une installation fixe absente ou transformée constitue un échec.`;
}

function strictImage(payload) {
  const encoded=payload?.data?.[0]?.b64_json;
  if(!Array.isArray(payload?.data)||payload.data.length!==1||typeof encoded!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw Object.assign(new Error('Le fournisseur n’a pas retourné une image unique valide.'),{status:502,ambiguous:true});
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length<1000||bytes.length>MAX_RESULT_BYTES)throw Object.assign(new Error('Image reçue vide ou trop volumineuse.'),{status:502,ambiguous:true});
  return bytes;
}

async function providerCall(provider,prompt,images,body) {
  const started=Date.now();let response;
  if(provider==='openai') {
    const key=process.env.OPENAI_API_KEY;if(!key)throw Object.assign(new Error('Clé OpenAI absente.'),{status:503});
    const request={model:process.env.OPENAI_IMAGE_MODEL||'gpt-image-2.5-sunburst-2026-09-08',images,prompt,n:1,quality:'high',size:'1536x864',output_format:'png',background:'opaque'};
    response=await fetch('https://api.openai.com/v1/images/edits',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(280000)});
  } else {
    const key=process.env.MODEL_API_KEY;if(!key)throw Object.assign(new Error('Clé Muse absente.'),{status:503});
    const request={model:'muse-image-1.0',prompt,images,n:1,size:`${body.width}x${body.height}`,response_format:'b64_json',output_format:'png',reasoning_strength:'high',tool_enablement:{image_search:false,web_search:false,shell:false}};
    response=await fetch('https://api.meta.ai/v1/images/edits',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(280000)});
  }
  let payload;try{payload=await response.json();}catch{throw Object.assign(new Error('Réponse fournisseur illisible ; facturation à rapprocher.'),{status:502,ambiguous:true});}
  if(!response.ok)throw Object.assign(new Error(`Erreur ${response.status} du fournisseur ; aucun retry automatique.`),{status:502,ambiguous:true,provider_status:response.status});
  return {bytes:strictImage(payload),usage:payload.usage??null,request_id:response.headers.get('x-request-id')??response.headers.get('request-id')??null,elapsed_ms:Date.now()-started};
}

async function signedRead(pathname) {
  const validUntil=Date.now()+60*60*1000;
  const token=await issueSignedToken({pathname,operations:['get'],validUntil});
  return (await presignUrl(token,{access:'private',pathname,operation:'get',validUntil})).presignedUrl;
}

export const __test={canonicalSelection,promptFor,validateBody,sha};

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!requireAuth(req,res)||!sameOrigin(req))return;
  const traceId=requestId(),runId=`run-${Date.now()}-${randomUUID()}`;let requestStarted=false;
  try {
    const body=await readJSON(req,128*1024),{index}=await catalogue(),products=validateBody(body,index);
    const hotspotPreflight=await preflightHotspotWorker();
    if(!hotspotPreflight.ready)throw Object.assign(new Error('Le worker de points produits est indisponible.'),{status:503});
    const guard={trace_id:traceId,run_id:runId,authorization_id:body.authorization_id,provider:body.provider,created_at:new Date().toISOString()};
    await put(`guards/${body.authorization_id}.json`,JSON.stringify(guard),{access:'private',contentType:'application/json',allowOverwrite:false});
    const room=await blobBytes(body.room_path,MAX_SOURCE_BYTES),references=[];let total=0;
    for(const product of products){const image=await referenceBytes(product);total+=image.bytes.length;if(total>MAX_TOTAL_REFERENCE_BYTES)throw Object.assign(new Error('Références catalogue trop volumineuses.'),{status:409});references.push(image);}
    const prompt=promptFor(body,products),images=[{image_url:dataURL(room.bytes,room.type)},...references.map(image=>({image_url:dataURL(image.bytes,image.type)}))];
    requestStarted=true;
    const generated=await providerCall(body.provider,prompt,images,body);
    const resultPath=`results/${runId}.png`;
    await put(resultPath,generated.bytes,{access:'private',contentType:'image/png',allowOverwrite:false});
    const record={schema_version:'aurimmo.public.run.v1',run_id:runId,trace_id:traceId,provider:body.provider,program:body.program,include_tv:Boolean(body.include_tv),surfaces:body.surfaces,
      selection_fingerprint:body.selection_fingerprint,product_ids:products.map(x=>x.catalog_id),source_path:body.room_path,result_path:resultPath,request_id:generated.request_id,
      output_sha256:sha(generated.bytes),elapsed_ms:generated.elapsed_ms,usage:generated.usage,status:'render_saved_visual_review_pending',automatic_retries:0,created_at:new Date().toISOString()};
    await put(`runs/${runId}.json`,JSON.stringify(record),{access:'private',contentType:'application/json',allowOverwrite:false});
    const queuedAt=new Date().toISOString();
    try {await put(`hotspot-jobs/${runId}.json`,JSON.stringify({schema_version:'aurimmo.public.hotspot-job.v1',run_id:runId,status:'queued',attempt:0,queued_at:queuedAt,updated_at:queuedAt}),{access:'private',contentType:'application/json',allowOverwrite:false});}catch{}
    const hotspotDispatch=await dispatchHotspotWorker(runId);
    try {await put(`hotspot-dispatches/${runId}.json`,JSON.stringify({schema_version:'aurimmo.public.hotspot-dispatch.v1',run_id:runId,status:hotspotDispatch.status,accepted:hotspotDispatch.accepted,http_status:hotspotDispatch.http_status??null,created_at:new Date().toISOString()}),{access:'private',contentType:'application/json',allowOverwrite:true});}catch{}
    return sendJSON(res,200,{run_id:runId,provider:body.provider,image_url:await signedRead(resultPath),selection_fingerprint:body.selection_fingerprint,products,
      elapsed_ms:generated.elapsed_ms,cost:body.provider==='muse'?{status:'published_flat_price',usd:0.01}:{status:'usage_based_reconcile',usage:generated.usage??null},review_status:'pending_human_review',
      hotspot_localization:{status:'queued',dispatch:hotspotDispatch.accepted?'accepted':'reconciliation_pending',paid_api_calls:0},automatic_retries:0});
  }catch(error){
    const status=Number(error.status)||500;
    return sendJSON(res,status,{error:status<500?error.message:requestStarted?`${error.message||'La génération a échoué.'} La facturation doit être vérifiée avant un nouvel essai.`:'La génération n’a pas démarré.',trace_id:traceId,request_started:requestStarted,automatic_retries:0});
  }
}
