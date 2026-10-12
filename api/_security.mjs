import {randomBytes} from 'node:crypto';

export function requestId() {return randomBytes(12).toString('hex');}

export function sendJSON(res,status,payload) {
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(payload));
}

export async function readJSON(req,maxBytes=64*1024) {
  if(req?.body!==undefined&&req.body!==null) {
    if(Buffer.isBuffer(req.body)) {
      if(req.body.length>maxBytes)throw Object.assign(new Error('Requête trop volumineuse.'),{status:413});
      try{return JSON.parse(req.body.toString('utf8')||'{}');}catch{throw Object.assign(new Error('JSON invalide.'),{status:400});}
    }
    if(typeof req.body==='string') {
      if(Buffer.byteLength(req.body)>maxBytes)throw Object.assign(new Error('Requête trop volumineuse.'),{status:413});
      try{return JSON.parse(req.body||'{}');}catch{throw Object.assign(new Error('JSON invalide.'),{status:400});}
    }
    if(typeof req.body==='object') {
      let encoded;
      try{encoded=JSON.stringify(req.body);}catch{throw Object.assign(new Error('JSON invalide.'),{status:400});}
      if(Buffer.byteLength(encoded)>maxBytes)throw Object.assign(new Error('Requête trop volumineuse.'),{status:413});
      return req.body;
    }
    throw Object.assign(new Error('JSON invalide.'),{status:400});
  }
  const chunks=[];let total=0;
  for await(const chunk of req){total+=chunk.length;if(total>maxBytes)throw Object.assign(new Error('Requête trop volumineuse.'),{status:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw Object.assign(new Error('JSON invalide.'),{status:400});}
}

export function sameOrigin(req) {
  const origin=req.headers.origin;
  if(!origin)return true;
  try {return new URL(origin).host===req.headers.host;}catch{return false;}
}
