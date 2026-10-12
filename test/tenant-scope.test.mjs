import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {validClientRunId,validResultPath,validUploadPath} from '../api/_client-data.mjs';
import {recordMatchesAttempt} from '../api/history.mjs';

test('client blob identifiers reject nesting and non-client run paths',()=>{
  assert.equal(validUploadPath('uploads/8a-photo.jpg'),true);
  assert.equal(validUploadPath('uploads/customer/photo.jpg'),false);
  assert.equal(validUploadPath('results/run-12345678.png'),false);
  assert.equal(validResultPath('results/run-12345678.png'),true);
  assert.equal(validResultPath('results/legacy.png'),false);
  assert.equal(validClientRunId('run-12345678'),true);
  assert.equal(validClientRunId('../run-12345678'),false);
});

test('history publishes a run only when the database attempt, blob record and owned source agree exactly',()=>{
  const attempt={run_id:'run-12345678',user_id:'11111111-1111-4111-8111-111111111111',project_id:'22222222-2222-4222-8222-222222222222',source_asset_id:'33333333-3333-4333-8333-333333333333',provider:'muse',selection_fingerprint:'a'.repeat(64),result_path:'results/run-12345678.png'};
  const asset={id:attempt.source_asset_id,blob_path:'uploads/customer-photo.jpg'};
  const record={...attempt,schema_version:'aurimmo.public.run.v2',source_path:asset.blob_path,status:'render_saved_visual_review_pending'};
  assert.equal(recordMatchesAttempt(record,attempt,asset),true);
  assert.equal(recordMatchesAttempt({...record,result_path:'results/run-87654321.png'},attempt,asset),false);
  assert.equal(recordMatchesAttempt({...record,provider:'openai'},attempt,asset),false);
  assert.equal(recordMatchesAttempt(record,attempt,{blob_path:'uploads/other-photo.jpg'}),false);
});

test('existing private APIs use client identity and never enumerate legacy global runs',async()=>{
  const names=['upload','history','hotspots','hotspots-retry','delete','catalogue','status'];
  for(const name of names) {
    const source=await readFile(new URL(`../api/${name}.mjs`,import.meta.url),'utf8');
    assert.match(source,/requireIdentity/);
    assert.doesNotMatch(source,/requireAuth/);
  }
  const upload=await readFile(new URL('../api/upload.mjs',import.meta.url),'utf8');
  assert.match(upload,/x-aurimmo-project-id/);assert.match(upload,/asset_id/);
  const history=await readFile(new URL('../api/history.mjs',import.meta.url),'utf8');
  assert.match(history,/listOwnedGenerationAttempts/);assert.doesNotMatch(history,/list\(\{prefix:'runs\/'/);
  const status=await readFile(new URL('../api/status.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(status,/openai/i);assert.match(status,/muse/);
});

test('source deletion is transactionally claimed by its owner and blocked after use',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/001_client_portal.sql',import.meta.url),'utf8');
  assert.match(migration,/function public\.delete_owned_source_asset\(p_asset_id uuid\)/);
  assert.match(migration,/a\.owner_id = current_user_id and a\.kind = 'source_photo'/);
  assert.match(migration,/generation_attempts g[\s\S]*g\.source_asset_id = current_asset\.id[\s\S]*failed_before_request/);
  assert.match(migration,/grant execute on function public\.delete_owned_source_asset\(uuid\) to authenticated/);
});
