import assert from 'node:assert/strict';
import test from 'node:test';
import {storageBoxConfiguration,storageProvider,verifyMediaSignature,__test} from '../api/_storage.mjs';
import {mediaAccessAllowed} from '../api/media.mjs';

test('storage provider is explicit and otherwise keeps the legacy backend',()=>{
  assert.equal(storageProvider({OBJECT_STORAGE_PROVIDER:'hetzner-storage-box'}),'hetzner-storage-box');
  assert.equal(storageProvider({BLOB_READ_WRITE_TOKEN:'legacy'}),'vercel-blob');
  assert.throws(()=>storageProvider({OBJECT_STORAGE_PROVIDER:'unknown'}),error=>error.code==='invalid_storage_provider');
});

test('Storage Box configuration requires an isolated HTTPS subaccount',()=>{
  const env={OBJECT_STORAGE_PROVIDER:'hetzner-storage-box',STORAGE_BOX_ENDPOINT:'https://u640183-sub1.your-storagebox.de',
    STORAGE_BOX_USERNAME:'u640183-sub1',STORAGE_BOX_PASSWORD:'a-secure-password-value'};
  assert.deepEqual(storageBoxConfiguration(env),{endpoint:env.STORAGE_BOX_ENDPOINT,username:env.STORAGE_BOX_USERNAME,password:env.STORAGE_BOX_PASSWORD});
  assert.throws(()=>storageBoxConfiguration({...env,STORAGE_BOX_ENDPOINT:'http://u640183-sub1.your-storagebox.de'}),error=>error.code==='invalid_storage_box_configuration');
  assert.throws(()=>storageBoxConfiguration({...env,STORAGE_BOX_USERNAME:'u640183'}),error=>error.code==='invalid_storage_box_configuration');
});

test('private object paths reject traversal and infer safe media types',()=>{
  assert.equal(__test.validPath('runs/run-12345678.json'),'runs/run-12345678.json');
  for(const value of ['', '/absolute', '../secret', 'runs/../secret', 'runs//secret'])assert.throws(()=>__test.validPath(value),/invalide/);
  assert.equal(__test.contentType('results/run-1.png','application/octet-stream'),'image/png');
  assert.equal(__test.contentType('runs/run-1.json'),'application/json');
});

test('signed media links are scoped to provider and expire within 24 hours',()=>{
  const now=1_800_000_000,env={OBJECT_STORAGE_PROVIDER:'hetzner-storage-box',MEDIA_URL_SIGNING_SECRET:'x'.repeat(32)};
  const expires=now+3600,signature=__test.mediaSignature('results/run-12345678.png',expires,env);
  assert.equal(verifyMediaSignature('results/run-12345678.png',expires,signature,{now,env}),true);
  assert.equal(verifyMediaSignature('results/run-other.png',expires,signature,{now,env}),false);
  assert.equal(verifyMediaSignature('../private',expires,signature,{now,env}),false);
  assert.equal(verifyMediaSignature('results/run-12345678.png',now+24*60*60+61,signature,{now,env}),false);
});

test('private media also accepts the authenticated same-origin session',()=>{
  const now=1_800_000_000,env={OBJECT_STORAGE_PROVIDER:'hetzner-storage-box',MEDIA_URL_SIGNING_SECRET:'x'.repeat(32)};
  assert.equal(mediaAccessAllowed('results/run-12345678.png',now-60,'invalid',{isAuthenticated:false,now,env}),false);
  assert.equal(mediaAccessAllowed('results/run-12345678.png',now-60,'invalid',{isAuthenticated:true,now,env}),true);
});
