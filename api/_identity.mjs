import {sendJSON} from './_security.mjs';
import {SupabaseRequestError,supabaseAuthFetch} from './_supabase.mjs';

export const ACCESS_COOKIE='__Host-aurimmo_client_access';
export const REFRESH_COOKIE='__Host-aurimmo_client_refresh';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const validUUID=value=>typeof value==='string'&&UUID.test(value);

export function normalizeEmail(value) {
  const email=String(value||'').trim().toLowerCase();
  if(email.length<3||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return null;
  return email;
}

function cookies(req) {
  const result=new Map();
  for(const part of String(req?.headers?.cookie||'').split(';')) {
    const index=part.indexOf('=');if(index<1)continue;
    const key=part.slice(0,index).trim();
    try{result.set(key,decodeURIComponent(part.slice(index+1).trim()));}catch{}
  }
  return result;
}

function bearer(req) {
  const value=String(req?.headers?.authorization||'');
  const match=value.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1]||null;
}

function plausibleAccessToken(value) {
  return typeof value==='string'&&value.length>=20&&value.length<=8192&&!/[\s\0]/.test(value);
}

// Hosted Supabase projects can issue short opaque refresh tokens (currently 12
// characters). Their authenticity is always verified by GoTrue; this check only
// rejects malformed cookie/input values before forwarding them.
function plausibleRefreshToken(value) {
  return typeof value==='string'&&value.length>=8&&value.length<=8192&&!/[\s\0]/.test(value);
}

export function accessTokenFromRequest(req) {
  const value=bearer(req)||cookies(req).get(ACCESS_COOKIE)||null;
  return plausibleAccessToken(value)?value:null;
}

export function refreshTokenFromRequest(req) {
  const value=cookies(req).get(REFRESH_COOKIE)||null;
  return plausibleRefreshToken(value)?value:null;
}

function tokenExpiresAt(value) {
  if(!plausibleAccessToken(value))return null;
  const parts=value.split('.');
  if(parts.length!==3)return null;
  try {
    const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp)?Number(payload.exp):null;
  } catch { return null; }
}

function appendCookies(res,values) {
  const current=res.getHeader?.('Set-Cookie');
  const existing=Array.isArray(current)?current:current?[String(current)]:[];
  res.setHeader('Set-Cookie',[...existing,...values]);
}

export function setClientSession(res,session) {
  const access=session?.access_token,refresh=session?.refresh_token;
  if(!plausibleAccessToken(access)||!plausibleRefreshToken(refresh))throw new Error('Session Supabase invalide.');
  const accessAge=Math.min(7200,Math.max(300,Number(session.expires_in)||3600));
  appendCookies(res,[
    `${ACCESS_COOKIE}=${encodeURIComponent(access)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${accessAge}`,
    `${REFRESH_COOKIE}=${encodeURIComponent(refresh)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60*60*24*30}`,
  ]);
}

export function clearClientSession(res) {
  appendCookies(res,[
    `${ACCESS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${REFRESH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ]);
}

function publicUser(value) {
  if(!validUUID(value?.id)||!normalizeEmail(value?.email))return null;
  const confirmedAt=value.email_confirmed_at||value.confirmed_at||null;
  if(!confirmedAt)return null;
  return {id:value.id,email:normalizeEmail(value.email),email_confirmed_at:confirmedAt,created_at:value.created_at||null};
}

export async function readIdentity(req,{fetchImpl=fetch}={}) {
  const accessToken=accessTokenFromRequest(req);
  if(!accessToken)return null;
  try {
    const value=await supabaseAuthFetch('user',{method:'GET',accessToken,fetchImpl});
    const user=publicUser(value);
    return user?{user,accessToken,refreshToken:refreshTokenFromRequest(req),accessTokenExpiresAt:tokenExpiresAt(accessToken)}:null;
  } catch(error) {
    if(error instanceof SupabaseRequestError&&(error.status===401||error.status===403))return null;
    throw error;
  }
}


export async function ensureFreshIdentity(req,res,identity,{minimumTtlSeconds=600,force=false,fetchImpl=fetch,now=Math.floor(Date.now()/1000)}={}) {
  if(!identity?.user||!plausibleAccessToken(identity.accessToken))throw Object.assign(new Error('Session client requise.'),{status:401,code:'authentication_required'});
  const expiresAt=Number(identity.accessTokenExpiresAt??tokenExpiresAt(identity.accessToken));
  if(!force&&Number.isFinite(expiresAt)&&expiresAt-now>=minimumTtlSeconds)return identity;
  const refreshToken=plausibleRefreshToken(identity.refreshToken)?identity.refreshToken:refreshTokenFromRequest(req);
  if(!refreshToken)throw Object.assign(new Error('Reconnectez-vous avant de lancer la génération.'),{status:401,code:'session_refresh_required'});
  let session;
  try {session=await supabaseAuthFetch('token?grant_type=refresh_token',{method:'POST',body:{refresh_token:refreshToken},fetchImpl});}
  catch(error) {
    if(error instanceof SupabaseRequestError&&[400,401,403].includes(error.status))
      throw Object.assign(new Error('Votre session a expiré. Reconnectez-vous avant de générer.'),{status:401,code:'session_refresh_required'});
    throw error;
  }
  const user=publicUser(session?.user),accessToken=session?.access_token,nextRefreshToken=session?.refresh_token;
  if(!user||user.id!==identity.user.id||user.email!==identity.user.email||!plausibleAccessToken(accessToken)||!plausibleRefreshToken(nextRefreshToken))
    throw Object.assign(new Error('La session renouvelée ne correspond pas au client connecté.'),{status:401,code:'session_identity_mismatch'});
  const refreshed={user,accessToken,refreshToken:nextRefreshToken,accessTokenExpiresAt:tokenExpiresAt(accessToken)??now+Math.max(0,Number(session.expires_in)||0)};
  if(!Number.isFinite(refreshed.accessTokenExpiresAt)||refreshed.accessTokenExpiresAt-now<minimumTtlSeconds)
    throw Object.assign(new Error('La session renouvelée est trop courte pour lancer une génération.'),{status:401,code:'session_too_short'});
  setClientSession(res,session);
  return refreshed;
}

export async function requireIdentity(req,res,options={}) {
  try {
    const identity=await readIdentity(req,options);
    if(identity)return identity;
    sendJSON(res,401,{error:'Connexion client requise.',code:'authentication_required'});
    return null;
  } catch {
    sendJSON(res,503,{error:'Vérification de session indisponible.',code:'identity_unavailable'});
    return null;
  }
}

export const __test={cookies,bearer,plausibleAccessToken,plausibleRefreshToken,publicUser,tokenExpiresAt};
