import { get, issueSignedToken, presignUrl, put } from '@vercel/blob';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {dispatchHotspotWorker,preflightHotspotWorker} from './_hotspot-dispatch.mjs';
import {ensureFreshIdentity,requireIdentity,validUUID} from './_identity.mjs';
import {SupabaseRequestError,supabaseAdminFetch,supabaseAdminRpc,supabaseUserFetch} from './_supabase.mjs';
import { readJSON, requestId, sameOrigin, sendJSON } from './_security.mjs';

const PROGRAMS=new Set(['living_conversation','living_reading','living_tv','living_dining']);
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
function stableRunId(authorizationId){return validUUID(authorizationId)?`run-${authorizationId.toLowerCase()}`:null;}
function dataURL(bytes,type){return `data:${type};base64,${bytes.toString('base64')}`;}
function canonicalSelection(body,products){return JSON.stringify({program:body.program,include_tv:Boolean(body.include_tv),surfaces:body.surfaces,products:products.map(x=>({catalog_id:x.catalog_id,role:x.role,quantity:x.quantity}))});}
function expectedRoles(body){const roles=[...PROGRAM_ROLES[body.program]];if(body.program==='living_dining'&&body.include_tv)roles.push('tv_unit');if(body.surfaces.floor==='replace')roles.push('floor_finish');if(body.surfaces.walls==='replace')roles.push('wall_finish');return roles;}

function validateBody(body,index) {
  if(process.env.GENERATION_ENABLED!=='true')throw Object.assign(new Error('Les générations sont désactivées.'),{status:503});
  if(body.confirm_paid_generation!==true)throw Object.assign(new Error('Confirmation payante explicite requise.'),{status:409});
  if(body.provider!=='muse'||!PROGRAMS.has(body.program)||typeof body.include_tv!=='boolean'||body.include_tv&&body.program!=='living_dining')throw Object.assign(new Error('Moteur Muse, programme ou option TV invalide.'),{status:400});
  if(!validUUID(body.project_id)||!validUUID(body.source_asset_id))throw Object.assign(new Error('Projet ou photo client invalide.'),{status:400});
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
  if(!validUUID(body.authorization_id))throw Object.assign(new Error('Autorisation de génération invalide.'),{status:400});
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

async function providerCall(prompt,images,body) {
  const started=Date.now(),key=process.env.MODEL_API_KEY;
  if(!key)throw Object.assign(new Error('Clé Muse absente.'),{status:503});
  const request={model:'muse-image-1.0',prompt,images,n:1,size:`${body.width}x${body.height}`,response_format:'b64_json',output_format:'png',reasoning_strength:'high',tool_enablement:{image_search:false,web_search:false,shell:false}};
  const response=await fetch('https://api.meta.ai/v1/images/edits',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(280000)});
  let payload;try{payload=await response.json();}catch{throw Object.assign(new Error('Réponse fournisseur illisible ; facturation à rapprocher.'),{status:502,ambiguous:true});}
  if(!response.ok)throw Object.assign(new Error(`Erreur ${response.status} du fournisseur ; aucun retry automatique.`),{status:502,ambiguous:true,provider_status:response.status});
  return {bytes:strictImage(payload),usage:payload.usage??null,request_id:response.headers.get('x-request-id')??response.headers.get('request-id')??null,elapsed_ms:Date.now()-started};
}

async function signedRead(pathname) {
  const validUntil=Date.now()+24*60*60*1000;
  const token=await issueSignedToken({pathname,operations:['get'],validUntil});
  return (await presignUrl(token,{access:'private',pathname,operation:'get',validUntil})).presignedUrl;
}

function firstRow(value) {return Array.isArray(value)?value[0]??null:value??null;}

async function sourceAsset(identity,body) {
  const rows=await supabaseUserFetch(`assets?select=id,owner_id,project_id,blob_path,kind,width,height,content_type,bytes&id=eq.${encodeURIComponent(body.source_asset_id)}&project_id=eq.${encodeURIComponent(body.project_id)}&blob_path=eq.${encodeURIComponent(body.room_path)}&kind=eq.source_photo&deleted_at=is.null&limit=1`,{accessToken:identity.accessToken});
  const asset=firstRow(rows);
  if(!asset||asset.owner_id!==identity.user.id)throw Object.assign(new Error('Cette photo n’appartient pas à ce projet.'),{status:404,code:'source_asset_not_found'});
  if(asset.width!==null&&asset.height!==null&&(Number(asset.width)!==body.width||Number(asset.height)!==body.height))
    throw Object.assign(new Error('Les dimensions de la photo ne correspondent pas à son import.'),{status:409,code:'source_asset_dimensions_changed'});
  return asset;
}

function creditError(error) {
  const reason=error instanceof SupabaseRequestError?error.upstreamMessage:null;
  if(reason==='subscription_required')return Object.assign(new Error('Choisissez une formule avant de générer cette image.'),{status:402,code:reason});
  if(reason==='credits_exhausted')return Object.assign(new Error('Tous les crédits de cette période ont été utilisés.'),{status:402,code:reason});
  if(['project_not_found','source_asset_not_found'].includes(reason))return Object.assign(new Error('Projet ou photo client introuvable.'),{status:404,code:reason});
  if(reason==='authorization_conflict')return Object.assign(new Error('Cette autorisation appartient à une autre intention de génération.'),{status:409,code:reason});
  return error;
}

async function privateJSON(pathname,maxBytes=512*1024) {
  const result=await get(pathname,{access:'private',useCache:false});
  if(!result||result.statusCode!==200||result.blob.size>maxBytes)throw Object.assign(new Error('Trace de génération indisponible.'),{status:503,code:'generation_trace_unavailable'});
  try{return JSON.parse(Buffer.from(await new Response(result.stream).arrayBuffer()).toString('utf8'));}
  catch{throw Object.assign(new Error('Trace de génération invalide.'),{status:503,code:'generation_trace_invalid'});}
}

async function generationAttempt(userId,authorizationId) {
  const rows=await supabaseAdminFetch(`generation_attempts?select=authorization_id,run_id,user_id,project_id,source_asset_id,selection_fingerprint,status,credit_state,reservation_owner_id,execution_id,result_path,request_started_at&authorization_id=eq.${encodeURIComponent(authorizationId)}&limit=1`);
  const attempt=firstRow(rows);
  return attempt?.user_id===userId?attempt:null;
}

function assertAttemptIdentity(attempt,{userId,runId,projectId,sourceAssetId,fingerprint}) {
  if(!attempt||attempt.user_id!==userId||attempt.run_id!==runId||attempt.project_id!==projectId||attempt.source_asset_id!==sourceAssetId||attempt.selection_fingerprint!==fingerprint)
    throw Object.assign(new Error('Cette autorisation ne correspond pas à cette génération.'),{status:409,code:'authorization_conflict'});
  return attempt;
}

function reservationAction(attempt,executionId) {
  if(!attempt)return 'missing';
  if(attempt.status==='saved')return 'replay_saved';
  if(attempt.status==='request_started')return attempt.execution_id===executionId?'owned_started':'in_progress';
  if(attempt.status==='reconciliation_required')return 'reconciliation_required';
  if(attempt.status==='failed_after_request')return 'closed_after_request';
  if(attempt.status==='failed_before_request'||attempt.credit_state==='released')return 'closed_before_request';
  if(attempt.status==='reserved')return attempt.reservation_owner_id===executionId?'prepare':'in_progress';
  return 'reconciliation_required';
}

function generationStateError(action) {
  if(action==='in_progress')return Object.assign(new Error('Cette génération est déjà en cours. Son état sera repris sans nouvel appel Muse.'),{status:409,code:'generation_in_progress',retrySameAuthorization:true});
  if(action==='reconciliation_required')return Object.assign(new Error('Cette génération doit être rapprochée avant tout nouvel appel Muse.'),{status:409,code:'generation_reconciliation_required',retrySameAuthorization:true});
  if(action==='closed_after_request')return Object.assign(new Error('Cette tentative a été clôturée après un appel Muse et ne sera jamais rejouée. Une nouvelle génération exige une nouvelle action explicite.'),{status:409,code:'generation_attempt_resolved',retrySameAuthorization:false});
  if(action==='closed_before_request')return Object.assign(new Error('Cette tentative a été fermée avant l’appel Muse. Vous pouvez relancer explicitement.'),{status:409,code:'generation_attempt_closed',retrySameAuthorization:false});
  return Object.assign(new Error('État de génération incohérent.'),{status:409,code:'generation_state_conflict',retrySameAuthorization:true});
}

async function reserveAttempt(context) {
  const args={p_user_id:context.userId,p_authorization_id:context.authorizationId,p_execution_id:context.executionId,p_run_id:context.runId,
    p_project_id:context.projectId,p_source_asset_id:context.sourceAssetId,p_selection_fingerprint:context.fingerprint};
  try {
    const reservation=firstRow(await supabaseAdminRpc('reserve_generation_credit',args));
    if(!reservation)throw Object.assign(new Error('Réservation de crédit sans réponse.'),{status:503,code:'reservation_response_missing'});
    return reservation;
  } catch(error) {
    let attempt;
    try {attempt=await generationAttempt(context.userId,context.authorizationId);} catch {
      throw Object.assign(new Error('État de réservation incertain ; aucun nouvel appel Muse ne sera lancé.'),{status:503,code:'reservation_ambiguous',retrySameAuthorization:true,cause:error});
    }
    if(!attempt)throw error;
    assertAttemptIdentity(attempt,context);
    return {reservation_status:'existing',attempt_status:attempt.status,reservation_owned:attempt.reservation_owner_id===context.executionId,result_path:attempt.result_path};
  }
}

async function claimRequestStart(context) {
  const args={p_user_id:context.userId,p_authorization_id:context.authorizationId,p_execution_id:context.executionId};
  for(let pass=0;pass<2;pass+=1) {
    try {
      const claim=firstRow(await supabaseAdminRpc('mark_generation_request_started',args));
      if(!claim)throw Object.assign(new Error('Démarrage de génération sans réponse.'),{status:503,code:'generation_start_response_missing'});
      return claim;
    } catch(error) {
      let attempt;
      try {attempt=await generationAttempt(context.userId,context.authorizationId);} catch {
        throw Object.assign(new Error('Démarrage Muse incertain ; aucun appel Muse n’a été relancé.'),{status:503,code:'generation_start_ambiguous',retrySameAuthorization:true,cause:error});
      }
      assertAttemptIdentity(attempt,context);
      const action=reservationAction(attempt,context.executionId);
      if(action==='owned_started')return {claim_status:'already_started',credit_status:attempt.credit_state,attempt_status:attempt.status,result_path:attempt.result_path,recovered:true};
      if(action==='prepare'&&pass===0)continue;
      if(action==='replay_saved')return {claim_status:'saved',credit_status:attempt.credit_state,attempt_status:attempt.status,result_path:attempt.result_path,recovered:true};
      throw generationStateError(action);
    }
  }
  throw Object.assign(new Error('Démarrage Muse non confirmé ; aucun appel Muse n’a été lancé.'),{status:503,code:'generation_start_ambiguous',retrySameAuthorization:true});
}

async function finishSavedAttempt(context,resultPath) {
  const args={p_user_id:context.userId,p_authorization_id:context.authorizationId,p_execution_id:context.executionId,p_outcome:'saved',p_result_path:resultPath};
  for(let pass=0;pass<2;pass+=1) {
    try {
      const result=firstRow(await supabaseAdminRpc('finish_generation_attempt',args));
      if(result?.attempt_status==='saved'&&result.result_path===resultPath)return result;
      throw Object.assign(new Error('Finalisation de génération non confirmée.'),{status:503,code:'generation_finish_unconfirmed'});
    } catch(error) {
      let attempt;
      try {attempt=await generationAttempt(context.userId,context.authorizationId);} catch {
        if(pass===0)continue;
        throw Object.assign(new Error('Le rendu est conservé mais sa finalisation doit être rapprochée.'),{status:503,code:'generation_finish_ambiguous',retrySameAuthorization:true,cause:error});
      }
      assertAttemptIdentity(attempt,context);
      if(attempt.status==='saved'&&attempt.result_path===resultPath)return {finish_status:'recovered_saved',attempt_status:'saved',result_path:resultPath};
      if(attempt.status==='request_started'&&attempt.execution_id===context.executionId&&pass===0)continue;
      throw Object.assign(new Error('Le rendu est conservé mais sa finalisation doit être rapprochée.'),{status:503,code:'generation_finish_ambiguous',retrySameAuthorization:true,cause:error});
    }
  }
  throw Object.assign(new Error('Le rendu est conservé mais sa finalisation doit être rapprochée.'),{status:503,code:'generation_finish_ambiguous',retrySameAuthorization:true});
}

async function bestEffortAdminRpc(name,body) {try{return firstRow(await supabaseAdminRpc(name,body));}catch{return null;}}

async function savedGenerationPayload(attempt,body,products) {
  const record=await privateJSON(`runs/${attempt.run_id}.json`),ids=products.map(product=>product.catalog_id);
  if(record?.schema_version!=='aurimmo.public.run.v2'||record.run_id!==attempt.run_id||record.user_id!==attempt.user_id||record.project_id!==attempt.project_id||record.source_asset_id!==attempt.source_asset_id||record.selection_fingerprint!==attempt.selection_fingerprint||record.result_path!==attempt.result_path||JSON.stringify(record.product_ids)!==JSON.stringify(ids))
    throw Object.assign(new Error('La trace du rendu ne correspond pas à l’autorisation enregistrée.'),{status:409,code:'saved_generation_mismatch'});
  return {run_id:attempt.run_id,provider:'muse',project_id:attempt.project_id,source_asset_id:attempt.source_asset_id,image_url:await signedRead(attempt.result_path),selection_fingerprint:attempt.selection_fingerprint,products,
    elapsed_ms:record.elapsed_ms??null,cost:{status:'unknown',usd:null},review_status:'pending_human_review',request_started:true,idempotent_replay:true,
    hotspot_localization:{status:'queued',dispatch:'already_requested',paid_api_calls:0},automatic_retries:0};
}

export const __test={canonicalSelection,promptFor,validateBody,sha,stableRunId,reservationAction,assertAttemptIdentity};

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.'});
  let identity=await requireIdentity(req,res);if(!identity)return;
  const traceId=requestId(),executionId=randomUUID();
  let requestStarted=false,startTransitionAttempted=false,attemptFinished=false,authorizationId=null,runId=null,reservationAttempted=false,reservationOwned=false,context=null;
  try {
    const body=await readJSON(req,128*1024),{index}=await catalogue(),products=validateBody(body,index);
    authorizationId=body.authorization_id;runId=stableRunId(authorizationId);
    const asset=await sourceAsset(identity,body);
    context={userId:identity.user.id,authorizationId,executionId,runId,projectId:body.project_id,sourceAssetId:asset.id,fingerprint:body.selection_fingerprint};
    const existing=await generationAttempt(identity.user.id,authorizationId);
    if(existing) {
      assertAttemptIdentity(existing,context);
      const action=reservationAction(existing,executionId);
      if(action==='replay_saved')return sendJSON(res,200,await savedGenerationPayload(existing,body,products));
      if(action!=='prepare'&&action!=='missing'&&!(action==='in_progress'&&existing.status==='reserved'))throw generationStateError(action);
    }
    try {
      reservationAttempted=true;
      const reservation=await reserveAttempt(context);reservationOwned=reservation.reservation_owned===true;
      const action=reservationAction({status:reservation.attempt_status,reservation_owner_id:reservationOwned?executionId:null,result_path:reservation.result_path},executionId);
      if(action==='replay_saved') {
        const saved=assertAttemptIdentity(await generationAttempt(identity.user.id,authorizationId),context);
        return sendJSON(res,200,await savedGenerationPayload(saved,body,products));
      }
      if(action!=='prepare')throw generationStateError(action);
    } catch(error) {throw creditError(error);}
    // The database is the subscription authority. Check it before exposing the
    // state of external workers or the provider configuration to a client that
    // has no usable plan. A paid subscriber's provisional credit is released
    // below if either preflight fails, before any Muse request can begin.
    const hotspotPreflight=await preflightHotspotWorker();
    if(!hotspotPreflight.ready)throw Object.assign(new Error('Le worker de points produits est indisponible.'),{status:503});
    if(typeof process.env.MODEL_API_KEY!=='string'||!process.env.MODEL_API_KEY)throw Object.assign(new Error('Le moteur Muse n’est pas configuré.'),{status:503});
    const room=await blobBytes(body.room_path,MAX_SOURCE_BYTES),references=[];let total=0;
    for(const product of products){const image=await referenceBytes(product);total+=image.bytes.length;if(total>MAX_TOTAL_REFERENCE_BYTES)throw Object.assign(new Error('Références catalogue trop volumineuses.'),{status:409});references.push(image);}
    const prompt=promptFor(body,products),images=[{image_url:dataURL(room.bytes,room.type)},...references.map(image=>({image_url:dataURL(image.bytes,image.type)}))];
    identity=await ensureFreshIdentity(req,res,identity,{minimumTtlSeconds:600});
    startTransitionAttempted=true;
    const claim=await claimRequestStart(context);
    if(claim.claim_status==='saved') {
      const saved=assertAttemptIdentity(await generationAttempt(identity.user.id,authorizationId),context);
      return sendJSON(res,200,await savedGenerationPayload(saved,body,products));
    }
    if(!['started','already_started'].includes(claim.claim_status))throw generationStateError(claim.claim_status==='in_progress'?'in_progress':'reconciliation_required');
    requestStarted=true;
    const guard={trace_id:traceId,run_id:runId,authorization_id:authorizationId,execution_id:executionId,user_id:identity.user.id,project_id:body.project_id,provider:'muse',created_at:new Date().toISOString()};
    await put(`guards/${body.authorization_id}.json`,JSON.stringify(guard),{access:'private',contentType:'application/json',allowOverwrite:true});
    const generated=await providerCall(prompt,images,body);
    const resultPath=`results/${runId}.png`;
    await put(resultPath,generated.bytes,{access:'private',contentType:'image/png',allowOverwrite:false});
    const record={schema_version:'aurimmo.public.run.v2',run_id:runId,trace_id:traceId,user_id:identity.user.id,project_id:body.project_id,source_asset_id:asset.id,provider:'muse',program:body.program,include_tv:Boolean(body.include_tv),surfaces:body.surfaces,
      selection_fingerprint:body.selection_fingerprint,product_ids:products.map(x=>x.catalog_id),source_path:body.room_path,result_path:resultPath,request_id:generated.request_id,
      output_sha256:sha(generated.bytes),elapsed_ms:generated.elapsed_ms,usage:generated.usage,status:'render_saved_visual_review_pending',automatic_retries:0,created_at:new Date().toISOString()};
    await put(`runs/${runId}.json`,JSON.stringify(record),{access:'private',contentType:'application/json',allowOverwrite:false});
    await supabaseAdminFetch('assets',{method:'POST',body:{owner_id:identity.user.id,project_id:body.project_id,blob_path:resultPath,kind:'generated_result',width:body.width,height:body.height,content_type:'image/png',bytes:generated.bytes.length},headers:{Prefer:'return=minimal'}});
    const imageUrl=await signedRead(resultPath);
    await finishSavedAttempt(context,resultPath);
    attemptFinished=true;
    const queuedAt=new Date().toISOString();
    try {await put(`hotspot-jobs/${runId}.json`,JSON.stringify({schema_version:'aurimmo.public.hotspot-job.v1',run_id:runId,status:'queued',attempt:0,queued_at:queuedAt,updated_at:queuedAt}),{access:'private',contentType:'application/json',allowOverwrite:false});}catch{}
    const hotspotDispatch=await dispatchHotspotWorker(runId);
    try {await put(`hotspot-dispatches/${runId}.json`,JSON.stringify({schema_version:'aurimmo.public.hotspot-dispatch.v1',run_id:runId,status:hotspotDispatch.status,accepted:hotspotDispatch.accepted,http_status:hotspotDispatch.http_status??null,created_at:new Date().toISOString()}),{access:'private',contentType:'application/json',allowOverwrite:true});}catch{}
    return sendJSON(res,200,{run_id:runId,provider:'muse',project_id:body.project_id,source_asset_id:asset.id,image_url:imageUrl,selection_fingerprint:body.selection_fingerprint,products,
      elapsed_ms:generated.elapsed_ms,cost:{status:'unknown',usd:null},review_status:'pending_human_review',request_started:true,idempotent_replay:false,
      hotspot_localization:{status:'queued',dispatch:hotspotDispatch.accepted?'accepted':'reconciliation_pending',paid_api_calls:0},automatic_retries:0});
  }catch(error){
    // Only the server invocation that owns the reservation may release it. A
    // duplicate or a concurrent conflict can therefore never cancel the winner.
    let released=false;
    if(startTransitionAttempted&&!requestStarted&&context) {
      await bestEffortAdminRpc('finish_generation_attempt',{p_user_id:context.userId,p_authorization_id:authorizationId,p_execution_id:executionId,p_outcome:'reconciliation_required',p_result_path:null});
    }
    if(reservationAttempted&&reservationOwned&&!requestStarted&&context) {
      const release=await bestEffortAdminRpc('release_generation_credit',{p_user_id:context.userId,p_authorization_id:authorizationId,p_execution_id:executionId,p_reason:error.code||'failed_before_request'});
      released=['released','already_released'].includes(release?.release_status);
    } else if(requestStarted&&!attemptFinished&&context) {
      await bestEffortAdminRpc('finish_generation_attempt',{p_user_id:context.userId,p_authorization_id:authorizationId,p_execution_id:executionId,p_outcome:'reconciliation_required',p_result_path:null});
    }
    const mapped=creditError(error),status=Number(mapped.status)||500;
    const retrySame=released?false:mapped.retrySameAuthorization===true||requestStarted||startTransitionAttempted||reservationAttempted;
    const startedState=requestStarted?true:startTransitionAttempted?null:false;
    const publicError=status<500?mapped.message:startTransitionAttempted
      ?'Le démarrage de la génération est incertain. Aucun nouvel appel Muse ne sera lancé avant rapprochement.'
      :'La génération n’a pas démarré.';
    return sendJSON(res,status,{error:publicError,code:mapped.code||'generation_failed',trace_id:traceId,request_started:startedState,retry_same_authorization:retrySame,authorization_reusable:retrySame,automatic_retries:0});
  }
}
