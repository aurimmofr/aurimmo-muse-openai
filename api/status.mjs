import {hotspotDispatchConfigured} from './_hotspot-dispatch.mjs';
import {requireIdentity} from './_identity.mjs';
import {sendJSON} from './_security.mjs';

export default async function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  const generationEnabled=process.env.GENERATION_ENABLED==='true',museConfigured=Boolean(process.env.MODEL_API_KEY);
  return sendJSON(res,200,{authenticated:true,user_id:identity.user.id,generation_enabled:generationEnabled,providers:{
    muse:{label:'Muse Image',configured:museConfigured}
  },hotspots:{configured:hotspotDispatchConfigured(),trigger:'workflow_dispatch',reconciliation:'scheduled'},paid_call_on_switch:false,automatic_retries:0});
}
