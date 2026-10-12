import {createHash,randomBytes} from 'node:crypto';
import {accessTokenFromRequest,clearClientSession,normalizeEmail,readIdentity,refreshTokenFromRequest,setClientSession,validUUID} from '../../api/_identity.mjs';
import {readJSON,sameOrigin,sendJSON} from '../../api/_security.mjs';
import {SupabaseRequestError,supabaseAdminAuthFetch,supabaseAdminFetch,supabaseAdminRpc,supabaseAuthFetch} from '../../api/_supabase.mjs';

const emailHash=email=>createHash('sha256').update(email).digest('hex');

function clientUser(value) {
  const email=normalizeEmail(value?.email),confirmedAt=value?.email_confirmed_at||value?.confirmed_at||null;
  return validUUID(value?.id)&&email&&confirmedAt?{id:value.id,email,email_confirmed_at:confirmedAt}:null;
}

const first=value=>Array.isArray(value)?value[0]??null:value??null;

function sessionTokens(body) {
  const accessToken=body?.access_token??body?.session?.access_token,refreshToken=body?.refresh_token??body?.session?.refresh_token;
  const validAccess=value=>typeof value==='string'&&value.length>=20&&value.length<=8192&&!/[\s\0]/.test(value);
  const validRefresh=value=>typeof value==='string'&&value.length>=8&&value.length<=8192&&!/[\s\0]/.test(value);
  return validAccess(accessToken)&&validRefresh(refreshToken)?{accessToken,refreshToken}:null;
}

async function ensureProfile(user,{adminFetch=supabaseAdminFetch}={}) {
  try {
    await adminFetch('profiles?on_conflict=user_id',{method:'POST',body:{user_id:user.id,email:user.email,signup_mode:'public_otp'},headers:{Prefer:'resolution=merge-duplicates,return=minimal'}});
  } catch {}
}

function publicPortalURL() {
  const raw=String(process.env.PUBLIC_APP_URL||'').trim();
  try {
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.username||url.password)return null;
    url.pathname='/portal.html';url.search='';url.hash='';
    return url.toString();
  } catch { return null; }
}

function generatedLink(value) {
  const code=String(value?.email_otp||'').trim(),link=String(value?.action_link||'').trim();
  if(!/^\d{6}$/.test(code))return null;
  try {
    const url=new URL(link);
    if(url.protocol!=='https:'||url.username||url.password||!/\/auth\/v1\/verify$/.test(url.pathname))return null;
  } catch { return null; }
  return {code,link};
}

async function deliverCode(email,generated,{fetchImpl=fetch}={}) {
  const endpoint=String(process.env.AUTH_EMAIL_RELAY_URL||'').trim(),secret=String(process.env.AUTH_EMAIL_RELAY_SECRET||'').trim();
  let url;
  try {url=new URL(endpoint);}catch{}
  if(!url||url.protocol!=='https:'||url.username||url.password||secret.length<32)
    throw Object.assign(new Error('Envoi des e-mails momentanément indisponible.'),{status:503,code:'email_delivery_not_configured'});
  let response;
  try {
    response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json','X-Aurimmo-Auth-Mail-Secret':secret},body:JSON.stringify({email,code:generated.code,action_link:generated.link}),redirect:'error',signal:AbortSignal.timeout(10_000)});
  } catch {
    throw Object.assign(new Error('Envoi des e-mails momentanément indisponible.'),{status:503,code:'email_delivery_unreachable'});
  }
  if(!response.ok)throw Object.assign(new Error('L’e-mail de connexion n’a pas pu être envoyé. Réessayez dans un instant.'),{status:502,code:'email_delivery_failed'});
}

async function requestCode(body,{adminRpc=supabaseAdminRpc,adminFetch=supabaseAdminFetch,adminAuthFetch=supabaseAdminAuthFetch,mailFetch=fetch}={}) {
  const email=normalizeEmail(body.email),requestedMode=body.intent??body.mode,mode=requestedMode==='login'?'login':'signup';
  if(!email)throw Object.assign(new Error('Adresse e-mail invalide.'),{status:400,code:'invalid_email'});
  const permission=first(await adminRpc('begin_otp_challenge',{p_email_hash:emailHash(email),p_mode:mode}));
  if(!permission?.allowed) {
    const retryAfter=Math.max(1,Math.min(900,Number(permission?.retry_after_seconds)||60));
    const exhausted=permission?.reason==='attempts_exhausted';
    throw Object.assign(new Error(exhausted?'Trop de tentatives. Réessayez plus tard.':'Un e-mail vient déjà d’être envoyé. Réessayez dans un instant.'),{
      status:429,code:exhausted?'otp_attempts_exhausted':'otp_cooldown',retryAfter,
    });
  }
  if(mode==='login') {
    const rows=await adminFetch(`profiles?select=user_id&email=eq.${encodeURIComponent(email)}&limit=1`);
    if(!Array.isArray(rows)||!rows.length)throw Object.assign(new Error('Aucun compte n’est associé à cette adresse. Créez d’abord votre espace.'),{status:404,code:'account_not_found'});
  }
  const redirectTo=publicPortalURL();
  if(!redirectTo)throw Object.assign(new Error('Envoi des e-mails momentanément indisponible.'),{status:503,code:'public_app_url_not_configured'});
  const link=await adminAuthFetch('admin/generate_link',{method:'POST',body:{
    type:mode==='signup'?'signup':'magiclink',email,redirect_to:redirectTo,
    ...(mode==='signup'?{password:randomBytes(32).toString('base64url')}:{}),
  }});
  const generated=generatedLink(link);
  if(!generated)throw Object.assign(new Error('L’e-mail de connexion n’a pas pu être préparé.'),{status:502,code:'invalid_generated_link'});
  await deliverCode(email,generated,{fetchImpl:mailFetch});
  return {sent:true,expires_in:900,max_attempts:5,retry_after:60};
}

async function verifyCode(body,res) {
  const email=normalizeEmail(body.email),code=String(body.code||'').trim();
  if(!email)throw Object.assign(new Error('Adresse e-mail invalide.'),{status:400,code:'invalid_email'});
  if(!/^\d{6}$/.test(code))throw Object.assign(new Error('Le code doit contenir exactement 6 chiffres.'),{status:400,code:'invalid_code_format'});
  const hash=emailHash(email),attemptRows=await supabaseAdminRpc('consume_otp_attempt',{p_email_hash:hash});
  const attempt=Array.isArray(attemptRows)?attemptRows[0]:attemptRows;
  if(!attempt?.allowed) {
    const expired=attempt?.reason==='expired';
    throw Object.assign(new Error(expired?'Ce code a expiré. Demandez-en un nouveau.':'Trop de tentatives. Demandez un nouveau code.'),{status:expired?410:429,code:attempt?.reason||'otp_unavailable'});
  }
  let session;
  try {session=await supabaseAuthFetch('verify',{method:'POST',body:{type:'email',email,token:code}});}
  catch(error) {
    if(error instanceof SupabaseRequestError&&[400,401,403].includes(error.status))
      throw Object.assign(new Error('Code incorrect.'),{status:401,code:'invalid_otp',attempts_remaining:Number(attempt.attempts_remaining)||0});
    throw error;
  }
  const user=clientUser(session?.user);
  if(!user)throw Object.assign(new Error('Compte client non confirmé.'),{status:401,code:'unconfirmed_account'});
  await supabaseAdminRpc('complete_otp_challenge',{p_email_hash:hash});
  await ensureProfile(user);
  setClientSession(res,session);
  return {authenticated:true,user};
}

async function establishSession(body,res,{authFetch=supabaseAuthFetch,adminFetch=supabaseAdminFetch,adminRpc=supabaseAdminRpc}={}) {
  const tokens=sessionTokens(body);
  if(!tokens)throw Object.assign(new Error('Lien de connexion invalide.'),{status:400,code:'invalid_magic_link'});
  let accessUser,session,refreshedUser;
  try {
    accessUser=clientUser(await authFetch('user',{method:'GET',accessToken:tokens.accessToken}));
    session=await authFetch('token?grant_type=refresh_token',{method:'POST',body:{refresh_token:tokens.refreshToken}});
    refreshedUser=clientUser(session?.user);
  } catch(error) {
    if(error instanceof SupabaseRequestError&&[400,401,403].includes(error.status))
      throw Object.assign(new Error('Ce lien de connexion a expiré ou n’est plus valide.'),{status:401,code:'invalid_magic_link'});
    throw error;
  }
  if(!accessUser||!refreshedUser||accessUser.id!==refreshedUser.id||accessUser.email!==refreshedUser.email)
    throw Object.assign(new Error('Ce lien de connexion ne correspond pas à cette session.'),{status:401,code:'magic_link_identity_mismatch'});
  await ensureProfile(refreshedUser,{adminFetch});
  try {await adminRpc('complete_otp_challenge',{p_email_hash:emailHash(refreshedUser.email)});}catch{}
  setClientSession(res,session);
  return {authenticated:true,user:refreshedUser};
}

async function sessionStatus(req,res) {
  const current=await readIdentity(req);
  if(current)return sendJSON(res,200,{authenticated:true,user:current.user});
  const refreshToken=refreshTokenFromRequest(req);
  if(!refreshToken){clearClientSession(res);return sendJSON(res,200,{authenticated:false});}
  try {
    const session=await supabaseAuthFetch('token?grant_type=refresh_token',{method:'POST',body:{refresh_token:refreshToken}}),user=clientUser(session?.user);
    if(!user)throw new Error('invalid_session');
    setClientSession(res,session);return sendJSON(res,200,{authenticated:true,user});
  } catch {clearClientSession(res);return sendJSON(res,200,{authenticated:false});}
}

export default async function handler(req,res) {
  if(req.method==='GET')return sessionStatus(req,res);
  if(req.method==='DELETE') {
    if(!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.',code:'origin_refused'});
    const token=accessTokenFromRequest(req);
    if(token)try{await supabaseAuthFetch('logout',{method:'POST',accessToken:token});}catch{}
    clearClientSession(res);return sendJSON(res,200,{authenticated:false});
  }
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.',code:'origin_refused'});
  try {
    const body=await readJSON(req,12*1024),action=body.action;
    if(action==='request_code'||action==='signup')return sendJSON(res,202,await requestCode({...body,mode:action==='signup'?'signup':body.mode}));
    if(action==='verify_code')return sendJSON(res,200,await verifyCode(body,res));
    if(action==='establish_session')return sendJSON(res,200,await establishSession(body,res));
    return sendJSON(res,400,{error:'Action de connexion inconnue.',code:'invalid_auth_action'});
  } catch(error) {
    const status=Number(error.status)||503,payload={error:status>=500?'Connexion client momentanément indisponible.':error.message,code:error.code||'client_auth_failed'};
    if(Number.isInteger(error.attempts_remaining))payload.attempts_remaining=error.attempts_remaining;
    if(Number.isInteger(error.retryAfter)){payload.retry_after=error.retryAfter;res.setHeader?.('Retry-After',String(error.retryAfter));}
    return sendJSON(res,status,payload);
  }
}

export const __test={emailHash,clientUser,sessionTokens,publicPortalURL,generatedLink,deliverCode,requestCode,establishSession};
