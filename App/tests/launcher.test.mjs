import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,rm} from 'node:fs/promises';
import {temporaryDirectory,textPdf} from './fixtures.mjs';
import {browserLaunch} from '../scripts/launch.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const browserEnv={ProgramFiles:path.join(root,'test-programs'),'ProgramFiles(x86)':path.join(root,'test-programs-x86'),LOCALAPPDATA:path.join(root,'test-local')};
test('launcher prefers Chrome over Edge and keeps its profile inside the app',async()=>{
  const chrome=path.join(browserEnv.ProgramFiles,'Google/Chrome/Application/chrome.exe');
  const edge=path.join(browserEnv['ProgramFiles(x86)'],'Microsoft/Edge/Application/msedge.exe');
  const launch=await browserLaunch(root,'http://127.0.0.1:4328',browserEnv,async candidate=>[chrome,edge].includes(candidate));
  assert.equal(launch.executable,chrome);
  assert.equal(launch.profileDirectory,path.join(root,'Files/browser-profile'));
  assert.deepEqual(launch.args,['--app=http://127.0.0.1:4328',`--user-data-dir=${launch.profileDirectory}`,'--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--disable-background-mode']);
});
test('launcher finds per-user Chrome before considering Edge',async()=>{
  const chrome=path.join(browserEnv.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe');
  const edge=path.join(browserEnv['ProgramFiles(x86)'],'Microsoft/Edge/Application/msedge.exe');
  const launch=await browserLaunch(root,'http://127.0.0.1:4328',browserEnv,async candidate=>[chrome,edge].includes(candidate));
  assert.equal(launch.executable,chrome);
});
test('launcher profile honors an isolated data directory',async()=>{
  const fakeRoot=path.join(root,'unused-app-root');
  const chrome=path.join(browserEnv.ProgramFiles,'Google/Chrome/Application/chrome.exe');
  const env={...browserEnv,CARNET_PDF_DATA_DIR:path.join(root,'isolated-launcher-data')};
  const launch=await browserLaunch(fakeRoot,'http://127.0.0.1:4328',env,async candidate=>candidate===chrome);
  assert.equal(launch.profileDirectory,path.join(env.CARNET_PDF_DATA_DIR,'browser-profile'));
  assert.ok(launch.args.includes(`--user-data-dir=${launch.profileDirectory}`));
  const relative=await browserLaunch(fakeRoot,'http://127.0.0.1:4328',{...env,CARNET_PDF_DATA_DIR:'custom-data'},async candidate=>candidate===chrome);
  assert.equal(relative.profileDirectory,path.join(fakeRoot,'custom-data/browser-profile'));
});
test('launcher falls back to an isolated Edge app or the system browser',async()=>{
  const edge=path.join(browserEnv['ProgramFiles(x86)'],'Microsoft/Edge/Application/msedge.exe');
  const launch=await browserLaunch(root,'http://127.0.0.1:4328',browserEnv,async candidate=>candidate===edge);
  assert.equal(launch.executable,edge);
  assert.ok(launch.args.includes(`--user-data-dir=${path.join(root,'Files/browser-profile')}`));
  const fallback=await browserLaunch(root,'http://127.0.0.1:4328',browserEnv,async()=>false);
  assert.deepEqual(fallback,{executable:'rundll32.exe',args:['url.dll,FileProtocolHandler','http://127.0.0.1:4328'],profileDirectory:null});
});
function run(script,env){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,'--no-open'],{cwd:root,env,windowsHide:true});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('exit',code=>resolve({code,output}));});}
test('launcher starts once, persists through stop/restart, and stop flushes files',{timeout:45000},async()=>{
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const dir=await temporaryDirectory('launcher-'),env={...process.env,PORT:String(port),CARNET_PDF_DATA_DIR:dir};const url=`http://127.0.0.1:${port}`;
  try{
    let result=await run('scripts/launch.mjs',env);assert.equal(result.code,0,result.output);
    await readFile(path.join(dir,'server.log'),'utf8');
    await assert.rejects(readFile(path.join(dir,'browser-profile')),error=>error.code==='ENOENT','--no-open does not create a browser profile');
    const session=await fetch(url+'/api/session').then(r=>r.json());assert.equal(session.app,'carnet-pdf-reader');
    result=await run('scripts/launch.mjs',env);assert.equal(result.code,0,result.output);
    const session2=await fetch(url+'/api/session').then(r=>r.json());assert.equal(session.token,session2.token,'duplicate launch reuses existing server');
    const response=await fetch(url+'/api/documents',{method:'POST',headers:{'x-carnet-token':session.token,'x-file-name':'Persistent.pdf','x-category-id':'fr'},body:textPdf()});assert.equal(response.status,201);const library=await response.json();
    result=await run('scripts/stop.mjs',env);assert.equal(result.code,0,result.output);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir,'library.json'),'utf8')),library);
    await assert.rejects(readFile(path.join(dir,'.lock')),error=>error.code==='ENOENT');
    result=await run('scripts/launch.mjs',env);assert.equal(result.code,0,result.output);
    const restored=await fetch(url+'/api/library').then(r=>r.json());assert.deepEqual(restored,library);
  }finally{
    await run('scripts/stop.mjs',env);await rm(dir,{recursive:true,force:true});
  }
});
