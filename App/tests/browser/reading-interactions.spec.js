import { test, expect } from '@playwright/test';
import { textPdf } from '../fixtures.mjs';

async function openSample(page, name = 'Reading interactions.pdf') {
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: textPdf('Select this passage to attach a thoughtful comment.') });
  await expect(page.locator('.textLayer span').first()).toBeVisible();
}

async function selectPassage(page) {
  const text = page.locator('.textLayer span').filter({ hasText: 'Select this passage' }).first();
  const box = await text.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 15 });
  await page.mouse.up();
  await text.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '添加批注', exact: true }).click();
}

test('PDF blank areas never open library file commands; sidebar commands remain available', async ({ page }) => {
  await openSample(page);
  await page.locator('.pdf-page').first().click({ button: 'right', position: { x: 12, y: 12 } });
  await expect(page.locator('#context-menu')).toBeHidden();
  await page.locator('.textLayer span').first().click({ button: 'right' });
  await expect(page.locator('#context-menu')).toBeHidden();
  await page.locator('.file-open').first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible();
});

test('category rename persists with the same identity and assigned document', async ({ page }) => {
  await openSample(page);
  await page.locator('[data-category-menu="fr"]').click();
  await page.getByRole('menuitem', { name: '重命名分类', exact: true }).click();
  await page.getByLabel('分类名称', { exact: true }).fill('法语报刊');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('[data-filter="fr"]')).toContainText('法语报刊');
  await page.reload();
  await expect(page.locator('[data-filter="fr"]')).toContainText('法语报刊');
  await page.locator('[data-filter="fr"]').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '重命名分类', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '重命名分类', exact: true }).click();
  await page.getByLabel('分类名称', { exact: true }).fill('法语');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
});

test('annotation is a compact nonmodal anchored card, with a persistent clickable page marker', async ({ page }) => {
  await openSample(page, 'Anchored note.pdf');
  await selectPassage(page);
  const card = page.locator('#annotation-editor');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-modal', 'false');
  expect(await page.locator('#dialog').evaluate(el => el.open)).toBe(false);
  const box = await card.boundingBox();
  expect(box.width).toBeLessThanOrEqual(340);
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.y).toBeGreaterThanOrEqual(8);
  await card.getByLabel('批注内容').fill('A local annotation.\n第二行 <b>原样保存</b>');
  await card.getByLabel('批注内容').press('Control+Enter');
  await expect(card).toBeHidden();
  await expect(page.getByRole('button', { name: '查看批注', exact: true })).toBeVisible();
  const marker = page.getByRole('button', { name: '查看批注', exact: true });
  await page.mouse.move(20, 20);
  await expect(marker).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(marker).toHaveCSS('background-image', 'none');
  await expect(marker).toHaveCSS('opacity', '0.22');
  await marker.hover();
  await expect(marker).toHaveCSS('opacity', '1');
  expect(await marker.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await page.mouse.move(20, 20);
  await expect(marker).toHaveCSS('opacity', '0.22');
  await page.reload();
  await page.getByRole('button', { name: '查看批注', exact: true }).click();
  await expect(card.getByLabel('批注内容')).toHaveValue('A local annotation.\n第二行 <b>原样保存</b>');
  await card.getByLabel('批注内容').fill('Edited without moving the page');
  await card.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(card).toBeHidden();
  await page.getByRole('button', { name: '查看批注', exact: true }).click();
  await expect(card.getByLabel('批注内容')).toHaveValue('Edited without moving the page');
  await card.getByRole('button', { name: '关闭批注', exact: true }).click();
  await expect(card).toBeHidden();
  const data = await (await page.request.get('/api/library')).json();
  expect(data.documents.find(d => d.name === 'Anchored note.pdf').highlights).toHaveLength(1);
});
