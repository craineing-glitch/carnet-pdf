import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const library = async page => (await page.request.get('/api/library')).json();
const documentById = async (page, id) => (await library(page)).documents.find(doc => doc.id === id);
const reviewsFor = async (page, id) => (await library(page)).documents.filter(doc => doc.review?.sourceId === id && !doc.deletedAt);
const entry = (page, id) => page.locator(`#filters [data-open="${id}"]`);
const options = (page, id) => page.locator(`#filters [data-file-menu="${id}"]`);
const menu = page => page.locator('#context-menu');

async function sixPagePaper() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= 6; number++) {
    const page = pdf.addPage([400, 400]);
    page.drawText(`Archive source page ${number}`, { x: 40, y: 320, size: 18, font });
    page.drawText(`Article ${number}: keep this page independently.`, { x: 40, y: 285, size: 12, font });
  }
  return Buffer.from(await pdf.save());
}

async function openPaper(page, name) {
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  const bytes = await sixPagePaper();
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('#document-title')).toHaveText(name);
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#page-count')).toHaveText('6');
  return { ...(await library(page)).documents.find(doc => doc.name === name), bytes };
}

async function goToPage(page, number) {
  await page.locator('#page-number').fill(String(number));
  await page.locator('#page-number').press('Enter');
  await expect(page.locator('#page-number')).toHaveValue(String(number));
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
}

async function collect(page, pages, name) {
  await page.getByRole('button', { name: '收录页面', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '收录到收藏夹', exact: true });
  if (pages !== undefined) await dialog.getByLabel('收录页码', { exact: true }).fill(pages);
  if (name !== undefined) await dialog.getByLabel('资料名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '收录', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#save-status')).toHaveText('已保存');
}

async function mutation(page, method, endpoint, data) {
  const { token } = await (await page.request.get('/api/session')).json();
  const response = await page.request.fetch(endpoint, { method, data, headers: { 'x-carnet-token': token } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function extractedText(page, id) {
  return page.evaluate(async documentId => {
    const { getDocument, GlobalWorkerOptions } = await import('/vendor/pdfjs/build/pdf.mjs');
    GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
    const task = getDocument({ url: `/api/documents/${documentId}/file` });
    const pdf = await task.promise;
    try {
      const contents = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const sheet = await pdf.getPage(number);
        contents.push((await sheet.getTextContent()).items.map(item => item.str).join(' '));
      }
      return contents;
    } finally { await task.destroy(); }
  }, id);
}

test('current-page collection gets a dated name; named excerpts remain separate and ordered after rename and reload', async ({ page }) => {
  const source = await openPaper(page, 'Review workflow newspaper.pdf');
  const normalCount = await page.locator('#total-count').textContent();
  const reviewCount = Number(await page.locator('#review-count').textContent()) || 0;
  await goToPage(page, 3);
  await page.getByRole('button', { name: '收录页面', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '收录到收藏夹', exact: true });
  await expect(dialog.getByLabel('收录页码', { exact: true })).toHaveValue('3');
  await dialog.getByRole('button', { name: '收录', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await reviewsFor(page, source.id)).length).toBe(1);
  const older = (await reviewsFor(page, source.id))[0];
  expect(older.name).toMatch(/\d{4}[-./年]\d{1,2}/);
  expect(older.review.pages).toEqual([3]);
  expect(older.review.sourceName).toBe(source.name);
  await expect(page.locator('#collection-status')).toContainText('已收录');
  await expect(page.locator('#total-count')).toHaveText(normalCount);
  await collect(page, '5, 2, 4-5', 'Selected economy articles');
  await expect.poll(async () => (await reviewsFor(page, source.id)).length).toBe(2);
  const newer = (await reviewsFor(page, source.id)).find(doc => doc.id !== older.id);
  expect(newer.review.pages).toEqual([2, 4, 5]);
  expect(Date.parse(newer.review.collectedAt)).toBeGreaterThan(Date.parse(older.review.collectedAt));
  await page.getByRole('button', { name: '收藏夹', exact: true }).click();
  await expect(page.locator('#review-count')).toHaveText(String(reviewCount + 2));
  const visibleOrder = await page.locator('#filters [data-open]').evaluateAll(nodes => nodes.map(node => node.dataset.open));
  expect(visibleOrder.indexOf(newer.id)).toBeLessThan(visibleOrder.indexOf(older.id));
  await expect(entry(page, newer.id)).toContainText(source.name);
  await expect(entry(page, newer.id)).toContainText(/2.*4.*5/);
  await entry(page, newer.id).click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem', { name: '移动到分类', exact: true })).toHaveCount(0);
  const contextActions = await menu(page).getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  await options(page, newer.id).click();
  await expect(menu(page).getByRole('menuitem')).toHaveText(contextActions);
  await menu(page).getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByLabel('文件名称', { exact: true }).fill('Review these articles again.pdf');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry(page, newer.id)).toContainText('Review these articles again.pdf');
  await page.reload();
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.getByRole('button', { name: '收藏夹', exact: true }).click();
  await expect(entry(page, newer.id)).toContainText('Review these articles again.pdf');
  expect((await documentById(page, newer.id)).review.collectedAt).toBe(newer.review.collectedAt);
  await entry(page, newer.id).click();
  await expect(page.locator('#page-count')).toHaveText('3');
  await expect(page.getByRole('button', { name: '收录页面', exact: true })).toBeDisabled();
  await expect(page.locator('.textLayer span').filter({ hasText: 'Archive source page 2' })).toBeVisible();
  await page.getByRole('button', { name: '分类', exact: true }).click();
  const all = page.locator('[data-filter=""]');
  if (await all.getAttribute('aria-expanded') !== 'true') await all.click();
  await expect(entry(page, source.id)).toBeVisible();
  await expect(entry(page, newer.id)).toHaveCount(0);
  await expect(entry(page, older.id)).toHaveCount(0);
});

test('nonconsecutive excerpts contain only selected pages and copied notes even after deleting the source', async ({ page }) => {
  const source = await openPaper(page, 'Independent archived newspaper.pdf');
  await mutation(page, 'POST', `/api/documents/${source.id}/highlights`, { page: 4, text: 'Archive source page 4', rects: [[40, 317, 220, 340]], color: '#9fc8ff', note: 'Review the selected fourth page.' });
  await mutation(page, 'POST', `/api/documents/${source.id}/highlights`, { page: 1, text: 'Archive source page 1', rects: [[40, 317, 220, 340]], color: '#ffe066', note: 'Do not collect this page.' });
  await mutation(page, 'POST', `/api/documents/${source.id}/bookmarks`, { page: 5, label: 'Article five' });
  await page.reload();
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
  const original = await documentById(page, source.id);
  await collect(page, '2,4-5', 'Independent selection');
  const excerpt = (await reviewsFor(page, source.id))[0];
  const content = await extractedText(page, excerpt.id);
  expect(content).toHaveLength(3);
  expect(content[0]).toContain('Archive source page 2');
  expect(content[1]).toContain('Archive source page 4');
  expect(content[2]).toContain('Archive source page 5');
  expect(excerpt.highlights).toHaveLength(1);
  expect(excerpt.highlights[0]).toMatchObject({ page: 2, note: 'Review the selected fourth page.', color: '#9fc8ff' });
  expect(excerpt.highlights[0].id).not.toBe(original.highlights[0].id);
  expect(excerpt.bookmarks).toHaveLength(1);
  expect(excerpt.bookmarks[0]).toMatchObject({ page: 3, label: 'Article five' });
  expect(excerpt.bookmarks[0].id).not.toBe(original.bookmarks[0].id);
  expect((await documentById(page, source.id)).highlights).toEqual(original.highlights);
  expect(await (await page.request.get(`/api/documents/${source.id}/file`)).body()).toEqual(source.bytes);
  await mutation(page, 'DELETE', `/api/documents/${source.id}`);
  await mutation(page, 'DELETE', `/api/documents/${source.id}/permanent`);
  await page.reload();
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.getByRole('button', { name: '收藏夹', exact: true }).click();
  await expect(entry(page, excerpt.id)).toContainText(source.name);
  await entry(page, excerpt.id).click();
  await expect(page.locator('#page-count')).toHaveText('3');
  await goToPage(page, 2);
  await expect(page.locator('.annotation-marker')).toBeVisible();
  await page.locator('.annotation-marker').click();
  await expect(page.getByLabel('批注内容', { exact: true })).toHaveValue('Review the selected fourth page.');
  await page.keyboard.press('Escape');
  await options(page, excerpt.id).click();
  const downloadPending = page.waitForEvent('download');
  await menu(page).getByRole('menuitem', { name: /导出.*PDF/ }).click();
  const exported = await readFile(await (await downloadPending).path());
  const stored = await (await page.request.get(`/api/documents/${excerpt.id}/file`)).body();
  expect(exported).toEqual(stored);
  expect((await PDFDocument.load(exported)).getPageCount()).toBe(3);
  expect(await extractedText(page, excerpt.id)).toEqual(content);
  await options(page, excerpt.id).click();
  await menu(page).getByRole('menuitem', { name: '移到回收站', exact: true }).click();
  await expect(entry(page, excerpt.id)).toHaveCount(0);
  await page.getByRole('button', { name: /^回收站/ }).click();
  await options(page, excerpt.id).click();
  await menu(page).getByRole('menuitem', { name: '还原', exact: true }).click();
  await page.getByRole('button', { name: '收藏夹', exact: true }).click();
  await expect(entry(page, excerpt.id)).toBeVisible();
  expect((await documentById(page, excerpt.id)).review).toEqual(excerpt.review);
});

test('invalid pages and failed saves keep the collection editable without creating partial excerpts', async ({ page }) => {
  const source = await openPaper(page, 'Validate collection input.pdf');
  await page.getByRole('button', { name: '收录页面', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '收录到收藏夹', exact: true });
  for (const invalid of ['0', '7', '4-2', '1.5', '2,word']) {
    await dialog.getByLabel('收录页码', { exact: true }).fill(invalid);
    await dialog.getByRole('button', { name: '收录', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.dialog-error')).not.toBeEmpty();
    expect(await reviewsFor(page, source.id)).toHaveLength(0);
  }
  await dialog.getByLabel('收录页码', { exact: true }).fill('2-3');
  await dialog.getByLabel('资料名称', { exact: true }).fill('Retry collection');
  const endpoint = `**/api/documents/${source.id}/review`;
  await page.route(endpoint, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试：本机保存失败，请重试。' }) }));
  await dialog.getByRole('button', { name: '收录', exact: true }).click();
  await expect(dialog.locator('.dialog-error')).toContainText('保存失败');
  await expect(dialog.getByLabel('收录页码', { exact: true })).toHaveValue('2-3');
  await expect(dialog.getByLabel('资料名称', { exact: true })).toHaveValue('Retry collection');
  await expect(dialog.getByRole('button', { name: '收录', exact: true })).toBeEnabled();
  expect(await reviewsFor(page, source.id)).toHaveLength(0);
  await page.unroute(endpoint);
  await dialog.getByRole('button', { name: '收录', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await reviewsFor(page, source.id)).length).toBe(1);
  expect((await reviewsFor(page, source.id))[0].review.pages).toEqual([2, 3]);
});
