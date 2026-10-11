import {test, expect} from '@playwright/test';
import {textPdf} from '../fixtures.mjs';

async function importNamed(page, name) {
  await page.locator('#file-input').setInputFiles({name,mimeType:'application/pdf',buffer:textPdf()});
  await expect(page.locator('#document-title')).toHaveText(name);
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy','false');
  const library = await (await page.request.get('/api/library')).json();
  return library.documents.find(doc=>doc.name===name);
}

test('imports use the selected category; all files, dates and collapsed categories do not assign one', async({page})=>{
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  expect((await importNamed(page,'Default all.pdf')).categoryId).toBe('');
  await page.locator('[data-filter="en"]').click();
  expect((await importNamed(page,'English selected.pdf')).categoryId).toBe('en');
  await page.locator('[data-filter="en"]').click();
  expect((await importNamed(page,'No selection.pdf')).categoryId).toBe('');
  await page.getByRole('button',{name:'新增分类',exact:true}).click();
  await page.getByLabel('分类名称').fill('旅行');
  await page.getByRole('button',{name:'创建分类',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const category = await (await page.request.get('/api/library')).json();
  const id = category.categories.find(item=>item.name==='旅行').id;
  await page.locator(`[data-filter="${id}"]`).click();
  expect((await importNamed(page,'Custom selected.pdf')).categoryId).toBe(id);
  await page.getByRole('button',{name:'日期',exact:true}).click();
  expect((await importNamed(page,'Dates view.pdf')).categoryId).toBe('');
  await page.getByRole('button',{name:'文件选项',exact:true}).first().click();
  await page.getByRole('menuitem',{name:'移动到分类',exact:true}).click();
  await expect(page.getByLabel('文件分类',{exact:true})).toHaveValue('');
  await page.getByLabel('文件分类',{exact:true}).selectOption('fr');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.reload();
  await expect(page.locator('#reader-label')).toHaveText('法语');
});

test('Shin-chan background loads locally and remains selected after reload', async({page})=>{
  await page.goto('/');await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.getByRole('button',{name:'切换环境',exact:true}).click();
  await expect(page.locator('.theme-card')).toHaveCount(4);
  const card=page.locator('[data-theme-id="shinchan"]');
  await expect(card).toContainText('蜡笔小新');
  await expect.poll(()=>card.locator('img').evaluate(image=>image.complete && image.naturalWidth>0)).toBe(true);
  await card.click();await expect(page.locator('html')).toHaveAttribute('data-theme','shinchan');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','shinchan');
  await expect(page.locator('.scene-photo')).toHaveCSS('background-image',/shinchan\.png/);
});
