import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { openStore, StoreError, MAX_PDF_BYTES } from './store.mjs';

import {programRoot as defaultRoot,dataDirectory} from './layout.mjs';
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.wasm':'application/wasm'};
function json(res,status,value) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value)); }
async function body(req,limit) {
  if(Number(req.headers['content-length']) > limit) {req.resume();throw new StoreError('请求内容超过大小限制。',413);}
  const chunks=[];let total=0;
  for await(const chunk of req) {total+=chunk.length;if(total > limit) throw new StoreError('请求内容超过大小限制。',413);chunks.push(chunk);}
  return Buffer.concat(chunks,total);
}
async function jsonBody(req) {
  try {const value=JSON.parse((await body(req,256*1024)).toString('utf8'));if(!value || typeof value !== 'object' || Array.isArray(value)) throw Error();return value;}
  catch(error) { if(error instanceof StoreError) throw error;throw new StoreError('请求内容不是有效的 JSON。'); }
}
function validHost(host,port) {return host===`127.0.0.1:${port}` || host===`localhost:${port}`;}
function secureRequest(req,token,port) {
  if(!validHost(req.headers.host,port) || req.headers['sec-fetch-site']==='cross-site') throw new StoreError('只允许本机阅读器访问。',403);
  const origin=req.headers.origin;
  if(origin && origin!==`http://127.0.0.1:${port}` && origin!==`http://localhost:${port}`) throw new StoreError('请求来源无效。',403);
  if(!['GET','HEAD'].includes(req.method)) {
    const supplied=req.headers['x-carnet-token'];
    if(typeof supplied !== 'string' || supplied.length!==token.length || !timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) throw new StoreError('请求凭证无效，请刷新页面。',403);
  }
}
async function sendFile(req,res,file,type,extra={}) {
  let info;
  try { info=await stat(file); } catch { throw new StoreError('文件不存在。',404); }
  if(!info.isFile()) throw new StoreError('文件不存在。',404);
  let start=0,end=info.size-1,status=200;
  const range=req.headers.range;
  if(range) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!match || (!match[1]&&!match[2])) {res.writeHead(416,{'content-range':`bytes */${info.size}`});res.end();return;}
    if(match[1]) {start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;}
    else {start=Math.max(0,info.size-Number(match[2]));}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size) {res.writeHead(416,{'content-range':`bytes */${info.size}`});res.end();return;}
    status=206;
  }
  const headers={'content-type':type,'content-length':info.size ? end-start+1 : 0,'accept-ranges':'bytes','cache-control':'no-cache',...extra};
  if(status===206) headers['content-range']=`bytes ${start}-${end}/${info.size}`;
  res.writeHead(status,headers);
  if(req.method==='HEAD' || !info.size) {res.end();return;}
  await pipeline(createReadStream(file,{start,end}),res);
}
async function staticPath(root,pathname,dataDir) {
  const relative=pathname==='/' ? 'index.html' : pathname.slice(1);
  if(relative!=='index.html' && !/^(?:src\/|assets\/|vendor\/(?:pdfjs|raindrop-fx)\/)/.test(relative)) throw new StoreError('找不到页面。',404);
  if(relative.split('/').some(part=>part==='.'||part==='..'||!part) || relative.includes('\\') || relative.includes('\0')) throw new StoreError('找不到页面。',404);
  const mapped=relative.startsWith('assets/') || relative.startsWith('vendor/') ? path.join(root,'public',relative) : path.join(root,relative);
  let resolved;
  try {resolved=await realpath(mapped);} catch {throw new StoreError('找不到页面。',404);}
  const canonicalRoot=await realpath(root);
  const base=relative.startsWith('assets/')?path.join(canonicalRoot,'public','assets'):relative.startsWith('vendor/')?path.join(canonicalRoot,'public','vendor',relative.split('/')[1]):relative.startsWith('src/')?path.join(canonicalRoot,'src'):canonicalRoot;
  const boundary=base;
  const distance=path.relative(boundary,resolved);
  if(distance.startsWith('..') || path.isAbsolute(distance)) throw new StoreError('找不到页面。',404);
  const privatePath=await realpath(dataDir);
  const privateDistance=path.relative(privatePath,resolved);
  if(!privateDistance || (!privateDistance.startsWith('..') && !path.isAbsolute(privateDistance))) throw new StoreError('找不到页面。',404);
  return resolved;
}

export async function createServer({root=defaultRoot,dataDir=root===defaultRoot?dataDirectory():process.env.CARNET_PDF_DATA_DIR || path.join(root,'data')}={}) {
  root=path.resolve(root);
  const store=await openStore(dataDir);
  const token=randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');
    res.setHeader('cross-origin-resource-policy','same-origin');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const port=server.address()?.port;
      secureRequest(req,token,port);
      let url,pathname;
      try {url=new URL(req.url,`http://127.0.0.1:${port}`);pathname=decodeURIComponent(url.pathname);} catch {throw new StoreError('请求路径无效。');}
      const method=req.method;
      if(method==='GET' && pathname==='/api/session') return json(res,200,{token,app:'carnet-pdf-reader'});
      if(method==='POST' && pathname==='/api/shutdown') {
        await store.close();
        json(res,200,{ok:true});
        setImmediate(()=>server.close());
        return;
      }
      if(method==='GET' && pathname==='/api/library') return json(res,200,store.getLibrary());
      if(method==='POST' && pathname==='/api/documents') {
        let name;try {name=decodeURIComponent(req.headers['x-file-name'] || '');} catch {throw new StoreError('文件名称无效。');}
        if(Number(req.headers['content-length'])>MAX_PDF_BYTES){req.resume();throw new StoreError('单个 PDF 最大支持 1 GB。',413);}
        try{return json(res,201,await store.importStream(req,{name,categoryId:req.headers['x-category-id']}));}
        catch(error){req.resume();throw error;}
      }
      if(method==='POST' && pathname==='/api/categories') return json(res,201,await store.addCategory((await jsonBody(req)).name));
      const categoryMatch=/^\/api\/categories\/([^/]+)$/.exec(pathname);
      if(method==='PATCH' && categoryMatch) return json(res,200,await store.patchCategory(categoryMatch[1],await jsonBody(req)));
      if(method==='DELETE' && categoryMatch) return json(res,200,await store.removeCategory(categoryMatch[1]));
      if(method==='PATCH' && pathname==='/api/settings') return json(res,200,await store.patchSettings(await jsonBody(req)));
      const match=/^\/api\/documents\/([^/]+)(?:\/(file|highlights|bookmarks|restore|permanent)(?:\/([^/]+))?)?$/.exec(pathname);
      if(match) {
        const [,id,action,hid]=match;
        if(!action && method==='PATCH') return json(res,200,await store.patchDocument(id,await jsonBody(req)));
        if(!action && method==='DELETE') return json(res,200,await store.trashDocument(id));
        if(action==='restore' && !hid && method==='POST') return json(res,200,await store.restoreDocument(id));
        if(action==='permanent' && !hid && method==='DELETE') return json(res,200,await store.permanentlyDeleteDocument(id));
        if(action==='highlights' && !hid && method==='POST') return json(res,201,await store.addHighlight(id,await jsonBody(req)));
        if(action==='highlights' && hid && method==='DELETE') return json(res,200,await store.removeHighlight(id,hid));
        if(action==='highlights' && hid && method==='PATCH') return json(res,200,await store.patchHighlight(id,hid,await jsonBody(req)));
        if(action==='bookmarks' && !hid && method==='POST') return json(res,201,await store.addBookmark(id,await jsonBody(req)));
        if(action==='bookmarks' && hid && method==='DELETE') return json(res,200,await store.removeBookmark(id,hid));
        if(action==='file' && !hid && ['GET','HEAD'].includes(method)) {
          const doc=store.getLibrary().documents.find(d=>d.id===id);
          const file=store.filePath(id);
          const disposition=url.searchParams.has('download')?'attachment':'inline';
          const downloadName=/\.pdf$/i.test(doc.name)?doc.name:doc.name+'.pdf';
          return await sendFile(req,res,file,'application/pdf',{'content-disposition':`${disposition}; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(downloadName)}`});
        }
      }
      if(pathname.startsWith('/api/')) throw new StoreError('接口不存在。',404);
      if(!['GET','HEAD'].includes(method)) throw new StoreError('请求方法不支持。',405);
      const file=await staticPath(root,pathname,dataDir);
      await sendFile(req,res,file,MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    } catch(error) {
      if(res.headersSent) {res.destroy();return;}
      const status=error instanceof StoreError?error.status:500;
      json(res,status,{error:status===500?'本机保存或读取失败。请检查资料目录和磁盘空间。':error.message});
    }
  });
  // Release the lock before the close callback resolves, including never-listened servers.
  const originalClose=server.close.bind(server);
  server.close=function(callback) {
    originalClose(error=>{store.close().then(()=>callback?.(error),failure=>callback?.(failure));});
    return server;
  };
  server.requestTimeout=600000;
  server.headersTimeout=30000;
  return server;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT || 4328);
  if(!Number.isInteger(port) || port<1 || port>65535) {console.error('PORT 必须是 1–65535 的整数。');process.exitCode=1;}
  else {
    try {
      const server=await createServer();
      server.once('error',async error=>{console.error(`启动失败：${error.message}`);server.close();process.exitCode=1;});
      server.listen(port,'127.0.0.1',()=>console.log(`Carnet PDF 已启动：http://127.0.0.1:${port}`));
      let exiting=false;
      const stop=()=>{if(exiting)return;exiting=true;server.close(()=>process.exit());};
      process.on('SIGINT',stop);process.on('SIGTERM',stop);
    } catch(error) {console.error(`启动失败：${error.message}`);process.exitCode=1;}
  }
}
