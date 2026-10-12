import {del,put} from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import {ownedProject} from './_client-data.mjs';
import {signedRead} from './_data.mjs';
import {requireIdentity,validUUID} from './_identity.mjs';
import {inspectUploadedImage} from './_image.mjs';
import {sameOrigin,sendJSON} from './_security.mjs';
import {SupabaseRequestError,supabaseAdminRpc} from './_supabase.mjs';

const MAX_BYTES=3_700_000;
const MIN_BYTES=1024;
const first=value=>Array.isArray(value)?value[0]??null:value??null;
const CLIENT_ERROR_CODES=new Set(['invalid_content_length','source_too_large','content_length_mismatch','invalid_binary_body',
  'unsupported_image_type','invalid_image_bytes','image_type_mismatch','invalid_image_dimensions']);

async function requestBytes(req) {
  const announcedHeader=req.headers['content-length'];
  const announced=announcedHeader===undefined?null:Number(announcedHeader);
  if(announced!==null&&(!Number.isSafeInteger(announced)||announced<0))
    throw Object.assign(new Error('Taille de photo invalide.'),{status:400,code:'invalid_content_length'});
  if(announced!==null&&announced>MAX_BYTES)
    throw Object.assign(new Error('Photo trop volumineuse après optimisation.'),{status:413,code:'source_too_large'});
  if(req.body!==undefined&&req.body!==null&&!Buffer.isBuffer(req.body)&&!(req.body instanceof Uint8Array))
    throw Object.assign(new Error('Corps de photo binaire attendu.'),{status:400,code:'invalid_binary_body'});
  if(Buffer.isBuffer(req.body)||req.body instanceof Uint8Array) {
    const bytes=Buffer.from(req.body);
    if(bytes.length>MAX_BYTES)throw Object.assign(new Error('Photo trop volumineuse après optimisation.'),{status:413,code:'source_too_large'});
    if(announced!==null&&announced!==bytes.length)throw Object.assign(new Error('Taille de photo incohérente.'),{status:400,code:'content_length_mismatch'});
    return bytes;
  }
  const chunks=[];let total=0;
  for await(const chunk of req) {
    if(!Buffer.isBuffer(chunk)&&!(chunk instanceof Uint8Array))throw Object.assign(new Error('Corps de photo binaire attendu.'),{status:400,code:'invalid_binary_body'});
    total+=chunk.length;
    if(total>MAX_BYTES)throw Object.assign(new Error('Photo trop volumineuse après optimisation.'),{status:413,code:'source_too_large'});
    chunks.push(Buffer.from(chunk));
  }
  if(announced!==null&&announced!==total)throw Object.assign(new Error('Taille de photo incohérente.'),{status:400,code:'content_length_mismatch'});
  return Buffer.concat(chunks,total);
}

async function reserveUpload(identity,projectId,bytes,{adminRpc=supabaseAdminRpc}={}) {
  return first(await adminRpc('reserve_source_upload',{p_user_id:identity.user.id,p_project_id:projectId,p_bytes:bytes}));
}

function completionArguments(identity,{reservationId,projectId,blobPath,metadata,bytes}) {
  return {
    p_reservation_id:reservationId,p_user_id:identity.user.id,p_project_id:projectId,p_blob_path:blobPath,
    p_content_type:metadata.contentType,p_bytes:bytes,p_width:metadata.width,p_height:metadata.height,
  };
}

async function completeUpload(identity,context,{adminRpc=supabaseAdminRpc}={}) {
  return first(await adminRpc('complete_source_upload',completionArguments(identity,context)));
}

async function reconcileUpload(identity,context,{adminRpc=supabaseAdminRpc}={}) {
  return first(await adminRpc('reconcile_source_upload_completion',completionArguments(identity,context)));
}

function ambiguousSupabase(error) {return error instanceof SupabaseRequestError&&error.status>=500;}

async function completeUploadResilient(identity,context,{adminRpc=supabaseAdminRpc}={}) {
  try{return await completeUpload(identity,context,{adminRpc});}
  catch(firstError) {
    if(!ambiguousSupabase(firstError))throw firstError;
    try {
      let state=await reconcileUpload(identity,context,{adminRpc});
      if(state?.completion_status==='completed'&&validUUID(state.asset_id))return state;
      if(state?.completion_status==='reserved') {
        try{return await completeUpload(identity,context,{adminRpc});}
        catch(retryError) {
          if(!ambiguousSupabase(retryError))throw retryError;
          state=await reconcileUpload(identity,context,{adminRpc});
          if(state?.completion_status==='completed'&&validUUID(state.asset_id))return state;
        }
      }
    } catch(recoveryError) {
      if(!ambiguousSupabase(recoveryError))throw recoveryError;
    }
    firstError.completionAmbiguous=true;
    throw firstError;
  }
}

async function releaseUpload(identity,reservationId,{adminRpc=supabaseAdminRpc}={}) {
  if(!validUUID(reservationId))return false;
  try{return Boolean(await adminRpc('release_source_upload',{p_reservation_id:reservationId,p_user_id:identity.user.id}));}catch{return false;}
}

export async function handleUpload(req,res,{
  identityFn=requireIdentity,ownedProjectFn=ownedProject,adminRpc=supabaseAdminRpc,putFn=put,delFn=del,signFn=signedRead,
  uuidFn=randomUUID,nowFn=Date.now,
}={}) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.',code:'origin_refused'});
  const identity=await identityFn(req,res);if(!identity)return;
  const projectId=String(req.headers['x-aurimmo-project-id']||'').trim();
  if(!validUUID(projectId))return sendJSON(res,400,{error:'Projet client invalide.',code:'invalid_project_id'});
  let stored=null,reservationId=null,completionAttempted=false,completionConfirmed=false;
  try {
    if(!await ownedProjectFn(identity,projectId))return sendJSON(res,404,{error:'Projet introuvable.',code:'project_not_found'});
    const bytes=await requestBytes(req);
    if(bytes.length<MIN_BYTES)return sendJSON(res,400,{error:'Photo vide ou trop petite.',code:'source_too_small'});
    const quota=await reserveUpload(identity,projectId,bytes.length,{adminRpc});
    if(!quota?.allowed) {
      const retryAfter=Math.max(1,Math.min(86_400,Number(quota?.retry_after_seconds)||60));
      res.setHeader('Retry-After',String(retryAfter));
      return sendJSON(res,429,{error:'Limite d’imports atteinte. Réessayez plus tard.',code:'source_upload_quota_exceeded',retry_after:retryAfter});
    }
    if(!validUUID(quota.reservation_id))throw Object.assign(new Error('invalid_source_upload_reservation'),{code:'source_upload_reservation_failed'});
    reservationId=quota.reservation_id;
    const transportType=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
    const sourceType=transportType==='application/octet-stream'?req.headers['x-aurimmo-source-content-type']:transportType;
    const metadata=inspectUploadedImage(bytes,sourceType);
    const pathname=`uploads/${identity.user.id}-${projectId}-${nowFn()}-${uuidFn()}.${metadata.extension}`;
    stored=await putFn(pathname,bytes,{access:'private',contentType:metadata.contentType,allowOverwrite:false});
    const imageUrl=await signFn(stored.pathname);
    completionAttempted=true;
    const asset=await completeUploadResilient(identity,{reservationId,projectId,blobPath:stored.pathname,metadata,bytes:bytes.length},{adminRpc});
    completionConfirmed=Boolean(asset?.asset_id);
    if(!completionConfirmed)throw new Error('asset_registration_failed');
    return sendJSON(res,201,{asset_id:asset.asset_id,project_id:projectId,pathname:stored.pathname,image_url:imageUrl,
      content_type:metadata.contentType,bytes:bytes.length,width:metadata.width,height:metadata.height});
  }catch(error){
    await releaseUpload(identity,reservationId,{adminRpc});
    const ambiguousCompletion=completionAttempted&&!completionConfirmed&&(error?.completionAmbiguous||ambiguousSupabase(error));
    if(stored?.pathname&&!completionConfirmed&&!ambiguousCompletion){try{await delFn(stored.pathname);}catch{}}
    const status=Number(error?.status)||500;
    const clientError=CLIENT_ERROR_CODES.has(error?.code);
    return sendJSON(res,status>=400&&status<600?status:500,{error:clientError?error.message:status===403?'Accès au projet refusé.':'La photo n’a pas pu être placée dans le stockage privé.',code:error?.code||'source_upload_failed'});
  }
}

export default function handler(req,res) {return handleUpload(req,res);}

export const __test={requestBytes,reserveUpload,completeUpload,reconcileUpload,completeUploadResilient,releaseUpload,CLIENT_ERROR_CODES,MAX_BYTES,MIN_BYTES};
