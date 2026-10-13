import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {openStore} from '../server/store.mjs';
import {temporaryDirectory,textPdf} from './fixtures.mjs';
async function fixture(t){
  const dir=await temporaryDirectory('stream-import-');const store=await openStore(dir);
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:60});});
  return {dir,store};
}
test('streamed PDF preserves bytes when its header is split between chunks',async t=>{
  const {store}=await fixture(t);const pdf=textPdf();
  const lib=await store.importStream(Readable.from([pdf.subarray(0,2),pdf.subarray(2,5),pdf.subarray(5)]),{name:'Stream.pdf',categoryId:'en'});
  assert.equal(lib.documents[0].size,pdf.length);
  assert.deepEqual(await readFile(store.filePath(lib.documents[0].id)),pdf);
});
test('failed and invalid uploads leave neither partial PDFs nor catalog entries',async t=>{
  const {store,dir}=await fixture(t);
  await assert.rejects(store.importStream(Readable.from([Buffer.from('invalid')]),{name:'Bad.pdf'}),/PDF/);
  async function* interrupted(){yield textPdf();throw new Error('Upload interrupted');}
  await assert.rejects(store.importStream(interrupted(),{name:'Interrupted.pdf'}),/interrupted/);
  assert.deepEqual(await readdir(path.join(dir,'pdfs')),[]);
  assert.equal(store.getLibrary().documents.length,0);
});
test('PDF larger than the old 100 MiB limit imports in bounded chunks',async t=>{
  const {store}=await fixture(t);const header=textPdf();const chunk=Buffer.alloc(1024*1024,32);chunk[0]=37;chunk[chunk.length-1]=10;
  const footer=header.subarray(header.lastIndexOf('startxref'));
  const hash=createHash('sha256');
  async function* large(){for(const bytes of [header,...Array(101).fill(chunk),footer]){hash.update(bytes);yield bytes;}}
  const lib=await store.importStream(large(),{name:'101 MiB.pdf'});
  assert.ok(lib.documents[0].size>100*1024*1024);
  const stored=await readFile(store.filePath(lib.documents[0].id));
  assert.equal(createHash('sha256').update(stored).digest('hex'),hash.digest('hex'));
});
