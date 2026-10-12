import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {inspectUploadedImage} from '../api/_image.mjs';
import {SupabaseRequestError} from '../api/_supabase.mjs';
import {handleUpload} from '../api/upload.mjs';

function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) {
    crc^=byte;
    for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;
  }
  return (crc^0xffffffff)>>>0;
}

function pngChunk(type,data=Buffer.alloc(0)) {
  const name=Buffer.from(type,'ascii'),length=Buffer.alloc(4),checksum=Buffer.alloc(4);
  length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([length,name,data,checksum]);
}

function png(width=640,height=480) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=0;
  const scanlines=Buffer.alloc((width+1)*height);
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    pngChunk('IHDR',header),pngChunk('tEXt',Buffer.alloc(1200,0x61)),pngChunk('IDAT',deflateSync(scanlines)),pngChunk('IEND'),
  ]);
}

function jpeg(width=800,height=600) {
  const sof=Buffer.from([0xff,0xc0,0x00,0x11,0x08,height>>8,height&255,width>>8,width&255,0x03,1,0x11,0,2,0x11,0,3,0x11,0]);
  const sos=Buffer.from([0xff,0xda,0x00,0x0c,0x03,1,0,2,0,3,0,0,0x3f,0]);
  return Buffer.concat([Buffer.from([0xff,0xd8]),sof,sos,Buffer.alloc(1024,0x11),Buffer.from([0xff,0xd9])]);
}

function webp(width=720,height=540) {
  const frame=Buffer.alloc(10);frame[3]=0x9d;frame[4]=0x01;frame[5]=0x2a;frame.writeUInt16LE(width,6);frame.writeUInt16LE(height,8);
  const chunk=Buffer.concat([Buffer.from('VP8 '),Buffer.from([10,0,0,0]),frame]);
  const bytes=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBP'),chunk]);bytes.writeUInt32LE(bytes.length-8,4);return bytes;
}

function response() {
  return {headers:{},setHeader(name,value){this.headers[name]=value;},end(value){this.body=JSON.parse(value);}};
}

const userId='11111111-1111-4111-8111-111111111111';
const projectId='22222222-2222-4222-8222-222222222222';
const reservationId='33333333-3333-4333-8333-333333333333';
const assetId='44444444-4444-4444-8444-444444444444';

test('server identifies JPEG, PNG and WebP from bytes and extracts dimensions',()=>{
  assert.deepEqual(inspectUploadedImage(jpeg(),'image/jpeg'),{contentType:'image/jpeg',extension:'jpg',width:800,height:600});
  assert.deepEqual(inspectUploadedImage(png(),'image/png'),{contentType:'image/png',extension:'png',width:640,height:480});
  assert.deepEqual(inspectUploadedImage(webp(),'image/webp'),{contentType:'image/webp',extension:'webp',width:720,height:540});
});

test('server rejects spoofed MIME, corrupt structure and dangerous dimensions',()=>{
  assert.throws(()=>inspectUploadedImage(png(),'image/jpeg'),error=>error.code==='image_type_mismatch'&&error.status===415);
  assert.throws(()=>inspectUploadedImage(Buffer.alloc(2048,0x41),'image/jpeg'),error=>error.code==='invalid_image_bytes');
  const corrupt=png();corrupt[corrupt.length-1]^=1;
  assert.throws(()=>inspectUploadedImage(corrupt,'image/png'),error=>error.code==='invalid_image_bytes');
  assert.throws(()=>inspectUploadedImage(png(5001,480),'image/png'),error=>error.code==='invalid_image_dimensions'&&error.status===422);
});

test('upload persists authoritative server dimensions only after an atomic quota reservation',async()=>{
  const bytes=png(),calls=[],req={method:'POST',headers:{'content-type':'image/png','content-length':String(bytes.length),'x-aurimmo-project-id':projectId},body:bytes},res=response();
  await handleUpload(req,res,{
    identityFn:async()=>({user:{id:userId}}),ownedProjectFn:async()=>({id:projectId}),uuidFn:()=> '55555555-5555-4555-8555-555555555555',nowFn:()=>123,
    adminRpc:async(name,body)=>{calls.push([name,body]);if(name==='reserve_source_upload')return [{allowed:true,reservation_id:reservationId}];if(name==='complete_source_upload')return [{asset_id:assetId}];throw new Error(name);},
    putFn:async(pathname,_body,options)=>{calls.push(['blob.put',{pathname,options}]);return {pathname};},signFn:async pathname=>`signed:${pathname}`,
    delFn:async()=>{throw new Error('must_not_delete');},
  });
  assert.equal(res.statusCode,201);assert.equal(res.body.width,640);assert.equal(res.body.height,480);assert.equal(res.body.content_type,'image/png');
  assert.deepEqual(calls.map(([name])=>name),['reserve_source_upload','blob.put','complete_source_upload']);
  assert.equal(calls[0][1].p_bytes,bytes.length);assert.equal(calls[2][1].p_width,640);assert.equal(calls[2][1].p_height,480);
  assert.equal(calls[1][1].options.contentType,'image/png');
});

test('browser binary transport preserves and verifies the declared source image type',async()=>{
  const bytes=jpeg(),calls=[];
  const req={method:'POST',headers:{'content-type':'application/octet-stream','content-length':String(bytes.length),'x-aurimmo-source-content-type':'image/jpeg','x-aurimmo-project-id':projectId},body:bytes},res=response();
  await handleUpload(req,res,{
    identityFn:async()=>({user:{id:userId}}),ownedProjectFn:async()=>({id:projectId}),uuidFn:()=> '55555555-5555-4555-8555-555555555555',nowFn:()=>123,
    adminRpc:async(name,body)=>{calls.push([name,body]);if(name==='reserve_source_upload')return [{allowed:true,reservation_id:reservationId}];if(name==='complete_source_upload')return [{asset_id:assetId}];throw new Error(name);},
    putFn:async(pathname,_body,options)=>({pathname,options}),signFn:async pathname=>`signed:${pathname}`,delFn:async()=>{},
  });
  assert.equal(res.statusCode,201);assert.equal(res.body.content_type,'image/jpeg');assert.equal(res.body.width,800);assert.equal(res.body.height,600);
  assert.equal(calls[0][1].p_bytes,bytes.length);assert.equal(calls[1][1].p_content_type,'image/jpeg');

  const mismatch=response();
  await handleUpload({...req,headers:{...req.headers,'x-aurimmo-source-content-type':'image/png'}},mismatch,{
    identityFn:async()=>({user:{id:userId}}),ownedProjectFn:async()=>({id:projectId}),
    adminRpc:async name=>name==='reserve_source_upload'?[{allowed:true,reservation_id:reservationId}]:true,
    putFn:async()=>{throw new Error('must_not_store');},delFn:async()=>{},
  });
  assert.equal(mismatch.statusCode,415);assert.equal(mismatch.body.code,'image_type_mismatch');
});

test('invalid bytes and exhausted quota never reach Blob storage',async()=>{
  let writes=0;const rpcNames=[];
  const bad=Buffer.alloc(2048,0x41),badRes=response();
  await handleUpload({method:'POST',headers:{'content-type':'image/jpeg','x-aurimmo-project-id':projectId},body:bad},badRes,{
    identityFn:async()=>({user:{id:userId}}),ownedProjectFn:async()=>({id:projectId}),adminRpc:async name=>{
      rpcNames.push(name);if(name==='reserve_source_upload')return [{allowed:true,reservation_id:reservationId}];if(name==='release_source_upload')return true;
    },putFn:async()=>{writes+=1;},
  });
  assert.equal(badRes.statusCode,415);assert.equal(badRes.body.code,'invalid_image_bytes');
  assert.deepEqual(rpcNames,['reserve_source_upload','release_source_upload']);assert.equal(writes,0);

  const bytes=png(),quotaRes=response();
  await handleUpload({method:'POST',headers:{'content-type':'image/png','x-aurimmo-project-id':projectId},body:bytes},quotaRes,{
    identityFn:async()=>({user:{id:userId}}),ownedProjectFn:async()=>({id:projectId}),
    adminRpc:async name=>{rpcNames.push(name);assert.equal(name,'reserve_source_upload');return [{allowed:false,reason:'daily_limit',retry_after_seconds:77}];},
    putFn:async()=>{writes+=1;},
  });
  assert.equal(quotaRes.statusCode,429);assert.equal(quotaRes.headers['Retry-After'],'77');assert.equal(quotaRes.body.code,'source_upload_quota_exceeded');assert.equal(writes,0);
});

test('a lost completion response is reconciled to the exact committed asset without duplicate or deletion',async()=>{
  const bytes=png(),calls=[];let deletes=0;
  const req={method:'POST',headers:{'content-type':'image/png','x-aurimmo-project-id':projectId},body:bytes},res=response();
  await handleUpload(req,res,{
    identityFn:async()=>({user:{id:userId}}),ownedProjectFn:async()=>({id:projectId}),uuidFn:()=> '55555555-5555-4555-8555-555555555555',nowFn:()=>123,
    adminRpc:async(name)=>{
      calls.push(name);
      if(name==='reserve_source_upload')return [{allowed:true,reservation_id:reservationId}];
      if(name==='complete_source_upload')throw new SupabaseRequestError('lost',{status:503,code:'supabase_unreachable'});
      if(name==='reconcile_source_upload_completion')return [{completion_status:'completed',asset_id:assetId,project_id:projectId,bytes:bytes.length,width:640,height:480,content_type:'image/png'}];
      throw new Error(name);
    },
    putFn:async pathname=>({pathname}),signFn:async pathname=>`signed:${pathname}`,delFn:async()=>{deletes+=1;},
  });
  assert.equal(res.statusCode,201);assert.equal(res.body.asset_id,assetId);assert.equal(deletes,0);
  assert.deepEqual(calls,['reserve_source_upload','complete_source_upload','reconcile_source_upload_completion']);
});

test('an unresolvable ambiguous completion preserves the Blob instead of breaking a possibly committed asset',async()=>{
  const bytes=png();let deletes=0,releases=0;
  const req={method:'POST',headers:{'content-type':'image/png','x-aurimmo-project-id':projectId},body:bytes},res=response();
  await handleUpload(req,res,{
    identityFn:async()=>({user:{id:userId}}),ownedProjectFn:async()=>({id:projectId}),uuidFn:()=> '55555555-5555-4555-8555-555555555555',nowFn:()=>123,
    adminRpc:async name=>{
      if(name==='reserve_source_upload')return [{allowed:true,reservation_id:reservationId}];
      if(name==='release_source_upload'){releases+=1;return true;}
      throw new SupabaseRequestError('lost',{status:503,code:'supabase_unreachable'});
    },
    putFn:async pathname=>({pathname}),signFn:async pathname=>`signed:${pathname}`,delFn:async()=>{deletes+=1;},
  });
  assert.equal(res.statusCode,503);assert.equal(res.body.code,'supabase_unreachable');assert.equal(releases,1);assert.equal(deletes,0);
});

test('upload quota migration is atomic, service-only and plan-aware',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/003_source_upload_security.sql',import.meta.url),'utf8');
  assert.match(sql,/create table if not exists public\.source_upload_reservations/);
  assert.match(sql,/asset_id uuid references public\.assets\(id\) on delete cascade/);
  assert.match(sql,/pg_advisory_xact_lock\(hashtextextended\('source-upload:' \|\| p_user_id::text/);
  assert.match(sql,/r\.created_at > now\(\) - interval '24 hours'/);
  assert.match(sql,/concurrent_uploads >= 3/);
  assert.match(sql,/live_plan = 'essential'[\s\S]*v_uploads_limit := 30[\s\S]*live_plan = 'pro'[\s\S]*v_uploads_limit := 150/);
  assert.match(sql,/insert into public\.assets[\s\S]*p_width, p_height, p_content_type, p_bytes/);
  assert.match(sql,/function public\.reconcile_source_upload_completion[\s\S]*current_asset\.blob_path <> p_blob_path/);
  assert.match(sql,/revoke all on function public\.reserve_source_upload[\s\S]*from public, anon, authenticated/);
  assert.match(sql,/grant execute on function public\.complete_source_upload[\s\S]*to service_role/);
  assert.match(sql,/grant execute on function public\.reconcile_source_upload_completion[\s\S]*to service_role/);
  assert.doesNotMatch(sql,/to authenticated;/);
});
