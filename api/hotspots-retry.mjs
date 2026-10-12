import {put} from '@vercel/blob';
import {ownedGenerationAttempt,validResultPath} from './_client-data.mjs';
import {privateJSON,validRunId} from './_data.mjs';
import {dispatchHotspotWorker} from './_hotspot-dispatch.mjs';
import {validateHotspotRecord} from './_hotspot-record.mjs';
import {requireIdentity} from './_identity.mjs';
import {readJSON,sameOrigin,sendJSON} from './_security.mjs';

const PROCESSING_TTL_MS=35*60*1000,DISPATCH_TTL_MS=2*60*1000;

function recentTimestamp(value,ttl,now=Date.now()) {
  const timestamp=Date.parse(value);return Number.isFinite(timestamp)&&timestamp<=now+60_000&&now-timestamp<ttl;
}

export function activeProcessingJob(job,runId,now=Date.now()) {
  return job?.schema_version==='aurimmo.public.hotspot-job.v1'&&job.run_id===runId&&job.status==='processing'&&recentTimestamp(job.updated_at,PROCESSING_TTL_MS,now);
}

export function activeDispatch(dispatch,runId,now=Date.now()) {
  return dispatch?.schema_version==='aurimmo.public.hotspot-dispatch.v1'&&dispatch.run_id===runId&&dispatch.accepted===true&&recentTimestamp(dispatch.created_at,DISPATCH_TTL_MS,now);
}

export function runMatchesAttempt(run,attempt,userId) {
  return Boolean(run&&attempt&&run.schema_version==='aurimmo.public.run.v2'&&run.status==='render_saved_visual_review_pending'
    &&run.run_id===attempt.run_id&&run.user_id===userId&&attempt.user_id===userId
    &&run.project_id===attempt.project_id&&run.source_asset_id===attempt.source_asset_id
    &&run.provider==='muse'&&attempt.provider==='muse'&&run.selection_fingerprint===attempt.selection_fingerprint
    &&run.result_path===attempt.result_path&&validResultPath(run.result_path));
}

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.',code:'origin_refused'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  try {
    const {run_id:runId}=await readJSON(req,16*1024);
    if(!validRunId(runId))return sendJSON(res,400,{error:'Identifiant de rendu invalide.'});
    const attempt=await ownedGenerationAttempt(identity,runId);
    if(!attempt)return sendJSON(res,404,{error:'Rendu introuvable.',code:'run_not_found'});
    const [run,completed,job,lastDispatch]=await Promise.all([privateJSON(`runs/${runId}.json`),privateJSON(`hotspots/${runId}.json`,2*1024*1024),privateJSON(`hotspot-jobs/${runId}.json`),privateJSON(`hotspot-dispatches/${runId}.json`)]);
    if(!runMatchesAttempt(run,attempt,identity.user.id))
      return sendJSON(res,409,{error:'Le rendu ne correspond pas à la génération client enregistrée.',code:'run_identity_mismatch'});
    const completion=validateHotspotRecord(completed,run),rebuild=Boolean(completed)&&!completion.valid;
    if(completion.valid)return sendJSON(res,200,{run_id:runId,status:'completed',dispatched:false,rebuild:false});
    if(activeProcessingJob(job,runId))return sendJSON(res,202,{run_id:runId,status:'processing',dispatched:false,rebuild});
    if(activeDispatch(lastDispatch,runId))return sendJSON(res,202,{run_id:runId,status:'queued',dispatched:false,rebuild});
    const dispatch=await dispatchHotspotWorker(runId),createdAt=new Date().toISOString();
    try {await put(`hotspot-dispatches/${runId}.json`,JSON.stringify({schema_version:'aurimmo.public.hotspot-dispatch.v1',run_id:runId,status:dispatch.status,accepted:dispatch.accepted,http_status:dispatch.http_status??null,rebuild,created_at:createdAt}),{access:'private',contentType:'application/json',allowOverwrite:true});}catch{}
    if(!dispatch.accepted)return sendJSON(res,503,{error:'Le worker de points ne peut pas être lancé maintenant. Le rendu reste intact.'});
    return sendJSON(res,202,{run_id:runId,status:'queued',dispatched:true,rebuild});
  } catch {return sendJSON(res,500,{error:'Relance du repérage indisponible. Le rendu reste intact.'});}
}
