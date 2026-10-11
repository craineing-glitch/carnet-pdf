import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {writeFile,rm} from 'node:fs/promises';
import {temporaryDirectory} from './fixtures.mjs';
import {observeDesktop} from '../scripts/watch-desktop.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
  const dir=await temporaryDirectory('desktop-monitor-');
  const state={token:'original-session',targets:[],lists:0,shutdowns:0};
  const server=http.createServer((req,res)=>{
    let data={};
    if(req.url==='/api/session')data={app:'carnet-pdf-reader',token:state.token};
    else if(req.url==='/json/list'){state.lists++;data=state.targets;}
    else if(req.url==='/api/shutdown'){
      assert.equal(req.headers['x-carnet-token'],state.token);state.shutdowns++;data={ok:true};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const appUrl=`http://127.0.0.1:${server.address().port}`;
  const target=id=>({id,type:'page',url:appUrl+'/'});
  state.targets=[target('first')];
  await writeFile(path.join(dir,'DevToolsActivePort'),String(server.address().port)+'\n/devtools/browser/test');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const options={appUrl,profileDirectory:dir,interval:15,closeGrace:80,startupTimeout:2000};
  return {state,options,target};
}
async function observed(state){while(!state.lists)await delay(10);}
test('closing the last reader window stops the matching local service',async t=>{
  const {state,options}=await fixture(t);const monitor=observeDesktop(options);
  await observed(state);state.targets=[];await monitor;assert.equal(state.shutdowns,1);
});
test('refresh and closing one of two reader windows leave the service running',async t=>{
  const {state,options,target}=await fixture(t);const monitor=observeDesktop(options);
  await observed(state);state.targets=[];await delay(30);state.targets=[target('reload'),target('second')];
  await delay(120);assert.equal(state.shutdowns,0);
  state.targets=[target('second')];await delay(120);assert.equal(state.shutdowns,0);
  state.targets=[];await monitor;assert.equal(state.shutdowns,1);
});
test('a stale window monitor cannot stop a newer service on the same port',async t=>{
  const {state,options}=await fixture(t);const monitor=observeDesktop(options);
  await observed(state);state.token='new-session';state.targets=[];
  await monitor;assert.equal(state.shutdowns,0);
});
