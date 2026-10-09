import { authenticated, checkPassword, clearSession, issueSession, readJSON, sameOrigin, sendJSON } from './_security.mjs';

export default async function handler(req,res) {
  if(req.method==='GET')return sendJSON(res,200,{authenticated:authenticated(req),generation_enabled:process.env.GENERATION_ENABLED==='true'});
  if(req.method==='DELETE'){clearSession(res);return sendJSON(res,200,{authenticated:false});}
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.'});
  try {
    const body=await readJSON(req,4096);
    if(!checkPassword(body.password))return sendJSON(res,401,{error:'Mot de passe incorrect.'});
    issueSession(res);return sendJSON(res,200,{authenticated:true,generation_enabled:process.env.GENERATION_ENABLED==='true'});
  }catch(error){return sendJSON(res,error.status??500,{error:error.status?error.message:'Authentification indisponible.'});}
}
