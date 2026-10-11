import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { temporaryDirectory,textPdf } from './fixtures.mjs';

const implementation=await import('../server/server.mjs').catch(() => ({}));
async function fixture(t) {
  assert.equal(typeof implementation.createServer,'function','HTTP implementation is available');
  const root=await temporaryDirectory('server-');
  await mkdir(path.join(root,'src'),{recursive:true});
  await mkdir(path.join(root,'public/vendor/pdfjs'),{recursive:true});
  await mkdir(path.join(root,'public/vendor/raindrop-fx'),{recursive:true});
  await writeFile(path.join(root,'index.html'),'<html>Reader</html>');
  await writeFile(path.join(root,'src/app.js'),'export const app = true;');
  await writeFile(path.join(root,'public/vendor/pdfjs/pdf.mjs'),'export const pdf = true;');
  await writeFile(path.join(root,'public/vendor/raindrop-fx/raindrop-fx.js'),'export default class Rain {}');
  const dataDir=path.join(root,'data');
  const server=await implementation.createServer({root,dataDir});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  const session=await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.app,'carnet-pdf-reader');
  const token=session.token;
  const headers={'x-carnet-token':token,origin:base};
  return {server,base,headers,root,dataDir};
}

test('HTTP API imports, reads, changes and persists PDF library',async t=>{
  const {base,headers}=await fixture(t);
  const response=await fetch(`${base}/api/documents`,{method:'POST',headers:{...headers,'x-file-name':encodeURIComponent('法语.pdf'),'x-category-id':'fr'},body:textPdf()});
  assert.equal(response.status,201);
  const lib=await response.json();
  const id=lib.documents[0].id;
  let file=await fetch(`${base}/api/documents/${id}/file`);
  assert.equal(file.headers.get('content-type'),'application/pdf');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()),textPdf());
  file=await fetch(`${base}/api/documents/${id}/file?download`,{method:'HEAD'});
  assert.equal(file.status,200);
  assert.match(file.headers.get('content-disposition'),/^attachment;/);
  assert.equal(file.headers.get('content-length'),String(textPdf().length));
  file=await fetch(`${base}/api/documents/${id}/file`,{headers:{Range:'bytes=0-7'}});
  assert.equal(file.status,206);
  assert.equal((await file.arrayBuffer()).byteLength,8);
  let update=await fetch(`${base}/api/documents/${id}`,{method:'PATCH',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({name:'Revised',lastPage:1})});
  assert.equal((await update.json()).documents[0].name,'Revised');
  const renamedDownload=await fetch(`${base}/api/documents/${id}/file?download`,{method:'HEAD'});
  assert.match(renamedDownload.headers.get('content-disposition'),/filename\*=UTF-8''Revised\.pdf$/);
  update=await fetch(`${base}/api/documents/${id}/highlights`,{method:'POST',headers,body:JSON.stringify({page:1,text:'Bonjour',rects:[[1,2,3,4]],color:'#ffe066'})});
  const highlight=(await update.json()).documents[0].highlights[0];
  const deletion=await fetch(`${base}/api/documents/${id}/highlights/${highlight.id}`,{method:'DELETE',headers});
  assert.equal((await deletion.json()).documents[0].highlights.length,0);
  assert.equal((await (await fetch(`${base}/api/library`)).json()).schema,1);
});

test('requires token and local origin, rejects unknown host and exposes only static allowlist',async t=>{
  const {base,headers,root}=await fixture(t);
  await writeFile(path.join(root,'secret.txt'),'secret');
  for(const bad of [{},{...headers,'x-carnet-token':'bad'},{...headers,origin:'https://evil.example'},{...headers,'sec-fetch-site':'cross-site'}]) {
    const response=await fetch(`${base}/api/categories`,{method:'POST',headers:bad,body:'{"name":"中文"}'});
    assert.equal(response.status,403);
  }
  for(const route of ['/secret.txt','/data/library.json','/server/server.mjs','/assets/../data/library.json','/src/%2e%2e%2fsecret.txt','/vendor/raindrop-fx/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.txt']) assert.equal((await fetch(base+route)).status,404);
  for(const route of ['/','/src/app.js','/vendor/pdfjs/pdf.mjs','/vendor/raindrop-fx/raindrop-fx.js']) assert.equal((await fetch(base+route)).status,200,route);
  const hostResponse=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/library',{headers:{host:'evil.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});
  assert.equal(hostResponse,403);
});

test('returns errors for malformed mutation and oversized bodies and releases data lock on close',async t=>{
  const {base,headers,server,root,dataDir}=await fixture(t);
  let response=await fetch(base+'/api/categories',{method:'POST',headers,body:'{oops'});
  assert.equal(response.status,400);
  assert.equal(typeof (await response.json()).error,'string');
  response=await fetch(base+'/api/categories',{method:'POST',headers,body:'x'.repeat(300000)});
  assert.equal(response.status,413);
  await new Promise(resolve=>server.close(resolve));
  const second=await implementation.createServer({root,dataDir});
  await new Promise(resolve=>second.close(resolve));
});

test('rejects oversized PDF before consuming the upload',async t=>{
  const {base,headers}=await fixture(t);
  const status=await new Promise((resolve,reject)=>{
    const request=http.request(base+'/api/documents',{method:'POST',headers:{...headers,'x-file-name':'huge.pdf','x-category-id':'fr','content-length':1024*1024*1024+1}},response=>{response.resume();response.on('end',()=>{request.destroy();resolve(response.statusCode);});});
    request.on('error',reject);request.end();
  });
  assert.equal(status,413);
  assert.equal((await (await fetch(base+'/api/library')).json()).documents.length,0);
});

test('never serves data even when data directory override falls inside a static directory',async t=>{
  assert.equal(typeof implementation.createServer,'function');
  const root=await temporaryDirectory('hidden-data-');
  const server=await implementation.createServer({root,dataDir:path.join(root,'src','private')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/src/private/library.json`)).status,404);
});

test('shutdown requires token and flushes queued disk changes before releasing lock',async t=>{
  const {base,headers,root,dataDir}=await fixture(t);
  assert.equal((await fetch(base+'/api/shutdown',{method:'POST'})).status,403);
  const change=await fetch(base+'/api/categories',{method:'POST',headers,body:JSON.stringify({name:'中文'})});
  assert.equal(change.status,201);
  const response=await fetch(base+'/api/shutdown',{method:'POST',headers});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true});
  const second=await implementation.createServer({root,dataDir});
  await new Promise(resolve=>second.close(resolve));
});

test('bookmark and highlight color API mutations return the latest persisted library',async t=>{
  const {base,headers,server,root,dataDir}=await fixture(t);
  const imported=await fetch(base+'/api/documents',{method:'POST',headers:{...headers,'x-file-name':'Saved.pdf','x-category-id':'fr'},body:textPdf()});
  const id=(await imported.json()).documents[0].id;
  const endpoint=base+`/api/documents/${id}`;
  const added=await fetch(endpoint+'/highlights',{method:'POST',headers,body:JSON.stringify({page:1,text:'Bonjour',rects:[[1,2,3,4]],color:'#ffe066'})});
  const highlight=(await added.json()).documents[0].highlights[0];
  const responses=await Promise.all([
    fetch(endpoint+'/bookmarks',{method:'POST',headers,body:JSON.stringify({page:1})}),
    fetch(endpoint+`/highlights/${highlight.id}`,{method:'PATCH',headers,body:JSON.stringify({color:'#aabbcc'})}),
  ]);
  assert.deepEqual(responses.map(r=>r.status),[201,200]);
  const bookmark=(await responses[0].json()).documents[0].bookmarks[0];
  assert.equal(bookmark.label,'第 1 页');
  const duplicate=await fetch(endpoint+'/bookmarks',{method:'POST',headers,body:JSON.stringify({page:1,label:'Duplicate'})});
  assert.equal(duplicate.status,201);
  assert.deepEqual((await duplicate.json()).documents[0].bookmarks,[bookmark]);
  assert.equal((await fetch(endpoint+'/bookmarks',{method:'POST',body:'{"page":1}'})).status,403);
  assert.equal((await fetch(endpoint+'/bookmarks',{method:'POST',headers,body:'{"page":0}'})).status,400);
  assert.equal((await fetch(endpoint+`/highlights/${highlight.id}`,{method:'PATCH',headers,body:'{"color":"red"}'})).status,400);
  await new Promise(resolve=>server.close(resolve));
  const reopened=await implementation.createServer({root,dataDir});
  reopened.listen(0,'127.0.0.1');await once(reopened,'listening');
  try {
    const nextBase=`http://127.0.0.1:${reopened.address().port}`;
    const saved=await (await fetch(nextBase+'/api/library')).json();
    assert.deepEqual(saved.documents[0].bookmarks,[bookmark]);
    assert.deepEqual(saved.documents[0].highlights,[{...highlight,color:'#aabbcc'}]);
    const token=(await (await fetch(nextBase+'/api/session')).json()).token;
    const removed=await fetch(nextBase+`/api/documents/${id}/bookmarks/${bookmark.id}`,{method:'DELETE',headers:{'x-carnet-token':token}});
    assert.equal(removed.status,200);
    assert.deepEqual((await removed.json()).documents[0].bookmarks,[]);
    assert.equal((await fetch(nextBase+`/api/documents/${id}/bookmarks/${bookmark.id}`,{method:'DELETE',headers:{'x-carnet-token':token}})).status,404);
    assert.deepEqual(Buffer.from(await (await fetch(nextBase+`/api/documents/${id}/file`)).arrayBuffer()),textPdf());
  } finally {await new Promise(resolve=>reopened.close(resolve));}
});
