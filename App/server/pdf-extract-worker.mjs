import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { PDFDocument, EncryptedPDFError } from './vendor/pdf-lib.mjs';

const fail=(message,status=400)=>parentPort.postMessage({ok:false,message,status});
try {
  const bytes=await readFile(workerData.file);
  let original;
  try {original=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});}
  catch(error) {
    // The pinned ES5 bundle returns a plain Error for its Error subclasses.
    if(error instanceof EncryptedPDFError || /Input document.*is encrypted/.test(error.message)) fail('这份 PDF 已加密，暂不能提取。请先另存为未加密的 PDF。');
    else fail('这份 PDF 的结构损坏或不受支持，无法提取页面。');
  }
  if(original) {
    const count=original.getPageCount();
    if(workerData.pages.some(page=>page>count)) fail(`页码超出范围，这份 PDF 共 ${count} 页。`);
    else {
      try {
        const extracted=await PDFDocument.create();
        const copied=await extracted.copyPages(original,workerData.pages.map(page=>page-1));
        for(const page of copied)extracted.addPage(page);
        const output=await extracted.save();
        if(output.byteLength>workerData.maxBytes) fail('提取后的 PDF 超过 1 GB，请减少选取页数。',413);
        else parentPort.postMessage({ok:true,bytes:output},[output.buffer]);
      } catch {fail('这份 PDF 的页面结构不受支持，无法完成提取。');}
    }
  }
} catch {fail('无法读取原 PDF，请检查文件和磁盘空间。',500);}
