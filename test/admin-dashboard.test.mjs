import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {aggregateAdminData,adminEmailsFrom,isAdminIdentity} from '../server/routes/admin-clients.mjs';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const SUB_A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUB_A_OLD='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const SUB_B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECONCILIATION='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROJECT_A='dddddddd-dddd-4ddd-8ddd-dddddddddddd';

test('la liste ADMIN_EMAILS est normalisée et fermée par défaut',()=>{
  assert.deepEqual([...adminEmailsFrom(' Admin@Aurimmo.fr,ops@example.fr\nincorrect ')],['admin@aurimmo.fr','ops@example.fr']);
  assert.equal(isAdminIdentity({user:{email:'ADMIN@AURIMMO.FR'}},'admin@aurimmo.fr'),true);
  assert.equal(isAdminIdentity({user:{email:'client@aurimmo.fr'}},'admin@aurimmo.fr'),false);
  assert.equal(isAdminIdentity({user:{email:'admin@aurimmo.fr'}},''),false);
});

test('le résumé admin agrège uniquement la période de crédits de l’abonnement actif',()=>{
  const result=aggregateAdminData({
    profiles:[
      {user_id:A,email:'Alice@Example.fr',first_name:'Alice',last_name:'Martin',company_name:'Agence A',signup_mode:'public_otp',onboarding_completed_at:'2026-10-02T10:00:00Z',created_at:'2026-10-01T10:00:00Z',updated_at:'2026-10-10T10:00:00Z'},
      {user_id:B,first_name:'Bob',last_name:'Durand',signup_mode:'public_otp',onboarding_completed_at:null,created_at:'2026-10-03T10:00:00Z',updated_at:'2026-10-03T10:00:00Z'},
    ],
    subscriptions:[
      {id:SUB_A_OLD,user_id:A,plan_code:'essential',billing_interval:'month',status:'canceled',updated_at:'2026-10-11T00:00:00Z'},
      {id:SUB_A,user_id:A,plan_code:'essential',billing_interval:'month',status:'active',current_period_start:'2026-09-30T08:15:00Z',current_period_end:'2026-10-30T08:15:00Z',updated_at:'2026-10-01T00:00:00Z'},
      {id:SUB_B,user_id:B,plan_code:'pro',billing_interval:'year',status:'past_due',updated_at:'2026-10-11T00:00:00Z'},
    ],
    usagePeriods:[
      {user_id:A,subscription_id:SUB_A,month_start:'2026-09-30T08:15:00Z',month_end:'2026-10-30T08:15:00Z',included_generations:10,reserved_generations:1,consumed_generations:2},
      {user_id:A,subscription_id:SUB_A_OLD,month_start:'2026-10-01T00:00:00Z',month_end:'2026-11-01T00:00:00Z',included_generations:10,reserved_generations:0,consumed_generations:8},
    ],
    generationAttempts:[
      {user_id:A,status:'saved',created_at:'2026-10-10T12:00:00Z',updated_at:'2026-10-10T12:00:00Z'},
      {authorization_id:RECONCILIATION,run_id:`run-${RECONCILIATION}`,user_id:A,project_id:PROJECT_A,status:'reconciliation_required',request_started_at:'2026-10-11T11:59:00Z',created_at:'2026-10-11T11:58:00Z',updated_at:'2026-10-11T12:00:00Z'},
      {user_id:B,status:'failed_before_request',created_at:'2026-10-09T12:00:00Z',updated_at:'2026-10-09T12:00:00Z'},
    ],
    projects:[
      {owner_id:A,created_at:'2026-10-02T00:00:00Z',updated_at:'2026-10-02T00:00:00Z'},
      {owner_id:A,created_at:'2026-10-04T00:00:00Z',updated_at:'2026-10-04T00:00:00Z'},
      {owner_id:B,created_at:'2026-10-03T00:00:00Z',updated_at:'2026-10-03T00:00:00Z'},
    ],
  },{now:new Date('2026-10-12T12:00:00Z')});

  assert.equal(result.as_of,'2026-10-12T12:00:00.000Z');
  assert.deepEqual(result.summary,{
    clients:2,onboarded:1,active_subscriptions:1,
    plans:{essential:1,pro:0},
    credits:{included:10,reserved:1,consumed:2,remaining:7},
    generations:{total:3,saved:1,reconciliation_required:1,request_started:0,reserved:0,failed_before_request:1,failed_after_request:0},
    projects:3,
  });
  const alice=result.clients.find(client=>client.user_id===A);
  assert.equal(alice.email,'alice@example.fr');
  assert.equal(alice.projects,2);
  assert.equal(alice.subscription.active,true);
  assert.equal('stripe_customer_id' in alice.subscription,false);
  assert.deepEqual(result.reconciliations,[{
    authorization_id:RECONCILIATION,run_id:`run-${RECONCILIATION}`,user_id:A,project_id:PROJECT_A,
    request_started_at:'2026-10-11T11:59:00.000Z',created_at:'2026-10-11T11:58:00.000Z',updated_at:'2026-10-11T12:00:00.000Z',
  }]);
});

test('le dashboard ne contient ni chiffres factices ni secrets Stripe',async()=>{
  const [html,script]=await Promise.all([
    readFile(new URL('../public/admin.html',import.meta.url),'utf8'),
    readFile(new URL('../public/admin.js',import.meta.url),'utf8'),
  ]);
  assert.match(html,/Clients et abonnements/);
  assert.match(html,/id="metric-reconciliation"/);
  assert.doesNotMatch(`${html}\n${script}`,/sk_live_|stripe_customer_id|latest_invoice_id/);
  assert.match(script,/\/api\/admin-clients/);
});
