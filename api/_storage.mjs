import {
  del as vercelDel,
  get as vercelGet,
  issueSignedToken,
  list as vercelList,
  presignUrl,
  put as vercelPut,
} from '@vercel/blob';
import {createHmac,timingSafeEqual} from 'node:crypto';

const STORAGE_BOX_PROVIDER='hetzner-storage-box';
const VERCEL_PROVIDER='vercel-blob';
const KEY=/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,1023}$/;

export function storageProvider(env=process.env) {
  const explicit=String(env.OBJECT_STORAGE_PROVIDER||'').trim().toLowerCase();
  if(!explicit)return VERCEL_PROVIDER;
  if(![STORAGE_BOX_PROVIDER,VERCEL_PROVIDER].includes(explicit))
    throw Object.assign(new Error('Fournisseur de stockage privé invalide.'),{code:'invalid_storage_provider'});
  return explicit;
}

export function storageBoxConfiguration(env=process.env) {
  const endpoint=String(env.STORAGE_BOX_ENDPOINT||'').trim().replace(/\/$/,'');
  const username=String(env.STORAGE_BOX_USERNAME||'').trim();
  const password=String(env.STORAGE_BOX_PASSWORD||'');
  let url;
  try{url=new URL(endpoint);}catch{}
  if(!url||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'
    ||!/^u\d+-sub\d+\.your-storagebox\.de$/.test(url.hostname)||username!==url.hostname.split('.')[0]||password.length<16)
    throw Object.assign(new Error('Configuration Hetzner Storage Box incomplète ou invalide.'),{code:'invalid_storage_box_configuration'});
  return {endpoint,username,password};
}

function validPath(pathname) {
  if(typeof pathname!=='string'||!KEY.test(pathname)||pathname.includes('//')||pathname.split('/').some(part=>part==='.'||part==='..'))
    throw Object.assign(new Error('Chemin de stockage privé invalide.'),{code:'invalid_storage_path'});
  return pathname;
}

function encodedPath(pathname) {return validPath(pathname).split('/').map(encodeURIComponent).join('/');}
function basicHeader(config) {return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;}

function contentType(pathname,reported='') {
  const value=String(reported).split(';')[0].trim().toLowerCase();
  if(value&&value!=='application/octet-stream')return value;
  if(/\.png$/i.test(pathname))return 'image/png';
  if(/\.jpe?g$/i.test(pathname))return 'image/jpeg';
  if(/\.webp$/i.test(pathname))return 'image/webp';
  if(/\.json$/i.test(pathname))return 'application/json';
  return 'application/octet-stream';
}

async function storageBoxRequest(pathname,{method='GET',headers={},body,allowMissing=false}={}) {
  const config=storageBoxConfiguration(),url=`${config.endpoint}/${encodedPath(pathname)}`;
  const response=await fetch(url,{method,headers:{Authorization:basicHeader(config),...headers},body,redirect:'error',signal:AbortSignal.timeout(60_000)});
  if(allowMissing&&response.status===404)return null;
  if(!response.ok&&response.status!==207)
    throw Object.assign(new Error(`Hetzner Storage Box a refusé l'opération (${response.status}).`),{status:response.status,code:response.status===404?'blob_not_found':'storage_box_request_failed'});
  return response;
}

async function ensureStorageBoxCollections(pathname) {
  const parts=validPath(pathname).split('/').slice(0,-1),built=[];
  for(const part of parts) {
    built.push(part);
    const response=await storageBoxRequest(`${built.join('/')}/`,{method:'MKCOL'}).catch(error=>{
      if([405,409].includes(Number(error?.status)))return null;
      throw error;
    });
    if(response&&![201,204].includes(response.status))
      throw Object.assign(new Error('Le dossier privé ne peut pas être préparé.'),{code:'storage_box_collection_failed'});
  }
}

export async function get(pathname,options={}) {
  validPath(pathname);
  if(storageProvider()===VERCEL_PROVIDER)return vercelGet(pathname,options);
  const response=await storageBoxRequest(pathname,{allowMissing:true});
  if(!response)return null;
  const bytes=Buffer.from(await response.arrayBuffer()),type=contentType(pathname,response.headers.get('content-type'));
  return {statusCode:200,blob:{pathname,size:bytes.length,contentType:type,uploadedAt:response.headers.get('last-modified')||null},stream:new Blob([bytes]).stream()};
}

export async function put(pathname,body,options={}) {
  validPath(pathname);
  if(storageProvider()===VERCEL_PROVIDER)return vercelPut(pathname,body,options);
  await ensureStorageBoxCollections(pathname);
  const type=String(options.contentType||contentType(pathname));
  const response=await storageBoxRequest(pathname,{method:'PUT',headers:{'Content-Type':type,
    ...(options.allowOverwrite===false?{'If-None-Match':'*'}:{})},body});
  return {pathname,contentType:type,etag:response.headers.get('etag')||null};
}

export async function del(pathnames) {
  if(storageProvider()===VERCEL_PROVIDER)return vercelDel(pathnames);
  const values=Array.isArray(pathnames)?pathnames:[pathnames];
  for(const pathname of values)await storageBoxRequest(pathname,{method:'DELETE',allowMissing:true});
}

function xmlText(block,name) {
  const match=block.match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`,'i'));
  return match?match[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim():'';
}

async function storageBoxList(options={}) {
  const prefix=options.prefix?validPath(options.prefix):'';
  if(!prefix)throw Object.assign(new Error('Un préfixe privé est requis pour lister le Storage Box.'),{code:'storage_box_prefix_required'});
  const directory=prefix.endsWith('/')?prefix:prefix.slice(0,prefix.lastIndexOf('/')+1);
  const response=await storageBoxRequest(directory,{method:'PROPFIND',headers:{Depth:'1'},allowMissing:true});
  if(!response)return {blobs:[],hasMore:false,cursor:undefined};
  const xml=await response.text(),blocks=xml.match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi)||[],blobs=[];
  for(const block of blocks) {
    const href=xmlText(block,'href');if(!href)continue;
    let pathname;try{pathname=decodeURIComponent(new URL(href,storageBoxConfiguration().endpoint).pathname).replace(/^\/+|\/+$/g,'');}catch{continue;}
    if(!pathname||pathname===directory.replace(/\/$/,'')||!pathname.startsWith(prefix)||/<(?:[A-Za-z0-9_-]+:)?collection\b/i.test(block))continue;
    const size=Number(xmlText(block,'getcontentlength'))||0,uploadedAt=new Date(xmlText(block,'getlastmodified')||0);
    blobs.push({pathname,size,uploadedAt:Number.isNaN(uploadedAt.getTime())?new Date(0):uploadedAt,contentType:contentType(pathname,xmlText(block,'getcontenttype'))});
  }
  blobs.sort((a,b)=>a.pathname.localeCompare(b.pathname));
  const start=Math.max(0,Number.parseInt(String(options.cursor||'0'),10)||0),limit=Math.max(1,Math.min(1000,Number(options.limit)||1000));
  const page=blobs.slice(start,start+limit),hasMore=start+limit<blobs.length;
  return {blobs:page,hasMore,cursor:hasMore?String(start+limit):undefined};
}

export async function list(options={}) {
  if(storageProvider()===VERCEL_PROVIDER)return vercelList(options);
  return storageBoxList(options);
}

function mediaSecret(env=process.env) {
  const value=String(env.MEDIA_URL_SIGNING_SECRET||'');
  if(value.length<32)throw Object.assign(new Error('Secret de signature média absent ou trop court.'),{code:'invalid_media_signing_secret'});
  return value;
}

function mediaSignature(pathname,expires,env=process.env) {
  return createHmac('sha256',mediaSecret(env)).update(`${storageProvider(env)}\n${validPath(pathname)}\n${expires}`).digest('hex');
}

export function verifyMediaSignature(pathname,expires,signature,{now=Math.floor(Date.now()/1000),env=process.env}={}) {
  const timestamp=Number(expires);
  if(!Number.isSafeInteger(timestamp)||timestamp<now-30||timestamp>now+24*60*60+60||!/^[a-f0-9]{64}$/.test(String(signature||'')))return false;
  let expected;
  try{expected=Buffer.from(mediaSignature(pathname,timestamp,env),'hex');}
  catch(error){if(error?.code==='invalid_storage_path')return false;throw error;}
  const actual=Buffer.from(String(signature),'hex');
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}

export async function openRead(pathname) {
  validPath(pathname);
  if(storageProvider()===VERCEL_PROVIDER)return vercelGet(pathname,{access:'private',useCache:false});
  const response=await storageBoxRequest(pathname,{allowMissing:true});
  if(!response)return null;
  return {statusCode:200,blob:{pathname,size:Number(response.headers.get('content-length'))||null,
    contentType:contentType(pathname,response.headers.get('content-type')),uploadedAt:response.headers.get('last-modified')||null},stream:response.body};
}

export async function signedRead(pathname,{validForSeconds=60*60}={}) {
  validPath(pathname);
  if(storageProvider()===VERCEL_PROVIDER) {
    const validUntil=Date.now()+validForSeconds*1000;
    const token=await issueSignedToken({pathname,operations:['get'],validUntil});
    return (await presignUrl(token,{access:'private',pathname,operation:'get',validUntil})).presignedUrl;
  }
  const origin=String(process.env.PUBLIC_APP_URL||'').replace(/\/$/,'');let url;
  try{url=new URL(origin);}catch{}
  if(!url||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')
    throw Object.assign(new Error('Origine publique média invalide.'),{code:'invalid_public_app_url'});
  const expires=Math.floor(Date.now()/1000)+Math.max(60,Math.min(24*60*60,Number(validForSeconds)||60*60));
  const query=new URLSearchParams({path:pathname,expires:String(expires),signature:mediaSignature(pathname,expires)});
  return `${origin}/api/media?${query}`;
}

export const __test={STORAGE_BOX_PROVIDER,VERCEL_PROVIDER,validPath,mediaSignature,xmlText,contentType};
