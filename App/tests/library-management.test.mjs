import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../server/store.mjs';
import { createServer } from '../server/server.mjs';
import { temporaryDirectory, textPdf } from './fixtures.mjs';

async function fixture(t) {
  const dir=await temporaryDirectory('library-management-');
  const store=await openStore(dir);
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  return {dir,store};
}
const selection={page:1,text:'Bonjour',rects:[[12,20,90,40]],color:'#ffe066'};

test('trash and restore retain bytes, category, bookmarks and annotated highlights across restart',async t=>{
  const {store,dir}=await fixture(t);
  const id=(await store.importDocument(textPdf(),{name:'Keep.pdf',categoryId:'fr'})).documents[0].id;
  await store.addHighlight(id,{...selection,note:'Une remarque\n第二行'});
  await store.addBookmark(id,{page:1,label:'Retrouver'});
  await store.patchDocument(id,{lastPage:3});
  const before=store.getLibrary().documents[0];
  const trashed=await store.trashDocument(id);
  assert.ok(Number.isFinite(Date.parse(trashed.documents[0].deletedAt)));
  assert.deepEqual(await readFile(store.filePath(id)),textPdf());
  assert.deepEqual(await store.trashDocument(id),trashed,'trashing again is idempotent');
  await store.close();
  const reopened=await openStore(dir);
  try {
    assert.deepEqual(reopened.getLibrary(),trashed);
    const restored=await reopened.restoreDocument(id);
    assert.deepEqual(restored.documents[0],before);
    assert.deepEqual(await reopened.restoreDocument(id),restored,'restoring again is idempotent');
  } finally {await reopened.close();}
});

test('permanent removal requires trash and removes the PDF and all document annotations from both catalogs',async t=>{
  const {store,dir}=await fixture(t);
  const id=(await store.importDocument(textPdf(),{name:'Remove.pdf',categoryId:'en'})).documents[0].id;
  const file=store.filePath(id);
  await store.addHighlight(id,{...selection,note:'Note to remove'});
  await store.addBookmark(id,{page:1});
  await assert.rejects(store.permanentlyDeleteDocument(id),error=>error.status===409);
  assert.deepEqual(await readFile(file),textPdf());
  await store.trashDocument(id);
  const result=await store.permanentlyDeleteDocument(id);
  assert.deepEqual(result.documents,[]);
  assert.deepEqual(await readdir(path.join(dir,'pdfs')),[]);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'library.json.bak'),'utf8')).documents,[]);
  await store.close();
  const reopened=await openStore(dir);
  try {assert.deepEqual(reopened.getLibrary().documents,[]);} finally {await reopened.close();}
});

test('failed permanent deletion rolls back staged PDF before another queued mutation runs',async t=>{
  const {store,dir}=await fixture(t);
  const id=(await store.importDocument(textPdf(),{name:'Keep.pdf'})).documents[0].id;
  await store.trashDocument(id);
  const before=store.getLibrary();
  await rename(path.join(dir,'library.json'),path.join(dir,'saved-library.json'));
  await mkdir(path.join(dir,'library.json'));
  const deletion=store.permanentlyDeleteDocument(id);
  const restoration=store.restoreDocument(id);
  await assert.rejects(deletion);
  await assert.rejects(restoration);
  assert.deepEqual(store.getLibrary(),before);
  assert.deepEqual(await readFile(store.filePath(id)),textPdf());
  assert.deepEqual(await readdir(path.join(dir,'pdfs')),[`${id}.pdf`]);
  await rm(path.join(dir,'library.json'),{recursive:true});
  await rename(path.join(dir,'saved-library.json'),path.join(dir,'library.json'));
  await store.restoreDocument(id);
});

test('startup recovers interrupted permanent deletion according to the committed catalog',async t=>{
  const {store,dir}=await fixture(t);
  const id=(await store.importDocument(textPdf(),{name:'Recover.pdf'})).documents[0].id;
  const file=store.filePath(id);
  await store.trashDocument(id);
  await store.close();
  await rename(file,file+'.deleting');
  const orphan=path.join(dir,'pdfs','11111111-1111-4111-8111-111111111111.pdf.deleting');
  await writeFile(orphan,textPdf());
  const reopened=await openStore(dir);
  try {
    assert.deepEqual(await readFile(reopened.filePath(id)),textPdf());
    assert.deepEqual(await readdir(path.join(dir,'pdfs')),[`${id}.pdf`]);
  } finally {await reopened.close();}
});

test('failed primary catalog replacement restores the exact prior backup and PDF on Windows',{skip:process.platform!=='win32'},async t=>{
  const {store,dir}=await fixture(t);
  const id=(await store.importDocument(textPdf(),{name:'Keep.pdf'})).documents[0].id;
  await store.trashDocument(id);
  const before=store.getLibrary();
  const catalog=path.join(dir,'library.json'),backup=path.join(dir,'library.json.bak');
  const originalCatalog=await readFile(catalog),originalBackup=await readFile(backup);
  // Windows permits reading a read-only file but rejects replacing its entry.
  // The backup is writable, so this failure happens after its replacement.
  await chmod(catalog,0o444);
  try {
    await assert.rejects(store.permanentlyDeleteDocument(id),error=>['EPERM','EACCES'].includes(error.code));
    assert.deepEqual(store.getLibrary(),before);
    assert.deepEqual(await readFile(catalog),originalCatalog);
    assert.deepEqual(await readFile(backup),originalBackup);
    assert.deepEqual(await readFile(store.filePath(id)),textPdf());
    assert.deepEqual(await readdir(path.join(dir,'pdfs')),[`${id}.pdf`]);
  } finally {await chmod(catalog,0o666);}
});

test('deleting categories preserves active and trashed documents and allows no categories',async t=>{
  const {store,dir}=await fixture(t);
  await store.addCategory('Magazine');
  const category=store.getLibrary().categories.at(-1).id;
  await store.importDocument(textPdf('First'),{name:'First.pdf',categoryId:category});
  const id=(await store.importDocument(textPdf('Second'),{name:'Second.pdf',categoryId:category})).documents.at(-1).id;
  await store.trashDocument(id);
  const before=store.getLibrary();
  await store.removeCategory(category);
  await store.removeCategory('fr');
  const result=await store.removeCategory('en');
  assert.deepEqual(result.categories,[]);
  assert.deepEqual(result.documents,before.documents.map(doc=>({...doc,categoryId:''})));
  await assert.rejects(store.removeCategory(''),error=>error.status===404);
  await store.close();
  const reopened=await openStore(dir);
  try {assert.deepEqual(reopened.getLibrary(),result);} finally {await reopened.close();}
});

test('notes update independently, preserve quote and geometry, validate and survive restart',async t=>{
  const {store,dir}=await fixture(t);
  const id=(await store.importDocument(textPdf(),{name:'Notes.pdf'})).documents[0].id;
  const highlight=(await store.addHighlight(id,selection)).documents[0].highlights[0];
  let changed=(await store.patchHighlight(id,highlight.id,{note:'第一句\nDeuxième phrase'})).documents[0].highlights[0];
  assert.deepEqual(changed,{...highlight,note:'第一句\nDeuxième phrase'});
  changed=(await store.patchHighlight(id,highlight.id,{color:'#ffccaa'})).documents[0].highlights[0];
  assert.equal(changed.note,'第一句\nDeuxième phrase');
  await store.close();
  const reopened=await openStore(dir);
  try {
    assert.deepEqual(reopened.getLibrary().documents[0].highlights[0],changed);
    const before=reopened.getLibrary();
    for(const note of [null,3,{},'x'.repeat(10001)]) {
      await assert.rejects(reopened.patchHighlight(id,highlight.id,{note}));
      await assert.rejects(reopened.addHighlight(id,{...selection,note}));
    }
    await assert.rejects(reopened.patchHighlight(id,highlight.id,{text:'Mutated quote'}));
    assert.deepEqual(reopened.getLibrary(),before);
    const cleared=(await reopened.patchHighlight(id,highlight.id,{note:'',color:'#aabbcc'})).documents[0].highlights[0];
    assert.deepEqual(cleared,{...highlight,color:'#aabbcc'});
  } finally {await reopened.close();}
});

test('HTTP routes authorize and persist trash, restore, permanent removal, category deletion and notes',async t=>{
  const root=await temporaryDirectory('library-management-api-');
  const server=await createServer({root,dataDir:path.join(root,'data')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const {token}=await(await fetch(base+'/api/session')).json();
  const headers={'x-carnet-token':token,origin:base};
  let response=await fetch(base+'/api/documents',{method:'POST',headers:{...headers,'x-file-name':'Test.pdf','x-category-id':'fr'},body:textPdf()});
  const id=(await response.json()).documents[0].id;
  response=await fetch(`${base}/api/documents/${id}/highlights`,{method:'POST',headers,body:JSON.stringify({...selection,note:'Initial note'})});
  const highlight=(await response.json()).documents[0].highlights[0];
  assert.equal(highlight.note,'Initial note');
  response=await fetch(`${base}/api/documents/${id}/highlights/${highlight.id}`,{method:'PATCH',headers,body:JSON.stringify({note:'Edited note'})});
  assert.equal(response.status,200);
  assert.equal((await response.json()).documents[0].highlights[0].note,'Edited note');
  for(const [route,method] of [[`/api/documents/${id}`,'DELETE'],[`/api/documents/${id}/restore`,'POST'],[`/api/documents/${id}/permanent`,'DELETE'],['/api/categories/fr','DELETE']]) {
    assert.equal((await fetch(base+route,{method})).status,403);
  }
  assert.equal((await fetch(`${base}/api/documents/${id}/permanent`,{method:'DELETE',headers})).status,409);
  response=await fetch(`${base}/api/documents/${id}`,{method:'DELETE',headers});
  assert.equal(response.status,200);assert.ok((await response.json()).documents[0].deletedAt);
  assert.equal((await fetch(`${base}/api/documents/${id}/file?download`)).status,200);
  response=await fetch(base+'/api/categories/fr',{method:'DELETE',headers});
  assert.equal(response.status,200);assert.equal((await response.json()).documents[0].categoryId,'');
  response=await fetch(`${base}/api/documents/${id}/restore`,{method:'POST',headers});
  assert.equal(response.status,200);assert.equal((await response.json()).documents[0].deletedAt,undefined);
  await fetch(`${base}/api/documents/${id}`,{method:'DELETE',headers});
  response=await fetch(`${base}/api/documents/${id}/permanent`,{method:'DELETE',headers});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).documents,[]);
  assert.equal((await fetch(`${base}/api/documents/${id}/file`)).status,404);
});
