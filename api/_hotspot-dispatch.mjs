const REPOSITORY='aurimmofr/aurimmo-muse-openai';
const WORKFLOW='product-hotspots.yml';
const REF='main';
const RUN_ID=/^run-[a-zA-Z0-9-]{8,120}$/;
const API_VERSION='2022-11-28';
let preflightCache={token:null,checkedAt:0,ready:false};

function headers(token) {
  return {Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':API_VERSION,'User-Agent':'aurimmo-hotspot-dispatch'};
}

export function hotspotDispatchConfigured(token=process.env.GITHUB_HOTSPOT_TOKEN) {
  return typeof token==='string'&&token.length>=20;
}

export async function preflightHotspotWorker({fetchImpl=fetch,token=process.env.GITHUB_HOTSPOT_TOKEN,now=Date.now()}={}) {
  if(!hotspotDispatchConfigured(token))return {ready:false,status:'not_configured'};
  if(preflightCache.token===token&&preflightCache.ready&&now-preflightCache.checkedAt<60_000)return {ready:true,status:'active_cached'};
  try {
    const response=await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`,{method:'GET',headers:headers(token),signal:AbortSignal.timeout(8000)});
    const payload=response.ok?await response.json().catch(()=>null):null;
    const ready=response.ok&&payload?.state==='active';
    preflightCache={token,checkedAt:now,ready};
    return {ready,status:ready?'active':response.ok?'inactive':'unavailable',http_status:response.status};
  } catch { return {ready:false,status:'unavailable'}; }
}

export async function dispatchHotspotWorker(runId,{fetchImpl=fetch,token=process.env.GITHUB_HOTSPOT_TOKEN}={}) {
  if(!RUN_ID.test(runId))return {accepted:false,status:'invalid_run_id'};
  if(!hotspotDispatchConfigured(token))return {accepted:false,status:'not_configured'};
  try {
    const response=await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,{
      method:'POST',headers:{...headers(token),'Content-Type':'application/json'},body:JSON.stringify({ref:REF,inputs:{run_id:runId}}),signal:AbortSignal.timeout(8000),
    });
    return {accepted:response.status===204,status:response.status===204?'accepted':'rejected',http_status:response.status};
  } catch { return {accepted:false,status:'unavailable'}; }
}

export const __test={REPOSITORY,WORKFLOW,REF,RUN_ID};
