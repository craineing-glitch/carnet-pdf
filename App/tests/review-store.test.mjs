import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { openStore } from '../server/store.mjs';
import { createServer } from '../server/server.mjs';
import { extractPdfPages } from '../server/pdf-extract.mjs';
import { temporaryDirectory } from './fixtures.mjs';

// Independent PDF fixture: extraction is checked with PDF.js, not pdf-lib.
function newspaperPdf() {
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for(let page=1;page<=3;page++) {
    const stream=`BT /F1 18 Tf 72 600 Td (Report number ${page}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${page===3?'/CropBox [20 30 590 760] /Rotate 90':''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length+2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let content='%PDF-1.4\n';const offsets=[];
  for(const [index,obj] of objects.entries()) {offsets.push(Buffer.byteLength(content));content+=`${index+1} 0 obj\n${obj}\nendobj\n`;}
  const start=Buffer.byteLength(content);
  content+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(content);
}
async function fixture(t) {
  const dir=await temporaryDirectory('review-store-');const store=await openStore(dir);
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  const source=(await store.importDocument(newspaperPdf(),{name:'Newspaper.pdf',categoryId:'fr'})).documents[0];
  return {dir,store,source};
}
async function readPdf(bytes) {
  const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:true});
  try {
    const pdf=await task.promise;const pages=[];
    for(let page=1;page<=pdf.numPages;page++) {
      const item=await pdf.getPage(page);pages.push({text:(await item.getTextContent()).items.map(i=>i.str).join(' '),rotation:item.rotate,box:item.view});
    }
    return pages;
  } finally {await task.destroy();}
}

test('review extraction stores selected pages in original order, preserves geometry, and remaps independent marks',async t=>{
  const {store,source}=await fixture(t);
  assert.equal(typeof store.collectReview,'function','review collection is implemented');
  await store.addHighlight(source.id,{page:3,text:'Report number 3',rects:[[72,598,210,620]],color:'#ff88aa',note:'Keep this report'});
  await store.addHighlight(source.id,{page:2,text:'Report number 2',rects:[[72,598,210,620]],color:'#ffe066'});
  await store.addBookmark(source.id,{page:3,label:'Science'});
  await store.addBookmark(source.id,{page:2,label:'Not selected'});
  const original=store.getLibrary().documents[0];
  const library=await store.collectReview(source.id,{pages:[3,1,3],name:'  Science review  '});
  const review=library.documents.find(doc=>doc.review);
  assert.equal(review.name,'Science review');assert.equal(review.categoryId,'');assert.equal(review.lastPage,1);
  assert.deepEqual(review.review,{sourceId:source.id,sourceName:source.name,pages:[1,3],collectedAt:review.importedAt});
  assert.ok(Number.isFinite(Date.parse(review.review.collectedAt)));
  assert.deepEqual(await readPdf(await readFile(store.filePath(review.id))),[
    {text:'Report number 1',rotation:0,box:[0,0,612,792]},
    {text:'Report number 3',rotation:90,box:[20,30,590,760]},
  ]);
  assert.equal(review.highlights.length,1);assert.equal(review.bookmarks.length,1);
  assert.deepEqual(review.highlights[0],{...original.highlights[0],id:review.highlights[0].id,page:2});
  assert.notEqual(review.highlights[0].id,original.highlights[0].id);
  assert.deepEqual(review.bookmarks[0],{...original.bookmarks[0],id:review.bookmarks[0].id,page:2});
  assert.notEqual(review.bookmarks[0].id,original.bookmarks[0].id);
  await store.patchHighlight(review.id,review.highlights[0].id,{note:'Independent note'});
  assert.deepEqual(store.getLibrary().documents[0],original);
  assert.deepEqual(await readFile(store.filePath(source.id)),newspaperPdf());
});

test('review names default to time and independent review survives source deletion, trash, rename and restart',async t=>{
  const {store,dir,source}=await fixture(t);
  assert.equal(typeof store.collectReview,'function');
  const review=(await store.collectReview(source.id,{pages:[2],name:'  '})).documents.at(-1);
  assert.match(review.name,/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/);
  await assert.rejects(store.patchDocument(review.id,{categoryId:'fr'}),error=>error.status===400);
  await assert.rejects(store.collectReview(review.id,{pages:[1]}),error=>error.status===409);
  await store.patchDocument(review.id,{name:'Tax report',lastPage:1});
  await store.trashDocument(source.id);await store.permanentlyDeleteDocument(source.id);
  await store.trashDocument(review.id);await store.restoreDocument(review.id);
  const before=store.getLibrary();await store.close();
  const reopened=await openStore(dir);
  try {
    assert.deepEqual(reopened.getLibrary(),before);
    assert.equal(before.documents.length,1);assert.equal(before.documents[0].name,'Tax report');
    assert.equal(before.documents[0].review.sourceName,'Newspaper.pdf');
    assert.equal((await readPdf(await readFile(reopened.filePath(review.id))))[0].text,'Report number 2');
  } finally {await reopened.close();}
});

test('invalid selections, encrypted or damaged source leave the catalog and PDF files unchanged',async t=>{
  const {store,dir,source}=await fixture(t);
  assert.equal(typeof store.collectReview,'function');
  const before=store.getLibrary();const files=await readdir(path.join(dir,'pdfs'));
  for(const value of [null,[],{}, {pages:[]},{pages:'1'},{pages:[0]},{pages:[1.5]},{pages:[4]},{pages:[1,'2']},{pages:[1],name:3},{pages:[1],name:'../unsafe'},{pages:[1],unknown:true}]) {
    await assert.rejects(store.collectReview(source.id,value),error=>error.status===400);
    assert.deepEqual(store.getLibrary(),before);assert.deepEqual(await readdir(path.join(dir,'pdfs')),files);
  }
  await assert.rejects(store.collectReview('missing',{pages:[1]}),error=>error.status===404);
  await store.trashDocument(source.id);
  await assert.rejects(store.collectReview(source.id,{pages:[1]}),error=>error.status===409);
  const corrupt=(await store.importDocument(Buffer.from('%PDF-damaged'),{name:'Broken.pdf'})).documents.at(-1);
  await assert.rejects(store.collectReview(corrupt.id,{pages:[1]}),error=>error.status===400);
  const protectedBytes=await readFile(new URL('./pdfs/password-protected.pdf',import.meta.url));
  const encrypted=(await store.importDocument(protectedBytes,{name:'Protected.pdf'})).documents.at(-1);
  const expected=store.getLibrary();const expectedFiles=await readdir(path.join(dir,'pdfs'));
  await assert.rejects(store.collectReview(encrypted.id,{pages:[1]}),error=>error.status===400 && /密码|加密/.test(error.message));
  assert.deepEqual(store.getLibrary(),expected);assert.deepEqual(await readdir(path.join(dir,'pdfs')),expectedFiles);
});

test('failed review catalog commit rolls back generated bytes and the following mutation can succeed',async t=>{
  const {store,dir,source}=await fixture(t);
  assert.equal(typeof store.collectReview,'function');
  const before=store.getLibrary();const originalBytes=await readFile(store.filePath(source.id));
  await rename(path.join(dir,'library.json'),path.join(dir,'saved-library.json'));await mkdir(path.join(dir,'library.json'));
  await assert.rejects(store.collectReview(source.id,{pages:[1,3]}));
  assert.deepEqual(store.getLibrary(),before);assert.deepEqual(await readdir(path.join(dir,'pdfs')),[`${source.id}.pdf`]);
  assert.deepEqual(await readFile(store.filePath(source.id)),originalBytes);
  await rm(path.join(dir,'library.json'),{recursive:true});await rename(path.join(dir,'saved-library.json'),path.join(dir,'library.json'));
  const collected=await store.collectReview(source.id,{pages:[3]});assert.equal(collected.documents.length,2);
});

test('extraction timeout terminates its worker without holding the file or breaking subsequent collection',async t=>{
  const {store,source}=await fixture(t);
  const before=store.getLibrary();
  await assert.rejects(extractPdfPages(store.filePath(source.id),[1],{timeoutMs:1}),error=>error.status===503 && /耗时/.test(error.message));
  assert.deepEqual(store.getLibrary(),before);
  const collected=await store.collectReview(source.id,{pages:[2]});
  assert.equal((await readPdf(await readFile(store.filePath(collected.documents.at(-1).id))))[0].text,'Report number 2');
});

test('concurrent review collection serializes with source edits and permanent deletion',async t=>{
  const {store,source}=await fixture(t);
  const first=store.collectReview(source.id,{pages:[1],name:'First'});
  const rename=store.patchDocument(source.id,{name:'Changed newspaper'});
  const second=store.collectReview(source.id,{pages:[3],name:'Second'});
  const trash=store.trashDocument(source.id);
  const deletion=store.permanentlyDeleteDocument(source.id);
  await Promise.all([first,rename,second,trash,deletion]);
  const reviews=store.getLibrary().documents;
  assert.equal(reviews.length,2);assert.equal(reviews[0].review.sourceName,'Newspaper.pdf');assert.equal(reviews[1].review.sourceName,'Changed newspaper');
  assert.equal((await readPdf(await readFile(store.filePath(reviews[0].id))))[0].text,'Report number 1');
  assert.equal((await readPdf(await readFile(store.filePath(reviews[1].id))))[0].text,'Report number 3');
});

test('review HTTP API requires credentials, validates pages, downloads an independent PDF and allows source deletion',async t=>{
  const root=await temporaryDirectory('review-api-');const server=await createServer({root,dataDir:path.join(root,'data')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  const base=`http://127.0.0.1:${server.address().port}`;const {token}=await(await fetch(base+'/api/session')).json();
  const headers={'x-carnet-token':token,origin:base};
  const imported=await fetch(base+'/api/documents',{method:'POST',headers:{...headers,'x-file-name':'Newspaper.pdf'},body:newspaperPdf()});
  const source=(await imported.json()).documents[0];const endpoint=base+`/api/documents/${source.id}/review`;
  assert.equal((await fetch(endpoint,{method:'POST',body:'{"pages":[1]}'})).status,403);
  assert.equal((await fetch(endpoint,{method:'POST',headers,body:'{"pages":[4]}'})).status,400);
  const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({pages:[3,1],name:'My report'})});
  assert.equal(response.status,201);const review=(await response.json()).documents.at(-1);
  await fetch(base+`/api/documents/${source.id}`,{method:'DELETE',headers});await fetch(base+`/api/documents/${source.id}/permanent`,{method:'DELETE',headers});
  const downloaded=await fetch(base+`/api/documents/${review.id}/file?download`);
  assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-disposition'),/My%20report.pdf/);
  assert.deepEqual((await readPdf(new Uint8Array(await downloaded.arrayBuffer()))).map(item=>item.text),['Report number 1','Report number 3']);
});

test('opening an older library does not rewrite it and malformed review metadata is refused',async t=>{
  const {store,dir}=await fixture(t);await store.close();
  const file=path.join(dir,'library.json');const raw=await readFile(file,'utf8');const reopened=await openStore(dir);
  try {assert.equal(await readFile(file,'utf8'),raw);assert.equal(reopened.getLibrary().documents[0].review,undefined);} finally {await reopened.close();}
  const valid={sourceId:'11111111-1111-4111-8111-111111111111',sourceName:'Newspaper.pdf',pages:[1,3],collectedAt:new Date().toISOString()};
  for(const review of [null,{}, {...valid,sourceId:'../bad'},{...valid,sourceId:'------------------------------------'}, {...valid,pages:[3,1]}, {...valid,pages:[1,1]}, {...valid,pages:[0]}, {...valid,pages:[1.5]}, {...valid,pages:[]}, {...valid,sourceName:'../bad.pdf'}, {...valid,sourceName:3}, {...valid,collectedAt:'bad'}, {...valid,extra:true}]) {
    const library=JSON.parse(raw);library.documents[0].categoryId='';library.documents[0].review=review;
    await writeFile(file,JSON.stringify(library));
    await assert.rejects(openStore(dir),/损坏|corrupt/i);
  }
});
