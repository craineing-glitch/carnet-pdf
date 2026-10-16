import { test, expect } from '@playwright/test';
import { textPdf } from '../fixtures.mjs';

const library = async page => (await page.request.get('/api/library')).json();
const row = (page, id) => page.locator(`[data-drag-document="${id}"]`);
const names = page => page.locator('#filters .file-name');
const sorting = {
  newest: '导入时间：最新在前', oldest: '导入时间：最早在前',
  'name-asc': '名称：A–Z', 'name-desc': '名称：Z–A', manual: '手动排序',
};

async function session(page) {
  const { token } = await (await page.request.get('/api/session')).json();
  const headers = { 'x-carnet-token': token };
  await page.request.patch('/api/settings', { headers, data: { screensaver: { enabled: false, minutes: 1 } } });
  return headers;
}

async function importPdf(page, headers, name) {
  const response = await page.request.post('/api/documents', {
    headers: { ...headers, 'Content-Type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
    data: textPdf('A document kept intact while arranging the library.'),
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).documents.find(document => document.name === name);
}

async function ready(page, query = '') {
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  if (query) await page.locator('#search').fill(query);
}

async function chooseSort(page, mode) {
  await page.getByRole('button', { name: '文件排序', exact: true }).click();
  await page.getByRole('menuitemradio', { name: sorting[mode], exact: true }).click();
  await expect.poll(async () => (await library(page)).settings.librarySort).toBe(mode);
}

async function startDrag(page, source) {
  const box = await source.boundingBox();
  expect(box).toBeTruthy();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 12, y, { steps: 3 });
  await expect(source).toHaveClass(/\bdragging\b/);
}

test('file sorting changes visible order and persists the selected order after reload', async ({ page }) => {
  const headers = await session(page), prefix = `Sorting ${Date.now()} `;
  await importPdf(page, headers, prefix + 'Beta.pdf');
  await importPdf(page, headers, prefix + 'Alpha.pdf');
  await importPdf(page, headers, prefix + 'Gamma.pdf');
  await ready(page, prefix);

  for (const [mode, expected] of [
    ['newest', ['Gamma.pdf', 'Alpha.pdf', 'Beta.pdf']],
    ['oldest', ['Beta.pdf', 'Alpha.pdf', 'Gamma.pdf']],
    ['name-asc', ['Alpha.pdf', 'Beta.pdf', 'Gamma.pdf']],
    ['name-desc', ['Gamma.pdf', 'Beta.pdf', 'Alpha.pdf']],
  ]) {
    await chooseSort(page, mode);
    await expect(names(page)).toHaveText(expected.map(name => prefix + name));
  }
  await page.reload();
  await page.locator('#search').fill(prefix);
  await expect(names(page)).toHaveText(['Gamma.pdf', 'Beta.pdf', 'Alpha.pdf'].map(name => prefix + name));
  await page.locator('#library-sort').click();
  await expect(page.getByRole('menuitemradio', { name: sorting['name-desc'], exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await chooseSort(page, 'manual');
  await expect(names(page)).toHaveCount(3);
});

test('native row drag reorders files before and after neighbours and survives reload', async ({ page }) => {
  const headers = await session(page), prefix = `Manual ${Date.now()} `;
  const first = await importPdf(page, headers, prefix + 'First.pdf');
  const second = await importPdf(page, headers, prefix + 'Second.pdf');
  const third = await importPdf(page, headers, prefix + 'Third.pdf');
  await ready(page, prefix);
  await chooseSort(page, 'oldest');

  await startDrag(page, row(page, third.id));
  try {
    const target = await row(page, first.id).boundingBox();
    await page.mouse.move(target.x + target.width / 2, target.y + 10, { steps: 8 });
    await page.mouse.move(target.x + target.width / 2 + 1, target.y + 10);
    await expect(row(page, first.id)).toHaveClass(/\breorder-before\b/);
  } finally { await page.mouse.up(); }
  await expect(names(page)).toHaveText([third.name, first.name, second.name]);
  await expect.poll(async () => (await library(page)).settings.librarySort).toBe('manual');

  await startDrag(page, row(page, third.id));
  try {
    const target = await row(page, first.id).boundingBox();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height - 10, { steps: 8 });
    await page.mouse.move(target.x + target.width / 2 + 1, target.y + target.height - 10);
    await expect(row(page, first.id)).toHaveClass(/\breorder-after\b/);
  } finally { await page.mouse.up(); }
  await expect(names(page)).toHaveText([first.name, third.name, second.name]);
  await page.reload();
  await page.locator('#search').fill(prefix);
  await expect(names(page)).toHaveText([first.name, third.name, second.name]);
  const final = await library(page);
  for (const document of [first, second, third]) {
    expect(final.documents.find(item => item.id === document.id).categoryId).toBe('');
    expect((await page.request.get(`/api/documents/${document.id}/file`)).ok()).toBe(true);
  }
});

test('empty trash confirms all trashed files even when search hides some and preserves active PDFs', async ({ page }) => {
  const headers = await session(page), prefix = `Trash ${Date.now()} `;
  const visible = await importPdf(page, headers, prefix + 'Visible.pdf');
  const hidden = await importPdf(page, headers, prefix + 'Hidden.pdf');
  const active = await importPdf(page, headers, prefix + 'Keep.pdf');
  const original = await (await page.request.get(`/api/documents/${active.id}/file`)).body();
  for (const document of [visible, hidden]) expect((await page.request.delete(`/api/documents/${document.id}`, { headers })).ok()).toBe(true);
  await ready(page);
  await page.locator('#trash-tab').click();
  await page.locator('#search').fill(visible.name);
  await expect(names(page)).toHaveText([visible.name]);
  await page.getByRole('button', { name: '清空回收站', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '清空回收站', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  for (const document of [visible, hidden]) expect((await page.request.get(`/api/documents/${document.id}/file`)).ok()).toBe(true);

  await page.locator('#empty-trash').click();
  await confirmation.getByRole('button', { name: '永久清空', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect.poll(async () => (await library(page)).documents.filter(document => document.deletedAt).length).toBe(0);
  for (const document of [visible, hidden]) expect((await page.request.get(`/api/documents/${document.id}/file`)).status()).toBe(404);
  expect(await (await page.request.get(`/api/documents/${active.id}/file`)).body()).toEqual(original);
  await page.reload();
  expect((await library(page)).documents.find(document => document.id === active.id).deletedAt).toBeUndefined();
  expect((await library(page)).documents.some(document => document.id === visible.id || document.id === hidden.id)).toBe(false);
});

test('a failed empty-trash request leaves confirmation open and supports retry', async ({ page }) => {
  const headers = await session(page);
  const document = await importPdf(page, headers, `Trash retry ${Date.now()}.pdf`);
  await page.request.delete(`/api/documents/${document.id}`, { headers });
  await ready(page);
  await page.locator('#trash-tab').click();
  await page.locator('#empty-trash').click();
  const confirmation = page.getByRole('dialog', { name: '清空回收站', exact: true });
  await page.route('**/api/trash', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '本机暂时无法保存，请重试。' }) }), { times: 1 });
  await confirmation.getByRole('button', { name: '永久清空', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('本机暂时无法保存');
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('button', { name: '永久清空', exact: true })).toBeEnabled();
  expect((await page.request.get(`/api/documents/${document.id}/file`)).ok()).toBe(true);
  await confirmation.getByRole('button', { name: '永久清空', exact: true }).click();
  await expect(confirmation).toBeHidden();
  expect((await page.request.get(`/api/documents/${document.id}/file`)).status()).toBe(404);
});

test('holding a native drag at the sidebar edge scrolls to an offscreen category and moves the PDF', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const headers = await session(page), prefix = `Long shelf ${Date.now()} `;
  for (let index = 0; index < 22; index++) await importPdf(page, headers, prefix + String(index).padStart(2, '0') + '.pdf');
  const source = await importPdf(page, headers, prefix + 'Dragged.pdf');
  const categoryResponse = await page.request.post('/api/categories', { headers, data: { name: prefix + 'Destination' } });
  expect(categoryResponse.ok()).toBe(true);
  const category = (await categoryResponse.json()).categories.find(item => item.name === prefix + 'Destination');
  await ready(page, prefix);
  // Set sorting through UI so the source is visible without any scripted scroll.
  await chooseSort(page, 'newest');
  const viewport = page.locator('#filters'), target = page.locator(`[data-filter="${category.id}"]`);
  const bounds = await viewport.boundingBox(), initialTarget = await target.boundingBox();
  expect(initialTarget.y).toBeGreaterThan(bounds.y + bounds.height);
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(0);

  await startDrag(page, row(page, source.id));
  try {
    const edgeX = bounds.x + bounds.width / 2, edgeY = bounds.y + bounds.height - 8;
    await page.mouse.move(edgeX, edgeY, { steps: 12 });
    await page.mouse.move(edgeX + 1, edgeY);
    // No scrollIntoView, wheel, dragTo or scrollTop writes: the held pointer must
    // make the real application reveal the destination by edge auto-scrolling.
    await expect.poll(async () => viewport.evaluate(element => element.scrollTop), { timeout: 12000 }).toBeGreaterThan(200);
    await expect.poll(async () => {
      const box = await target.boundingBox();
      return box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height;
    }, { timeout: 12000 }).toBe(true);
    const destination = await target.boundingBox();
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 6 });
    await page.mouse.move(destination.x + destination.width / 2 + 1, destination.y + destination.height / 2);
    await expect(target).toHaveClass(/\bcategory-drop-target\b/);
  } finally { await page.mouse.up(); }
  await expect.poll(async () => (await library(page)).documents.find(document => document.id === source.id).categoryId).toBe(category.id);
  await page.reload();
  expect((await library(page)).documents.find(document => document.id === source.id).categoryId).toBe(category.id);
});
