import {ownedGenerationAttempt,validClientRunId,validResultPath} from './_client-data.mjs';
import {publicCatalogue,privateJSON,validRunId} from './_data.mjs';
import {validateHotspotRecord} from './_hotspot-record.mjs';
import {requireIdentity} from './_identity.mjs';
import {sendJSON} from './_security.mjs';

function query(req,name) {
  try{return new URL(req.url,'https://aurimmo.local').searchParams.get(name);}catch{return null;}
}

export default async function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  const runId=query(req,'run_id');
  if(!validRunId(runId)||!validClientRunId(runId))return sendJSON(res,400,{error:'Identifiant de rendu invalide.'});
  try {
    const attempt=await ownedGenerationAttempt(identity,runId);
    if(!attempt)return sendJSON(res,404,{error:'Rendu introuvable.',code:'run_not_found'});
    const [run,{index},job]=await Promise.all([privateJSON(`runs/${runId}.json`),publicCatalogue(),privateJSON(`hotspot-jobs/${runId}.json`)]);
    if(!run||run.schema_version!=='aurimmo.public.run.v2'||run.run_id!==runId||run.user_id!==identity.user.id||run.project_id!==attempt.project_id||run.source_asset_id!==attempt.source_asset_id
      ||run.provider!=='muse'||run.selection_fingerprint!==attempt.selection_fingerprint||run.result_path!==attempt.result_path||!validResultPath(run.result_path))
      return sendJSON(res,409,{error:'Le rendu ne correspond pas à la génération client enregistrée.',code:'run_identity_mismatch'});
    const products=(run.product_ids||[]).map(id=>index.get(id)).filter(Boolean);
    if(products.length!==(run.product_ids||[]).length)return sendJSON(res,409,{error:'Les références figées du rendu ne sont plus disponibles.'});
    const record=await privateJSON(`hotspots/${runId}.json`,2*1024*1024);
    if(!record) {
      const jobStatus=job?.run_id===runId&&['queued','processing','failed'].includes(job.status)?job.status:'queued';
      return sendJSON(res,200,{schema_version:'aurimmo.public.hotspots.v1',run_id:runId,project_id:attempt.project_id,selection_fingerprint:run.selection_fingerprint,
        image_sha256:run.output_sha256??null,products,hotspots:[],diagnostics:[],localization:{status:jobStatus,method:'automatic_offline_vision',attempt:Number(job?.attempt)||0,
          retryable:jobStatus==='failed'?job?.retryable!==false:true,updated_at:job?.updated_at??null,paid_api_calls:0,image_uploads:0}});
    }
    if(!validateHotspotRecord(record,run).valid) {
      const jobStatus=job?.run_id===runId&&['queued','processing'].includes(job.status)?job.status:'failed';
      return sendJSON(res,200,{schema_version:'aurimmo.public.hotspots.v1',run_id:runId,project_id:attempt.project_id,selection_fingerprint:run.selection_fingerprint,
        image_sha256:run.output_sha256??null,products,hotspots:[],diagnostics:[],localization:{status:jobStatus,method:'automatic_offline_vision',attempt:Number(job?.attempt)||0,
          retryable:true,updated_at:job?.updated_at??null,paid_api_calls:0,image_uploads:0,code:'record_rebuild_required'}});
    }
    return sendJSON(res,200,{schema_version:'aurimmo.public.hotspots.v1',run_id:runId,project_id:attempt.project_id,selection_fingerprint:run.selection_fingerprint,
      image_sha256:record.image_sha256,products,hotspots:record.hotspots,diagnostics:record.diagnostics,
      localization:{status:'completed',method:'automatic_offline_vision',paid_api_calls:0,image_uploads:0,completed_at:record.completed_at??null}});
  }catch{return sendJSON(res,500,{error:'Repérage automatique indisponible.'});}
}
