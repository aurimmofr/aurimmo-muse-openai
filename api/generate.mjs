import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {dispatchHotspotWorker,preflightHotspotWorker} from './_hotspot-dispatch.mjs';
import { readJSON, requireAuth, requestId, sameOrigin, sendJSON } from './_security.mjs';
import {get,put,signedRead} from './_storage.mjs';

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
const ARCHITECTURE_CONTRACT_VERSION='muse.interior.edit.v3-public';
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
  const floor=body.surfaces.floor==='preserve'?
    `SOL À CONSERVER : conserver exactement son apparence, sa teinte, sa matière visible, son motif, le sens des lames ou joints, ses traces, ses limites, niveaux, pentes, seuils, plinthes et raccords.`:
    `SOL — APPARENCE SEULEMENT : appliquer l'apparence exacte de la référence floor_finish uniquement sur l'emprise du sol existant. Conserver sa géométrie, ses limites, niveaux, pentes, seuils, plinthes, raccords, perspective et relation aux ouvertures. Ne jamais prolonger le revêtement sur une marche, un mur, une porte, un meuble de cuisine ou une installation fixe.`;
  const walls=body.surfaces.walls==='preserve'?
    `MURS À CONSERVER : conserver exactement leurs teintes, textures, matières visibles, moulures, plinthes, angles, raccords et défauts photographiques.`:
    `MURS — FINITION SEULEMENT : appliquer l'apparence exacte de la référence wall_finish uniquement sur les faces de murs existantes. Conserver chaque plan, angle, contour, moulure, plinthe, raccord, ouverture et installation fixe ; ne créer ni supprimer aucun volume.`;
  const tv=(body.program==='living_tv'||body.program==='living_dining'&&body.include_tv)?'Créer exactement une télévision générique, sans marque ni faux produit, posée ou fixée au-dessus du meuble TV catalogue sélectionné. Orienter les assises vers elle.':'Ne créer aucune télévision.';
  return `CONTRAT D'ÉDITION — MÊME PIÈCE EXACTE\nModifier l'image 1 de cette pièce précise. Ceci est une édition ciblée de la photographie, jamais une nouvelle pièce inspirée de celle-ci et jamais une reconstruction. Image 1 est l'unique autorité pour l'espace, la caméra, le cadrage, la lumière et le bâti. Le résultat doit rester immédiatement reconnaissable comme la même pièce.\n\nCAMÉRA ET CADRE — ZÉRO CHANGEMENT\nConserver l'image complète et exactement la même position de caméra, hauteur, direction de visée, angle, focale apparente, perspective, lignes de fuite, orientation, cadrage, recadrage et proportions apparentes. Ne pas zoomer, élargir, redresser, pivoter, retourner en miroir, étendre ou rogner la scène. Conserver la direction de la lumière naturelle et l'exposition générale ; ne jamais inventer une ouverture pour améliorer la lumière.\n\nARCHITECTURE — ZÉRO CHANGEMENT DE GÉOMÉTRIE — PRIORITÉ ABSOLUE\nConserver exactement le nombre, la position, les dimensions visibles, la forme, les contours, l'épaisseur et la profondeur de toutes les fenêtres, baies vitrées, portes, impostes, huisseries et ouvertures. Garder leurs vitrages, poignées, encadrements et raccords visibles.\nConserver exactement tous les murs, angles, cloisons, colonnes, poutres, poteaux, renfoncements, niches existantes, arches existantes, passages, mezzanines, garde-corps, plafonds, plafonds inclinés, raccords mur-plafond et changements de niveau. Conserver la géométrie, les limites, les niveaux, les pentes et les raccords du sol et du plafond.\nInterdiction absolue d'ajouter, supprimer, déplacer, agrandir, réduire, inverser, prolonger, redessiner, recadrer, couvrir ou masquer un élément architectural. Ne créer aucune arche, niche, cloison, fenêtre, porte, poutre, estrade, faux plafond, nouvelle marche ou nouveau volume, même pour renforcer le style Japandi.\n\nESCALIERS — VERROU DÉTAILLÉ\nPour chaque escalier, conserver exactement son emplacement, l'orientation et le sens montant ou descendant de chaque volée, le départ, l'arrivée, la pente, les paliers, le nombre et l'espacement apparents des marches, leurs nez et contremarches, ainsi que les limons, rampes, mains courantes, garde-corps, balustres et toutes leurs connexions visibles. Ne jamais retourner en miroir, réorienter, déplacer, raccourcir, allonger, élargir, reconstruire, simplifier, cacher ou interrompre un escalier pour servir la composition.\n\nINSTALLATIONS FIXES ET ÉLÉMENTS INTÉGRÉS — ZÉRO CHANGEMENT\nPréserver intégralement chaque poêle, cheminée, insert, foyer, conduit, tuyau, plaque murale et raccord visible : même position, orientation, hauteur, silhouette, proportion, matière apparente et connexion du corps au conduit, du conduit au plafond ou au mur. Ne jamais déplacer, raccourcir, remplacer, masquer ou redessiner un poêle ou son conduit.\nPréserver intégralement radiateurs, climatisation, bouches, gaines, tuyauteries, prises, interrupteurs, points électriques, spots fixes, plinthes, moulures et menuiseries. Un luminaire décoratif mobile peut être remplacé, mais son point électrique exact reste fixe. Des rideaux peuvent être retirés, mais la fenêtre, ses vitrages, son cadre et sa quincaillerie restent intacts.\nPréserver intégralement toute cuisine intégrée : meubles de cuisine fixés, hauts et bas, colonnes, joues, plinthes, plans de travail, crédences, îlot fixe, évier, robinetterie, plaques, hotte et appareils encastrés. Conserver exactement leur implantation, position, silhouette, proportions, façades visibles, connexions et fonction. Ne jamais transformer une cuisine intégrée en mur, fenêtre, coin repas ou meuble décoratif. Préserver de la même manière placards, bibliothèques et rangements réellement intégrés au bâti.\nSi un élément est ambigu entre meuble mobile et élément intégré, retirer uniquement ses parties mobiles clairement identifiables et préserver toute partie fixée, tout plan de travail, toute surface intégrée, toute installation et tout bâti. En cas de doute, préserver.\nAucun meuble ni objet nouveau ne doit cacher une ouverture, un escalier, un poêle, un conduit, un radiateur, une prise utile, une cuisine intégrée ou une circulation. Si une idée décorative ou un produit entre en conflit avec le bâti ou une installation fixe, déplacer ou abandonner l'idée décorative. Ne jamais adapter la pièce au mobilier.\n\nMOBILIER MOBILE — RELOOKING COMPLET AUTORISÉ\nRetirer et remplacer uniquement les meubles, textiles, rideaux, luminaires décoratifs non structurels et objets décoratifs mobiles visibles, y compris ceux qui ne sont pas explicitement nommés. Retirer leurs silhouettes et ombres devenues incohérentes. Reconstituer seulement les pixels de mur ou de sol réellement révélés, en continuité stricte avec la surface adjacente ; ne créer à cet endroit aucune porte, fenêtre, ouverture, niche, moulure, colonne ni installation. Ne pas produire une boîte blanche et ne pas effacer les détails existants de la pièce.\n\nSURFACES — POLITIQUE EXPLICITE\n${floor}\n${walls}\nUne finition autorisée change uniquement l'apparence de la surface désignée. Elle ne modifie jamais sa structure, son emprise, sa géométrie, ses niveaux, ses ouvertures ni les installations qui la traversent. Appliquer la finition autour des éléments protégés, jamais par-dessus eux.\n\nPROGRAMME ET STYLE\nRedécorer cette pièce exacte en Japandi photoréaliste pour le programme suivant : ${program}. Obtenir une transformation décorative marquée avec du mobilier bas, des lignes épurées, des matières naturelles et une ambiance sobre, uniquement dans le volume existant. ${tv}\n\nRÉFÉRENCES PRODUITS — NON SPATIALES\nLes images 2 et suivantes décrivent uniquement l'apparence du produit ciblé. Elles ne sont jamais des références de pièce, d'implantation ou d'architecture. Ne jamais importer leurs décors marchands, murs, sols, plafonds, ouvertures, plantes, textiles, livres, accessoires, cadrages, perspectives, lumières, textes, marques ou filigranes. Une photo montrant plusieurs exemplaires ne fixe pas la quantité.\n${mapping}\n\nCONTRAINTES PHYSIQUES ET COMMERCIALES\nUtiliser exactement chaque référence sélectionnée et sa quantité, sans fusion, duplication, omission, substitution, recoloration ni produit commercial supplémentaire. Préserver la silhouette reconnaissable, les proportions, le piètement, les détails, la matière visible et la couleur de chaque variante. Respecter l'échelle adulte, les contacts au sol, les ombres de contact, les passages, les supports, les dépendances et la cohérence fonctionnelle. Le mobilier s'adapte à la pièce existante ; la pièce ne s'adapte jamais au mobilier.\n\nPHOTORÉALISME\nRetourner une seule photographie intérieure réaliste, jamais une planche, un collage, un diagramme ou une image annotée. Respecter l'éclairage de la source, l'échelle, la perspective, les occultations, la réponse des matières et les ombres physiques. Aucun texte, logo, prix, étiquette, interface, point bleu ou filigrane dans l'image finale.\n\nCONTRÔLE FINAL — ORDRE DE PRIORITÉ\n1. Architecture, ouvertures, géométrie des escaliers, niveaux, installations fixes, cuisine intégrée, caméra et cadre complet identiques à l'image 1.\n2. Programme, circulation, supports et fonctions respectés.\n3. Produits catalogue reconnaissables et quantités exactes.\n4. Cohérence Japandi et photoréalisme.\nAvant de répondre, comparer le résultat à l'image 1 bord à bord. Vérifier chaque ouverture ; chaque volée d'escalier, son sens, son départ, son arrivée, sa pente, ses marches et ses garde-corps ; chaque limite de mur, sol et plafond ; chaque poêle et son conduit complet ; chaque radiateur ; chaque élément de cuisine intégrée ; et la caméra, le cadrage et la perspective. Toute architecture ou installation fixe absente, ajoutée, déplacée, inversée, redimensionnée, recolorée, recouverte, masquée ou transformée constitue un échec. Dans ce cas, préserver l'image 1 et renoncer à la modification décorative en conflit. Ne jamais sacrifier la fidélité architecturale à l'esthétique.`;
}

function providerRequest(provider,prompt,images,body) {
  if(provider==='openai')return {model:process.env.OPENAI_IMAGE_MODEL||'gpt-image-2.5-sunburst-2026-09-08',images,prompt,n:1,quality:'high',size:'1536x864',output_format:'png',background:'opaque'};
  return {model:'muse-image-1.0',prompt,images,n:1,size:`${body.width}x${body.height}`,response_format:'b64_json',output_format:'png',reasoning_strength:'high',
    tool_enablement:{enable_image_search:false,enable_web_search:false,enable_shell:false}};
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
    const request=providerRequest(provider,prompt,images,body);
    response=await fetch('https://api.openai.com/v1/images/edits',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(280000)});
  } else {
    const key=process.env.MODEL_API_KEY;if(!key)throw Object.assign(new Error('Clé Muse absente.'),{status:503});
    const request=providerRequest(provider,prompt,images,body);
    response=await fetch('https://api.meta.ai/v1/images/edits',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(280000)});
  }
  let payload;try{payload=await response.json();}catch{throw Object.assign(new Error('Réponse fournisseur illisible ; facturation à rapprocher.'),{status:502,ambiguous:true});}
  if(!response.ok)throw Object.assign(new Error(`Erreur ${response.status} du fournisseur ; aucun retry automatique.`),{status:502,ambiguous:true,provider_status:response.status});
  return {bytes:strictImage(payload),usage:payload.usage??null,request_id:response.headers.get('x-request-id')??response.headers.get('request-id')??null,elapsed_ms:Date.now()-started};
}

export const __test={canonicalSelection,promptFor,providerRequest,validateBody,sha};

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
      architecture_contract_version:ARCHITECTURE_CONTRACT_VERSION,prompt_sha256:sha(prompt),
      selection_fingerprint:body.selection_fingerprint,product_ids:products.map(x=>x.catalog_id),source_path:body.room_path,result_path:resultPath,request_id:generated.request_id,
      output_sha256:sha(generated.bytes),elapsed_ms:generated.elapsed_ms,usage:generated.usage,status:'render_saved_visual_review_pending',automatic_retries:0,created_at:new Date().toISOString()};
    await put(`runs/${runId}.json`,JSON.stringify(record),{access:'private',contentType:'application/json',allowOverwrite:false});
    const queuedAt=new Date().toISOString();
    try {await put(`hotspot-jobs/${runId}.json`,JSON.stringify({schema_version:'aurimmo.public.hotspot-job.v1',run_id:runId,status:'queued',attempt:0,queued_at:queuedAt,updated_at:queuedAt}),{access:'private',contentType:'application/json',allowOverwrite:false});}catch{}
    const hotspotDispatch=await dispatchHotspotWorker(runId);
    try {await put(`hotspot-dispatches/${runId}.json`,JSON.stringify({schema_version:'aurimmo.public.hotspot-dispatch.v1',run_id:runId,status:hotspotDispatch.status,accepted:hotspotDispatch.accepted,http_status:hotspotDispatch.http_status??null,created_at:new Date().toISOString()}),{access:'private',contentType:'application/json',allowOverwrite:true});}catch{}
    return sendJSON(res,200,{run_id:runId,provider:body.provider,image_url:await signedRead(resultPath),selection_fingerprint:body.selection_fingerprint,products,
      architecture_contract_version:ARCHITECTURE_CONTRACT_VERSION,
      elapsed_ms:generated.elapsed_ms,cost:body.provider==='muse'?{status:'published_flat_price',usd:0.01}:{status:'usage_based_reconcile',usage:generated.usage??null},review_status:'pending_human_review',
      hotspot_localization:{status:'queued',dispatch:hotspotDispatch.accepted?'accepted':'reconciliation_pending',paid_api_calls:0},automatic_retries:0});
  }catch(error){
    const status=Number(error.status)||500;
    return sendJSON(res,status,{error:status<500?error.message:requestStarted?`${error.message||'La génération a échoué.'} La facturation doit être vérifiée avant un nouvel essai.`:'La génération n’a pas démarré.',trace_id:traceId,request_started:requestStarted,automatic_retries:0});
  }
}
