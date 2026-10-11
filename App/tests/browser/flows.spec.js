import {test,expect} from '@playwright/test';
import path from 'node:path';
import {textPdf} from '../fixtures.mjs';
const pdf=name=>path.resolve('tests/pdfs',name);
async function ready(page){await page.goto('/');await expect(page.locator('#save-status')).toHaveText('已保存');}
async function importPdf(page,name){await page.locator('#file-input').setInputFiles(pdf(name));await expect(page.locator('.pdf-page').first()).toBeVisible();await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy','false');}
async function selectText(page){const text=page.locator('.textLayer span').filter({hasText:'Lire,'}).first();const box=await text.boundingBox();await page.mouse.move(box.x+1,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width-1,box.y+box.height/2,{steps:15});await page.mouse.up();await text.click({button:'right'});}

test('native selection copies, highlights align after zoom/rotation, right-click removes permanently',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);await ready(page);await importPdf(page,'reading-sample.pdf');
  await selectText(page);await page.getByRole('menuitem',{name:'复制',exact:false}).click();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain('Lire,');
  await selectText(page);await page.getByRole('menuitem',{name:'高亮所选文字',exact:true}).click();
  await expect(page.locator('[data-highlight-id]').first()).toBeVisible();
  await page.getByRole('button',{name:'放大',exact:true}).click();await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy','false');
  await page.getByRole('button',{name:'旋转页面',exact:true}).click();await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy','false');
  const marker=await page.locator('[data-highlight-id]').first().boundingBox();
  expect(marker.height).toBeGreaterThan(marker.width);
  await page.mouse.click(marker.x+marker.width/2,marker.y+marker.height/2,{button:'right'});
  await page.getByRole('menuitem',{name:'取消高亮',exact:true}).click();
  await expect(page.locator('[data-highlight-id]')).toHaveCount(0);await page.reload();
  await expect(page.locator('.textLayer span').first()).toBeVisible();await expect(page.locator('[data-highlight-id]')).toHaveCount(0);
});

test('page position, category move, date counts and search persist',async({page})=>{
  await ready(page);await page.locator('[data-filter="en"]').click();await importPdf(page,'reading-sample.pdf');
  await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('#page-number')).toHaveValue('2');await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.reload();await expect(page.locator('#page-number')).toHaveValue('2');await expect(page.locator('.textLayer span').filter({hasText:'A little room'})).toBeVisible();
  await page.getByRole('button',{name:'文件选项',exact:true}).first().click();await page.getByRole('menuitem',{name:'移动到分类',exact:true}).click();
  await page.getByLabel('文件分类',{exact:true}).selectOption('fr');await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('button',{name:'日期',exact:true}).click();
  const total=Number(await page.locator('#total-count').textContent());await expect(page.locator('#filters .filter-button').nth(1).locator('.filter-count')).toHaveText(String(total));
  await page.locator('#filters .filter-button').nth(1).click();await page.getByRole('searchbox').fill('reading-sample');expect(await page.locator('.file-row').count()).toBeGreaterThan(0);
  await page.getByRole('searchbox').fill('does not exist 0123');await expect(page.locator('.file-row')).toHaveCount(0);
});

test('scanned PDFs display but have no selectable text',async({page})=>{
  await ready(page);await importPdf(page,'scanned.pdf');await expect(page.locator('.pdf-scan-note')).toBeVisible();await expect(page.locator('.textLayer span')).toHaveCount(0);
  await expect(page.locator('#reader-hint')).toContainText('无文字层');
});

test('invalid and encrypted files fail clearly without partial import or stuck busy state',async({page})=>{
  await ready(page);const before=await page.locator('#total-count').textContent();
  await page.locator('#file-input').setInputFiles({name:'broken.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nbroken\n%%EOF')});
  await expect(page.getByRole('dialog')).toContainText('损坏');await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.locator('#file-input').setInputFiles(pdf('password-protected.pdf'));
  await expect(page.getByRole('dialog')).toContainText('密码');await expect(page.locator('#total-count')).toHaveText(before);await expect(page.getByRole('button',{name:'导入 PDF',exact:true})).toBeEnabled();
});

test('failed highlight save remains retryable and never displays a saved marker',async({page})=>{
  await ready(page);await importPdf(page,'reading-sample.pdf');
  await page.route('**/api/documents/*/highlights',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'测试：磁盘写入失败'})}));
  await selectText(page);await page.getByRole('menuitem',{name:'高亮所选文字',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('磁盘写入失败');await expect(page.locator('[data-highlight-id]')).toHaveCount(0);
  await page.unroute('**/api/documents/*/highlights');await selectText(page);await page.getByRole('menuitem',{name:'高亮所选文字',exact:true}).click();await expect(page.locator('[data-highlight-id]').first()).toBeVisible();
});

test('multiple files import to selected category and names stay escaped',async({page})=>{
  await ready(page);await page.locator('[data-filter="en"]').click();
  const name='<img src=x onerror=alert(1)>.pdf';
  await page.locator('#file-input').setInputFiles([{name,mimeType:'application/pdf',buffer:textPdf()},{name:'Second.pdf',mimeType:'application/pdf',buffer:textPdf('Second document')}]);
  await expect(page.getByRole('button',{name:'打开 Second.pdf',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'打开 '+name,exact:true})).toBeVisible();
  await expect(page.locator('#filters img')).toHaveCount(0);await expect(page.locator('#reader-label')).toContainText('英语');
});

test('local content policy permits PDF image decoder WebAssembly',async({page})=>{
  await ready(page);
  const result=await page.evaluate(async()=>{try{await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));return 'allowed';}catch(error){return error.message;}});
  expect(result).toBe('allowed');
});
