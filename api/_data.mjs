import {get,issueSignedToken,presignUrl} from '@vercel/blob';
import {readFile} from 'node:fs/promises';

let catalogueCache;

export async function publicCatalogue() {
  if(catalogueCache)return catalogueCache;
  const value=JSON.parse(await readFile(new URL('../public/catalogue.json',import.meta.url),'utf8'));
  catalogueCache={value,index:new Map(value.products.map(product=>[product.catalog_id,product]))};
  return catalogueCache;
}

export async function privateJSON(pathname,maxBytes=512*1024) {
  const result=await get(pathname,{access:'private',useCache:false});
  if(!result||result.statusCode!==200||result.blob.size>maxBytes)return null;
  try{return JSON.parse(Buffer.from(await new Response(result.stream).arrayBuffer()).toString('utf8'));}
  catch{return null;}
}

export async function signedRead(pathname) {
  const validUntil=Date.now()+60*60*1000;
  const token=await issueSignedToken({pathname,operations:['get'],validUntil});
  return (await presignUrl(token,{access:'private',pathname,operation:'get',validUntil})).presignedUrl;
}

export const validRunId=value=>typeof value==='string'&&/^run-[a-zA-Z0-9-]{8,120}$/.test(value);
