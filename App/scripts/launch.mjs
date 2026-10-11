import {spawn} from 'node:child_process';
import {access,mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {programRoot as root,productRoot,dataDirectory as resolveDataDirectory} from '../server/layout.mjs';
const port=Number(process.env.PORT||4328),url=`http://127.0.0.1:${port}`;
async function isRunning(){try{const response=await fetch(url+'/api/session',{signal:AbortSignal.timeout(800)});const data=await response.json();return response.ok&&data.app==='carnet-pdf-reader';}catch{return false;}}
export async function browserLaunch(appRoot,appUrl,env=process.env,exists=async candidate=>{try{await access(candidate);return true;}catch{return false;}}){
  const profileDirectory=path.join(path.resolve(appRoot,env.CARNET_PDF_DATA_DIR||'Files'),'browser-profile');
  const programs=env.ProgramFiles||'C:\\Program Files',programsX86=env['ProgramFiles(x86)']||'C:\\Program Files (x86)';
  const browsers=[path.join(programs,'Google/Chrome/Application/chrome.exe'),path.join(programsX86,'Google/Chrome/Application/chrome.exe')];
  if(env.LOCALAPPDATA)browsers.push(path.join(env.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe'));
  browsers.push(path.join(programsX86,'Microsoft/Edge/Application/msedge.exe'),path.join(programs,'Microsoft/Edge/Application/msedge.exe'));
  if(env.LOCALAPPDATA)browsers.push(path.join(env.LOCALAPPDATA,'Microsoft/Edge/Application/msedge.exe'));
  for(const executable of browsers){
    if(await exists(executable))return {executable,args:[`--app=${appUrl}`,`--user-data-dir=${profileDirectory}`,'--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--disable-background-mode'],profileDirectory};
  }
  return {executable:'rundll32.exe',args:['url.dll,FileProtocolHandler',appUrl],profileDirectory:null};
}
async function main(){
const dataDirectory=resolveDataDirectory();
if(!await isRunning()){
  await mkdir(dataDirectory,{recursive:true});
  const log=await open(path.join(dataDirectory,'server.log'),'a');
  const child=spawn(process.execPath,[path.join(root,'server/server.mjs')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
  child.unref();await log.close();
  let started=false;for(let i=0;i<60;i++){if(await isRunning()){started=true;break;}await new Promise(resolve=>setTimeout(resolve,150));}
  if(!started){console.error(`启动失败。请查看 ${path.join(dataDirectory,'server.log')}；端口 ${port} 可能已被其他程序占用。`);process.exit(1);}
}
if(process.argv.includes('--no-open')){console.log(url);process.exit(0);}
const launch=await browserLaunch(productRoot,url);
if(!launch.profileDirectory){console.error('请安装 Chrome 或 Edge 后再打开阅读器。');await import('./stop.mjs');process.exit(1);}
if(launch.profileDirectory)await mkdir(launch.profileDirectory,{recursive:true});
const child=spawn(launch.executable,launch.args,{detached:true,stdio:'ignore',windowsHide:true});
child.on('error',async error=>{console.error(error.message);await import('./stop.mjs');process.exitCode=1;});child.unref();
const monitorLog=await open(path.join(dataDirectory,'desktop.log'),'a');
const monitor=spawn(process.execPath,[path.join(root,'scripts/watch-desktop.mjs'),url,launch.profileDirectory],{cwd:root,detached:true,stdio:['ignore',monitorLog.fd,monitorLog.fd],windowsHide:true});
monitor.unref();await monitorLog.close();
console.log(`Carnet PDF 已启动：${url}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
