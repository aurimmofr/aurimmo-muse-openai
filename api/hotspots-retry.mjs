import {put} from '@vercel/blob';
import {privateJSON,validRunId} from './_data.mjs';
import {dispatchHotspotWorker} from './_hotspot-dispatch.mjs';
import {readJSON,requireAuth,sameOrigin,sendJSON} from './_security.mjs';

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!requireAuth(req,res)||!sameOrigin(req))return;
  try {
    const {run_id:runId}=await readJSON(req,16*1024);
    if(!validRunId(runId))return sendJSON(res,400,{error:'Identifiant de rendu invalide.'});
    const [run,completed,job,lastDispatch]=await Promise.all([privateJSON(`runs/${runId}.json`),privateJSON(`hotspots/${runId}.json`,2*1024*1024),privateJSON(`hotspot-jobs/${runId}.json`),privateJSON(`hotspot-dispatches/${runId}.json`)]);
    if(!run||run.run_id!==runId)return sendJSON(res,404,{error:'Rendu introuvable.'});
    if(completed)return sendJSON(res,200,{run_id:runId,status:'completed',dispatched:false});
    if(job?.status==='processing')return sendJSON(res,202,{run_id:runId,status:'processing',dispatched:false});
    if(lastDispatch?.accepted&&Date.now()-Date.parse(lastDispatch.created_at)<120_000)return sendJSON(res,202,{run_id:runId,status:'queued',dispatched:false});
    const dispatch=await dispatchHotspotWorker(runId),createdAt=new Date().toISOString();
    try {await put(`hotspot-dispatches/${runId}.json`,JSON.stringify({schema_version:'aurimmo.public.hotspot-dispatch.v1',run_id:runId,status:dispatch.status,accepted:dispatch.accepted,http_status:dispatch.http_status??null,created_at:createdAt}),{access:'private',contentType:'application/json',allowOverwrite:true});}catch{}
    if(!dispatch.accepted)return sendJSON(res,503,{error:'Le worker de points ne peut pas être lancé maintenant. Le rendu reste intact.'});
    return sendJSON(res,202,{run_id:runId,status:'queued',dispatched:true});
  } catch {return sendJSON(res,500,{error:'Relance du repérage indisponible. Le rendu reste intact.'});}
}
