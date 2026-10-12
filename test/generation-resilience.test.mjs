import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {ensureFreshIdentity} from '../api/_identity.mjs';
import {__test as generationTest} from '../api/generate.mjs';

function withEnv(values,fn) {
  const previous={};
  for(const [key,value] of Object.entries(values)){previous[key]=process.env[key];process.env[key]=value;}
  return Promise.resolve(fn()).finally(()=>{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
}

function jwt(exp,subject='11111111-1111-4111-8111-111111111111') {
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({alg:'none',typ:'JWT'})}.${encode({exp,sub:subject})}.signature-value`;
}

test('one authorization always maps to one stable run and one server owner',()=>{
  const authorizationId='11111111-1111-4111-8111-111111111111',executionId='22222222-2222-4222-8222-222222222222';
  assert.equal(generationTest.stableRunId(authorizationId),'run-11111111-1111-4111-8111-111111111111');
  assert.equal(generationTest.reservationAction({status:'reserved',reservation_owner_id:executionId},executionId),'prepare');
  assert.equal(generationTest.reservationAction({status:'reserved',reservation_owner_id:'33333333-3333-4333-8333-333333333333'},executionId),'in_progress');
  assert.equal(generationTest.reservationAction({status:'request_started',execution_id:executionId},executionId),'owned_started');
  assert.equal(generationTest.reservationAction({status:'request_started',execution_id:'33333333-3333-4333-8333-333333333333'},executionId),'in_progress');
  assert.equal(generationTest.reservationAction({status:'saved'},executionId),'replay_saved');
  assert.equal(generationTest.reservationAction({status:'reconciliation_required'},executionId),'reconciliation_required');
  assert.equal(generationTest.reservationAction({status:'failed_after_request',credit_state:'consumed'},executionId),'closed_after_request');
});

test('an expiring browser session is rotated before the paid call and keeps the same user',async()=>withEnv({
  SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_generation_test',
},async()=>{
  const now=1_800_000_000,user={id:'11111111-1111-4111-8111-111111111111',email:'client@example.com',email_confirmed_at:'2026-10-12T00:00:00Z'};
  const oldAccess=jwt(now+30),nextAccess=jwt(now+3600),headers=new Map();
  const req={headers:{cookie:'__Host-aurimmo_client_refresh=refresh-token-value-for-generation-test'}};
  const res={getHeader:key=>headers.get(key),setHeader:(key,value)=>headers.set(key,value)};
  const refreshed=await ensureFreshIdentity(req,res,{user,accessToken:oldAccess,refreshToken:'refresh-token-value-for-generation-test',accessTokenExpiresAt:now+30},{minimumTtlSeconds:600,now,
    fetchImpl:async(_url,options)=>{
      assert.equal(JSON.parse(options.body).refresh_token,'refresh-token-value-for-generation-test');
      return new Response(JSON.stringify({access_token:nextAccess,refresh_token:'rotated-refresh-token-value-for-test',expires_in:3600,user}),{status:200,headers:{'Content-Type':'application/json'}});
    }});
  assert.equal(refreshed.user.id,user.id);
  assert.equal(refreshed.accessToken,nextAccess);
  assert.equal(headers.get('Set-Cookie').length,2);
}));

test('database transitions serialize duplicates, preserve the winner and are service-only',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/001_client_portal.sql',import.meta.url),'utf8');
  const reserve=sql.slice(sql.indexOf('create or replace function public.reserve_generation_credit'),sql.indexOf('create or replace function public.mark_generation_request_started'));
  const mark=sql.slice(sql.indexOf('create or replace function public.mark_generation_request_started'),sql.indexOf('create or replace function public.release_generation_credit'));
  const release=sql.slice(sql.indexOf('create or replace function public.release_generation_credit'),sql.indexOf('create or replace function public.finish_generation_attempt'));
  assert.match(sql,/reservation_owner_id uuid not null/);
  assert.match(sql,/execution_id uuid/);
  assert.match(reserve,/pg_advisory_xact_lock\(hashtextextended\(p_authorization_id::text, 42063\)\)/);
  assert.match(reserve,/existing_attempt\.reservation_owner_id = p_execution_id/);
  assert.match(mark,/pg_advisory_xact_lock\(hashtextextended\(p_user_id::text, 42064\)\)/);
  assert.match(mark,/current_attempt\.reservation_owner_id <> p_execution_id[\s\S]*'in_progress'/);
  assert.match(release,/current_attempt\.reservation_owner_id <> p_execution_id[\s\S]*'not_owner'/);
  assert.match(sql,/grant execute on function public\.mark_generation_request_started\(uuid, uuid, uuid\) to service_role/);
  assert.doesNotMatch(sql,/grant execute on function public\.mark_generation_request_started\([^;]+\) to authenticated/);
});

test('browser retries reuse the same authorization and the server never retries Muse',async()=>{
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const server=await readFile(new URL('../api/generate.mjs',import.meta.url),'utf8');
  assert.match(app,/GENERATION_INTENT_KEY='aurimmo-generation-intent-v1'/);
  assert.match(app,/authorizationId=generationAuthorization\(\)/);
  assert.match(app,/authorization_id:authorizationId/);
  assert.match(app,/authorization_reusable===false/);
  assert.match(server,/function stableRunId\(authorizationId\)/);
  assert.match(server,/claimRequestStart\(context\)[\s\S]*providerCall\(prompt,images,body\)/);
  assert.match(server,/startTransitionAttempted&&!requestStarted[\s\S]*p_outcome:'reconciliation_required'[\s\S]*release_generation_credit/);
  assert.match(server,/idempotent_replay:true/);
  assert.match(server,/cost:\{status:'unknown',usd:null\}/);
  assert.doesNotMatch(server,/published_flat_price|already_recorded|usd:0\.01/);
  assert.match(server,/automatic_retries:0/);
  assert.doesNotMatch(server,/providerCall\([^\n]+\)[\s\S]{0,300}providerCall\(/);
});
