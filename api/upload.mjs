import { put } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { requireAuth, sameOrigin, sendJSON } from './_security.mjs';

const MAX_BYTES=3_700_000;
const TYPES=new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp']]);

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!requireAuth(req,res)||!sameOrigin(req))return;
  try {
    const type=String(req.headers['content-type']??'').split(';')[0].trim();
    const extension=TYPES.get(type);
    if(!extension)return sendJSON(res,415,{error:'Photo JPEG, PNG ou WebP attendue.'});
    const announced=Number(req.headers['content-length']??0);
    if(announced>MAX_BYTES)return sendJSON(res,413,{error:'Photo trop volumineuse après optimisation.'});
    const chunks=[];let total=0;
    for await(const chunk of req){total+=chunk.length;if(total>MAX_BYTES)return sendJSON(res,413,{error:'Photo trop volumineuse après optimisation.'});chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);
    if(bytes.length<1024)return sendJSON(res,400,{error:'Photo vide ou trop petite.'});
    const pathname=`uploads/${Date.now()}-${randomUUID()}.${extension}`;
    const stored=await put(pathname,bytes,{access:'private',contentType:type,allowOverwrite:false});
    return sendJSON(res,201,{pathname:stored.pathname,content_type:type,bytes:bytes.length});
  }catch{return sendJSON(res,500,{error:'La photo n’a pas pu être placée dans le stockage privé.'});}
}
