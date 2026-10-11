import { test, expect } from '@playwright/test';
import { textPdf } from '../fixtures.mjs';

const quote = 'Save this note before changing documents.';
const library = async page => (await page.request.get('/api/library')).json();

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  const all = page.locator('[data-filter=""]');
  if (await all.getAttribute('aria-expanded') !== 'true') await all.click();
}

async function importPdf(page, name) {
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: textPdf(quote) });
  await expect(page.locator('#document-title')).toHaveText(name);
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.textLayer span').filter({ hasText: quote }).first()).toBeVisible();
  return (await library(page)).documents.find(document => document.name === name).id;
}

async function selectText(page) {
  const text = page.locator('.textLayer span').filter({ hasText: quote }).first();
  await expect(text).toBeVisible();
  const box = await text.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection().toString())).toContain('Save this note');
  return text;
}

async function openComment(page) {
  const text = await selectText(page);
  await text.click({ button: 'right' });
  await page.locator('#context-menu').getByRole('menuitem', { name: '添加批注', exact: true }).click();
  await page.getByLabel('批注内容', { exact: true }).fill('A note saved on the original document.');
}

async function delaySave(page, id, failure = false) {
  let announce, release;
  const received = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const url = `**/api/documents/${id}/highlights`;
  await page.route(url, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    announce();
    await gate;
    if (failure) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Delayed save failed.' }) });
    else await route.fulfill({ response: await route.fetch() });
  });
  return { received, release };
}

test('returning home during a pending annotation save hides the card and a late failure cannot reopen or refocus it', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  const id = await importPdf(page, 'Delayed annotation home.pdf');
  await openComment(page);
  const delayed = await delaySave(page, id, true);
  try {
    await page.getByRole('button', { name: '保存批注', exact: true }).click();
    await delayed.received;
    await page.locator('.brand').click();
    await expect(page.locator('#welcome')).toBeVisible();
    await expect(page.locator('#annotation-editor')).toBeHidden();
    await page.locator('#search').focus();
    delayed.release();
    await expect(page.locator('#save-status')).toHaveText('保存失败');
    await expect(page.locator('#welcome')).toBeVisible();
    await expect(page.locator('#annotation-editor')).toBeHidden();
    await expect(page.locator('#search')).toBeFocused();
    expect((await library(page)).documents.find(document => document.id === id).highlights).toEqual([]);
    expect(errors).toEqual([]);
  } finally { delayed.release(); }
});

test('a late successful annotation save belongs to the original file and preserves the new file selection', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  const firstId = await importPdf(page, 'Delayed annotation first.pdf');
  const secondId = await importPdf(page, 'Delayed annotation second.pdf');
  await page.getByRole('button', { name: '打开 Delayed annotation first.pdf', exact: true }).click();
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
  await openComment(page);
  const delayed = await delaySave(page, firstId);
  try {
    await page.getByRole('button', { name: '保存批注', exact: true }).click();
    await delayed.received;
    await page.getByRole('button', { name: '打开 Delayed annotation second.pdf', exact: true }).click();
    await expect(page.locator('#document-title')).toHaveText('Delayed annotation second.pdf');
    await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#annotation-editor')).toBeHidden();
    await selectText(page);
    const selected = await page.evaluate(() => getSelection().toString());
    delayed.release();
    await expect(page.locator('#save-status')).toHaveText('已保存');
    await expect.poll(async () => (await library(page)).documents.find(document => document.id === firstId).highlights.length).toBe(1);
    await expect(page.locator('#document-title')).toHaveText('Delayed annotation second.pdf');
    await expect(page.locator('#annotation-editor')).toBeHidden();
    expect(await page.evaluate(() => getSelection().toString())).toBe(selected);
    const documents = (await library(page)).documents;
    expect(documents.find(document => document.id === secondId).highlights).toEqual([]);
    expect(documents.find(document => document.id === firstId).highlights[0].note).toBe('A note saved on the original document.');
    expect(errors).toEqual([]);
  } finally { delayed.release(); }
});
