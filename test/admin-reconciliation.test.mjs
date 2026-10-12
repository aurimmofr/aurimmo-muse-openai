import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {reconciliationRequest,resolveReconciliation,trustedAdminMutation,verifyStoredResult} from '../server/routes/admin-reconciliations.mjs';

const USER='11111111-1111-4111-8111-111111111111';
const ADMIN='22222222-2222-4222-8222-222222222222';
const PROJECT='33333333-3333-4333-8333-333333333333';
const ASSET='44444444-4444-4444-8444-444444444444';
const AUTHORIZATION='55555555-5555-4555-8555-555555555555';
const RUN=`run-${AUTHORIZATION}`;
const FINGERPRINT='a'.repeat(64);
const CRC_TABLE=new Uint32Array(256);
for(let value=0;value<256;value++) {
  let crc=value;
  for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;
  CRC_TABLE[value]=crc>>>0;
}

const attempt={
  authorization_id:AUTHORIZATION,run_id:RUN,user_id:USER,project_id:PROJECT,source_asset_id:ASSET,
  provider:'muse',selection_fingerprint:FINGERPRINT,status:'reconciliation_required',credit_state:'reconciliation_required',result_path:null,
  reconciliation_resolution:null,reconciled_at:null,
};

function stored(bytes,contentType) {
  return {statusCode:200,blob:{size:bytes.length,contentType},stream:new Blob([bytes]).stream()};
}

function pngChunk(type,data=Buffer.alloc(0)) {
  const name=Buffer.from(type),chunk=Buffer.alloc(12+data.length);chunk.writeUInt32BE(data.length,0);name.copy(chunk,4);data.copy(chunk,8);
  let crc=0xffffffff;for(const byte of Buffer.concat([name,data]))crc=CRC_TABLE[(crc^byte)&0xff]^(crc>>>8);
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,8+data.length);return chunk;
}

function png(width=640,height=480) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),pngChunk('IHDR',header),pngChunk('IDAT',Buffer.alloc(1200,7)),pngChunk('IEND')]);
}

function storedArtifacts({override={}}={}) {
  const image=png(),resultPath=`results/${RUN}.png`;
  const record={schema_version:'aurimmo.public.run.v2',run_id:RUN,user_id:USER,project_id:PROJECT,source_asset_id:ASSET,provider:'muse',
    selection_fingerprint:FINGERPRINT,result_path:resultPath,output_sha256:createHash('sha256').update(image).digest('hex'),...override};
  const encoded=Buffer.from(JSON.stringify(record));
  return {image,record,getImpl:async pathname=>pathname===`runs/${RUN}.json`?stored(encoded,'application/json'):pathname===resultPath?stored(image,'image/png'):null};
}

test('admin reconciliation binds the authorization to its deterministic run and a meaningful note',()=>{
  assert.deepEqual(reconciliationRequest({authorization_id:AUTHORIZATION.toUpperCase(),run_id:RUN,resolution:'confirmed_no_result',note:'  Vérifié   auprès du fournisseur.  '}),{
    authorizationId:AUTHORIZATION,runId:RUN,resolution:'confirmed_no_result',note:'Vérifié auprès du fournisseur.',
  });
  assert.throws(()=>reconciliationRequest({authorization_id:AUTHORIZATION,run_id:'run-66666666-6666-4666-8666-666666666666',resolution:'confirmed_no_result',note:'Vérification suffisante'}),/invalide/);
  assert.throws(()=>reconciliationRequest({authorization_id:AUTHORIZATION,run_id:RUN,resolution:'confirmed_no_result',note:'court'}),/invalide/);
  assert.equal(trustedAdminMutation({headers:{origin:'https://app.example.fr',host:'app.example.fr','sec-fetch-site':'same-origin'}}),true);
  assert.equal(trustedAdminMutation({headers:{host:'app.example.fr'}}),false);
  assert.equal(trustedAdminMutation({headers:{origin:'https://evil.example',host:'app.example.fr','sec-fetch-site':'cross-site'}}),false);
});

test('confirming a saved result requires the exact private run trace and image digest',async()=>{
  const valid=storedArtifacts();
  assert.deepEqual(await verifyStoredResult(attempt,{getImpl:valid.getImpl}),{resultPath:`results/${RUN}.png`,width:640,height:480,bytes:valid.image.length,contentType:'image/png'});
  const mismatched=storedArtifacts({override:{project_id:'66666666-6666-4666-8666-666666666666'}});
  await assert.rejects(()=>verifyStoredResult(attempt,{getImpl:mismatched.getImpl}),error=>error.code==='stored_result_mismatch');
  await assert.rejects(()=>verifyStoredResult(attempt,{getImpl:async()=>null}),error=>error.code==='stored_result_missing');
});

test('confirmed saved forwards verified PNG metadata for atomic asset registration without an image provider call',async()=>{
  const artifacts=storedArtifacts(),calls=[];
  const result=await resolveReconciliation({user:{id:ADMIN,email:'admin@example.fr'}},{authorization_id:AUTHORIZATION,run_id:RUN,resolution:'confirmed_saved',note:'Image et empreinte vérifiées dans le stockage.'},{
    adminFetch:async path=>{calls.push(['read',path]);return [attempt];},
    getImpl:async(path,options)=>{calls.push(['blob',path,options]);return artifacts.getImpl(path);},
    adminRpc:async(name,args)=>{calls.push(['rpc',name,args]);return [{resolution_status:'resolved',attempt_status:'saved',credit_status:'consumed',resolved_result_path:`results/${RUN}.png`,reconciliation_resolved_at:'2026-10-12T12:00:00Z'}];},
  });
  assert.equal(result.provider_call_performed,false);
  assert.equal(result.status,'saved');
  const rpc=calls.find(call=>call[0]==='rpc');
  assert.equal(rpc[1],'resolve_generation_reconciliation');
  assert.equal(rpc[2].p_admin_user_id,ADMIN);
  assert.equal(rpc[2].p_authorization_id,AUTHORIZATION);
  assert.equal(rpc[2].p_result_path,`results/${RUN}.png`);
  assert.equal(rpc[2].p_result_width,640);
  assert.equal(rpc[2].p_result_height,480);
  assert.equal(rpc[2].p_result_bytes,artifacts.image.length);
  assert.equal(rpc[2].p_result_content_type,'image/png');
  assert.deepEqual(calls.filter(call=>call[0]==='blob').map(call=>call[1]).sort(),[`results/${RUN}.png`,`runs/${RUN}.json`].sort());
});

test('closing without a usable result remains consumed and performs no blob or Muse call',async()=>{
  let blobCalls=0;
  const result=await resolveReconciliation({user:{id:ADMIN,email:'admin@example.fr'}},{authorization_id:AUTHORIZATION,run_id:RUN,resolution:'confirmed_no_result',note:'Aucun rendu exploitable confirmé manuellement.'},{
    adminFetch:async()=>[attempt],
    getImpl:async()=>{blobCalls+=1;throw new Error('unexpected blob read');},
    adminRpc:async(name,args)=>{
      assert.equal(name,'resolve_generation_reconciliation');
      assert.equal(args.p_result_path,null);
      assert.equal(args.p_result_width,null);
      assert.equal(args.p_result_height,null);
      assert.equal(args.p_result_bytes,null);
      assert.equal(args.p_result_content_type,null);
      return [{resolution_status:'resolved',attempt_status:'failed_after_request',credit_status:'consumed',resolved_result_path:null,reconciliation_resolved_at:'2026-10-12T12:00:00Z'}];
    },
  });
  assert.equal(blobCalls,0);
  assert.equal(result.status,'failed_after_request');
  assert.equal(result.credit_state,'consumed');
  assert.equal(result.provider_call_performed,false);
});

test('migration and admin UI keep reconciliation service-only, immutable and audited',async()=>{
  const [sql,server,html,client,generator]=await Promise.all([
    readFile(new URL('../supabase/migrations/002_reconciliation_admin.sql',import.meta.url),'utf8'),
    readFile(new URL('../server/routes/admin-reconciliations.mjs',import.meta.url),'utf8'),
    readFile(new URL('../public/admin.html',import.meta.url),'utf8'),
    readFile(new URL('../public/admin.js',import.meta.url),'utf8'),
    readFile(new URL('../api/generate.mjs',import.meta.url),'utf8'),
  ]);
  assert.match(sql,/status in \([^)]*'failed_after_request'/);
  assert.match(sql,/reconciliation_resolution in \('confirmed_saved', 'confirmed_no_result'\)/);
  assert.match(sql,/generation\.reconciliation_resolved/);
  assert.match(sql,/insert into public\.assets\(owner_id, project_id, blob_path, kind, width, height, content_type, bytes\)/);
  assert.match(sql,/on conflict \(blob_path\) do nothing/);
  assert.match(sql,/raise exception 'generated_asset_conflict'/);
  assert.match(sql,/'provider_call_performed', false/);
  assert.match(sql,/revoke all on function public\.resolve_generation_reconciliation\([^;]+\) from public, anon, authenticated/);
  assert.match(sql,/grant execute on function public\.resolve_generation_reconciliation\([^;]+\) to service_role/);
  assert.doesNotMatch(sql,/grant execute on function public\.resolve_generation_reconciliation\([^;]+\) to authenticated/);
  assert.match(generator,/attempt\.status==='failed_after_request'\)return 'closed_after_request'/);
  assert.match(html,/id="reconciliations-list"/);
  assert.match(client,/\/api\/admin-reconciliations/);
  assert.match(client,/Confirmer le rendu stocké/);
  assert.match(client,/Clôturer sans rendu/);
  assert.doesNotMatch(server,/api\.meta\.ai|providerCall|MODEL_API_KEY/);
});
