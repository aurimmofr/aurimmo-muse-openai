import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PORTAL_PLANS,subscriptionBlocksCheckout} from '../public/portal-plans.mjs';

const publicUrl=new URL('../public/',import.meta.url);
const readPublic=name=>readFile(new URL(name,publicUrl),'utf8');

async function pageAndLocalScripts(pageName){
  const html=await readPublic(pageName);
  const scriptNames=[...html.matchAll(/<script\b[^>]*\bsrc=["']\/([^"']+)["'][^>]*>/gi)].map(match=>match[1]).filter(name=>!name.includes('://'));
  const scripts=await Promise.all(scriptNames.map(readPublic));
  return {html,scripts,source:[html,...scripts].join('\n')};
}

test('the client catalogue exposes exactly the two approved plans and prices',()=>{
  assert.deepEqual(PORTAL_PLANS.map(plan=>plan.code),['essential','pro']);
  assert.equal(new Set(PORTAL_PLANS.map(plan=>plan.code)).size,2);

  const essential=PORTAL_PLANS[0];
  assert.equal(essential.name,'Essentiel');
  assert.equal(essential.images_per_month,10);
  assert.deepEqual(essential.monthly,{amount_cents:999,display_monthly_cents:999});
  assert.deepEqual(essential.yearly,{amount_cents:7428,display_monthly_cents:619});
  assert.equal(essential.recommended,false);

  const pro=PORTAL_PLANS[1];
  assert.equal(pro.name,'Pro');
  assert.equal(pro.images_per_month,100);
  assert.deepEqual(pro.monthly,{amount_cents:3999,display_monthly_cents:3999});
  assert.deepEqual(pro.yearly,{amount_cents:29988,display_monthly_cents:2499});
  assert.equal(pro.recommended,true);
  assert.equal(pro.badge,'Le plus choisi');
});

test('both plans keep the approved common service contract without a hidden trial',()=>{
  for(const plan of PORTAL_PLANS){
    assert.deepEqual(plan.features,{
      rooms_per_project:1,
      source:'one_photo',
      catalogue_library:true,
      styles_library:true,
      furniture_library:true,
      finishes_library:true,
      download_retention_hours:24,
      credits_rollover:false,
      trial:false
    });
  }
});

test('terminal subscriptions can subscribe again while current or pending subscriptions stay protected',()=>{
  const now=Date.parse('2026-10-12T12:00:00.000Z');
  assert.equal(subscriptionBlocksCheckout(null,now),false);
  assert.equal(subscriptionBlocksCheckout({status:'canceled'},now),false);
  assert.equal(subscriptionBlocksCheckout({status:'incomplete_expired'},now),false);
  assert.equal(subscriptionBlocksCheckout({status:'active',periodStart:'2026-10-01T00:00:00Z',periodEnd:'2026-11-01T00:00:00Z'},now),true);
  assert.equal(subscriptionBlocksCheckout({status:'active',periodStart:'2026-09-01T00:00:00Z',periodEnd:'2026-10-01T00:00:00Z'},now),false);
  assert.equal(subscriptionBlocksCheckout({status:'active',periodStart:'',periodEnd:''},now),false);
  for(const status of ['incomplete','trialing','past_due','unpaid','paused'])assert.equal(subscriptionBlocksCheckout({status},now),true);
});

test('the public portal exposes signup, onboarding, dashboard and subscription navigation',async()=>{
  const {html,source}=await pageAndLocalScripts('portal.html');
  for(const marker of [
    'data-auth-intent="register"',
    'id="email-form"',
    'id="code-form"',
    'id="onboarding-form"',
    'id="onboarding-project-name"',
    'id="plans-grid"',
    'data-dashboard-target="overview"',
    'data-dashboard-target="projects"',
    'data-dashboard-target="history"',
    'data-dashboard-target="billing"',
    'data-dashboard-target="account"',
    'id="billing-portal-button"',
    'href="/studio.html"'
  ])assert.ok(html.includes(marker),`Missing portal hook: ${marker}`);
  assert.match(source,/PORTAL_PLANS|portal-plans\.mjs/);
});

test('the root redirect preserves Supabase magic-link query and fragment tokens',async()=>{
  const [index,redirect]=await Promise.all([readPublic('index.html'),readPublic('index-redirect.js')]);
  assert.match(index,/src="\/index-redirect\.js"/);
  assert.doesNotMatch(index,/http-equiv="refresh"/i);
  assert.match(redirect,/\/portal\.html\$\{location\.search\}\$\{location\.hash\}/);
});

test('the portal exposes only the currently supported salon room type',async()=>{
  const html=await readPublic('portal.html');
  for(const id of ['onboarding-room-type','new-project-room']) {
    const select=html.match(new RegExp(`<select id="${id}"[\\s\\S]*?<\\/select>`))?.[0]||'';
    assert.match(select,/<option value="living_room">Salon<\/option>/);
    assert.equal((select.match(/<option\b/g)||[]).length,1);
    assert.doesNotMatch(select,/bedroom|office|dining_room|other/);
  }
});

test('checkout confirmation is polled before the portal returns to the studio',async()=>{
  const source=await readPublic('portal.js');
  assert.match(source,/async function waitForGenerationEntitlement\(\)/);
  assert.match(source,/data\?\.can_generate === true/);
  assert.match(source,/const activated = await waitForGenerationEntitlement\(\)/);
  assert.match(source,/activated && state\.returnTo\.startsWith\('\/studio\.html'\)/);
  assert.match(source,/activation des crédits n’est pas encore confirmée/);
});

test('an abandoned Checkout can be replaced without creating a concurrent subscription',async()=>{
  const source=await readPublic('portal.js');
  assert.match(source,/cancelled-checkout-session/);
  assert.match(source,/rememberCancelledCheckout\(result\.checkout_session_id\)/);
  assert.match(source,/rememberCancelledCheckout\(query\.get\('session_id'\) \|\| state\.cancelledCheckoutSessionId\)/);
  assert.match(source,/replace_checkout_session_id: state\.cancelledCheckoutSessionId/);
});

test('private image links honor the approved 24-hour download window',async()=>{
  const [sharedData,generation]=await Promise.all([
    readFile(new URL('../api/_data.mjs',import.meta.url),'utf8'),
    readFile(new URL('../api/generate.mjs',import.meta.url),'utf8'),
  ]);
  assert.match(sharedData,/Date\.now\(\)\+24\*60\*60\*1000/);
  assert.match(generation,/Date\.now\(\)\+24\*60\*60\*1000/);
});

test('admin login uses the whitelisted local return path',async()=>{
  const portal=await readPublic('portal.js');
  const admin=await readPublic('admin.html');
  const adminScript=await readPublic('admin.js');
  assert.match(portal,/\['\/studio\.html', '\/admin\.html'\]\.includes/);
  assert.match(admin,/\/portal\.html\?view=login&amp;return_to=%2Fadmin\.html/);
  assert.match(adminScript,/\/portal\.html\?view=login&return_to=%2Fadmin\.html/);
  assert.doesNotMatch(admin+adminScript,/\?next=%2Fadmin\.html/);
});

test('the client portal and Muse studio contain no OpenAI or ChatGPT product copy',async()=>{
  const portal=await readPublic('portal.html');
  const studio=await readPublic('studio.html');
  assert.doesNotMatch(portal,/\b(?:OpenAI|ChatGPT)\b/i);
  assert.doesNotMatch(studio,/\b(?:OpenAI|ChatGPT)\b/i);
  assert.match(studio,/Muse/i);
});

test('the Muse studio preserves photo, catalogue, random selection and hotspot hooks',async()=>{
  const {html,source}=await pageAndLocalScripts('studio.html');
  for(const marker of [
    'id="camera-file"',
    'id="room-file"',
    'id="programme-cards"',
    'id="product-hotspot-layer"',
    'id="product-hotspot-toggle"',
    'id="product-hotspot-refresh"',
    'id="catalogue-explorer-details"',
    'id="catalogue-explorer-products"'
  ])assert.ok(html.includes(marker),`Missing studio hook: ${marker}`);
  for(const contract of [
    /\/api\/catalogue/,
    /\/api\/hotspots(?:\?|['"`])/,
    /\/api\/hotspots-retry/,
    /prepareRandomSelection/,
    /renderCatalogueExplorer/
  ])assert.match(source,contract);
});
