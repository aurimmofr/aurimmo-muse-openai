import {Readable} from 'node:stream';
import {openRead,verifyMediaSignature} from './_storage.mjs';

function query(req,name) {
  try{return new URL(req.url,'https://aurimmo.local').searchParams.get(name);}catch{return null;}
}

export default async function handler(req,res) {
  if(!['GET','HEAD'].includes(req.method)) {res.statusCode=405;res.setHeader('Allow','GET, HEAD');return res.end();}
  const pathname=query(req,'path'),expires=query(req,'expires'),signature=query(req,'signature');
  try {
    if(!verifyMediaSignature(pathname,expires,signature)) {res.statusCode=403;return res.end();}
    const object=await openRead(pathname);
    if(!object||object.statusCode!==200) {res.statusCode=404;return res.end();}
    res.statusCode=200;
    res.setHeader('Content-Type',object.blob.contentType||'application/octet-stream');
    if(Number.isSafeInteger(object.blob.size)&&object.blob.size>=0)res.setHeader('Content-Length',String(object.blob.size));
    res.setHeader('Cache-Control','private, max-age=300, no-transform');
    res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method==='HEAD')return res.end();
    if(!object.stream) {res.statusCode=404;return res.end();}
    if(typeof object.stream.pipe==='function')return object.stream.pipe(res);
    return Readable.fromWeb(object.stream).pipe(res);
  } catch {res.statusCode=503;return res.end();}
}

export const __test={query};
