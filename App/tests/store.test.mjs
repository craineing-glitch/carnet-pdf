import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory, textPdf } from './fixtures.mjs';

const implementation = await import('../server/store.mjs').catch(() => ({}));
async function fixture(t) {
  assert.equal(typeof implementation.openStore, 'function', 'storage implementation is available');
  const dir = await temporaryDirectory('store-');
  const store = await implementation.openStore(dir);
  // Windows can briefly retain a directory entry after its last file is unlinked.
  t.after(async () => { await store.close(); await rm(dir, {recursive:true, force:true, maxRetries:5, retryDelay:60}); });
  return {store, dir};
}

test('imports raw PDF and preserves metadata and highlights across restart', async t => {
  const {store, dir} = await fixture(t);
  const initial = store.getLibrary();
  assert.deepEqual(initial.categories, [{id:'fr',name:'法语'},{id:'en',name:'英语'}]);
  assert.equal(initial.settings.theme, 'mediterranean');
  let lib = await store.importDocument(textPdf(), {name:'Français.pdf',categoryId:'fr'});
  const doc = lib.documents[0];
  assert.match(doc.importedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(doc.size, textPdf().length);
  assert.deepEqual(await readFile(store.filePath(doc.id)), textPdf());
  await store.addHighlight(doc.id,{page:1,text:'Bonjour',rects:[[72,700,130,720]],color:'#ffe066'});
  await store.patchDocument(doc.id,{name:'Lecture.pdf',categoryId:'en',lastPage:2});
  await store.patchSettings({theme:'paris'});
  const before = store.getLibrary();
  await store.close();
  const reopened = await implementation.openStore(dir);
  try {
    assert.deepEqual(reopened.getLibrary(), before);
    assert.equal(before.documents[0].highlights[0].text,'Bonjour');
  } finally { await reopened.close(); }
});

test('serializes concurrent modifications without losing imports, categories or highlights', async t => {
  const {store} = await fixture(t);
  await Promise.all(Array.from({length:12},(_,i) => store.importDocument(textPdf(),{name:`Book ${i}.pdf`,categoryId:'fr'})));
  assert.equal(store.getLibrary().documents.length,12);
  const id=store.getLibrary().documents[0].id;
  await Promise.all([store.addCategory('中文'),store.patchDocument(id,{name:'Renamed.pdf'}),store.addHighlight(id,{page:1,text:'hello',rects:[[1,2,3,4]],color:'#ffe066'})]);
  const lib=store.getLibrary();
  assert.equal(lib.categories.length,3);
  assert.equal(lib.documents[0].name,'Renamed.pdf');
  assert.equal(lib.documents[0].highlights.length,1);
  const hid=lib.documents[0].highlights[0].id;
  await store.removeHighlight(id,hid);
  assert.equal(store.getLibrary().documents[0].highlights.length,0);
});

test('imports without a selected category stay unclassified and survive restart', async t => {
  const {store, dir} = await fixture(t);
  const library = await store.importDocument(textPdf(), {name:'Unclassified.pdf'});
  const doc = library.documents[0];
  assert.equal(doc.categoryId, '');
  await store.patchDocument(doc.id, {categoryId:'en'});
  await store.patchDocument(doc.id, {categoryId:''});
  await store.patchSettings({theme:'shinchan'});
  await store.close();
  const reopened = await implementation.openStore(dir);
  try {
    assert.equal(reopened.getLibrary().documents[0].categoryId, '');
    assert.equal(reopened.getLibrary().settings.theme, 'shinchan');
    assert.deepEqual(await readFile(reopened.filePath(doc.id)), textPdf());
  } finally { await reopened.close(); }
});

test('rejects invalid files, names, categories and highlight geometry without changing revision', async t => {
  const {store} = await fixture(t);
  for (const name of ['', '   ', '../escape.pdf', 'x\\escape.pdf', 'x\u0000.pdf']) {
    await assert.rejects(store.importDocument(textPdf(),{name,categoryId:'fr'}));
  }
  await assert.rejects(store.importDocument(Buffer.from('not pdf'),{name:'Bad.pdf',categoryId:'fr'}));
  await assert.rejects(store.importDocument(textPdf(),{name:'Good.pdf',categoryId:'missing'}));
  await assert.rejects(store.addCategory('法语'));
  const lib=await store.importDocument(textPdf(),{name:'Good.pdf',categoryId:'en'});
  const id=lib.documents[0].id;
  for(const rects of [[], [[NaN,0,3,4]], [[0,0,Infinity,3]], [[0,1,0,2]], [[0,3,2,1]], [[0,0,1e12,3]]]) {
    await assert.rejects(store.addHighlight(id,{page:1,text:'x',rects,color:'#ffe066'}));
  }
  await assert.rejects(store.patchDocument(id,{lastPage:0}));
  await assert.rejects(store.patchDocument(id,{categoryId:'missing'}));
  await assert.rejects(store.patchSettings({theme:'../secret'}));
  assert.equal(store.getLibrary().revision,lib.revision);
});

test('blocks simultaneous stores and refuses to reset corrupt metadata',async t => {
  const {store, dir} = await fixture(t);
  await assert.rejects(implementation.openStore(dir),/已在使用|locked/i);
  await store.close();
  const corrupt='{broken';
  await writeFile(path.join(dir,'library.json'),corrupt);
  await assert.rejects(implementation.openStore(dir),/损坏|corrupt/i);
  assert.equal(await readFile(path.join(dir,'library.json'),'utf8'),corrupt);
});

test('failed disk commits do not mutate in-memory library or claim success',async t => {
  const {store, dir} = await fixture(t);
  const before=store.getLibrary();
  await rm(path.join(dir,'library.json'));
  await mkdir(path.join(dir,'library.json'));
  await assert.rejects(store.addCategory('中文'));
  assert.deepEqual(store.getLibrary(),before);
});

test('missing catalog with existing PDF files never silently creates an empty library',async t=>{
  const {store,dir}=await fixture(t);
  await store.importDocument(textPdf(),{name:'Keep.pdf',categoryId:'fr'});
  await store.close();
  await rm(path.join(dir,'library.json'));
  await rm(path.join(dir,'library.json.bak'));
  await assert.rejects(implementation.openStore(dir),/缺失|missing/i);
});

test('an oversized PDF is rejected without creating a document',async t=>{
  const {store}=await fixture(t);
  const oversized=Buffer.allocUnsafe(implementation.MAX_PDF_BYTES+1);oversized.write('%PDF-1.4');
  await assert.rejects(store.importDocument(oversized,{name:'Huge.pdf',categoryId:'fr'}),error=>error.status===413);
  assert.equal(store.getLibrary().documents.length,0);
});

test('maintains a readable previous catalog backup and rejects malformed persisted schema',async t=>{
  const {store,dir}=await fixture(t);
  const before=await store.importDocument(textPdf(),{name:'Keep.pdf',categoryId:'fr'});
  await store.addCategory('中文');
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'library.json.bak'),'utf8')),before);
  await store.close();
  await writeFile(path.join(dir,'library.json'),JSON.stringify({...before,documents:[{...before.documents[0],id:'../../escape'}]}));
  await assert.rejects(implementation.openStore(dir),/损坏|corrupt/i);
});

test('concurrent stale lock recovery allows exactly one owner without deleting its live lock',async t=>{
  const dir=await temporaryDirectory('stale-lock-');
  t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:60}));
  await writeFile(path.join(dir,'.lock'),JSON.stringify({pid:2147483647,nonce:'stale'}));
  const results=await Promise.allSettled(Array.from({length:16},()=>implementation.openStore(dir)));
  const winners=results.filter(result=>result.status==='fulfilled');
  try {
    assert.equal(winners.length,1);
    const lock=JSON.parse(await readFile(path.join(dir,'.lock'),'utf8'));
    assert.equal(lock.pid,process.pid);
    assert.notEqual(lock.nonce,'stale');
    await assert.rejects(implementation.openStore(dir),/已在使用|locked/i);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir,'.lock'),'utf8')),lock);
  } finally {await Promise.all(winners.map(result=>result.value.close()));}
});

test('loads legacy catalog without rewriting it and persists migrated bookmarks on the next mutation',async t=>{
  const dir=await temporaryDirectory('legacy-bookmarks-');
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const id='11111111-1111-4111-8111-111111111111';
  const highlight={id:'22222222-2222-4222-8222-222222222222',page:1,text:'Bonjour',rects:[[72,700,130,720]],color:'#ffe066'};
  const pdf=textPdf();
  const legacy={schema:1,revision:9,categories:[{id:'fr',name:'法语'}],documents:[{id,name:'Saved.pdf',categoryId:'fr',importedAt:'2026-10-09T12:00:00.000Z',size:pdf.length,lastPage:1,highlights:[highlight]}],settings:{theme:'forest',paper:'warm'}};
  const raw=JSON.stringify(legacy,null,2);
  await mkdir(path.join(dir,'pdfs'));
  await writeFile(path.join(dir,'pdfs',`${id}.pdf`),pdf);
  await writeFile(path.join(dir,'library.json'),raw);
  const store=await implementation.openStore(dir);
  t.after(()=>store.close());
  const loaded=store.getLibrary();
  assert.deepEqual(loaded.documents[0].bookmarks,[]);
  assert.deepEqual(loaded.documents[0].highlights,[highlight]);
  assert.equal(loaded.settings.theme,'rose-dusk');
  assert.equal(loaded.settings.paper,'warm');
  assert.equal(await readFile(path.join(dir,'library.json'),'utf8'),raw);
  await store.addBookmark(id,{page:1});
  const saved=JSON.parse(await readFile(path.join(dir,'library.json'),'utf8'));
  assert.equal(saved.documents[0].bookmarks[0].label,'第 1 页');
  assert.deepEqual(saved.documents[0].highlights,[highlight]);
  assert.deepEqual(await readFile(store.filePath(id)),pdf);
  assert.equal(saved.settings.paper,'warm');
  assert.equal(await readFile(path.join(dir,'library.json.bak'),'utf8'),raw);
});

test('bookmarks survive reopening and duplicate pages retain their original bookmark',async t=>{
  const {store,dir}=await fixture(t);
  let lib=await store.importDocument(textPdf(),{name:'Saved.pdf',categoryId:'fr'});
  const id=lib.documents[0].id;
  lib=await store.addBookmark(id,{page:1,label:'  First lesson  '});
  const bookmark=lib.documents[0].bookmarks[0];
  assert.equal(bookmark.label,'First lesson');
  assert.equal(bookmark.page,1);
  assert.match(bookmark.id,/^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(bookmark.createdAt)));
  const revision=lib.revision;
  lib=await store.addBookmark(id,{page:1,label:'Duplicate'});
  assert.deepEqual(lib.documents[0].bookmarks,[bookmark]);
  assert.equal(lib.revision,revision);
  await store.close();
  const reopened=await implementation.openStore(dir);
  try {
    assert.deepEqual(reopened.getLibrary().documents[0].bookmarks,[bookmark]);
    const removed=await reopened.removeBookmark(id,bookmark.id);
    assert.deepEqual(removed.documents[0].bookmarks,[]);
    assert.deepEqual(removed.documents[0].highlights,[]);
    assert.deepEqual(await readFile(reopened.filePath(id)),textPdf());
  } finally {await reopened.close();}
});

test('invalid bookmark and highlight color updates leave saved library untouched',async t=>{
  const {store}=await fixture(t);
  const imported=await store.importDocument(textPdf(),{name:'Saved.pdf',categoryId:'fr'});
  const id=imported.documents[0].id;
  const added=await store.addHighlight(id,{page:1,text:'Bonjour',rects:[[1,2,3,4]],color:'#ffe066'});
  const hid=added.documents[0].highlights[0].id;
  for(const value of [null,[],{}, {page:0},{page:1.5},{page:'1'},{page:1,label:''},{page:1,label:'x'.repeat(201)},{page:1,label:3},{page:1,label:'bad\u0000'}]) {
    await assert.rejects(store.addBookmark(id,value),error=>error.status===400);
  }
  for(const patch of [{},{color:'red'},{color:'#abc'},{color:['#aabbcc']},{color:'#aabbcc',text:'changed'}]) {
    await assert.rejects(store.patchHighlight(id,hid,patch),error=>error.status===400);
  }
  await assert.rejects(store.patchHighlight(id,'missing',{color:'#aabbcc'}),error=>error.status===404);
  await assert.rejects(store.removeBookmark(id,'missing'),error=>error.status===404);
  await assert.rejects(store.addBookmark('missing',{page:1}),error=>error.status===404);
  await assert.rejects(store.patchSettings({theme:'forest'}),error=>error.status===400);
  assert.deepEqual(store.getLibrary(),added);
});

test('concurrent bookmark additions and highlight recoloring persist without losing either',async t=>{
  const {store,dir}=await fixture(t);
  const imported=await store.importDocument(textPdf(),{name:'Saved.pdf',categoryId:'fr'});
  const id=imported.documents[0].id;
  const added=await store.addHighlight(id,{page:1,text:'Bonjour',rects:[[1,2,3,4]],color:'#ffe066'});
  const highlight=added.documents[0].highlights[0];
  await Promise.all([store.patchHighlight(id,highlight.id,{color:'#AABBCC'}),store.addBookmark(id,{page:1}),store.addBookmark(id,{page:1}),store.addBookmark(id,{page:2})]);
  const saved=store.getLibrary();
  assert.deepEqual(saved.documents[0].highlights,[{...highlight,color:'#AABBCC'}]);
  assert.deepEqual(saved.documents[0].bookmarks.map(b=>b.page),[1,2]);
  await store.close();
  const reopened=await implementation.openStore(dir);
  try {assert.deepEqual(reopened.getLibrary(),saved);} finally {await reopened.close();}
});
