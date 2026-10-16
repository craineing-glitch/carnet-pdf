import { mkdir, open, readFile, rename, unlink, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { extractPdfPages, PdfExtractionError } from './pdf-extract.mjs';
import { sortDocuments } from '../src/library-model.js';

export const MAX_PDF_BYTES = 1024 * 1024 * 1024;
export class StoreError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const invalid = message => { throw new StoreError(message); };
const identifier = value => typeof value === 'string' && /^(?:fr|en|[a-f0-9-]{36})$/.test(value);
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\\/\u0000-\u001f\u007f]/.test(value) || value === '.' || value === '..') invalid('名称不能为空、过长或包含路径字符。');
  return value.trim();
};
const pageOf = value => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) invalid('页码无效。');
  return value;
};
function reviewOf(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==4 || Object.keys(value).some(key=>!['sourceId','sourceName','pages','collectedAt'].includes(key))) invalid('复习记录无效。');
  if(typeof value.sourceId!=='string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.sourceId)) invalid('复习来源无效。');
  nameOf(value.sourceName);
  if(!Array.isArray(value.pages) || !value.pages.length || value.pages.length>1000000 || value.pages.some((page,index)=>pageOf(page)!==page || (index>0 && page<=value.pages[index-1]))) invalid('复习页码无效。');
  if(typeof value.collectedAt!=='string' || !Number.isFinite(Date.parse(value.collectedAt))) invalid('收录时间无效。');
  return value;
}
function reviewRequest(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!['pages','name'].includes(key)) || !Array.isArray(value.pages) || !value.pages.length || value.pages.length>1000000) invalid('请选择要收录的页面。');
  const pages=[...new Set(value.pages.map(pageOf))].sort((a,b)=>a-b);
  if(value.name!==undefined && typeof value.name!=='string') invalid('名称无效。');
  const name=value.name?.trim() ? nameOf(value.name) : undefined;
  return {pages,name};
}
function timeName(date) {
  const pad=value=>String(value).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}
const colorOf = value => {
  if (typeof value !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(value)) invalid('高亮颜色无效。');
  return value;
};
const noteOf = value => {
  if(typeof value !== 'string' || value.length > 10000) invalid('批注须为不超过 10000 字的文字。');
  return value;
};
function bookmarkOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!['page','label'].includes(key))) invalid('书签内容无效。');
  const page=pageOf(value.page);
  const label=value.label === undefined ? `第 ${page} 页` : value.label;
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(label)) invalid('书签名称无效。');
  return {page,label:label.trim()};
}
function highlightOf(value) {
  if (!value || typeof value !== 'object' || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 50000) invalid('高亮文字无效。');
  const page = pageOf(value.page);
  if (!Array.isArray(value.rects) || value.rects.length < 1 || value.rects.length > 2000) invalid('高亮区域无效。');
  for (const r of value.rects) {
    if (!Array.isArray(r) || r.length !== 4 || r.some(n => !Number.isFinite(n) || Math.abs(n) > 1000000) || r[2] <= r[0] || r[3] <= r[1]) invalid('高亮坐标无效。');
  }
  const color = colorOf(value.color ?? '#ffe066');
  const note=value.note === undefined ? '' : noteOf(value.note);
  return {page,text:value.text,rects:structuredClone(value.rects),color,...(note ? {note} : {})};
}
function themeOf(value) {
  if (!['mediterranean','paris','rose-dusk','shinchan'].includes(value)) invalid('主题无效。');
  return value;
}
function screensaverOf(value) {
  if(!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || Object.keys(value).some(key=>!['enabled','minutes'].includes(key)) || typeof value.enabled !== 'boolean' || !Number.isInteger(value.minutes) || value.minutes < 1 || value.minutes > 120) invalid('屏保设置无效。');
  return {enabled:value.enabled,minutes:value.minutes};
}
function librarySortOf(value) {
  if(!['newest','oldest','name-asc','name-desc','manual'].includes(value)) invalid('文件排序方式无效。');
  return value;
}
function trashSnapshot(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==1 || !Array.isArray(value.ids) || value.ids.length>100000 || value.ids.some(id=>typeof id!=='string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) || new Set(value.ids).size!==value.ids.length) invalid('回收站清理内容无效。');
  return new Set(value.ids);
}
function validateLibrary(lib) {
  if (!lib || lib.schema !== 1 || !Number.isSafeInteger(lib.revision) || lib.revision < 0 || !Array.isArray(lib.categories) || !Array.isArray(lib.documents)) throw Error('Invalid schema');
  if (typeof lib.settings?.theme !== 'string' || !/^[a-z][a-z0-9-]{0,49}$/.test(lib.settings.theme)) throw Error('Invalid theme');
  if(Object.hasOwn(lib.settings,'screensaver')) screensaverOf(lib.settings.screensaver);
  if(Object.hasOwn(lib.settings,'librarySort')) librarySortOf(lib.settings.librarySort);
  const cats=new Set();
  for(const cat of lib.categories) {
    if(!identifier(cat.id) || cats.has(cat.id)) throw Error('Invalid category');
    nameOf(cat.name); cats.add(cat.id);
  }
  const docs=new Set();
  for(const doc of lib.documents) {
    if(!identifier(doc.id) || doc.id === 'fr' || doc.id === 'en' || docs.has(doc.id) || (doc.categoryId !== '' && !cats.has(doc.categoryId)) || !Number.isSafeInteger(doc.size) || doc.size < 5 || doc.size > MAX_PDF_BYTES || !Number.isFinite(Date.parse(doc.importedAt)) || !Array.isArray(doc.highlights)) throw Error('Invalid document');
    nameOf(doc.name); pageOf(doc.lastPage); docs.add(doc.id);
    if(doc.review!==undefined) {
      reviewOf(doc.review);
      if(doc.categoryId!=='' || doc.review.sourceId===doc.id) throw Error('Invalid review document');
    }
    if(doc.deletedAt !== undefined && (typeof doc.deletedAt !== 'string' || !Number.isFinite(Date.parse(doc.deletedAt)))) throw Error('Invalid deletion date');
    const highlights=new Set();
    for(const h of doc.highlights) {
      if(!identifier(h.id) || highlights.has(h.id)) throw Error('Invalid highlight');
      highlightOf(h); highlights.add(h.id);
    }
    if(!Array.isArray(doc.bookmarks)) throw Error('Invalid bookmarks');
    const bookmarks=new Set(), pages=new Set();
    for(const bookmark of doc.bookmarks) {
      if(!identifier(bookmark.id) || bookmarks.has(bookmark.id) || pages.has(bookmark.page) || !Number.isFinite(Date.parse(bookmark.createdAt))) throw Error('Invalid bookmark');
      bookmarkOf({page:bookmark.page,label:bookmark.label});
      bookmarks.add(bookmark.id);pages.add(bookmark.page);
    }
  }
  if(Object.hasOwn(lib.settings,'documentOrder')) {
    const order=lib.settings.documentOrder,active=new Set(lib.documents.filter(doc=>!doc.deletedAt&&!doc.review).map(doc=>doc.id));
    if(!Array.isArray(order) || order.some(id=>!active.has(id)) || new Set(order).size!==order.length) throw Error('Invalid document order');
  }
}
async function atomicWrite(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary,'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary,file);
  } finally {
    await handle?.close().catch(()=>{});
    await unlink(temporary).catch(error=> { if(error.code !== 'ENOENT') throw error; });
  }
}

export async function openStore(dataDir) {
  dataDir=path.resolve(dataDir);
  await mkdir(path.join(dataDir,'pdfs'),{recursive:true});
  const lockPath=path.join(dataDir,'.lock');
  const owner={pid:process.pid,nonce:randomUUID()};
  const recoveryPath=path.join(dataDir,'.lock-recovery');
  // Every acquire participates in the same exclusive guard. A guard interrupted
  // by a process crash is deliberately not auto-deleted: manual recovery is safer
  // than another check/delete race removing a newly created guard.
  let recovery;
  try { recovery=await open(recoveryPath,'wx'); }
  catch(error) {
    if(error.code==='EEXIST') throw new StoreError('资料目录已在使用（locked），或启动恢复被中断。确认所有阅读器已关闭后，删除 .lock-recovery 再启动。',409);
    throw error;
  }
  let lock;
  try {
    await recovery.writeFile(JSON.stringify(owner));
    try { lock=await open(lockPath,'wx'); }
    catch(error) {
      if(error.code !== 'EEXIST') throw error;
      let existing;
      try { existing=JSON.parse(await readFile(lockPath,'utf8')); } catch { throw new StoreError('资料目录已在使用，或锁文件损坏。',409); }
      if(!Number.isSafeInteger(existing.pid) || existing.pid <= 0) throw new StoreError('资料目录已在使用：锁文件无效。',409);
      try { process.kill(existing.pid,0); throw new StoreError('资料目录已在使用（locked）。请关闭另一个阅读器。',409); }
      catch(probe) {
        if(probe.code !== 'ESRCH') throw probe;
        await unlink(lockPath);
        lock=await open(lockPath,'wx');
      }
    }
    await lock.writeFile(JSON.stringify(owner));
    await lock.close(); lock=undefined;
  } finally {
    await lock?.close();
    await recovery.close();
    await unlink(recoveryPath);
  }
  const release=async()=>{
    try { const current=JSON.parse(await readFile(lockPath,'utf8')); if(current.nonce === owner.nonce) await unlink(lockPath); }
    catch(error) { if(error.code !== 'ENOENT') throw error; }
  };
  const libraryPath=path.join(dataDir,'library.json');
  const backupPath=path.join(dataDir,'library.json.bak');
  let library;
  try {
    let raw;
    try { raw=await readFile(libraryPath,'utf8'); }
    catch(error) {
      if(error.code !== 'ENOENT') throw error;
      try { await stat(backupPath); throw new StoreError('目录元数据缺失；已有备份，请恢复 library.json 后再启动。',500); }
      catch(backupError) { if(backupError.code !== 'ENOENT') throw backupError; }
      if((await readdir(path.join(dataDir,'pdfs'))).length) throw new StoreError('目录元数据缺失（missing），但 PDF 文件仍存在。请恢复资料目录后再启动。',500);
      library={schema:1,revision:0,categories:[{id:'fr',name:'法语'},{id:'en',name:'英语'}],documents:[],settings:{theme:'mediterranean',screensaver:{enabled:true,minutes:1},librarySort:'newest',documentOrder:[]}};
      await atomicWrite(libraryPath,JSON.stringify(library,null,2));
    }
    if(raw !== undefined) {
      try {
        library=JSON.parse(raw);
        if(Array.isArray(library?.documents)) for(const doc of library.documents) if(doc && typeof doc === 'object') doc.bookmarks ??= [];
        validateLibrary(library);
        if(!['mediterranean','paris','rose-dusk','shinchan'].includes(library.settings.theme)) library.settings.theme='rose-dusk';
        if(!Object.hasOwn(library.settings,'screensaver')) library.settings.screensaver={enabled:true,minutes:1};
        if(!Object.hasOwn(library.settings,'librarySort')) library.settings.librarySort='newest';
        if(!Object.hasOwn(library.settings,'documentOrder')) library.settings.documentOrder=[];
      }
      catch { throw new StoreError('资料元数据损坏（corrupt）。请保留文件并从 library.json.bak 恢复，系统不会覆盖。',500); }
    }
    // A crash may interrupt deletion between staging the PDF and committing its
    // catalog change. The committed catalog decides whether to restore or erase.
    for(const entry of await readdir(path.join(dataDir,'pdfs'))) {
      const match=/^([a-f0-9-]{36})\.pdf\.deleting$/.exec(entry);
      if(!match) continue;
      const staged=path.join(dataDir,'pdfs',entry),file=path.join(dataDir,'pdfs',`${match[1]}.pdf`);
      if(library.documents.some(doc=>doc.id===match[1])) {
        const original=await stat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
        if(original) throw new StoreError('删除恢复遇到重复的 PDF 文件，请保留资料目录并检查。',500);
        await rename(staged,file);
      } else await unlink(staged);
    }
    for(const doc of library.documents) {
      const file=await stat(path.join(dataDir,'pdfs',`${doc.id}.pdf`)).catch(()=>null);
      if(!file?.isFile() || file.size !== doc.size) throw new StoreError('资料文件缺失或大小异常。请从备份恢复。',500);
    }
  } catch(error) { await release(); throw error; }
  let queue=Promise.resolve();
  let closed=false;
  let closing;
  const snapshot=()=>structuredClone(library);
  const mutate = (operation) => {
    if(closed) return Promise.reject(new StoreError('资料库已关闭。',503));
    const pending=queue.then(async()=>{
      const next=structuredClone(library);
      let rollback,transaction,previousBackup,backupReplaced=false;
      try {
        transaction=await operation(next);
        // An idempotent operation can report that it changed nothing.
        if(transaction === false) return snapshot();
        rollback=typeof transaction === 'function' ? transaction : transaction?.rollback;
        next.revision=library.revision+1;
        const serialized=JSON.stringify(next,null,2);
        // Permanent deletion must not leave a backup referencing erased bytes.
        const previous=await readFile(libraryPath);
        if(transaction?.replaceBackup) previousBackup=await readFile(backupPath).catch(error=>{
          if(error.code!=='ENOENT') throw error;
          return null;
        });
        await atomicWrite(backupPath,transaction?.replaceBackup ? serialized : previous);
        backupReplaced=Boolean(transaction?.replaceBackup);
        await atomicWrite(libraryPath,serialized);
        library=next;
      } catch(error) {
        const failures=[error];
        if(typeof rollback === 'function') try {await rollback();} catch(failure) {failures.push(failure);}
        // If replacing the main catalog fails, deletion has not committed.
        // Restore the exact old backup as well as the staged PDF, before any
        // later queued mutation can observe the failed operation's effects.
        if(backupReplaced) try {
          if(previousBackup===null) await unlink(backupPath);
          else await atomicWrite(backupPath,previousBackup);
        } catch(failure) {failures.push(failure);}
        if(failures.length>1) throw new AggregateError(failures,'保存失败，资料恢复未能完全完成。');
        throw error;
      }
      await transaction?.finalize?.();
      return snapshot();
    });
    queue=pending.catch(()=>{});
    return pending;
  };
  const documentOf=(lib,id)=>{
    const doc=lib.documents.find(d=>d.id===id);
    if(!doc) throw new StoreError('找不到这份 PDF。',404);
    return doc;
  };
  const categoryOf=(lib,id)=>{
    if(id === '') return '';
    if(!lib.categories.some(c=>c.id===id)) invalid('分类不存在。');
    return id;
  };
  const stageDeletion=async(next,documents)=>{
    const staged=[];
    const rollback=async()=>{
      const failures=[];
      for(const item of [...staged].reverse()) try {await rename(item.staged,item.file);} catch(error) {failures.push(error);}
      if(failures.length) throw new AggregateError(failures,'PDF 删除恢复未能完全完成。');
    };
    try {
      for(const doc of documents) {
        const file=path.join(dataDir,'pdfs',`${doc.id}.pdf`),pending=file+'.deleting';
        const existing=await stat(pending).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
        if(existing) throw new StoreError('有待恢复的 PDF 清理，请重新启动阅读器后重试。',409);
        await rename(file,pending);
        staged.push({file,staged:pending});
      }
    } catch(error) {
      try {await rollback();} catch(failure) {throw new AggregateError([error,failure],'删除失败，资料恢复未能完全完成。');}
      throw error;
    }
    const removed=new Set(documents.map(doc=>doc.id));
    next.documents=next.documents.filter(doc=>!removed.has(doc.id));
    next.settings.documentOrder=next.settings.documentOrder.filter(id=>!removed.has(id));
    return {
      replaceBackup:true,rollback,
      // The committed catalog lets startup safely finish interrupted byte cleanup.
      finalize:async()=>{
        const failures=[];
        for(const item of staged) try {await unlink(item.staged);} catch(error) {if(error.code!=='ENOENT') failures.push(error);}
        if(failures.length) throw new StoreError('回收站记录已清理，但部分 PDF 正被占用，尚未释放空间。请重新启动阅读器完成清理。',503);
      },
    };
  };
  const importStream=(stream,{name,categoryId=''}={})=>mutate(async next=>{
    name=nameOf(name);categoryOf(next,categoryId);
    const id=randomUUID(),file=path.join(dataDir,'pdfs',`${id}.pdf`),temporary=file+'.upload.tmp';
    let handle,size=0,header=Buffer.alloc(0),committed=false;
    try{
      handle=await open(temporary,'wx');
      const chunks=typeof stream.iterator==='function'?stream.iterator({destroyOnReturn:false}):stream;
      for await(const chunk of chunks){
        if(!Buffer.isBuffer(chunk)&&!(chunk instanceof Uint8Array))invalid('文件不是有效的 PDF。');
        size+=chunk.length;
        if(size>MAX_PDF_BYTES)throw new StoreError('单个 PDF 最大支持 1 GB。',413);
        if(header.length<5){header=Buffer.concat([header,chunk.subarray(0,5-header.length)]);if(header.length===5&&header.toString('ascii')!=='%PDF-')invalid('文件不是有效的 PDF。');}
        await handle.writeFile(chunk);
      }
      if(size<5)invalid('文件不是有效的 PDF。');
      await handle.sync();await handle.close();handle=undefined;
      await rename(temporary,file);committed=true;
      next.documents.push({id,name,categoryId,importedAt:new Date().toISOString(),size,lastPage:1,highlights:[],bookmarks:[]});
      return ()=>unlink(file);
    }finally{
      await handle?.close();
      if(!committed)await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
  });
  return {
    getLibrary:snapshot,
    filePath(id) { documentOf(library,id); return path.join(dataDir,'pdfs',`${id}.pdf`); },
    importDocument(bytes,{name,categoryId=''}={}) {
      if(!Buffer.isBuffer(bytes))return Promise.reject(new StoreError('文件不是有效的 PDF。'));
      if(bytes.length>MAX_PDF_BYTES)return Promise.reject(new StoreError('单个 PDF 最大支持 1 GB。',413));
      return importStream(Readable.from([bytes]),{name,categoryId});
    },
    importStream,
    reorderDocument(value) {return mutate(next=>{
      if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==2 || !Object.hasOwn(value,'id') || !Object.hasOwn(value,'beforeId') || typeof value.id!=='string' || typeof value.beforeId!=='string') invalid('文件排序内容无效。');
      const doc=documentOf(next,value.id),target=value.beforeId ? documentOf(next,value.beforeId) : null;
      if(doc.deletedAt || doc.review || target?.deletedAt || target?.review) throw new StoreError('只能对资料库中的文件排序。',409);
      if(value.id===value.beforeId) return false;
      const order=sortDocuments(next.documents.filter(item=>!item.deletedAt&&!item.review),{sort:next.settings.librarySort,order:next.settings.documentOrder}).map(item=>item.id).filter(id=>id!==value.id);
      order.splice(value.beforeId ? order.indexOf(value.beforeId) : order.length,0,value.id);
      if(next.settings.librarySort==='manual' && JSON.stringify(order)===JSON.stringify(next.settings.documentOrder)) return false;
      next.settings.librarySort='manual';next.settings.documentOrder=order;
    });},
    emptyTrash(value) {return mutate(async next=>{
      const ids=trashSnapshot(value),documents=next.documents.filter(doc=>doc.deletedAt&&ids.has(doc.id));
      if(!documents.length) return false;
      return stageDeletion(next,documents);
    });},
    collectReview(sourceId,value) {return mutate(async next=>{
      const {pages,name}=reviewRequest(value);
      const source=documentOf(next,sourceId);
      if(source.deletedAt) throw new StoreError('请先从回收站恢复这份 PDF，再收录页面。',409);
      if(source.review) throw new StoreError('这份文件已经在收藏夹中。',409);
      let bytes;
      try {bytes=await extractPdfPages(path.join(dataDir,'pdfs',`${source.id}.pdf`),pages,{maxBytes:MAX_PDF_BYTES});}
      catch(error) {if(error instanceof PdfExtractionError)throw new StoreError(error.message,error.status);throw error;}
      const id=randomUUID(),now=new Date(),collectedAt=now.toISOString(),file=path.join(dataDir,'pdfs',`${id}.pdf`);
      const pageMap=new Map(pages.map((page,index)=>[page,index+1]));
      const remap=marks=>marks.filter(mark=>pageMap.has(mark.page)).map(mark=>({...structuredClone(mark),id:randomUUID(),page:pageMap.get(mark.page)}));
      const review={id,name:name??timeName(now),categoryId:'',importedAt:collectedAt,size:bytes.length,lastPage:1,highlights:remap(source.highlights),bookmarks:remap(source.bookmarks),review:{sourceId:source.id,sourceName:source.name,pages,collectedAt}};
      await atomicWrite(file,bytes);
      next.documents.push(review);
      return ()=>unlink(file);
    });},
    trashDocument(id) { return mutate(next=>{
      const doc=documentOf(next,id);
      if(doc.deletedAt) return false;
      doc.deletedAt=new Date().toISOString();
      next.settings.documentOrder=next.settings.documentOrder.filter(item=>item!==id);
    }); },
    restoreDocument(id) { return mutate(next=>{
      const doc=documentOf(next,id);
      if(!doc.deletedAt) return false;
      delete doc.deletedAt;
    }); },
    permanentlyDeleteDocument(id) { return mutate(async next=>{
      const doc=documentOf(next,id);
      if(!doc.deletedAt) throw new StoreError('请先将文件移入回收站。',409);
      return stageDeletion(next,[doc]);
    }); },
    patchDocument(id,patch) { return mutate(next=>{
      if(!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k=>!['name','categoryId','lastPage'].includes(k)) || !Object.keys(patch).length) invalid('修改内容无效。');
      const doc=documentOf(next,id);
      if(doc.review && 'categoryId' in patch) invalid('收藏夹中的文件不能移入资料分类。');
      if('name' in patch) doc.name=nameOf(patch.name);
      if('categoryId' in patch) doc.categoryId=categoryOf(next,patch.categoryId);
      if('lastPage' in patch) doc.lastPage=pageOf(patch.lastPage);
    }); },
    addCategory(name) { return mutate(next=>{
      name=nameOf(name);
      if(next.categories.some(c=>c.name.toLocaleLowerCase()===name.toLocaleLowerCase())) invalid('已有同名分类。');
      if(next.categories.length >= 500) invalid('分类数量已达到上限。');
      next.categories.push({id:randomUUID(),name});
    }); },
    patchCategory(id,patch) { return mutate(next=>{
      if(!patch || typeof patch!=='object' || Array.isArray(patch) || Object.keys(patch).length!==1 || !Object.hasOwn(patch,'name')) invalid('分类修改内容无效。');
      const category=next.categories.find(item=>item.id===id);
      if(!category) throw new StoreError('找不到这个分类。',404);
      const name=nameOf(patch.name);
      if(next.categories.some(item=>item.id!==id && item.name.toLocaleLowerCase()===name.toLocaleLowerCase())) invalid('已有同名分类。');
      if(category.name===name) return false;
      category.name=name;
    }); },
    removeCategory(id) { return mutate(next=>{
      const index=next.categories.findIndex(category=>category.id===id);
      if(index<0) throw new StoreError('找不到这个分类。',404);
      next.categories.splice(index,1);
      for(const doc of next.documents) if(doc.categoryId===id) doc.categoryId='';
    }); },
    addHighlight(id,value) { return mutate(next=>{
      const doc=documentOf(next,id);
      if(doc.highlights.length >= 100000) invalid('高亮数量已达到上限。');
      doc.highlights.push({id:randomUUID(),...highlightOf(value)});
    }); },
    removeHighlight(id,hid) { return mutate(next=>{
      const doc=documentOf(next,id); const index=doc.highlights.findIndex(h=>h.id===hid);
      if(index<0) throw new StoreError('找不到这处高亮。',404);
      doc.highlights.splice(index,1);
    }); },
    patchHighlight(id,hid,patch) { return mutate(next=>{
      if(!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key=>!['color','note'].includes(key))) invalid('高亮修改内容无效。');
      const doc=documentOf(next,id);const highlight=doc.highlights.find(h=>h.id===hid);
      if(!highlight) throw new StoreError('找不到这处高亮。',404);
      if('color' in patch) highlight.color=colorOf(patch.color);
      if('note' in patch) {
        const note=noteOf(patch.note);
        if(note) highlight.note=note;
        else delete highlight.note;
      }
    }); },
    addBookmark(id,value) { return mutate(next=>{
      const doc=documentOf(next,id);const bookmark=bookmarkOf(value);
      if(doc.bookmarks.some(existing=>existing.page===bookmark.page)) return false;
      if(doc.bookmarks.length >= 100000) invalid('书签数量已达到上限。');
      doc.bookmarks.push({id:randomUUID(),...bookmark,createdAt:new Date().toISOString()});
    }); },
    removeBookmark(id,bookmarkId) { return mutate(next=>{
      const doc=documentOf(next,id);const index=doc.bookmarks.findIndex(bookmark=>bookmark.id===bookmarkId);
      if(index<0) throw new StoreError('找不到这处书签。',404);
      doc.bookmarks.splice(index,1);
    }); },
    patchSettings(patch) { return mutate(next=>{
      if(!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key=>!['theme','screensaver','librarySort'].includes(key))) invalid('设置无效。');
      const theme=Object.hasOwn(patch,'theme') ? themeOf(patch.theme) : next.settings.theme;
      const screensaver=Object.hasOwn(patch,'screensaver') ? screensaverOf(patch.screensaver) : next.settings.screensaver;
      const librarySort=Object.hasOwn(patch,'librarySort') ? librarySortOf(patch.librarySort) : next.settings.librarySort;
      if(theme === next.settings.theme && screensaver.enabled === next.settings.screensaver.enabled && screensaver.minutes === next.settings.screensaver.minutes && librarySort===next.settings.librarySort) return false;
      next.settings.theme=theme;
      next.settings.screensaver=screensaver;
      next.settings.librarySort=librarySort;
    }); },
    close() { if(!closing) {closed=true;closing=queue.then(release);}return closing; },
  };
}
