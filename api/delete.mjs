import { del } from '@vercel/blob';
import { readJSON, requireAuth, sameOrigin, sendJSON } from './_security.mjs';

export function validPrivatePath(value) {
  return typeof value==='string'&&/^(uploads|results)\/[a-zA-Z0-9._-]+$/.test(value);
}

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!requireAuth(req,res)||!sameOrigin(req))return;
  try {
    const body=await readJSON(req,16*1024),paths=body.paths;
    if(!Array.isArray(paths)||paths.length<1||paths.length>3||new Set(paths).size!==paths.length||paths.some(path=>!validPrivatePath(path))) {
      return sendJSON(res,400,{error:'Liste de fichiers privés invalide.'});
    }
    await del(paths);
    return sendJSON(res,200,{removed:paths.length});
  } catch {
    return sendJSON(res,500,{error:'Le fichier privé n’a pas pu être supprimé.'});
  }
}
