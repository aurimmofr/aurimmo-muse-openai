import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE='__Host-aurimmo_session';
const MAX_AGE=60*60*12;

function secret() {
  const value=process.env.SESSION_SECRET;
  if(typeof value!=='string'||value.length<32)throw new Error('SESSION_SECRET absent ou trop court.');
  return value;
}

function signature(payload) {
  return createHmac('sha256',secret()).update(payload).digest('base64url');
}

function safeEqual(a,b) {
  const left=Buffer.from(String(a)),right=Buffer.from(String(b));
  return left.length===right.length&&timingSafeEqual(left,right);
}

export function issueSession(res) {
  const expires=Math.floor(Date.now()/1000)+MAX_AGE,payload=`v1.${expires}`,token=`${payload}.${signature(payload)}`;
  res.setHeader('Set-Cookie',`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

export function authenticated(req) {
  try {
    const raw=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='));
    if(!raw)return false;
    const token=raw.slice(COOKIE.length+1),parts=token.split('.');
    if(parts.length!==3||parts[0]!=='v1')return false;
    const payload=`${parts[0]}.${parts[1]}`,expires=Number(parts[1]);
    return Number.isSafeInteger(expires)&&expires>Math.floor(Date.now()/1000)&&safeEqual(parts[2],signature(payload));
  }catch{return false;}
}

export function requireAuth(req,res) {
  if(authenticated(req))return true;
  sendJSON(res,401,{error:'Authentification requise.'});return false;
}

export function checkPassword(candidate) {
  const expected=process.env.APP_PASSWORD;
  return typeof expected==='string'&&expected.length>=12&&typeof candidate==='string'&&safeEqual(candidate,expected);
}

export function requestId() {return randomBytes(12).toString('hex');}

export function sendJSON(res,status,payload) {
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(payload));
}

export async function readJSON(req,maxBytes=64*1024) {
  const chunks=[];let total=0;
  for await(const chunk of req){total+=chunk.length;if(total>maxBytes)throw Object.assign(new Error('Requête trop volumineuse.'),{status:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw Object.assign(new Error('JSON invalide.'),{status:400});}
}

export function sameOrigin(req) {
  const origin=req.headers.origin;
  if(!origin)return true;
  try {return new URL(origin).host===req.headers.host;}catch{return false;}
}
