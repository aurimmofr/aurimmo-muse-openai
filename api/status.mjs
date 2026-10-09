import { authenticated, sendJSON } from './_security.mjs';
import {hotspotDispatchConfigured} from './_hotspot-dispatch.mjs';

export default function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  const ok=authenticated(req);
  return sendJSON(res,200,{authenticated:ok,generation_enabled:ok&&process.env.GENERATION_ENABLED==='true',providers:{
    openai:{label:'OpenAI Image',configured:ok&&Boolean(process.env.OPENAI_API_KEY)},
    muse:{label:'Muse Image',configured:ok&&Boolean(process.env.MODEL_API_KEY)}
  },hotspots:{configured:ok&&hotspotDispatchConfigured(),trigger:'workflow_dispatch',reconciliation:'scheduled'},paid_call_on_switch:false,automatic_retries:0});
}
