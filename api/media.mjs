import {Readable} from 'node:stream';
import {authenticated} from './_security.mjs';
import {openRead,verifyMediaSignature} from './_storage.mjs';

function query(req,name) {
  const direct=req?.query?.[name];
  if(typeof direct==='string')return direct;
  if(Array.isArray(direct)&&typeof direct[0]==='string')return direct[0];
  try{return new URL(req.url,'https://aurimmo.local').searchParams.get(name);}catch{return null;}
}

export function mediaAccessAllowed(pathname,expires,signature,{isAuthenticated=false,now,env}={}) {
  if(isAuthenticated)return true;
  try{return verifyMediaSignature(pathname,expires,signature,{...(now===undefined?{}:{now}),...(env===undefined?{}:{env})});}
  catch{return false;}
}

export default async function handler(req,res) {
  if(!['GET','HEAD'].includes(req.method)) {res.statusCode=405;res.setHeader('Allow','GET, HEAD');return res.end();}
  const pathname=query(req,'path'),expires=query(req,'expires'),signature=query(req,'signature');let stage='authorization';
  try {
    // Signed links remain usable outside the app. Inside the authenticated app,
    // the same-origin session is an equally private fallback if a rotated or
    // differently provisioned signing secret invalidates an otherwise valid URL.
    if(!mediaAccessAllowed(pathname,expires,signature,{isAuthenticated:authenticated(req)})) {res.statusCode=403;return res.end();}
    stage='storage_read';
    const object=await openRead(pathname);
    if(!object||object.statusCode!==200) {res.statusCode=404;return res.end();}
    stage='response_headers';
    res.statusCode=200;
    res.setHeader('Content-Type',object.blob.contentType||'application/octet-stream');
    if(Number.isSafeInteger(object.blob.size)&&object.blob.size>=0)res.setHeader('Content-Length',String(object.blob.size));
    res.setHeader('Cache-Control','private, max-age=300, no-transform');
    res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method==='HEAD')return res.end();
    if(!object.stream) {res.statusCode=404;return res.end();}
    stage='response_stream';
    if(typeof object.stream.pipe==='function')return object.stream.pipe(res);
    return Readable.fromWeb(object.stream).pipe(res);
  } catch(error) {
    console.error('Private media delivery failed.',{stage,code:error?.code??null,status:error?.status??null,name:error?.name??null,message:error?.message??null});
    if(res.headersSent)return res.destroy();
    res.statusCode=503;return res.end();
  }
}

export const __test={query};
