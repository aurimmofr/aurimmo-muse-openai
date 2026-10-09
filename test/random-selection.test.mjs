import assert from 'node:assert/strict';
import test from 'node:test';
import {secureRandomIndex,selectProductsByRole} from '../public/random-selection.mjs';

const catalogue=[
  {catalog_id:'SOFA_A',role:'sofa'},{catalog_id:'SOFA_B',role:'sofa'},{catalog_id:'SOFA_OLD',role:'sofa',selection_status:'historical_run_only'},
  {catalog_id:'RUG_A',role:'rug'},{catalog_id:'RUG_B',role:'rug'},
];

test('a fresh random composition changes each role when alternatives exist',()=>{
  const previous=[catalogue[0],catalogue[3]];
  const selection=selectProductsByRole({catalogue,roles:['sofa','rug'],currentSelection:previous,avoidSelection:previous,randomize:true,pickIndex:()=>0});
  assert.deepEqual(selection.map(product=>product.catalog_id),['SOFA_B','RUG_B']);
});

test('manual choices stay pinned while other roles are randomly refreshed',()=>{
  const previous=[catalogue[0],catalogue[3]];
  const selection=selectProductsByRole({catalogue,roles:['sofa','rug'],forcedByRole:{sofa:'SOFA_A'},avoidSelection:previous,randomize:true,pickIndex:()=>0});
  assert.deepEqual(selection.map(product=>product.catalog_id),['SOFA_A','RUG_B']);
});

test('historical-only references are never selected for a new composition',()=>{
  const values=new Set();
  for(let index=0;index<20;index++)values.add(selectProductsByRole({catalogue,roles:['sofa'],randomize:true,pickIndex:length=>index%length})[0].catalog_id);
  assert.deepEqual([...values].sort(),['SOFA_A','SOFA_B']);
  assert.equal(values.has('SOFA_OLD'),false);
});

test('the browser cryptographic sampler always returns a valid index',()=>{
  for(const length of [1,2,3,17,4192])for(let attempt=0;attempt<100;attempt++){const index=secureRandomIndex(length);assert.ok(index>=0&&index<length);}
});
