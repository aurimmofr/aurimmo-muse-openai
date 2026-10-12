import {listOwnedGenerationAttempts,ownedAssetById,ownedProject,validClientRunId,validResultPath} from './_client-data.mjs';
import {publicCatalogue,privateJSON,signedRead} from './_data.mjs';
import {requireIdentity,validUUID} from './_identity.mjs';
import {sendJSON} from './_security.mjs';

function query(req,name) {
  try{return new URL(req.url,'https://aurimmo.local').searchParams.get(name);}catch{return null;}
}

export function recordMatchesAttempt(record,attempt,asset) {
  return Boolean(record&&attempt&&asset
    &&record.schema_version==='aurimmo.public.run.v2'
    &&record.run_id===attempt.run_id
    &&record.user_id===attempt.user_id&&record.project_id===attempt.project_id
    &&record.source_asset_id===attempt.source_asset_id
    &&record.provider==='muse'&&attempt.provider==='muse'
    &&record.status==='render_saved_visual_review_pending'
    &&record.selection_fingerprint===attempt.selection_fingerprint
    &&record.result_path===attempt.result_path&&validResultPath(record.result_path)
    &&record.source_path===asset.blob_path);
}

async function publicRun(identity,attempt,index) {
  if(!validClientRunId(attempt?.run_id)||!validResultPath(attempt?.result_path))return null;
  const [record,asset]=await Promise.all([
    privateJSON(`runs/${attempt.run_id}.json`),
    ownedAssetById(identity,attempt.source_asset_id,{projectId:attempt.project_id,kind:'source_photo',includeDeleted:true}),
  ]);
  if(!recordMatchesAttempt(record,attempt,asset))return null;
  const productIds=Array.isArray(record.product_ids)?record.product_ids:[],products=productIds.map(id=>index.get(id)).filter(Boolean);
  if(products.length!==productIds.length)return null;
  return {run_id:record.run_id,project_id:attempt.project_id,source_asset_id:asset.id,provider:'muse',program:record.program,include_tv:Boolean(record.include_tv),surfaces:record.surfaces,
    source_path:asset.blob_path,source_image_url:await signedRead(asset.blob_path),selection_fingerprint:attempt.selection_fingerprint,products,
    image_url:await signedRead(attempt.result_path),elapsed_ms:record.elapsed_ms,usage:record.usage??null,output_sha256:record.output_sha256??null,
    created_at:attempt.created_at||record.created_at,cost:{status:'unknown',usd:null}};
}

export default async function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  const projectId=query(req,'project_id');
  if(!validUUID(projectId))return sendJSON(res,400,{error:'Projet client invalide.',code:'invalid_project_id'});
  try {
    if(!await ownedProject(identity,projectId,{active:false}))return sendJSON(res,404,{error:'Projet introuvable.',code:'project_not_found'});
    const [attempts,{index}]=await Promise.all([listOwnedGenerationAttempts(identity,projectId,{limit:25}),publicCatalogue()]);
    const runs=(await Promise.all(attempts.map(attempt=>publicRun(identity,attempt,index)))).filter(Boolean);
    return sendJSON(res,200,{project_id:projectId,runs});
  }catch{return sendJSON(res,503,{error:'Historique privé indisponible.',code:'history_unavailable'});}
}

export const __test={query,publicRun};
