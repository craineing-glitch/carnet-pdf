import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function getJson(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(1500)});
  if(!response.ok)throw new Error('Desktop connection unavailable');
  return response.json();
}
async function closeBrowser(debugUrl){
  if(!debugUrl)return;
  try{
    const {webSocketDebuggerUrl}=await getJson(debugUrl+'/json/version');
    if(!webSocketDebuggerUrl)return;
    const endpoint=new URL(webSocketDebuggerUrl),expected=new URL(debugUrl);
    if(endpoint.protocol!=='ws:'||endpoint.hostname!==expected.hostname||endpoint.port!==expected.port)return;
    await new Promise(resolve=>{
      const socket=new WebSocket(endpoint);
      const timer=setTimeout(()=>{socket.close();resolve();},2000);
      const finish=()=>{clearTimeout(timer);resolve();};
      socket.addEventListener('open',()=>socket.send(JSON.stringify({id:1,method:'Browser.close'})),{once:true});
      socket.addEventListener('close',finish,{once:true});
      socket.addEventListener('error',finish,{once:true});
    });
  }catch{}
}
export async function observeDesktop({appUrl,profileDirectory,interval=400,closeGrace=1200,startupTimeout=30000}){
  const initial=await getJson(appUrl+'/api/session');
  if(initial.app!=='carnet-pdf-reader')throw new Error('Wrong application');
  const origin=new URL(appUrl).origin;
  let debugUrl,armed=false,emptySince=0;
  const started=Date.now();
  for(;;){
    let current;
    try{current=await getJson(appUrl+'/api/session');}
    catch(error){
      if(error.cause?.code==='ECONNREFUSED'){await closeBrowser(debugUrl);return;}
      await delay(interval);continue;
    }
    // A monitor from a previous launch must never shut down a newer server.
    if(current.token!==initial.token)return;
    try{
      const port=Number((await readFile(path.join(profileDirectory,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);
      if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid browser port');
      debugUrl=`http://127.0.0.1:${port}`;
      const targets=await getJson(debugUrl+'/json/list');
      const hasReader=targets.some(target=>{
        try{return target.type==='page'&&new URL(target.url).origin===origin;}catch{return false;}
      });
      if(hasReader){armed=true;emptySince=0;}
      else if(armed&&!emptySince)emptySince=Date.now();
    }catch(error){
      if(armed&&!emptySince&&(error.cause?.code==='ECONNREFUSED'||error.code==='ENOENT'))emptySince=Date.now();
    }
    if((armed&&emptySince&&Date.now()-emptySince>=closeGrace)||(!armed&&Date.now()-started>=startupTimeout)){
      // Let final keepalive saves reach the store, then flush its write queue.
      try{
        current=await getJson(appUrl+'/api/session');
        if(current.token!==initial.token)return;
        const response=await fetch(appUrl+'/api/shutdown',{method:'POST',headers:{'x-carnet-token':initial.token},signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error('Reading library could not be flushed');
      }catch(error){
        if(error.cause?.code!=='ECONNREFUSED')throw error;
      }
      await closeBrowser(debugUrl);return;
    }
    await delay(interval);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{await observeDesktop({appUrl:process.argv[2],profileDirectory:process.argv[3]});}
  catch(error){console.error(error.message);process.exitCode=1;}
}
