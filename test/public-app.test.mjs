import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { __test } from '../api/generate.mjs';
import {__test as hotspotDispatchTest,dispatchHotspotWorker,preflightHotspotWorker} from '../api/_hotspot-dispatch.mjs';
import { referencedPrivatePaths,validPrivatePath } from '../api/delete.mjs';

const catalogue=JSON.parse(await readFile(new URL('../public/catalogue.json',import.meta.url),'utf8'));

test('public catalogue contains the complete eligible Salon/Japandi library',()=>{
  assert.equal(catalogue.schema_version,'aurimmo.public.catalogue.v2');
  assert.equal(catalogue.active_total,4192);
  assert.equal(catalogue.historical_run_only_total,2);
  assert.equal(catalogue.products.length,4194);
  assert.equal(catalogue.total,catalogue.products.length);
  assert.equal(new Set(catalogue.products.map(product=>product.catalog_id)).size,catalogue.products.length);
  const roles=new Set(catalogue.products.map(product=>product.role));
  for(const role of ['sofa','armchair','coffee_table','rug','floor_lamp','tv_unit','dining_table','dining_chair','floor_finish','wall_finish','bookcase','side_table','mirror','plant'])assert.ok(roles.has(role),role);
  for(const product of catalogue.products){
    assert.match(product.catalog_id,/^[a-zA-Z0-9_-]+$/);
    assert.ok(['interieur-ia.aurimmo.fr','m.media-amazon.com'].includes(new URL(product.image_url).hostname));
    assert.ok(!Object.hasOwn(product,'raw_values'));
  }
});

test('exact frozen selection fingerprint is deterministic and ignores transport metadata',()=>{
  const products=[catalogue.products.find(x=>x.role==='sofa'),catalogue.products.find(x=>x.role==='rug'),catalogue.products.find(x=>x.role==='floor_lamp')];
  const body={program:'living_conversation',include_tv:false,surfaces:{floor:'preserve',walls:'preserve'}};
  const first=__test.sha(__test.canonicalSelection(body,products));
  const second=__test.sha(__test.canonicalSelection({...body,project_id:'11111111-1111-4111-8111-111111111111',provider:'muse'},products));
  assert.equal(first,second);
  assert.match(first,/^[a-f0-9]{64}$/);
});

test('Muse generation validation requires client scope, one explicit confirmation and an exact selection',()=>{
  process.env.GENERATION_ENABLED='true';
  const products=['sofa','armchair','coffee_table','rug','floor_lamp','decorative_object'].map(role=>catalogue.products.find(x=>x.role===role&&x.selection_status!=='historical_run_only'));
  const index=new Map(products.map(product=>[product.catalog_id,product]));
  const base={provider:'muse',project_id:'11111111-1111-4111-8111-111111111111',source_asset_id:'22222222-2222-4222-8222-222222222222',program:'living_conversation',include_tv:false,surfaces:{floor:'preserve',walls:'preserve'},room_path:'uploads/photo.jpg',width:1200,height:800,
    product_ids:products.map(x=>x.catalog_id),authorization_id:'11111111-1111-4111-8111-111111111111',confirm_paid_generation:true};
  base.selection_fingerprint=__test.sha(__test.canonicalSelection(base,products));
  assert.deepEqual(__test.validateBody(base,index),products);
  assert.throws(()=>__test.validateBody({...base,provider:'openai'},index),/Moteur Muse/);
  assert.throws(()=>__test.validateBody({...base,project_id:'not-a-project'},index),/Projet ou photo client/);
  assert.throws(()=>__test.validateBody({...base,confirm_paid_generation:false},index),/Confirmation payante/);
  assert.throws(()=>__test.validateBody({...base,selection_fingerprint:'0'.repeat(64)},index),/sélection figée/);
  const incomplete={...base,product_ids:base.product_ids.slice(0,-1)};incomplete.selection_fingerprint=__test.sha(__test.canonicalSelection(incomplete,products.slice(0,-1)));
  assert.throws(()=>__test.validateBody(incomplete,index),/rôles catalogue/);
});

test('prompt protects source architecture, fixed elements and merchant backgrounds',()=>{
  const products=[catalogue.products.find(x=>x.role==='sofa'),catalogue.products.find(x=>x.role==='rug'),catalogue.products.find(x=>x.role==='floor_lamp')];
  const prompt=__test.promptFor({program:'living_conversation',include_tv:false,surfaces:{floor:'preserve',walls:'replace'}},products);
  assert.match(prompt,/architecture/);
  assert.match(prompt,/poêle/);
  assert.match(prompt,/décors marchands/);
  assert.match(prompt,/Ne créer aucune télévision/);
  assert.match(prompt,/référence wall_finish/);
});

test('public source never contains local secrets or paid result data',async()=>{
  const files=['../public/index.html','../public/portal.html','../public/studio.html','../public/app.js','../api/generate.mjs','../README.md'];
  for(const relative of files){const text=await readFile(new URL(relative,import.meta.url),'utf8');assert.doesNotMatch(text,/sk-[A-Za-z0-9_-]{20,}|BFL_API_KEY=/);}
  const [index,indexRedirect,portal,studio,app]=await Promise.all([
    readFile(new URL('../public/index.html',import.meta.url),'utf8'),
    readFile(new URL('../public/index-redirect.js',import.meta.url),'utf8'),
    readFile(new URL('../public/portal.html',import.meta.url),'utf8'),
    readFile(new URL('../public/studio.html',import.meta.url),'utf8'),
    readFile(new URL('../public/app.js',import.meta.url),'utf8'),
  ]);
  assert.match(index,/src="\/index-redirect\.js"/);
  assert.match(indexRedirect,/location\.replace\(destination\)/);
  assert.match(indexRedirect,/\/portal\.html/);
  assert.match(studio,/Muse/);
  assert.doesNotMatch(`${portal}\n${studio}\n${app}`,/\b(?:OpenAI|ChatGPT)\b/i);
});

test('the authenticated studio preserves the Aurimmo photo workflow and original stylesheet',async()=>{
  const html=await readFile(new URL('../public/studio.html',import.meta.url),'utf8');
  assert.match(html,/href="\/app\.css"/);
  assert.match(html,/id="camera-file"[^>]*capture="environment"/);
  assert.match(html,/id="room-file"[^>]*type="file"[^>]*accept="image\/jpeg,image\/png,image\/webp"/);
  assert.doesNotMatch(html,/id="room-file"[^>]*capture=/);
  assert.match(html,/id="camera-button"[^>]*>[\s\S]*?Prendre une photo/);
  assert.match(html,/id="upload-button"[^>]*>[\s\S]*?Télécharger une image/);
  assert.match(html,/id="programme-cards"/);
  assert.doesNotMatch(html,/data-image-provider=/);
  assert.match(html,/Rendu Muse/);
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.ok(app.includes("$('#camera-button').addEventListener('click',()=>$('#camera-file').click());"));
  assert.ok(app.includes("$('#upload-button').addEventListener('click',()=>$('#room-file').click());"));
  assert.match(app,/camera-button[^\n]*disabled=false;[^\n]*upload-button[^\n]*disabled=false/);
  assert.match(app,/renderCatalogueExplorer/);assert.match(app,/\/api\/hotspots/);assert.match(app,/Ouvrir avec les points/);assert.match(app,/prepareRandomSelection/);assert.match(app,/Modifier ce produit/);assert.match(app,/product-hotspot-refresh/);
  assert.match(app,/project_id:state\.projectId/);assert.match(app,/source_asset_id:state\.photoAssetId/);assert.match(app,/provider:'muse'/);
  assert.match(app,/\/portal\.html\?view=\$\{encodeURIComponent\(view\)\}&return_to=/);assert.match(app,/returnToPortal\('plans'\)/);assert.match(app,/can_generate/);
});

test('private deletion is restricted to exact upload and result paths',()=>{
  assert.equal(validPrivatePath('uploads/123-photo.jpg'),true);
  assert.equal(validPrivatePath('results/run-123.png'),true);
  assert.equal(validPrivatePath('../uploads/photo.jpg'),false);
  assert.equal(validPrivatePath('runs/run.json'),false);
  assert.equal(validPrivatePath('uploads/nested/photo.jpg'),false);
  const protectedPaths=referencedPrivatePaths([{source_path:'uploads/photo.jpg',result_path:'results/run-123.png'}]);
  assert.equal(protectedPaths.has('uploads/photo.jpg'),true);assert.equal(protectedPaths.has('results/run-123.png'),true);
});

test('client APIs use Supabase identity and legacy shared-password configuration is absent',async()=>{
  const protectedSources=await Promise.all(['generate','upload','history','status'].map(name=>readFile(new URL(`../api/${name}.mjs`,import.meta.url),'utf8')));
  for(const source of protectedSources){assert.match(source,/requireIdentity/);assert.doesNotMatch(source,/requireAuth|APP_PASSWORD/);}
  const security=await readFile(new URL('../api/_security.mjs',import.meta.url),'utf8');
  const envExample=await readFile(new URL('../.env.example',import.meta.url),'utf8');
  assert.doesNotMatch(security,/checkPassword|SESSION_SECRET/);
  assert.doesNotMatch(envExample,/APP_PASSWORD|SESSION_SECRET|OPENAI_API_KEY|OPENAI_IMAGE_MODEL/);
  assert.match(envExample,/SUPABASE_URL=/);assert.match(envExample,/STRIPE_WEBHOOK_SECRET=/);assert.match(envExample,/MODEL_API_KEY=/);
});

test('every saved render can dispatch the exact hotspot workflow without exposing its token',async()=>{
  const calls=[],token='dispatch-token-value-for-test';
  const fetchImpl=async(url,options)=>{calls.push({url,options});return {status:204};};
  const runId='run-1791556528389-ecd5f826-8d46-4457-9cb3-d1280d4fe690',result=await dispatchHotspotWorker(runId,{fetchImpl,token});
  assert.deepEqual(result,{accepted:true,status:'accepted',http_status:204});
  assert.equal(calls.length,1);assert.equal(calls[0].url,`https://api.github.com/repos/${hotspotDispatchTest.REPOSITORY}/actions/workflows/${hotspotDispatchTest.WORKFLOW}/dispatches`);
  assert.deepEqual(JSON.parse(calls[0].options.body),{ref:'main',inputs:{run_id:runId}});
  assert.equal(calls[0].options.headers.Authorization,`Bearer ${token}`);assert.doesNotMatch(JSON.stringify(result),/dispatch-token/);
});

test('hotspot dispatch rejects invalid ids and preflights the active workflow before a paid render',async()=>{
  let calls=0;assert.deepEqual(await dispatchHotspotWorker('../bad',{token:'dispatch-token-value-for-test',fetchImpl:async()=>{calls++;}}),{accepted:false,status:'invalid_run_id'});assert.equal(calls,0);
  const preflight=await preflightHotspotWorker({token:'another-dispatch-token-for-test',now:1,fetchImpl:async()=>({ok:true,status:200,json:async()=>({state:'active'})})});
  assert.equal(preflight.ready,true);assert.equal(preflight.status,'active');
});

test('hosted hotspot workflow has immediate dispatch, staggered reconciliation and explicit failures',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/product-hotspots.yml',import.meta.url),'utf8');
  assert.match(workflow,/workflow_dispatch:[\s\S]*run_id:/);assert.match(workflow,/3,8,13,18,23,28,33,38,43,48,53,58/);assert.doesNotMatch(workflow,/push:[\s\S]{0,100}paths:/);
  const worker=await readFile(new URL('../scripts/hotspot-bridge.mjs',import.meta.url),'utf8');
  assert.match(worker,/hotspot-jobs/);assert.match(worker,/processing/);assert.match(worker,/failed/);assert.match(worker,/page\.hasMore/);assert.match(worker,/throw new Error\(`Repérage échoué/);
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');assert.match(app,/\/api\/hotspots-retry/);assert.match(app,/hotspotWorkerReady/);assert.match(app,/\['queued','pending','processing'\]/);
});
