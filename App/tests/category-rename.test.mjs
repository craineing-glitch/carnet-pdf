import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../server/store.mjs';
import { createServer } from '../server/server.mjs';
import { temporaryDirectory, textPdf } from './fixtures.mjs';

async function fixture(t) {
  const dir=await temporaryDirectory('category-rename-');
  const store=await openStore(dir);
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  return {dir,store};
}

test('renaming built-in and custom categories preserves IDs, order, active and trashed files after restart',async t=>{
  const {dir,store}=await fixture(t);
  await store.addCategory('Magazine');
  const categoryId=store.getLibrary().categories.at(-1).id;
  await store.importDocument(textPdf('Active'),{name:'Active.pdf',categoryId:'fr'});
  const deletedId=(await store.importDocument(textPdf('Trashed'),{name:'Trashed.pdf',categoryId})).documents.at(-1).id;
  await store.trashDocument(deletedId);
  const before=store.getLibrary();
  await store.patchCategory('fr',{name:'  Français  '});
  await store.patchCategory('en',{name:'English'});
  const after=await store.patchCategory(categoryId,{name:'Journal'});
  assert.deepEqual(after.categories,[{id:'fr',name:'Français'},{id:'en',name:'English'},{id:categoryId,name:'Journal'}]);
  assert.deepEqual(after.documents,before.documents);
  assert.deepEqual(await readFile(store.filePath(deletedId)),textPdf('Trashed'));
  await store.close();
  const reopened=await openStore(dir);
  try {assert.deepEqual(reopened.getLibrary(),after);} finally {await reopened.close();}
});

test('category rename validates payload, rejects duplicate names, and leaves catalog unchanged on failure',async t=>{
  const {store}=await fixture(t);
  await store.addCategory('Magazine');
  const before=store.getLibrary();
  for(const patch of [null,[],{}, {id:'en'}, {name:'Good',extra:true}, {name:null}, {name:''}, {name:'  '}, {name:'x'.repeat(201)}, {name:'a/b'}, {name:'a\\b'}, {name:'a\u0000b'}, {name:' 英语 '}, {name:'magazine'}]) {
    await assert.rejects(store.patchCategory('fr',patch),error=>error.status===400,JSON.stringify(patch));
    assert.deepEqual(store.getLibrary(),before);
  }
  await assert.rejects(store.patchCategory('missing',{name:'Missing'}),error=>error.status===404);
  assert.deepEqual(store.getLibrary(),before);
  assert.deepEqual(await store.patchCategory('fr',{name:' 法语 '}),before,'unchanged trimmed name is a no-op');
  const renamed=await store.patchCategory(before.categories.at(-1).id,{name:'MAGAZINE'});
  assert.equal(renamed.categories.at(-1).name,'MAGAZINE','case-only rename is allowed for the same category');
});

test('category rename API requires authorization and returns updated library or explicit errors',async t=>{
  const root=await temporaryDirectory('category-rename-api-');
  const server=await createServer({root,dataDir:path.join(root,'data')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const {token}=await(await fetch(base+'/api/session')).json();
  const headers={'x-carnet-token':token,origin:base,'content-type':'application/json'};
  assert.equal((await fetch(base+'/api/categories/fr',{method:'PATCH',body:JSON.stringify({name:'French'})})).status,403);
  let response=await fetch(base+'/api/categories/fr',{method:'PATCH',headers,body:JSON.stringify({name:' French '})});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).categories[0],{id:'fr',name:'French'});
  for(const [id,body,status] of [['en',{name:'french'},400],['fr',{},400],['fr',{name:123},400],['missing',{name:'New'},404]]) {
    response=await fetch(`${base}/api/categories/${id}`,{method:'PATCH',headers,body:JSON.stringify(body)});
    assert.equal(response.status,status);
    assert.equal(typeof(await response.json()).error,'string');
  }
});
