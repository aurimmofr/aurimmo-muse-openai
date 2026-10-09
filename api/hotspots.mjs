import {publicCatalogue,privateJSON,validRunId} from './_data.mjs';
import {requireAuth,sendJSON} from './_security.mjs';

function query(req,name) {
  try{return new URL(req.url,'https://aurimmo.local').searchParams.get(name);}catch{return null;}
}

export default async function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!requireAuth(req,res))return;
  const runId=query(req,'run_id');
  if(!validRunId(runId))return sendJSON(res,400,{error:'Identifiant de rendu invalide.'});
  try {
    const [run,{index},job]=await Promise.all([privateJSON(`runs/${runId}.json`),publicCatalogue(),privateJSON(`hotspot-jobs/${runId}.json`)]);
    if(!run||run.run_id!==runId)return sendJSON(res,404,{error:'Rendu introuvable.'});
    const products=(run.product_ids||[]).map(id=>index.get(id)).filter(Boolean);
    if(products.length!==(run.product_ids||[]).length)return sendJSON(res,409,{error:'Les références figées du rendu ne sont plus disponibles.'});
    const record=await privateJSON(`hotspots/${runId}.json`,2*1024*1024);
    if(!record) {
      const jobStatus=job?.run_id===runId&&['queued','processing','failed'].includes(job.status)?job.status:'queued';
      return sendJSON(res,200,{schema_version:'aurimmo.public.hotspots.v1',run_id:runId,selection_fingerprint:run.selection_fingerprint,
        image_sha256:run.output_sha256??null,products,hotspots:[],diagnostics:[],localization:{status:jobStatus,method:'automatic_offline_vision',attempt:Number(job?.attempt)||0,
          retryable:jobStatus==='failed'?job?.retryable!==false:true,updated_at:job?.updated_at??null,paid_api_calls:0,image_uploads:0}});
    }
    const exactIds=Array.isArray(record.product_ids)&&record.product_ids.length===run.product_ids.length&&record.product_ids.every((id,index)=>id===run.product_ids[index]);
    if(record.run_id!==runId||record.selection_fingerprint!==run.selection_fingerprint||!exactIds||record.result_path!==run.result_path)
      return sendJSON(res,409,{error:'Les points disponibles ne correspondent pas au rendu figé.'});
    const allowed=new Set(run.product_ids),seen=new Set();
    const hotspots=(record.hotspots||[]).filter(point=>allowed.has(point.catalog_id)&&!seen.has(point.catalog_id)&&Number.isFinite(point.x)&&point.x>=0&&point.x<=1&&Number.isFinite(point.y)&&point.y>=0&&point.y<=1&&(seen.add(point.catalog_id)||true));
    return sendJSON(res,200,{schema_version:'aurimmo.public.hotspots.v1',run_id:runId,selection_fingerprint:run.selection_fingerprint,
      image_sha256:record.image_sha256??run.output_sha256??null,products,hotspots,diagnostics:Array.isArray(record.diagnostics)?record.diagnostics:[],
      localization:{status:'completed',method:'automatic_offline_vision',paid_api_calls:0,image_uploads:0,completed_at:record.completed_at??null}});
  }catch{return sendJSON(res,500,{error:'Repérage automatique indisponible.'});}
}
