import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { __test } from '../api/generate.mjs';
import { checkPassword } from '../api/_security.mjs';

const catalogue=JSON.parse(await readFile(new URL('../public/catalogue.json',import.meta.url),'utf8'));

test('public catalogue is compact, Japandi and contains every supported role',()=>{
  assert.equal(catalogue.schema_version,'aurimmo.public.catalogue.v1');
  assert.ok(catalogue.products.length>=80&&catalogue.products.length<=120);
  const roles=new Set(catalogue.products.map(product=>product.role));
  for(const role of ['sofa','armchair','coffee_table','rug','floor_lamp','tv_unit','dining_table','dining_chair','floor_finish','wall_finish'])assert.ok(roles.has(role),role);
  for(const product of catalogue.products){
    assert.match(product.catalog_id,/^[a-zA-Z0-9_-]+$/);
    assert.equal(new URL(product.image_url).hostname,'interieur-ia.aurimmo.fr');
    assert.ok(!Object.hasOwn(product,'raw_values'));
  }
});

test('exact frozen selection fingerprint is deterministic and provider independent',()=>{
  const products=[catalogue.products.find(x=>x.role==='sofa'),catalogue.products.find(x=>x.role==='rug'),catalogue.products.find(x=>x.role==='floor_lamp')];
  const body={program:'living_conversation',include_tv:false,surfaces:{floor:'preserve',walls:'preserve'}};
  const first=__test.sha(__test.canonicalSelection(body,products));
  const second=__test.sha(__test.canonicalSelection({...body,provider:'muse'},products));
  assert.equal(first,second);
  assert.match(first,/^[a-f0-9]{64}$/);
});

test('generation validation requires one explicit confirmation and an exact selection',()=>{
  process.env.GENERATION_ENABLED='true';
  const products=[catalogue.products.find(x=>x.role==='sofa'),catalogue.products.find(x=>x.role==='rug'),catalogue.products.find(x=>x.role==='floor_lamp')];
  const index=new Map(products.map(product=>[product.catalog_id,product]));
  const base={provider:'openai',program:'living_conversation',include_tv:false,surfaces:{floor:'preserve',walls:'preserve'},room_path:'uploads/photo.jpg',width:1200,height:800,
    product_ids:products.map(x=>x.catalog_id),authorization_id:'11111111-1111-4111-8111-111111111111',confirm_paid_generation:true};
  base.selection_fingerprint=__test.sha(__test.canonicalSelection(base,products));
  assert.deepEqual(__test.validateBody(base,index),products);
  assert.throws(()=>__test.validateBody({...base,confirm_paid_generation:false},index),/Confirmation payante/);
  assert.throws(()=>__test.validateBody({...base,selection_fingerprint:'0'.repeat(64)},index),/sélection figée/);
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
  const files=['../public/index.html','../public/app.js','../api/generate.mjs','../README.md'];
  for(const relative of files){const text=await readFile(new URL(relative,import.meta.url),'utf8');assert.doesNotMatch(text,/sk-[A-Za-z0-9_-]{20,}|BFL_API_KEY=/);}
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/OpenAI Image/);assert.match(html,/Muse Image/);assert.doesNotMatch(html,/Flux 3/);
});

test('application password accepts the configured 10+ character policy',()=>{
  const previous=process.env.APP_PASSWORD;
  process.env.APP_PASSWORD='valid-pass1';
  assert.equal(checkPassword('valid-pass1'),true);
  assert.equal(checkPassword('invalid-pass'),false);
  if(previous===undefined)delete process.env.APP_PASSWORD;else process.env.APP_PASSWORD=previous;
});
