import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {validateHotspotRecord} from '../api/_hotspot-record.mjs';
import {activeDispatch,activeProcessingJob,runMatchesAttempt} from '../api/hotspots-retry.mjs';

const runId='run-12345678-aaaa-bbbb-cccc-123456789abc',hash='a'.repeat(64),fingerprint='b'.repeat(64);
const run={schema_version:'aurimmo.public.run.v2',run_id:runId,provider:'muse',selection_fingerprint:fingerprint,
  product_ids:['sofa-1','rug-1'],result_path:`results/${runId}.png`,output_sha256:hash};
const point={candidate_key:'sofa-1',catalog_id:'sofa-1',x:.25,y:.5,position_source:'automatic_local_detection',human_verified:false,
  evidence:{sku_fidelity_verified:false}};
const completed={schema_version:'aurimmo.public.hotspots.v1',status:'completed',run_id:runId,selection_fingerprint:fingerprint,
  product_ids:[...run.product_ids],result_path:run.result_path,image_sha256:hash,hotspots:[point],
  diagnostics:[{candidate_key:'rug-1',reason:'no_confident_pixel_detection'}],paid_api_calls:0,image_uploads:0};

test('only a complete offline record for the exact frozen render is terminal',()=>{
  assert.deepEqual(validateHotspotRecord(completed,run),{valid:true,reason:null});
  assert.equal(validateHotspotRecord({...completed,selection_fingerprint:'c'.repeat(64)},run).reason,'render_identity');
  assert.equal(validateHotspotRecord({...completed,product_ids:['rug-1','sofa-1']},run).reason,'product_identity');
  assert.equal(validateHotspotRecord({...completed,image_sha256:'c'.repeat(64)},run).reason,'image_identity');
  assert.equal(validateHotspotRecord({...completed,paid_api_calls:1},run).reason,'offline_contract');
});

test('unknown, invented, duplicate and unaccounted product points force a safe rebuild',()=>{
  const invented={...point,candidate_key:'unknown',catalog_id:'unknown'};
  assert.equal(validateHotspotRecord({...completed,hotspots:[invented]},run).reason,'hotspot_identity');
  assert.equal(validateHotspotRecord({...completed,hotspots:[point,{...point}],diagnostics:[]},run).reason,'hotspot_identity');
  assert.equal(validateHotspotRecord({...completed,hotspots:[{...point,x:1.4}]},run).reason,'hotspot_coordinates');
  assert.equal(validateHotspotRecord({...completed,hotspots:[],diagnostics:[{candidate_key:'sofa-1',reason:'no_confident_pixel_detection'}]},run).reason,'unaccounted_product');
  assert.equal(validateHotspotRecord({...completed,hotspots:[point],diagnostics:[{candidate_key:'rug-1',reason:'made_up_reason'}]},run).reason,'diagnostic_identity');
  assert.equal(validateHotspotRecord({...completed,hotspots:[{...point,position_source:'planned_placement'}]},run).reason,'hotspot_provenance');
});

test('retry coalescing trusts only fresh records scoped to the same run',()=>{
  const now=Date.parse('2026-10-12T12:00:00Z');
  const job={schema_version:'aurimmo.public.hotspot-job.v1',run_id:runId,status:'processing',updated_at:'2026-10-12T11:50:00Z'};
  const dispatch={schema_version:'aurimmo.public.hotspot-dispatch.v1',run_id:runId,accepted:true,created_at:'2026-10-12T11:59:00Z'};
  assert.equal(activeProcessingJob(job,runId,now),true);
  assert.equal(activeProcessingJob({...job,run_id:'run-87654321'},runId,now),false);
  assert.equal(activeProcessingJob({...job,updated_at:'2026-10-12T11:20:00Z'},runId,now),false);
  assert.equal(activeDispatch(dispatch,runId,now),true);
  assert.equal(activeDispatch({...dispatch,run_id:'run-87654321'},runId,now),false);
  assert.equal(activeDispatch({...dispatch,created_at:'2026-10-12T11:57:00Z'},runId,now),false);
});

test('retry accepts a run only through the owning saved generation identity',()=>{
  const userId='11111111-1111-4111-8111-111111111111',projectId='22222222-2222-4222-8222-222222222222',sourceId='33333333-3333-4333-8333-333333333333';
  const attempt={run_id:runId,user_id:userId,project_id:projectId,source_asset_id:sourceId,provider:'muse',selection_fingerprint:fingerprint,result_path:run.result_path};
  const ownedRun={...run,user_id:userId,project_id:projectId,source_asset_id:sourceId,status:'render_saved_visual_review_pending'};
  assert.equal(runMatchesAttempt(ownedRun,attempt,userId),true);
  assert.equal(runMatchesAttempt({...ownedRun,user_id:'44444444-4444-4444-8444-444444444444'},attempt,userId),false);
  assert.equal(runMatchesAttempt({...ownedRun,project_id:'44444444-4444-4444-8444-444444444444'},attempt,userId),false);
  assert.equal(runMatchesAttempt({...ownedRun,source_asset_id:'44444444-4444-4444-8444-444444444444'},attempt,userId),false);
});

test('hosted bridge reprocesses incoherent blobs and verifies the replacement contract',async()=>{
  const bridge=await readFile(new URL('../scripts/hotspot-bridge.mjs',import.meta.url),'utf8');
  const retry=await readFile(new URL('../api/hotspots-retry.mjs',import.meta.url),'utf8');
  const read=await readFile(new URL('../api/hotspots.mjs',import.meta.url),'utf8');
  assert.match(bridge,/validateHotspotRecord\(existing,record\)\.valid/);
  assert.match(bridge,/allowOverwrite:true/);
  assert.match(bridge,/validateHotspotRecord\(saved,record\)\.valid/);
  assert.match(bridge,/paid_api_calls:0,image_uploads:0/);
  assert.match(retry,/const completion=validateHotspotRecord\(completed,run\)/);
  assert.doesNotMatch(retry,/if\(completed\)return sendJSON/);
  assert.match(read,/code:'record_rebuild_required'/);
  assert.match(read,/hotspots:\[\],diagnostics:\[\]/);
});
