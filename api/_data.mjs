import {readFile} from 'node:fs/promises';
import {get,signedRead as storageSignedRead} from './_storage.mjs';

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
  return storageSignedRead(pathname,{validForSeconds:60*60});
}

export const validRunId=value=>typeof value==='string'&&/^run-[a-zA-Z0-9-]{8,120}$/.test(value);
