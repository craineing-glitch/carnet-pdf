import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {temporaryDirectory,textPdf} from './fixtures.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const executable=path.join(path.dirname(root),'Carnet.exe');
const stopExecutable=path.join(root,'Stop Reader.exe');
function run(args,env,cwd,file=executable) {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{env,cwd,windowsHide:true});
    let output='';
    child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);
    child.on('error',reject);child.on('exit',code=>resolve({code,output}));
  });
}

test('Windows EXE has a GUI subsystem and starts from an unrelated working directory', {timeout:45000}, async()=>{
  assert.ok(existsSync(executable),'the real Windows launcher executable exists');
  const binary=await readFile(executable);
  assert.equal(binary.toString('ascii',0,2),'MZ');
  const pe=binary.readUInt32LE(0x3c);
  assert.equal(binary.readUInt32LE(pe),0x00004550);
  assert.equal(binary.readUInt16LE(pe+24+68),2,'GUI executable never opens a console');
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const dir=await temporaryDirectory('native-launcher-');
  const env={...process.env,PORT:String(port),CARNET_PDF_DATA_DIR:dir};
  const url=`http://127.0.0.1:${port}`;
  try {
    let result=await run(['--no-open'],env,dir);assert.equal(result.code,0,result.output);
    const session=await fetch(url+'/api/session').then(response=>response.json());
    result=await run(['--no-open'],env,dir);assert.equal(result.code,0,result.output);
    assert.equal((await fetch(url+'/api/session').then(response=>response.json())).token,session.token);
    const response=await fetch(url+'/api/documents',{method:'POST',headers:{'x-carnet-token':session.token,'x-file-name':'EXE saved.pdf'},body:textPdf()});
    assert.equal(response.status,201);const library=await response.json();
    assert.equal(library.documents[0].categoryId,'');
    result=await run(['--no-open'],env,dir,stopExecutable);assert.equal(result.code,0,result.output);
    result=await run(['--no-open'],env,dir);assert.equal(result.code,0,result.output);
    assert.deepEqual(await fetch(url+'/api/library').then(response=>response.json()),library);
    assert.deepEqual(Buffer.from(await fetch(url+`/api/documents/${library.documents[0].id}/file`).then(response=>response.arrayBuffer())),textPdf());
  } finally {
    await run(['--stop','--no-open'],env,dir);
    await rm(dir,{recursive:true,force:true});
  }
});
