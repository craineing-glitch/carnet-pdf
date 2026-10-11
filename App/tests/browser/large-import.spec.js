import {test,expect} from '@playwright/test';
import {open,rm} from 'node:fs/promises';
import path from 'node:path';
import {temporaryDirectory,textPdf} from '../fixtures.mjs';
test('a real PDF above 100 MiB validates, uploads, and renders in the reader',async({page})=>{
  const dir=await temporaryDirectory('large-browser-'),file=path.join(dir,'Large reading.pdf');
  const pdf=textPdf('Large document above one hundred megabytes.');
  const chunk=Buffer.alloc(1024*1024,32);chunk[0]=37;chunk[chunk.length-1]=10;
  const handle=await open(file,'wx');
  try{await handle.writeFile(pdf);for(let i=0;i<101;i++)await handle.writeFile(chunk);await handle.writeFile(pdf.subarray(pdf.lastIndexOf('startxref')));}
  finally{await handle.close();}
  try{
    await page.goto('/');await expect(page.locator('#save-status')).toHaveText('已保存');
    await page.locator('#file-input').setInputFiles(file);
    await expect(page.locator('#document-title')).toHaveText('Large reading.pdf');
    await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy','false');
    await expect(page.locator('.textLayer').first()).toContainText('one hundred megabytes');
    const lib=await (await page.request.get('/api/library')).json();
    expect(lib.documents.find(d=>d.name==='Large reading.pdf').size).toBeGreaterThan(100*1024*1024);
  }finally{await rm(dir,{recursive:true,force:true});}
});
