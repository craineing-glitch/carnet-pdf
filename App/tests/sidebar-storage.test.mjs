import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../server/store.mjs';
import { createServer } from '../server/server.mjs';
import { temporaryDirectory, textPdf } from './fixtures.mjs';

async function fixture(t) {
  const dir=await temporaryDirectory('sidebar-storage-');
  const store=await openStore(dir);
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  const add=async name=>(await store.importDocument(textPdf(name),{name})).documents.at(-1).id;
  return {dir,store,add};
}

test('sort preference persists and rejects invalid or direct order settings without changing the library',async t=>{
  const {dir,store}=await fixture(t);
  assert.equal(store.getLibrary().settings.librarySort,'newest');
  assert.deepEqual(store.getLibrary().settings.documentOrder,[]);
  for(const librarySort of ['oldest','name-asc','name-desc','manual','newest']) {
    const result=await store.patchSettings({librarySort});
    assert.equal(result.settings.librarySort,librarySort);
  }
  await store.patchSettings({librarySort:'name-asc'});
  const before=store.getLibrary();
  for(const patch of [{librarySort:'invalid'},{librarySort:null},{librarySort:[]},{documentOrder:[]}]) await assert.rejects(store.patchSettings(patch),error=>error.status===400);
  assert.deepEqual(store.getLibrary(),before);
  await store.close();
  const reopened=await openStore(dir);
  try {assert.deepEqual(reopened.getLibrary(),before);} finally {await reopened.close();}
});

test('old libraries acquire safe sorting defaults and malformed persisted order is not overwritten',async t=>{
  const {dir,store,add}=await fixture(t);
  const id=await add('Existing.pdf');
  const original=store.getLibrary();
  await store.close();
  delete original.settings.librarySort;delete original.settings.documentOrder;
  await writeFile(path.join(dir,'library.json'),JSON.stringify(original));
  const old=await openStore(dir);
  try {assert.equal(old.getLibrary().settings.librarySort,'newest');assert.deepEqual(old.getLibrary().settings.documentOrder,[]);}
  finally {await old.close();}
  for(const settings of [{librarySort:'oops',documentOrder:[]},{librarySort:'manual',documentOrder:[id,id]},{librarySort:'manual',documentOrder:['../escape']},{librarySort:'manual',documentOrder:'all'}]) {
    const malformed=JSON.stringify({...original,settings:{...original.settings,...settings}});
    await writeFile(path.join(dir,'library.json'),malformed);
    await assert.rejects(openStore(dir),error=>error.status===500);
    assert.equal(await readFile(path.join(dir,'library.json'),'utf8'),malformed);
  }
});

test('manual reorder starts from selected sorting, preserves new imports and persists across restart',async t=>{
  const {dir,store,add}=await fixture(t);
  const ten=await add('Paper 10.pdf'),two=await add('Paper 2.pdf'),one=await add('Paper 1.pdf');
  await store.patchSettings({librarySort:'name-asc'});
  let result=await store.reorderDocument({id:ten,beforeId:two});
  assert.equal(result.settings.librarySort,'manual');
  assert.deepEqual(result.settings.documentOrder,[one,ten,two]);
  const fresh=await add('New.pdf');
  result=await store.reorderDocument({id:ten,beforeId:''});
  assert.deepEqual(result.settings.documentOrder,[fresh,one,two,ten]);
  result=await store.reorderDocument({id:two,beforeId:fresh});
  assert.deepEqual(result.settings.documentOrder,[two,fresh,one,ten]);
  await store.close();
  const reopened=await openStore(dir);
  try {assert.deepEqual(reopened.getLibrary(),result);} finally {await reopened.close();}
});

test('reordering rejects missing, trashed and favorite documents without altering order or metadata',async t=>{
  const {store,add}=await fixture(t);
  const first=await add('First.pdf'),second=await add('Second.pdf');
  const review=(await store.collectReview(first,{pages:[1]})).documents.at(-1).id;
  await store.trashDocument(second);
  const before=store.getLibrary();
  for(const value of [{id:first,beforeId:second},{id:second,beforeId:first},{id:review,beforeId:first},{id:first,beforeId:review},{id:'missing',beforeId:first},{id:first,beforeId:'missing'},{id:first},{id:first,beforeId:'',extra:true},null]) {
    await assert.rejects(store.reorderDocument(value));
    assert.deepEqual(store.getLibrary(),before);
  }
  await store.reorderDocument({id:first,beforeId:''});
  await store.trashDocument(first);
  assert.deepEqual(store.getLibrary().settings.documentOrder,[]);
  await store.restoreDocument(first);
  assert.deepEqual((await store.reorderDocument({id:first,beforeId:''})).settings.documentOrder,[first]);
});

test('emptying trash deletes only the confirmed snapshot and protects restored, active and newly trashed PDFs',async t=>{
  const {dir,store,add}=await fixture(t);
  const remove=await add('Remove.pdf'),restored=await add('Restored.pdf'),later=await add('Later.pdf'),active=await add('Active.pdf');
  await store.trashDocument(remove);await store.trashDocument(restored);
  const confirmed=[remove,restored];
  await store.restoreDocument(restored);await store.trashDocument(later);
  const result=await store.emptyTrash({ids:[...confirmed,active]});
  assert.deepEqual(result.documents.map(doc=>doc.id),[restored,later,active]);
  assert.equal(result.documents[0].deletedAt,undefined);
  assert.ok(result.documents[1].deletedAt);
  assert.equal(result.documents[2].deletedAt,undefined);
  const files=await readdir(path.join(dir,'pdfs'));
  assert.ok(!files.includes(`${remove}.pdf`));
  for(const id of [restored,later,active]) assert.ok(files.includes(`${id}.pdf`));
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'library.json.bak'),'utf8')),result);
  assert.deepEqual(await store.emptyTrash({ids:confirmed}),result,'repeating an old snapshot is harmless');
  await store.close();
  const reopened=await openStore(dir);
  try {assert.deepEqual(reopened.getLibrary(),result);} finally {await reopened.close();}
});

test('malformed trash snapshots are rejected without deleting files',async t=>{
  const {store,add}=await fixture(t);const id=await add('Keep.pdf');await store.trashDocument(id);
  const before=store.getLibrary();
  for(const value of [null,{},[],{ids:null},{ids:'all'},{ids:['../escape']},{ids:[id,id]},{ids:[id],all:true}]) {
    await assert.rejects(store.emptyTrash(value),error=>error.status===400);
    assert.deepEqual(store.getLibrary(),before);
    assert.deepEqual(await readFile(store.filePath(id)),textPdf('Keep.pdf'));
  }
  assert.deepEqual(await store.emptyTrash({ids:[]}),before);
});

test('batch staging failure restores earlier PDFs and retains every catalog entry',async t=>{
  const {dir,store,add}=await fixture(t);
  const first=await add('First.pdf'),second=await add('Second.pdf');
  await store.trashDocument(first);await store.trashDocument(second);
  const before=store.getLibrary(),firstPath=store.filePath(first),secondPath=store.filePath(second);
  const original=await readFile(path.join(dir,'library.json'));
  await mkdir(secondPath+'.deleting');
  await assert.rejects(store.emptyTrash({ids:[first,second]}));
  assert.deepEqual(store.getLibrary(),before);
  assert.deepEqual(await readFile(path.join(dir,'library.json')),original);
  assert.deepEqual(await readFile(firstPath),textPdf('First.pdf'));
  assert.deepEqual(await readFile(secondPath),textPdf('Second.pdf'));
  assert.ok(!(await readdir(path.join(dir,'pdfs'))).includes(`${first}.pdf.deleting`));
  await rm(secondPath+'.deleting',{recursive:true});
  assert.deepEqual((await store.emptyTrash({ids:[first,second]})).documents,[]);
});

test('batch catalog failure restores both staged PDFs and exact previous backup on Windows',{skip:process.platform!=='win32'},async t=>{
  const {dir,store,add}=await fixture(t);
  const first=await add('First.pdf'),second=await add('Second.pdf');
  await store.trashDocument(first);await store.trashDocument(second);
  const before=store.getLibrary(),catalog=path.join(dir,'library.json'),backup=path.join(dir,'library.json.bak');
  const original=await readFile(catalog),oldBackup=await readFile(backup);
  await chmod(catalog,0o444);
  try {
    await assert.rejects(store.emptyTrash({ids:[first,second]}));
    assert.deepEqual(store.getLibrary(),before);
    assert.deepEqual(await readFile(catalog),original);assert.deepEqual(await readFile(backup),oldBackup);
    assert.deepEqual(await readFile(store.filePath(first)),textPdf('First.pdf'));
    assert.deepEqual(await readFile(store.filePath(second)),textPdf('Second.pdf'));
  } finally {await chmod(catalog,0o666);}
});

test('HTTP sort, reorder and trash snapshot routes require authorization and return complete updated libraries',async t=>{
  const root=await temporaryDirectory('sidebar-api-');
  const server=await createServer({root,dataDir:path.join(root,'data')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
  const headers={'x-carnet-token':token,origin:base,'content-type':'application/json'};
  const call=(route,method,value)=>fetch(base+route,{method,headers,body:JSON.stringify(value)});
  const imported=await fetch(base+'/api/documents',{method:'POST',headers:{...headers,'x-file-name':'Test.pdf'},body:textPdf()});
  const id=(await imported.json()).documents[0].id;
  for(const [route,method] of [['/api/documents/reorder','POST'],['/api/trash','DELETE']]) assert.equal((await fetch(base+route,{method,body:'{}'})).status,403);
  let response=await call('/api/settings','PATCH',{librarySort:'oldest'});
  assert.equal(response.status,200);assert.equal((await response.json()).settings.librarySort,'oldest');
  response=await call('/api/documents/reorder','POST',{id,beforeId:''});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).settings.documentOrder,[id]);
  assert.equal((await call('/api/trash','DELETE',{ids:['bad']})).status,400);
  await call(`/api/documents/${id}`,'DELETE');
  response=await call('/api/trash','DELETE',{ids:[id]});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).documents,[]);
  assert.equal((await fetch(`${base}/api/documents/${id}/file`)).status,404);
});
