import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { textPdf } from '../fixtures.mjs';

const menu = page => page.locator('#context-menu');
const library = async page => (await page.request.get('/api/library')).json();
const documentById = async (page, id) => (await library(page)).documents.find(item => item.id === id);
const row = (page, id) => page.locator(`[data-drag-document="${id}"]`);
const fileOptions = (page, id) => row(page, id).getByRole('button', { name: '文件选项', exact: true });

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
}

async function expand(page, categoryId = '') {
  const button = page.locator(`[data-filter="${categoryId}"]`);
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}

async function importPdf(page, name, categoryId = 'fr') {
  await expand(page, categoryId);
  const bytes = textPdf('Keep this original PDF, its notes, and its bookmarks.');
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  const document = (await library(page)).documents.find(item => item.name === name);
  expect(document).toBeTruthy();
  return { id: document.id, bytes };
}

async function selectPdfText(page) {
  const text = page.locator('.textLayer span').filter({ hasText: 'Keep this original' }).first();
  await expect(text).toBeVisible();
  const box = await text.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 14 });
  await page.mouse.up();
  await text.click({ button: 'right' });
}

async function trash(page, id) {
  await fileOptions(page, id).click();
  await menu(page).getByRole('menuitem', { name: '移到回收站', exact: true }).click();
  await expect.poll(async () => Boolean((await documentById(page, id))?.deletedAt)).toBe(true);
}

async function openTrash(page) {
  await page.getByRole('button', { name: /^回收站/ }).click();
}

test('file right-click and ellipsis offer the same application actions, with working rename, move and export', async ({ page }) => {
  await ready(page);
  const { id, bytes } = await importPdf(page, 'Context actions.pdf');
  await page.evaluate(() => document.addEventListener('contextmenu', event => {
    queueMicrotask(() => { window.lastContextWasPrevented = event.defaultPrevented; });
  }));
  await row(page, id).getByRole('button', { name: '打开 Context actions.pdf', exact: true }).click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  expect(await page.evaluate(() => window.lastContextWasPrevented)).toBe(true);
  const expected = ['重命名', '移动到分类', '导出原始 PDF', '移到回收站'];
  await expect(menu(page).getByRole('menuitem')).toHaveCount(expected.length);
  for (const name of expected) await expect(menu(page).getByRole('menuitem', { name, exact: true })).toBeVisible();
  const fromRightClick = await menu(page).getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  await fileOptions(page, id).click();
  await expect(menu(page).getByRole('menuitem')).toHaveText(fromRightClick);
  await expect(menu(page).getByRole('menuitem', { name: '永久删除', exact: true })).toHaveCount(0);

  await menu(page).getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByLabel('文件名称', { exact: true }).fill('Renamed original.pdf');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(row(page, id)).toContainText('Renamed original.pdf');
  await fileOptions(page, id).click();
  await menu(page).getByRole('menuitem', { name: '移动到分类', exact: true }).click();
  await page.getByLabel('文件分类', { exact: true }).selectOption('en');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await documentById(page, id)).categoryId).toBe('en');
  await expand(page, 'en');
  await fileOptions(page, id).click();
  const downloadPending = page.waitForEvent('download');
  await menu(page).getByRole('menuitem', { name: '导出原始 PDF', exact: true }).click();
  const download = await downloadPending;
  expect(download.suggestedFilename()).toBe('Renamed original.pdf');
  expect(await readFile(await download.path())).toEqual(bytes);
  await page.reload();
  await expand(page, 'en');
  await expect(row(page, id)).toContainText('Renamed original.pdf');
});

test('recycle bin restores the same PDF, category, highlights and bookmarks after reload', async ({ page }) => {
  await ready(page);
  const { id, bytes } = await importPdf(page, 'Restore with notes.pdf');
  await selectPdfText(page);
  await menu(page).getByRole('menuitem', { name: '高亮所选文字', exact: true }).click();
  await expect(page.locator('[data-highlight-id]').first()).toBeVisible();
  await page.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect(page.getByRole('button', { name: '移除书签', exact: true })).toBeVisible();
  const before = await documentById(page, id);
  const totalBefore = Number(await page.locator('#total-count').textContent());
  const frenchBefore = Number(await page.locator('[data-filter="fr"] .filter-count').textContent());
  await trash(page, id);
  await expect(page.locator('#total-count')).toHaveText(String(totalBefore - 1));
  await expect(page.locator('[data-filter="fr"] .filter-count')).toHaveText(String(frenchBefore - 1));
  await expect(row(page, id)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await openTrash(page);
  await expect(row(page, id)).toBeVisible();
  await fileOptions(page, id).click();
  await menu(page).getByRole('menuitem', { name: '还原', exact: true }).click();
  await expect.poll(async () => Boolean((await documentById(page, id))?.deletedAt)).toBe(false);
  await page.reload();
  await expand(page, 'fr');
  await expect(row(page, id)).toBeVisible();
  const restored = await documentById(page, id);
  expect(restored).toEqual(before);
  expect((await library(page)).documents.filter(item => item.id === id)).toHaveLength(1);
  const original = await page.request.get(`/api/documents/${id}/file`);
  expect(await original.body()).toEqual(bytes);
  await row(page, id).getByRole('button', { name: '打开 Restore with notes.pdf', exact: true }).click();
  await expect(page.locator('[data-highlight-id]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '移除书签', exact: true })).toBeVisible();
  await expect(page.locator('#total-count')).toHaveText(String(totalBefore));
});

test('permanent deletion is available only in the recycle bin and requires confirmation', async ({ page }) => {
  await ready(page);
  const { id } = await importPdf(page, 'Delete permanently.pdf');
  await fileOptions(page, id).click();
  await expect(menu(page).getByRole('menuitem', { name: '永久删除', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await trash(page, id);
  await openTrash(page);
  await fileOptions(page, id).click();
  await menu(page).getByRole('menuitem', { name: '永久删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await documentById(page, id)).toBeTruthy();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(row(page, id)).toBeVisible();
  expect((await page.request.get(`/api/documents/${id}/file`)).ok()).toBe(true);
  await fileOptions(page, id).click();
  await menu(page).getByRole('menuitem', { name: '永久删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '永久删除', exact: true }).click();
  await expect.poll(async () => Boolean(await documentById(page, id))).toBe(false);
  await expect(row(page, id)).toHaveCount(0);
  expect((await page.request.get(`/api/documents/${id}/file`)).status()).toBe(404);
  await page.reload();
  expect(await documentById(page, id)).toBeUndefined();
});

test('deleting a category confirms first and keeps its PDF in all files', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: '新增分类', exact: true }).click();
  await page.getByLabel('分类名称').fill('可删除分类');
  await page.getByRole('button', { name: '创建分类', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const category = (await library(page)).categories.find(item => item.name === '可删除分类');
  const { id, bytes } = await importPdf(page, 'Keep after category deletion.pdf', category.id);
  await page.locator(`[data-filter="${category.id}"]`).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: '删除分类', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect((await documentById(page, id)).categoryId).toBe(category.id);
  await page.locator(`[data-filter="${category.id}"]`).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: '删除分类', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除分类', exact: true }).click();
  await expect(page.locator(`[data-filter="${category.id}"]`)).toHaveCount(0);
  await expand(page);
  await expect(row(page, id)).toBeVisible();
  await page.reload();
  const document = await documentById(page, id);
  expect(document.categoryId).toBe('');
  expect(document.deletedAt).toBeUndefined();
  expect((await library(page)).categories.some(item => item.id === category.id)).toBe(false);
  expect(await (await page.request.get(`/api/documents/${id}/file`)).body()).toEqual(bytes);
});

test('selected text accepts a persistent annotation which can be edited without duplicate highlights', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  const { id } = await importPdf(page, 'Annotated passage.pdf');
  await selectPdfText(page);
  await menu(page).getByRole('menuitem', { name: '添加批注', exact: true }).click();
  await page.getByLabel('批注内容', { exact: true }).fill('第一行阅读笔记\n第二行 <b>保留原文</b>');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: '查看高亮笔记', exact: true }).click();
  await expect(page.locator('#notes-panel')).toBeVisible();
  await expect(page.locator('#notes-panel')).toContainText('第二行 <b>保留原文</b>');
  await expect(page.locator('#notes-panel b')).toHaveCount(0);
  let document = await documentById(page, id);
  expect(document.highlights).toHaveLength(1);
  const highlightId = document.highlights[0].id;
  expect(document.highlights[0].note).toBe('第一行阅读笔记\n第二行 <b>保留原文</b>');
  await page.reload();
  await expect(page.locator('[data-highlight-id]').first()).toBeVisible();
  await page.getByRole('button', { name: '查看高亮笔记', exact: true }).click();
  await expect(page.locator('#notes-panel')).toContainText('第一行阅读笔记');
  await page.locator('#notes-panel').getByRole('button', { name: '编辑批注', exact: true }).click();
  await expect(page.getByLabel('批注内容', { exact: true })).toHaveValue('第一行阅读笔记\n第二行 <b>保留原文</b>');
  await page.getByLabel('批注内容', { exact: true }).fill('修改后的批注');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(page.locator('#notes-panel')).toContainText('修改后的批注');
  await page.reload();
  document = await documentById(page, id);
  expect(document.highlights).toHaveLength(1);
  expect(document.highlights[0].id).toBe(highlightId);
  expect(document.highlights[0].note).toBe('修改后的批注');
  await page.getByRole('button', { name: '查看高亮笔记', exact: true }).click();
  await page.getByRole('button', { name: '删除批注', exact: true }).click();
  await expect.poll(async () => (await documentById(page, id)).highlights[0].note).toBeUndefined();
  expect((await documentById(page, id)).highlights[0].id).toBe(highlightId);
  await expect(page.locator('[data-highlight-id]').first()).toBeVisible();
  expect(errors).toEqual([]);
});
