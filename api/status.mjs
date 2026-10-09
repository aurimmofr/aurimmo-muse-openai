import { authenticated, sendJSON } from './_security.mjs';

export default function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  const ok=authenticated(req);
  return sendJSON(res,200,{authenticated:ok,generation_enabled:ok&&process.env.GENERATION_ENABLED==='true',providers:{
    openai:{label:'OpenAI Image',configured:ok&&Boolean(process.env.OPENAI_API_KEY)},
    muse:{label:'Muse Image',configured:ok&&Boolean(process.env.MODEL_API_KEY)}
  },paid_call_on_switch:false,automatic_retries:0});
}
