#!/usr/bin/env node
import {get,list,put} from '@vercel/blob';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {promisify} from 'node:util';

const run=promisify(execFile),DEPLOY_ROOT=resolve(import.meta.dirname,'..'),LAB_ROOT=resolve(process.env.AURIMMO_LAB_ROOT||join(DEPLOY_ROOT,'../..'));
const once=process.argv.includes('--once'),checkOnly=process.argv.includes('--check'),interval=Math.max(7000,Number(process.env.HOTSPOT_POLL_INTERVAL_MS)||15000);
const requestedRunId=String(process.env.HOTSPOT_RUN_ID||'').trim()||null,RUN_ID=/^run-[a-zA-Z0-9-]{8,120}$/;
const catalogue=JSON.parse(await readFile(join(DEPLOY_ROOT,'public/catalogue.json'),'utf8')),catalogueIndex=new Map(catalogue.products.map(product=>[product.catalog_id,product]));
const python=join(LAB_ROOT,'.venv-vision/bin/python'),locator=join(LAB_ROOT,'scripts/local-product-locator.py'),traceDirectory=join(LAB_ROOT,'data/local-ui/public-bridge');

function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
async function blobBytes(pathname,maxBytes) {
  const result=await get(pathname,{access:'private',useCache:false});
  if(!result||result.statusCode!==200||result.blob.size>maxBytes)throw new Error(`Blob privé absent ou trop volumineux : ${pathname}`);
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}
async function blobJSON(pathname,maxBytes=1024*1024){return JSON.parse((await blobBytes(pathname,maxBytes)).toString('utf8'));}
async function maybeBlobJSON(pathname,maxBytes=1024*1024){try{return await blobJSON(pathname,maxBytes);}catch{return null;}}
async function listAll(prefix) {
  const blobs=[];let cursor;
  do {const page=await list({prefix,limit:1000,...(cursor?{cursor}:{})});blobs.push(...page.blobs);cursor=page.hasMore?page.cursor:undefined;} while(cursor);
  return blobs;
}

async function writeJob(runId,status,extra={}) {
  const now=new Date().toISOString(),previous=await maybeBlobJSON(`hotspot-jobs/${runId}.json`),attempt=status==='processing'?(Number(previous?.attempt)||0)+1:Number(extra.attempt??previous?.attempt)||0;
  const record={schema_version:'aurimmo.public.hotspot-job.v1',run_id:runId,status,attempt,queued_at:previous?.queued_at??now,updated_at:now,...extra};
  await put(`hotspot-jobs/${runId}.json`,JSON.stringify(record),{access:'private',contentType:'application/json',allowOverwrite:true});return record;
}

function validateLocator(result,record,imageHash) {
  if(!result||result.paid_api_calls!==0||(result.image_uploads??0)!==0||result.image_sha256!==imageHash||!Array.isArray(result.hotspots)||!Array.isArray(result.diagnostics))throw new Error('Sortie du repérage local invalide.');
  const allowed=new Set(record.product_ids),seen=new Set();
  for(const point of result.hotspots) {
    if(!allowed.has(point.catalog_id)||point.candidate_key!==point.catalog_id||seen.has(point.catalog_id)||!Number.isFinite(point.x)||point.x<0||point.x>1||!Number.isFinite(point.y)||point.y<0||point.y>1||point.position_source!=='automatic_local_detection')throw new Error('Un point local ne correspond pas à la sélection figée.');
    seen.add(point.catalog_id);
  }
}

async function processRun(pathname) {
  const runId=basename(pathname,'.json'),existing=await maybeBlobJSON(`hotspots/${runId}.json`,2*1024*1024);
  if(existing?.run_id===runId)return {run_id:runId,status:'already_completed'};
  const record=await blobJSON(pathname);
  if(!record?.run_id||basename(pathname,'.json')!==record.run_id||!Array.isArray(record.product_ids)||!/^results\/run-[a-zA-Z0-9-]{8,120}\.png$/.test(record.result_path||''))throw new Error(`Trace de rendu invalide : ${pathname}`);
  const products=record.product_ids.map(id=>catalogueIndex.get(id));
  if(products.some(product=>!product))throw new Error(`Catalogue incomplet pour ${record.run_id}.`);
  const processing=await writeJob(record.run_id,'processing',{retryable:true});
  const temp=await mkdtemp(join(tmpdir(),'aurimmo-hotspots-'));
  try {
    const imageBytes=await blobBytes(record.result_path,20*1024*1024),imageHash=sha256(imageBytes),imagePath=join(temp,'result.png'),inputPath=join(temp,'input.json'),outputPath=join(temp,'output.json');
    if(record.output_sha256&&record.output_sha256!==imageHash)throw new Error(`Empreinte du rendu divergente : ${record.run_id}.`);
    await writeFile(imagePath,imageBytes,{mode:0o600});
    await writeFile(inputPath,JSON.stringify({image_path:imagePath,image_sha256:imageHash,products:products.map(product=>({candidate_key:product.catalog_id,catalog_id:product.catalog_id,variant_id:product.sku??null,role:product.role,product_name:product.product_name}))}),{mode:0o600});
    await run(python,[locator,inputPath,outputPath,'--device','auto'],{timeout:20*60*1000,maxBuffer:128*1024,env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});
    const located=JSON.parse(await readFile(outputPath,'utf8'));validateLocator(located,record,imageHash);
    const completedAt=new Date().toISOString(),derived={schema_version:'aurimmo.public.hotspots.v1',status:'completed',run_id:record.run_id,selection_fingerprint:record.selection_fingerprint,
      product_ids:record.product_ids,result_path:record.result_path,image_sha256:imageHash,hotspots:located.hotspots,diagnostics:located.diagnostics,
      provenance:located.provenance??null,paid_api_calls:0,image_uploads:0,elapsed_seconds:located.elapsed_seconds??null,completed_at:completedAt};
    await mkdir(traceDirectory,{recursive:true});await writeFile(join(traceDirectory,`${record.run_id}.json`),JSON.stringify(derived,null,2)+'\n',{mode:0o600});
    try {await put(`hotspots/${record.run_id}.json`,JSON.stringify(derived),{access:'private',contentType:'application/json',allowOverwrite:false});}
    catch(error){const concurrent=await maybeBlobJSON(`hotspots/${record.run_id}.json`,2*1024*1024);if(concurrent?.run_id!==record.run_id)throw error;}
    await writeJob(record.run_id,'completed',{attempt:processing.attempt,retryable:false,completed_at:completedAt});
    console.log(JSON.stringify({run_id:record.run_id,status:'completed',hotspots:derived.hotspots.length,omitted:derived.diagnostics.length,paid_api_calls:0}));
    return derived;
  } finally {await rm(temp,{recursive:true,force:true});}
}

async function pendingRuns() {
  if(requestedRunId&&!RUN_ID.test(requestedRunId))throw new Error('Identifiant de rendu prioritaire invalide.');
  const [runs,hotspots]=await Promise.all([listAll('runs/'),listAll('hotspots/')]),done=new Set(hotspots.map(blob=>basename(blob.pathname,'.json')));
  return runs.filter(blob=>!done.has(basename(blob.pathname,'.json'))).sort((a,b)=>{
    const left=basename(a.pathname,'.json')===requestedRunId?0:1,right=basename(b.pathname,'.json')===requestedRunId?0:1;
    return left-right||a.uploadedAt-b.uploadedAt;
  });
}

async function cycle() {
  const pending=await pendingRuns(),failures=[];
  for(const blob of pending)try{await processRun(blob.pathname);}catch(error){
    const runId=basename(blob.pathname,'.json'),previous=await maybeBlobJSON(`hotspot-jobs/${runId}.json`),attempt=Number(previous?.attempt)||1;
    try{await writeJob(runId,'failed',{attempt,retryable:true,failed_at:new Date().toISOString()});}catch{}
    console.error(JSON.stringify({run_id:runId,status:'failed',error:String(error.message||error).slice(0,400),paid_api_calls:0}));failures.push(runId);
  }
  if(failures.length)throw new Error(`Repérage échoué pour ${failures.length} rendu(s).`);
  return pending.length;
}

if(checkOnly)console.log((await pendingRuns()).length);
else if(once)await cycle();
else {
  console.log(JSON.stringify({status:'watching',interval_ms:interval,paid_api_calls:0}));
  while(true){await cycle();await new Promise(resolve=>setTimeout(resolve,interval));}
}
