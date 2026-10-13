import { Worker } from 'node:worker_threads';

export class PdfExtractionError extends Error {
  constructor(message,status=400) {super(message);this.status=status;}
}

// A large newspaper is parsed off the HTTP thread. The store still owns the
// mutation queue while waiting, so its source cannot be erased halfway through.
export function extractPdfPages(file,pages,{maxBytes=1024*1024*1024,timeoutMs=300000}={}) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./pdf-extract-worker.mjs',import.meta.url),{workerData:{file,pages,maxBytes}});
    let settled=false;
    const finish=(error,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      // Release the parser and its buffers before another queued extraction.
      worker.terminate().then(()=>error?reject(error):resolve(value),reject);
    };
    const timer=setTimeout(()=>finish(new PdfExtractionError('提取页面耗时过长，请减少本次选取的页数后重试。',503)),timeoutMs);
    timer.unref();
    worker.once('message',message=>{
      if(!message?.ok) return finish(new PdfExtractionError(message?.message || '无法提取这份 PDF 的页面。',[400,413,500,503].includes(message?.status)?message.status:500));
      if(!(message.bytes instanceof Uint8Array) || message.bytes.byteLength<5 || message.bytes.byteLength>maxBytes) return finish(new PdfExtractionError('提取生成的 PDF 无效。',500));
      finish(null,Buffer.from(message.bytes.buffer,message.bytes.byteOffset,message.bytes.byteLength));
    });
    worker.once('error',()=>finish(new PdfExtractionError('提取页面失败，请关闭其他占用内存的程序后重试。',503)));
    worker.once('exit',()=>{if(!settled)finish(new PdfExtractionError('提取页面意外中断，请重试。',503));});
  });
}
