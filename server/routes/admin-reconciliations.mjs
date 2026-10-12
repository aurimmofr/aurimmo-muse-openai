import {get} from '@vercel/blob';
import {createHash} from 'node:crypto';
import {isAdminIdentity} from './admin-clients.mjs';
import {inspectUploadedImage} from '../../api/_image.mjs';
import {requireIdentity,validUUID} from '../../api/_identity.mjs';
import {readJSON,sameOrigin,sendJSON} from '../../api/_security.mjs';
import {SupabaseRequestError,supabaseAdminFetch,supabaseAdminRpc} from '../../api/_supabase.mjs';

const RUN_ID=/^run-[A-Za-z0-9-]{8,120}$/;
const SHA256=/^[a-f0-9]{64}$/;
const RESOLUTIONS=new Set(['confirmed_saved','confirmed_no_result']);
const MAX_RECORD_BYTES=512*1024;
const MAX_RESULT_BYTES=20_000_000;

function firstRow(value) {return Array.isArray(value)?value[0]??null:value??null;}

export function trustedAdminMutation(req) {
  const origin=String(req?.headers?.origin||''),fetchSite=String(req?.headers?.['sec-fetch-site']||'');
  return Boolean(origin&&sameOrigin(req)&&(!fetchSite||fetchSite==='same-origin'));
}

export function reconciliationRequest(body) {
  if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('Demande de rapprochement invalide.'),{status:400,code:'invalid_reconciliation_request'});
  const authorizationId=validUUID(body.authorization_id)?body.authorization_id.toLowerCase():null;
  const runId=typeof body.run_id==='string'&&RUN_ID.test(body.run_id)?body.run_id:null;
  const resolution=RESOLUTIONS.has(body.resolution)?body.resolution:null;
  const note=typeof body.note==='string'?body.note.replace(/\s+/g,' ').trim():'';
  if(!authorizationId||runId!==`run-${authorizationId}`||!resolution||note.length<10||note.length>500)
    throw Object.assign(new Error('Identifiant, décision ou note de rapprochement invalide.'),{status:400,code:'invalid_reconciliation_request'});
  return {authorizationId,runId,resolution,note};
}

async function blobOrNull(pathname,{getImpl=get}={}) {
  try {
    const value=await getImpl(pathname,{access:'private',useCache:false});
    if(value===null||value===undefined||value.statusCode===404)return null;
    if(value.statusCode!==200)throw new Error('blob_status');
    return value;
  } catch(error) {
    if(Number(error?.status||error?.statusCode)===404||error?.code==='blob_not_found')return null;
    throw Object.assign(new Error('Le stockage privé est momentanément indisponible.'),{status:503,code:'private_storage_unavailable',cause:error});
  }
}

async function blobBytes(blob,{minimum=1,maximum,contentType,missingMessage,invalidMessage}) {
  if(!blob)throw Object.assign(new Error(missingMessage),{status:409,code:'stored_result_missing'});
  const announced=Number(blob.blob?.size),type=String(blob.blob?.contentType||'').split(';')[0].toLowerCase();
  if(!Number.isSafeInteger(announced)||announced<minimum||announced>maximum||type!==contentType)
    throw Object.assign(new Error(invalidMessage),{status:409,code:'stored_result_invalid'});
  let bytes;
  try{bytes=Buffer.from(await new Response(blob.stream).arrayBuffer());}
  catch(error){throw Object.assign(new Error('Le rendu stocké ne peut pas être relu.'),{status:503,code:'private_storage_unavailable',cause:error});}
  if(bytes.length!==announced||bytes.length<minimum||bytes.length>maximum)
    throw Object.assign(new Error(invalidMessage),{status:409,code:'stored_result_invalid'});
  return bytes;
}

export async function verifyStoredResult(attempt,{getImpl=get}={}) {
  const resultPath=`results/${attempt.run_id}.png`,recordPath=`runs/${attempt.run_id}.json`;
  const [recordBlob,imageBlob]=await Promise.all([blobOrNull(recordPath,{getImpl}),blobOrNull(resultPath,{getImpl})]);
  const recordBytes=await blobBytes(recordBlob,{maximum:MAX_RECORD_BYTES,contentType:'application/json',missingMessage:'La trace du rendu stocké est absente.',invalidMessage:'La trace du rendu stocké est invalide.'});
  const imageBytes=await blobBytes(imageBlob,{minimum:1000,maximum:MAX_RESULT_BYTES,contentType:'image/png',missingMessage:'L’image finale stockée est absente.',invalidMessage:'L’image finale stockée est invalide.'});
  let record;
  try{record=JSON.parse(recordBytes.toString('utf8'));}
  catch{throw Object.assign(new Error('La trace du rendu stocké est illisible.'),{status:409,code:'stored_result_invalid'});}
  const digest=createHash('sha256').update(imageBytes).digest('hex');
  let metadata;
  try{metadata=inspectUploadedImage(imageBytes,'image/png');}
  catch(error){throw Object.assign(new Error('L’image finale stockée n’est pas un PNG valide.'),{status:409,code:'stored_result_invalid',cause:error});}
  if(record?.schema_version!=='aurimmo.public.run.v2'
    ||record.run_id!==attempt.run_id
    ||attempt.provider!=='muse'
    ||record.provider!==attempt.provider
    ||record.user_id!==attempt.user_id
    ||record.project_id!==attempt.project_id
    ||record.source_asset_id!==attempt.source_asset_id
    ||record.selection_fingerprint!==attempt.selection_fingerprint
    ||record.result_path!==resultPath
    ||!SHA256.test(record.output_sha256)
    ||record.output_sha256!==digest)
    throw Object.assign(new Error('Le rendu et sa trace ne correspondent pas exactement à la tentative.'),{status:409,code:'stored_result_mismatch'});
  return {resultPath,width:metadata.width,height:metadata.height,bytes:imageBytes.length,contentType:metadata.contentType};
}

function reconciliationError(error) {
  const reason=error instanceof SupabaseRequestError?error.upstreamMessage:null;
  if(reason==='generation_attempt_not_found')return Object.assign(new Error('Cette tentative n’existe plus.'),{status:404,code:reason});
  if(['authorization_conflict','generation_reconciliation_conflict','generation_not_reconcilable'].includes(reason))
    return Object.assign(new Error('Cette tentative a changé. Actualisez le tableau avant toute nouvelle décision.'),{status:409,code:reason});
  if(reason==='generated_asset_conflict')
    return Object.assign(new Error('Un asset conflictuel existe pour ce rendu. Aucune décision n’a été enregistrée.'),{status:409,code:reason});
  if(['invalid_reconciliation_request','invalid_result_path','invalid_generated_asset_metadata','invalid_admin_identity'].includes(reason))
    return Object.assign(new Error('Le rapprochement a été refusé par les contrôles de sécurité.'),{status:409,code:reason});
  return error;
}

export async function resolveReconciliation(identity,body,{adminFetch=supabaseAdminFetch,adminRpc=supabaseAdminRpc,getImpl=get}={}) {
  const request=reconciliationRequest(body);
  const rows=await adminFetch(`generation_attempts?select=authorization_id,run_id,user_id,project_id,source_asset_id,provider,selection_fingerprint,status,credit_state,result_path,reconciliation_resolution,reconciled_at&authorization_id=eq.${encodeURIComponent(request.authorizationId)}&limit=1`);
  const attempt=firstRow(rows);
  if(!attempt||attempt.run_id!==request.runId)throw Object.assign(new Error('Cette tentative est introuvable.'),{status:404,code:'generation_attempt_not_found'});
  let storedResult=null;
  if(request.resolution==='confirmed_saved')storedResult=await verifyStoredResult(attempt,{getImpl});
  try {
    const result=firstRow(await adminRpc('resolve_generation_reconciliation',{
      p_admin_user_id:identity.user.id,
      p_authorization_id:request.authorizationId,
      p_expected_run_id:request.runId,
      p_resolution:request.resolution,
      p_note:request.note,
      p_result_path:storedResult?.resultPath??null,
      p_result_width:storedResult?.width??null,
      p_result_height:storedResult?.height??null,
      p_result_bytes:storedResult?.bytes??null,
      p_result_content_type:storedResult?.contentType??null,
    }));
    if(!result||!['resolved','already_resolved'].includes(result.resolution_status))
      throw Object.assign(new Error('Le rapprochement n’a pas été confirmé.'),{status:503,code:'reconciliation_unconfirmed'});
    return {
      authorization_id:request.authorizationId,
      run_id:request.runId,
      resolution:request.resolution,
      resolution_status:result.resolution_status,
      status:result.attempt_status,
      credit_state:result.credit_status,
      result_path:result.resolved_result_path??null,
      reconciled_at:result.reconciliation_resolved_at??null,
      provider_call_performed:false,
    };
  } catch(error) {throw reconciliationError(error);}
}

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!trustedAdminMutation(req))return sendJSON(res,403,{error:'Origine refusée.'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  if(!isAdminIdentity(identity))return sendJSON(res,403,{error:'Accès administrateur refusé.',code:'admin_required'});
  try {
    const result=await resolveReconciliation(identity,await readJSON(req,16*1024));
    return sendJSON(res,200,result);
  } catch(error) {
    const status=Number(error?.status)||500;
    return sendJSON(res,status,{error:status<500?error.message:'Le rapprochement est momentanément indisponible.',code:error?.code||'admin_reconciliation_failed'});
  }
}

export const __test={blobBytes,blobOrNull,reconciliationError};
