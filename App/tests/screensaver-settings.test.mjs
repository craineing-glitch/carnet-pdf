import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './fixtures.mjs';
import { openStore } from '../server/store.mjs';
import { createServer } from '../server/server.mjs';

async function fixture(t) {
  const dir=await temporaryDirectory('screensaver-settings-');
  const store=await openStore(dir);
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  return {store,dir};
}

test('new libraries default to Mediterranean with a one-minute screensaver and persist independent setting changes',async t=>{
  const {store,dir}=await fixture(t);
  assert.deepEqual(store.getLibrary().settings,{theme:'mediterranean',screensaver:{enabled:true,minutes:1},librarySort:'newest',documentOrder:[]});
  await store.patchSettings({screensaver:{enabled:false,minutes:120}});
  assert.deepEqual(store.getLibrary().settings,{theme:'mediterranean',screensaver:{enabled:false,minutes:120},librarySort:'newest',documentOrder:[]});
  await store.patchSettings({theme:'paris'});
  assert.deepEqual(store.getLibrary().settings,{theme:'paris',screensaver:{enabled:false,minutes:120},librarySort:'newest',documentOrder:[]});
  await store.patchSettings({theme:'rose-dusk',screensaver:{enabled:true,minutes:2}});
  const before=store.getLibrary();
  const raw=await readFile(path.join(dir,'library.json'),'utf8');
  await store.patchSettings({theme:'rose-dusk',screensaver:{enabled:true,minutes:2}});
  assert.deepEqual(store.getLibrary(),before,'an unchanged settings save does not create a revision');
  assert.equal(await readFile(path.join(dir,'library.json'),'utf8'),raw);
  await store.close();
  const reopened=await openStore(dir);
  try {assert.deepEqual(reopened.getLibrary(),before);} finally {await reopened.close();}
});

test('invalid screensaver settings and mixed patches leave the live catalog and disk unchanged',async t=>{
  const {store,dir}=await fixture(t);
  const before=store.getLibrary(),raw=await readFile(path.join(dir,'library.json'),'utf8');
  const invalidScreensavers=[null,[],true,'1',{}, {enabled:true},{minutes:1},
    {enabled:1,minutes:1},{enabled:'false',minutes:1},{enabled:false,minutes:'1'},
    {enabled:true,minutes:0},{enabled:true,minutes:121},{enabled:true,minutes:1.5},
    {enabled:true,minutes:NaN},{enabled:true,minutes:Infinity},
    {enabled:true,minutes:1,extra:true}];
  const invalidPatches=[null,[],{}, {unknown:true},{theme:'paris',unknown:true},
    ...invalidScreensavers.map(screensaver=>({theme:'paris',screensaver})),
    {theme:'invalid',screensaver:{enabled:false,minutes:5}}];
  for(const patch of invalidPatches) {
    await assert.rejects(store.patchSettings(patch),error=>error.status===400);
    assert.deepEqual(store.getLibrary(),before);
    assert.equal(await readFile(path.join(dir,'library.json'),'utf8'),raw);
  }
});

test('legacy libraries preserve chosen themes and stay byte-for-byte intact until a real mutation',async t=>{
  const {store,dir}=await fixture(t);
  await store.close();
  const legacy={schema:1,revision:8,categories:[{id:'fr',name:'法语'}],documents:[],settings:{theme:'rose-dusk',paper:'warm'}};
  const raw=JSON.stringify(legacy,null,2);
  await writeFile(path.join(dir,'library.json'),raw);
  const reopened=await openStore(dir);
  try {
    assert.deepEqual(reopened.getLibrary().settings,{theme:'rose-dusk',paper:'warm',screensaver:{enabled:true,minutes:1},librarySort:'newest',documentOrder:[]});
    assert.equal(reopened.getLibrary().revision,8);
    assert.equal(await readFile(path.join(dir,'library.json'),'utf8'),raw);
    await reopened.patchSettings({screensaver:{enabled:true,minutes:1}});
    assert.equal(await readFile(path.join(dir,'library.json'),'utf8'),raw);
    await reopened.addCategory('中文');
    const saved=JSON.parse(await readFile(path.join(dir,'library.json'),'utf8'));
    assert.deepEqual(saved.settings,{theme:'rose-dusk',paper:'warm',screensaver:{enabled:true,minutes:1},librarySort:'newest',documentOrder:[]});
    assert.equal(saved.revision,9);
    assert.equal(await readFile(path.join(dir,'library.json.bak'),'utf8'),raw);
  } finally {await reopened.close();}
});

test('malformed persisted screensaver settings are rejected rather than overwritten',async t=>{
  const {store,dir}=await fixture(t);
  const original=store.getLibrary();
  await store.close();
  for(const screensaver of [null,{}, {enabled:true}, {enabled:'yes',minutes:1}, {enabled:true,minutes:0}, {enabled:true,minutes:1,extra:1}]) {
    const broken={...original,settings:{theme:'shinchan',screensaver}},raw=JSON.stringify(broken);
    await writeFile(path.join(dir,'library.json'),raw);
    await assert.rejects(openStore(dir),/损坏|corrupt/i);
    assert.equal(await readFile(path.join(dir,'library.json'),'utf8'),raw);
  }
});

test('settings API requires local authentication and validates updates without changing unrelated settings',async t=>{
  const root=await temporaryDirectory('screensaver-api-');
  const dataDir=path.join(root,'data');
  await mkdir(root,{recursive:true});
  const server=await createServer({root,dataDir});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  const {token}=await (await fetch(`${base}/api/session`)).json();
  const headers={'x-carnet-token':token,origin:base,'content-type':'application/json'};
  const patch=(value,auth=headers)=>fetch(`${base}/api/settings`,{method:'PATCH',headers:auth,body:JSON.stringify(value)});
  const initial=await (await fetch(`${base}/api/library`)).json();
  for(const bad of [{},{...headers,'x-carnet-token':'bad'},{...headers,origin:'https://evil.example'},{...headers,'sec-fetch-site':'cross-site'}]) {
    assert.equal((await patch({screensaver:{enabled:false,minutes:2}},bad)).status,403);
  }
  assert.deepEqual(await (await fetch(`${base}/api/library`)).json(),initial);
  let response=await patch({screensaver:{enabled:false,minutes:5}});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).settings,{theme:'mediterranean',screensaver:{enabled:false,minutes:5},librarySort:'newest',documentOrder:[]});
  response=await patch({theme:'paris'});
  assert.equal(response.status,200);
  const before=await response.json();
  assert.deepEqual(before.settings,{theme:'paris',screensaver:{enabled:false,minutes:5},librarySort:'newest',documentOrder:[]});
  for(const invalid of [{screensaver:{enabled:true,minutes:0}},{screensaver:{enabled:false,minutes:1,extra:true}},{theme:'rose-dusk',screensaver:{enabled:'yes',minutes:1}},{other:1}]) {
    response=await patch(invalid);assert.equal(response.status,400);
    assert.equal(typeof (await response.json()).error,'string');
  }
  assert.deepEqual(await (await fetch(`${base}/api/library`)).json(),before);
  response=await patch({theme:'mediterranean',screensaver:{enabled:true,minutes:1}});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).settings,{theme:'mediterranean',screensaver:{enabled:true,minutes:1},librarySort:'newest',documentOrder:[]});
});
