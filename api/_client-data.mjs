import {validUUID} from './_identity.mjs';
import {supabaseAdminFetch,supabaseUserFetch,supabaseUserRpc} from './_supabase.mjs';

const RUN_ID=/^run-[A-Za-z0-9-]{8,120}$/;
const UPLOAD_PATH=/^uploads\/[A-Za-z0-9._-]+$/;
const RESULT_PATH=/^results\/run-[A-Za-z0-9-]{8,120}\.png$/;

const first=value=>Array.isArray(value)?value[0]??null:value??null;
const encoded=value=>encodeURIComponent(String(value));

export function validUploadPath(value) {return typeof value==='string'&&UPLOAD_PATH.test(value);}
export function validResultPath(value) {return typeof value==='string'&&RESULT_PATH.test(value);}
export function validClientRunId(value) {return typeof value==='string'&&RUN_ID.test(value);}

export async function ownedProject(identity,projectId,{active=true}={}) {
  if(!identity?.user?.id||!validUUID(projectId))return null;
  const status=active?'&status=eq.active':'';
  const rows=await supabaseUserFetch(`projects?select=id,name,property_type,city,room_type,style,status,created_at,updated_at&id=eq.${encoded(projectId)}&owner_id=eq.${encoded(identity.user.id)}${status}&limit=1`,{accessToken:identity.accessToken});
  return first(rows);
}

export async function ownedAssetById(identity,assetId,{projectId=null,kind=null,includeDeleted=false}={}) {
  if(!identity?.user?.id||!validUUID(assetId)||projectId&&!validUUID(projectId))return null;
  const project=projectId?`&project_id=eq.${encoded(projectId)}`:'';
  const type=kind?`&kind=eq.${encoded(kind)}`:'';
  const deleted=includeDeleted?'':'&deleted_at=is.null';
  const rows=await supabaseUserFetch(`assets?select=id,owner_id,project_id,blob_path,kind,width,height,content_type,bytes,deleted_at,created_at&id=eq.${encoded(assetId)}&owner_id=eq.${encoded(identity.user.id)}${project}${type}${deleted}&limit=1`,{accessToken:identity.accessToken});
  return first(rows);
}

export async function ownedAssetByPath(identity,blobPath,{projectId=null,kind=null,includeDeleted=false}={}) {
  if(!identity?.user?.id||!validUploadPath(blobPath)||projectId&&!validUUID(projectId))return null;
  const project=projectId?`&project_id=eq.${encoded(projectId)}`:'';
  const type=kind?`&kind=eq.${encoded(kind)}`:'';
  const deleted=includeDeleted?'':'&deleted_at=is.null';
  const rows=await supabaseUserFetch(`assets?select=id,owner_id,project_id,blob_path,kind,width,height,content_type,bytes,deleted_at,created_at&blob_path=eq.${encoded(blobPath)}&owner_id=eq.${encoded(identity.user.id)}${project}${type}${deleted}&limit=1`,{accessToken:identity.accessToken});
  return first(rows);
}

export async function ownedGenerationAttempt(identity,runId,{projectId=null,savedOnly=true}={}) {
  if(!identity?.user?.id||!validClientRunId(runId)||projectId&&!validUUID(projectId))return null;
  const project=projectId?`&project_id=eq.${encoded(projectId)}`:'';
  const status=savedOnly?'&status=eq.saved':'';
  const rows=await supabaseUserFetch(`generation_attempts?select=authorization_id,run_id,user_id,project_id,source_asset_id,provider,selection_fingerprint,status,credit_state,result_path,created_at,updated_at&run_id=eq.${encoded(runId)}&user_id=eq.${encoded(identity.user.id)}${project}${status}&limit=1`,{accessToken:identity.accessToken});
  return first(rows);
}

export async function listOwnedGenerationAttempts(identity,projectId,{limit=25}={}) {
  if(!identity?.user?.id||!validUUID(projectId))return [];
  const safeLimit=Math.min(50,Math.max(1,Number(limit)||25));
  const rows=await supabaseUserFetch(`generation_attempts?select=authorization_id,run_id,user_id,project_id,source_asset_id,provider,selection_fingerprint,status,credit_state,result_path,created_at,updated_at&user_id=eq.${encoded(identity.user.id)}&project_id=eq.${encoded(projectId)}&status=eq.saved&order=created_at.desc&limit=${safeLimit}`,{accessToken:identity.accessToken});
  return Array.isArray(rows)?rows:[];
}

export async function createSourceAsset(identity,{projectId,blobPath,contentType,bytes,width=null,height=null}) {
  if(!identity?.user?.id||!validUUID(projectId)||!validUploadPath(blobPath))throw new Error('invalid_source_asset');
  if(!await ownedProject(identity,projectId))throw new Error('project_not_found');
  const rows=await supabaseAdminFetch('assets?select=id,project_id,blob_path,kind,content_type,bytes,created_at',{method:'POST',
    headers:{Prefer:'return=representation'},body:{owner_id:identity.user.id,project_id:projectId,blob_path:blobPath,kind:'source_photo',content_type:contentType,bytes,width,height}});
  return first(rows);
}

export async function claimSourceAssetDeletion(identity,assetId) {
  if(!identity?.user?.id||!validUUID(assetId))return null;
  const result=await supabaseUserRpc('delete_owned_source_asset',{p_asset_id:assetId},identity.accessToken);
  return first(result);
}

export const __test={RUN_ID,UPLOAD_PATH,RESULT_PATH,first,encoded};
