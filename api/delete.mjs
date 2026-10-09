import { del,list } from '@vercel/blob';
import { privateJSON } from './_data.mjs';
import { readJSON, requireAuth, sameOrigin, sendJSON } from './_security.mjs';

export function validPrivatePath(value) {
  return typeof value==='string'&&/^(uploads|results)\/[a-zA-Z0-9._-]+$/.test(value);
}

export function referencedPrivatePaths(records=[]) {
  const paths=new Set();
  for(const record of records){if(validPrivatePath(record?.source_path))paths.add(record.source_path);if(validPrivatePath(record?.result_path))paths.add(record.result_path);}
  return paths;
}

async function protectedRunPaths() {
  const records=[];let cursor;
  do {
    const page=await list({prefix:'runs/',limit:1000,...(cursor?{cursor}:{})});
    records.push(...(await Promise.all(page.blobs.map(blob=>privateJSON(blob.pathname)))).filter(Boolean));cursor=page.cursor;
  } while(cursor);
  return referencedPrivatePaths(records);
}

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!requireAuth(req,res)||!sameOrigin(req))return;
  try {
    const body=await readJSON(req,16*1024),paths=body.paths;
    if(!Array.isArray(paths)||paths.length<1||paths.length>3||new Set(paths).size!==paths.length||paths.some(path=>!validPrivatePath(path))) {
      return sendJSON(res,400,{error:'Liste de fichiers privés invalide.'});
    }
    const protectedPaths=await protectedRunPaths();
    if(paths.some(path=>protectedPaths.has(path)))return sendJSON(res,409,{error:'Ce fichier appartient à un rendu conservé et ne peut pas être supprimé.'});
    await del(paths);
    return sendJSON(res,200,{removed:paths.length});
  } catch {
    return sendJSON(res,500,{error:'Le fichier privé n’a pas pu être supprimé.'});
  }
}
