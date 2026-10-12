const DEFAULT_TIMEOUT_MS=10_000;

export class SupabaseRequestError extends Error {
  constructor(message,{status=502,code='supabase_request_failed',upstreamMessage=null}={}) {
    super(message);
    this.name='SupabaseRequestError';
    this.status=status;
    this.code=code;
    this.upstreamMessage=upstreamMessage;
  }
}

function projectURL() {
  const raw=String(process.env.SUPABASE_URL||'').trim();
  if(!raw)return null;
  try {
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.username||url.password)return null;
    return url.origin;
  } catch { return null; }
}

function publishableKey() {
  return String(process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY||'').trim()||null;
}

function secretKey() {
  return String(process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim()||null;
}

export function supabaseConfigured({admin=false}={}) {
  return Boolean(projectURL()&&publishableKey()&&(!admin||secretKey()));
}

export function assertConfigured({admin=false}={}) {
  const url=projectURL(),key=publishableKey(),secret=admin?secretKey():null;
  if(!url||!key||admin&&!secret)throw new SupabaseRequestError('Base clients indisponible.',{status:503,code:'supabase_not_configured'});
  return {url,publishableKey:key,secretKey:secret};
}

function safePath(path) {
  const value=String(path||'').replace(/^\/+/, '');
  if(!value||value.includes('\\')||value.includes('\n')||value.includes('\r')||value.split(/[?#]/,1)[0].split('/').includes('..'))
    throw new SupabaseRequestError('Chemin Supabase invalide.',{status:500,code:'invalid_supabase_path'});
  return value;
}

async function parseResponse(response) {
  const text=await response.text();
  if(!text)return null;
  try{return JSON.parse(text);}catch{return null;}
}

function safeUpstreamMessage(payload) {
  const value=typeof payload?.message==='string'?payload.message.trim():'';
  return /^[a-z][a-z0-9_]{2,80}$/.test(value)?value:null;
}

async function request(url,{method='GET',headers={},body,fetchImpl=fetch,timeoutMs=DEFAULT_TIMEOUT_MS}={}) {
  let response;
  try {
    response=await fetchImpl(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  } catch {
    throw new SupabaseRequestError('Base clients momentanément indisponible.',{status:503,code:'supabase_unreachable'});
  }
  const payload=await parseResponse(response);
  if(!response.ok) {
    const upstreamCode=typeof payload?.code==='string'?payload.code:typeof payload?.error_code==='string'?payload.error_code:null;
    throw new SupabaseRequestError('Opération clients refusée.',{
      status:response.status>=400&&response.status<500?response.status:502,
      code:upstreamCode||'supabase_rejected',
      upstreamMessage:safeUpstreamMessage(payload),
    });
  }
  return payload;
}

export async function supabaseAuthFetch(path,{method='POST',body,accessToken,fetchImpl=fetch,timeoutMs}={}) {
  const configured=assertConfigured(),headers={apikey:configured.publishableKey,'Content-Type':'application/json'};
  if(accessToken)headers.Authorization=`Bearer ${accessToken}`;
  return request(`${configured.url}/auth/v1/${safePath(path)}`,{method,headers,body,fetchImpl,timeoutMs});
}

export async function supabaseAdminAuthFetch(path,{method='POST',body,fetchImpl=fetch,timeoutMs}={}) {
  const configured=assertConfigured({admin:true}),headers={apikey:configured.secretKey,'Content-Type':'application/json'};
  if(!configured.secretKey.startsWith('sb_secret_'))headers.Authorization=`Bearer ${configured.secretKey}`;
  return request(`${configured.url}/auth/v1/${safePath(path)}`,{method,headers,body,fetchImpl,timeoutMs});
}

export async function supabaseUserFetch(path,{method='GET',body,accessToken,headers:extraHeaders={},fetchImpl=fetch,timeoutMs}={}) {
  if(typeof accessToken!=='string'||accessToken.length<20)throw new SupabaseRequestError('Session client requise.',{status:401,code:'authentication_required'});
  const configured=assertConfigured(),headers={apikey:configured.publishableKey,Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',...extraHeaders};
  return request(`${configured.url}/rest/v1/${safePath(path)}`,{method,headers,body,fetchImpl,timeoutMs});
}

export async function supabaseAdminFetch(path,{method='GET',body,headers:extraHeaders={},fetchImpl=fetch,timeoutMs}={}) {
  const configured=assertConfigured({admin:true}),headers={apikey:configured.secretKey,'Content-Type':'application/json',...extraHeaders};
  if(!configured.secretKey.startsWith('sb_secret_'))headers.Authorization=`Bearer ${configured.secretKey}`;
  return request(`${configured.url}/rest/v1/${safePath(path)}`,{method,headers,body,fetchImpl,timeoutMs});
}

export function supabaseUserRpc(name,body,accessToken,options={}) {
  if(!/^[a-z][a-z0-9_]{1,80}$/.test(String(name)))throw new SupabaseRequestError('RPC Supabase invalide.',{status:500,code:'invalid_supabase_rpc'});
  return supabaseUserFetch(`rpc/${name}`,{...options,method:'POST',body,accessToken});
}

export function supabaseAdminRpc(name,body,options={}) {
  if(!/^[a-z][a-z0-9_]{1,80}$/.test(String(name)))throw new SupabaseRequestError('RPC Supabase invalide.',{status:500,code:'invalid_supabase_rpc'});
  return supabaseAdminFetch(`rpc/${name}`,{...options,method:'POST',body});
}

export const __test={projectURL,publishableKey,secretKey,safePath,safeUpstreamMessage};
