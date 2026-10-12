import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {ACCESS_COOKIE,REFRESH_COOKIE,__test as identityTest,accessTokenFromRequest,normalizeEmail,refreshTokenFromRequest,validUUID} from '../api/_identity.mjs';
import {readJSON} from '../api/_security.mjs';
import {BILLING_PLANS,__test as stripeTest,normalizeBillingPeriod,publicPlans,stripePriceFor,stripePriceMatchesOffer,stripeWebhookConfigured,verifyStripeSignature} from '../api/_stripe.mjs';
import {__test as supabaseTest,supabaseAdminFetch} from '../api/_supabase.mjs';
import {__test as onboardingTest} from '../server/routes/onboarding.mjs';
import {__test as projectsTest} from '../server/routes/projects.mjs';
import {__test as checkoutTest} from '../server/routes/billing-checkout.mjs';
import {__test as webhookTest} from '../api/billing-webhook.mjs';
import {__test as clientAuthTest} from '../server/routes/client-auth.mjs';
import {__test as routerTest} from '../api/router.mjs';

function withEnv(values,fn) {
  const previous={};
  for(const [key,value] of Object.entries(values)) {
    previous[key]=process.env[key];
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  try{return fn();}finally{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}

async function withEnvAsync(values,fn) {
  const previous={};
  for(const [key,value] of Object.entries(values)) {
    previous[key]=process.env[key];
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  try{return await fn();}finally{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}

test('backend plans keep the exact approved quotas and prices',()=>{
  assert.deepEqual(BILLING_PLANS.essential,{id:'essential',name:'Essentiel',credits_per_month:10,monthly_amount_cents:999,annual_amount_cents:7428,currency:'EUR'});
  assert.deepEqual(BILLING_PLANS.pro,{id:'pro',name:'Pro',credits_per_month:100,monthly_amount_cents:3999,annual_amount_cents:29988,currency:'EUR'});
  assert.deepEqual(publicPlans().map(plan=>[plan.id,plan.prices.monthly.amount_cents,plan.prices.annual.amount_cents]),[
    ['essential',999,7428],['pro',3999,29988],
  ]);
});

test('checkout periods accept the portal vocabulary and resolve server-side Stripe prices',()=>withEnv({
  STRIPE_PRICE_ESSENTIAL_MONTHLY:'price_essentialMonth1',
  STRIPE_PRICE_ESSENTIAL_ANNUAL:'price_essentialYear1',
},()=>{
  assert.equal(normalizeBillingPeriod('monthly'),'month');
  assert.equal(normalizeBillingPeriod('yearly'),'year');
  assert.equal(normalizeBillingPeriod('annual'),'year');
  assert.equal(normalizeBillingPeriod('weekly'),null);
  const monthly=stripePriceFor('essential','monthly');
  assert.equal(monthly.priceId,'price_essentialMonth1');
  assert.equal(stripePriceFor('essential','yearly').priceId,'price_essentialYear1');
  assert.equal(stripePriceMatchesOffer({id:monthly.priceId,active:true,currency:'eur',type:'recurring',unit_amount:999,recurring:{interval:'month',interval_count:1}},monthly),true);
  assert.equal(stripePriceMatchesOffer({id:monthly.priceId,active:true,currency:'eur',type:'recurring',unit_amount:1000,recurring:{interval:'month',interval_count:1}},monthly),false);
}));

test('billing return paths cannot escape the application origin',()=>{
  assert.equal(stripeTest.safeReturnPath('/studio.html?project=one'),'/studio.html?project=one');
  assert.equal(stripeTest.safeReturnPath('https://evil.example/path','/portal.html'),'/portal.html');
  assert.equal(stripeTest.safeReturnPath('//evil.example/path','/portal.html'),'/portal.html');
  assert.equal(stripeTest.safeReturnPath('/\\evil','/portal.html'),'/portal.html');
});

test('Stripe Checkout always returns through the plans portal before a preserved studio path',()=>{
  const result=checkoutTest.checkoutReturnURLs('https://interieur.example','/studio.html?project=00000000-0000-4000-8000-000000000001');
  assert.equal(result.returnPath,'/studio.html?project=00000000-0000-4000-8000-000000000001');
  const success=new URL(result.successUrl.replace('{CHECKOUT_SESSION_ID}','cs_test_123'));
  assert.equal(success.pathname,'/portal.html');
  assert.equal(success.searchParams.get('view'),'plans');
  assert.equal(success.searchParams.get('return_to'),result.returnPath);
  assert.equal(success.searchParams.get('billing'),'success');
  assert.equal(success.searchParams.get('session_id'),'cs_test_123');
  const cancelled=new URL(result.cancelUrl);
  assert.equal(cancelled.searchParams.get('billing'),'cancelled');
  assert.equal(cancelled.searchParams.get('session_id'),null);
  assert.equal(checkoutTest.studioReturnPath('/admin.html'),'/studio.html');
  assert.equal(checkoutTest.studioReturnPath('https://evil.example/studio.html'),'/studio.html');
});

test('Checkout resumes only strict Stripe-hosted session URLs and keeps the claimed offer immutable',()=>{
  const claim={checkout_session_id:'cs_test_ABC123',checkout_session_url:'https://checkout.stripe.com/c/pay/cs_test_ABC123',
    selected_plan_code:'essential',selected_billing_interval:'month',selected_stripe_price_id:'price_essentialMonth1'};
  assert.equal(checkoutTest.validCheckoutURL(claim.checkout_session_url),claim.checkout_session_url);
  assert.equal(checkoutTest.validCheckoutURL('https://checkout.stripe.com.evil.example/c/pay/cs_test_ABC123'),null);
  assert.equal(checkoutTest.publicCheckout(claim,{resumed:true}).resumed,true);
  assert.deepEqual(checkoutTest.claimedOffer(claim),{plan:BILLING_PLANS.essential,period:'month',priceId:'price_essentialMonth1'});
  assert.equal(checkoutTest.checkoutActionError('creating_other_offer',claim).code,'checkout_creation_pending');
  assert.equal(checkoutTest.checkoutActionError('open_other_offer',claim).checkout.checkout_session_id,'cs_test_ABC123');
});

test('an expired local active subscription is reconciled with Stripe before a new Checkout',async()=>{
  const now=Date.parse('2026-10-12T12:00:00.000Z'),userId='00000000-0000-4000-8000-000000000001';
  assert.equal(checkoutTest.activePeriodIsCurrent({status:'active',current_period_start:'2026-10-01T00:00:00Z',current_period_end:'2026-11-01T00:00:00Z'},now),true);
  assert.equal(checkoutTest.activePeriodIsCurrent({status:'active',current_period_start:'2026-09-01T00:00:00Z',current_period_end:'2026-10-01T00:00:00Z'},now),false);
  const calls=[];
  const reconciled=await checkoutTest.reconcileExpiredActiveSubscriptions({user:{id:userId},accessToken:'access-token'}, {
    now,
    subscriptions:[
      {stripe_subscription_id:'sub_Current123',status:'active',current_period_start:'2026-10-01T00:00:00Z',current_period_end:'2026-11-01T00:00:00Z',stripe_event_created:1790834400},
      {stripe_subscription_id:'sub_Expired123',status:'active',current_period_start:'2026-09-01T00:00:00Z',current_period_end:'2026-10-01T00:00:00Z',stripe_event_created:1790834400},
      {stripe_subscription_id:'sub_Canceled123',status:'canceled',current_period_start:'2026-09-01T00:00:00Z',current_period_end:'2026-10-01T00:00:00Z'},
    ],
    sync:async(...args)=>calls.push(args),
  });
  assert.equal(reconciled,1);
  assert.deepEqual(calls,[['sub_Expired123',1790834400,{candidateUserId:userId}]]);
});

test('Stripe webhook signatures are authenticated and time bounded',()=>{
  const raw=Buffer.from('{"id":"evt_example1"}'),secret='whsec_unit_test_secret',timestamp=1_800_000_000;
  const signature=createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest('hex');
  const header=`t=${timestamp},v1=${signature}`;
  assert.equal(verifyStripeSignature(raw,header,secret,{now:timestamp}),true);
  assert.equal(verifyStripeSignature(Buffer.from('{}'),header,secret,{now:timestamp}),false);
  assert.equal(verifyStripeSignature(raw,header,secret,{now:timestamp+301}),false);
});

test('Stripe webhook reads the untouched Web Request body used by Vercel',async()=>{
  const payload='{"id":"evt_rawBody123","nested":{"value":1}}';
  const request=new Request('https://interieur.example/api/billing-webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:payload});
  assert.equal((await webhookTest.readRawBody(request)).toString('utf8'),payload);
});

test('paid checkout readiness requires a configured webhook secret',()=>withEnv({STRIPE_WEBHOOK_SECRET:'whsec_unit_test'},()=>{
  assert.equal(stripeWebhookConfigured(),true);
}));

test('identity parsing accepts only normalized emails, UUIDs and plausible tokens',()=>{
  assert.equal(normalizeEmail(' Client@Example.COM '),'client@example.com');
  assert.equal(normalizeEmail('not-an-email'),null);
  assert.equal(validUUID('00000000-0000-4000-8000-000000000001'),true);
  assert.equal(validUUID('not-a-uuid'),false);
  const token='a'.repeat(32);
  assert.equal(accessTokenFromRequest({headers:{authorization:`Bearer ${token}`}}),token);
  assert.equal(accessTokenFromRequest({headers:{cookie:`${ACCESS_COOKIE}=${token}`}}),token);
  assert.equal(refreshTokenFromRequest({headers:{cookie:`${REFRESH_COOKIE}=Ab3dEf7hIj9K`}}),'Ab3dEf7hIj9K');
  assert.equal(identityTest.plausibleRefreshToken('too'),false);
  assert.equal(identityTest.publicUser({id:'00000000-0000-4000-8000-000000000001',email:'A@EXAMPLE.COM',email_confirmed_at:'2026-10-12T00:00:00Z'}).email,'a@example.com');
});

test('JSON bodies work both after Vercel parsing and as a raw request stream',async()=>{
  assert.deepEqual(await readJSON({body:{action:'request_code',email:'client@example.com'}}),{action:'request_code',email:'client@example.com'});
  assert.deepEqual(await readJSON({body:'{"plan_id":"essential"}'}),{plan_id:'essential'});
  await assert.rejects(()=>readJSON({body:{value:'x'.repeat(100)}},16),error=>error.status===413);
});

test('OTP delivery is authorized atomically before Supabase sends mail and a cooldown never sends',async()=>{
  const calls=[];
  const allowed=await clientAuthTest.requestCode({email:'client@example.com',intent:'signup'}, {
    adminRpc:async name=>{calls.push(`db:${name}`);return [{allowed:true,retry_after_seconds:0,reason:'allowed'}];},
    authFetch:async path=>{calls.push(`auth:${path}`);return {};},
  });
  assert.deepEqual(calls,['db:begin_otp_challenge','auth:otp']);
  assert.equal(allowed.retry_after,60);
  let sent=false;
  await assert.rejects(()=>clientAuthTest.requestCode({email:'client@example.com',intent:'login'}, {
    adminRpc:async()=>[{allowed:false,retry_after_seconds:47,reason:'cooldown'}],
    authFetch:async()=>{sent=true;},
  }),error=>error.code==='otp_cooldown'&&error.retryAfter===47);
  assert.equal(sent,false);
});

test('magic-link session verifies both tokens and refuses cross-user refresh tokens',async()=>{
  const access='access_token_'.padEnd(32,'a'),refresh='Ab3dEf7hIj9K';
  const user={id:'00000000-0000-4000-8000-000000000001',email:'client@example.com',email_confirmed_at:'2026-10-12T00:00:00Z'};
  const headers=new Map(),res={getHeader:key=>headers.get(key),setHeader:(key,value)=>headers.set(key,value)};
  const calls=[];
  const result=await clientAuthTest.establishSession({access_token:access,refresh_token:refresh},res,{
    authFetch:async(path,options)=>{
      calls.push(path);
      if(path==='user'){assert.equal(options.accessToken,access);return user;}
      assert.equal(options.body.refresh_token,refresh);
      return {access_token:'rotated_access_'.padEnd(32,'c'),refresh_token:'Zy8xWv6uTs4r',expires_in:3600,user};
    },
    adminFetch:async(path,options)=>{
      assert.match(path,/^profiles\?on_conflict=user_id$/);
      assert.equal(options.body.email,'client@example.com');
      return null;
    },
    adminRpc:async()=>null,
  });
  assert.deepEqual(calls,['user','token?grant_type=refresh_token']);
  assert.equal(result.authenticated,true);
  assert.equal(headers.get('Set-Cookie').length,2);

  await assert.rejects(()=>clientAuthTest.establishSession({access_token:access,refresh_token:refresh},res,{
    authFetch:async path=>path==='user'?user:{access_token:'rotated_access_'.padEnd(32,'c'),refresh_token:'Zy8xWv6uTs4r',user:{...user,id:'00000000-0000-4000-8000-000000000002'}},
    adminFetch:async()=>null,adminRpc:async()=>null,
  }),error=>error.code==='magic_link_identity_mismatch');
});

test('Supabase exposes only safe machine-readable RPC failures',()=>{
  assert.equal(supabaseTest.safeUpstreamMessage({message:'credits_exhausted'}),'credits_exhausted');
  assert.equal(supabaseTest.safeUpstreamMessage({message:'sensitive value: abc'}),null);
});

test('new Supabase secret keys stay in apikey instead of an invalid Bearer header',()=>withEnvAsync({
  SUPABASE_URL:'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY:'sb_publishable_unit_test',
  SUPABASE_SECRET_KEY:'sb_secret_unit_test',
},async()=>{
  let received;
  await supabaseAdminFetch('plans?select=code',{fetchImpl:async(_url,options)=>{received=options;return new Response('[]',{status:200,headers:{'Content-Type':'application/json'}});}});
  assert.equal(received.headers.apikey,'sb_secret_unit_test');
  assert.equal(received.headers.Authorization,undefined);
}));

test('portal onboarding and projects accept room/address payloads without property_type',()=>{
  const onboarding=onboardingTest.input({
    profile:{first_name:'Ada',last_name:'Lovelace',company:'Aurimmo'},
    project:{name:'Salon témoin',room_type:'living_room',address:'Paris'},
    terms_accepted:true,
  });
  assert.equal(onboarding.propertyType,'other');
  assert.equal(onboarding.city,'Paris');
  assert.equal(onboarding.companyName,'Aurimmo');
  const project=projectsTest.projectInput({name:'Salon client',room_type:'living_room',address:'Lyon'});
  assert.deepEqual(project,{name:'Salon client',propertyType:'other',city:'Lyon',notes:null});
  assert.equal(projectsTest.publicProject({id:'one',city:'Lyon'}).address,'Lyon');
});

test('project history signs only saved Muse results owned by the current tenant',async()=>{
  const owner='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
  const projectId='00000000-0000-4000-8000-000000000011',otherProject='00000000-0000-4000-8000-000000000012';
  const signed=[];
  const projects=await projectsTest.projectsWithGenerations([{id:projectId,name:'Salon',city:'Paris'}],[
    {run_id:'run-owned-12345678',user_id:owner,project_id:projectId,provider:'muse',status:'saved',result_path:'results/run-owned-12345678.png',created_at:'2026-10-12T12:00:00Z'},
    {run_id:'run-other-12345678',user_id:other,project_id:projectId,provider:'muse',status:'saved',result_path:'results/run-other-12345678.png'},
    {run_id:'run-project-12345678',user_id:owner,project_id:otherProject,provider:'muse',status:'saved',result_path:'results/run-project-12345678.png'},
    {run_id:'run-unsaved-12345678',user_id:owner,project_id:projectId,provider:'muse',status:'failed_before_request',result_path:'results/run-unsaved-12345678.png'},
    {run_id:'run-noasset-12345678',user_id:owner,project_id:projectId,provider:'muse',status:'saved',result_path:'results/run-noasset-12345678.png'},
  ],[
    {owner_id:owner,project_id:projectId,kind:'generated_result',blob_path:'results/run-owned-12345678.png'},
    {owner_id:other,project_id:projectId,kind:'generated_result',blob_path:'results/run-other-12345678.png'},
    {owner_id:owner,project_id:otherProject,kind:'generated_result',blob_path:'results/run-project-12345678.png'},
  ],owner,{sign:async path=>{signed.push(path);return `https://blob.example/${path}`;}});
  assert.deepEqual(signed,['results/run-owned-12345678.png']);
  assert.equal(projects.length,1);
  assert.equal(projects[0].address,'Paris');
  assert.deepEqual(projects[0].generations,[{
    id:'run-owned-12345678',run_id:'run-owned-12345678',project_id:projectId,provider:'muse',selection_fingerprint:null,
    created_at:'2026-10-12T12:00:00Z',image_url:'https://blob.example/results/run-owned-12345678.png',result_url:'https://blob.example/results/run-owned-12345678.png',
  }]);
  assert.equal(JSON.stringify(projects).includes(other),false);
});

test('webhook helpers support Stripe subscription references without weakening identifiers',()=>{
  assert.equal(webhookTest.scalar([{claim_billing_event:'claimed'}],'claim_billing_event'),'claimed');
  assert.equal(webhookTest.stripeId('sub_ABC123','sub'),'sub_ABC123');
  assert.equal(webhookTest.stripeId('cus_ABC123','sub'),null);
  assert.equal(webhookTest.subscriptionIdFrom({parent:{subscription_details:{subscription:'sub_ABC123'}}}),'sub_ABC123');
  assert.equal(webhookTest.checkoutSessionId('cs_test_ABC123'),'cs_test_ABC123');
  assert.equal(webhookTest.checkoutSessionId('cs_test_bad_value'),null);
  assert.equal(webhookTest.SUPPORTED_EVENTS.has('checkout.session.expired'),true);
  assert.equal(webhookTest.SUPPORTED_EVENTS.has('checkout.session.async_payment_succeeded'),true);
  assert.equal(webhookTest.SUPPORTED_EVENTS.has('checkout.session.async_payment_failed'),true);
  assert.equal(webhookTest.unixTimestamp(1_800_000_000),'2027-01-15T08:00:00.000Z');
  assert.equal(webhookTest.errorCode({message:'unknown_stripe_price'}),'unknown_stripe_price');
  assert.equal(webhookTest.errorCode({message:'secret value: leaked'}),'webhook_processing_failed');
});

test('a completed subscription Checkout without a subscription id is retried, never acknowledged as activated',async()=>{
  const source=await readFile(new URL('../api/billing-webhook.mjs',import.meta.url),'utf8');
  const completed=source.slice(source.indexOf("if(event.type==='checkout.session.completed'||"),source.indexOf("if(event.type.startsWith('customer.subscription.'))"));
  assert.match(completed,/const subscriptionId=stripeId\(object\.subscription,'sub'\);\s*if\(!subscriptionId\)throw Object\.assign\(new Error\('checkout_subscription_missing'\)/);
  assert.doesNotMatch(completed,/if\(subscriptionId\)await fetchAndSyncSubscription/);
});

test('migration serializes Checkout and OTP without resetting active failed attempts',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/001_client_portal.sql',import.meta.url),'utf8');
  assert.match(sql,/create table if not exists public\.billing_checkout_intents/);
  assert.match(sql,/create unique index if not exists subscriptions_one_live_per_user_idx/);
  assert.match(sql,/create or replace function public\.begin_billing_checkout\(/);
  assert.match(sql,/perform pg_advisory_xact_lock\(hashtextextended\(p_user_id::text, 42062\)\)/);
  assert.match(sql,/create or replace function public\.attach_billing_checkout_session\(/);
  assert.match(sql,/create or replace function public\.record_billing_checkout_event\(/);
  assert.match(sql,/p_status not in \('completed', 'expired', 'failed'\)/);
  assert.match(sql,/not \(status = 'completed' and p_status = 'expired'\)/);
  assert.match(sql,/subscription_reconciliation_required/);
  assert.match(sql,/current_intent\.lease_expires_at > now\(\)[\s\S]*creating_other_offer/);
  assert.match(sql,/set status = 'failed', updated_at = now\(\)[\s\S]*new_intent_id := gen_random_uuid\(\)/);
  assert.match(sql,/perform pg_advisory_xact_lock\(hashtextextended\(p_email_hash, 42061\)\)/);
  assert.match(sql,/interval '60 seconds'/);
  assert.match(sql,/set mode = p_mode, requested_at = now\(\)\s+where email_hash = p_email_hash/);
  assert.match(sql,/grant execute on function public\.begin_billing_checkout\([^;]+\) to service_role/);
});

test('migration fixes RLS, service-only billing RPCs and generation credit transitions',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/001_client_portal.sql',import.meta.url),'utf8');
  assert.match(sql,/\('essential', 'Essentiel', 10, 999, 7428, 'EUR'\)/);
  assert.match(sql,/alter table public\.generation_attempts enable row level security/);
  assert.match(sql,/grant execute on function public\.claim_billing_event\([^;]+\) to service_role/);
  for(const name of ['reserve_generation_credit','mark_generation_request_started','release_generation_credit','finish_generation_attempt'])
    assert.match(sql,new RegExp(`create or replace function public\\.${name}\\(`));
  const reserve=sql.slice(sql.indexOf('create or replace function public.reserve_generation_credit'),sql.indexOf('create or replace function public.mark_generation_request_started'));
  assert.match(reserve,/status = 'reserved'[\s\S]*credit_state = 'reserved'[\s\S]*request_started_at is null/);
  assert.match(reserve,/updated_at <= now\(\) - interval '30 minutes'/);
  assert.match(reserve,/for update[\s\S]*reserved_generations = greatest\(0, reserved_generations - 1\)[\s\S]*failure_code = 'reservation_ttl_expired'/);
  assert.match(reserve,/ttl_seconds', 1800/);
});

test('generation releases only the winning pre-Muse reservation',async()=>{
  const source=await readFile(new URL('../api/generate.mjs',import.meta.url),'utf8');
  assert.match(source,/reservationAttempted=true;[\s\S]*reserveAttempt\(context\)/);
  assert.match(source,/reservationAttempted&&reservationOwned&&!requestStarted&&context/);
  assert.match(source,/release_generation_credit[^\n]+p_execution_id:executionId/);
  assert.doesNotMatch(source,/reservationAttempted&&!requestStarted&&authorizationId/);
});

test('client JSON routes share one Vercel function on the Hobby deployment',async()=>{
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  const routed=[...routerTest.ROUTES.keys()];
  assert.equal(routed.length,11);
  for(const route of routed)assert.ok(config.rewrites.some(rewrite=>rewrite.source===`/api/${route}`&&rewrite.destination===`/api/router?route=${route}`));
  const directFunctions=['billing-webhook','catalogue','generate','history','hotspots-retry','hotspots','router','upload'];
  assert.equal(directFunctions.length,8);assert.ok(directFunctions.length<=12);
});
