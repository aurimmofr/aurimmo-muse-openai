import { readFile } from 'node:fs/promises';
import { requireAuth, sendJSON } from './_security.mjs';

let cache;
async function catalogue(){return cache??=JSON.parse(await readFile(new URL('../public/catalogue.json',import.meta.url),'utf8'));}

export default async function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!requireAuth(req,res))return;
  try{return sendJSON(res,200,await catalogue());}
  catch{return sendJSON(res,500,{error:'Catalogue public indisponible.'});}
}
