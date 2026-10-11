import { test, expect } from '@playwright/test';
import { textPdf } from '../fixtures.mjs';

const firstPassage = 'First annotation passage.';
const secondPassage = 'Second annotation passage.';
const sampleText = `${firstPassage}   ${secondPassage}`;
const library = async page => (await page.request.get('/api/library')).json();
const documentById = async (page, id) => (await library(page)).documents.find(document => document.id === id);
const marker = (page, id) => page.locator(`.annotation-marker[data-annotation-id="${id}"]`);

async function openSample(page, name) {
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: textPdf(sampleText) });
  await expect(page.locator('#document-title')).toHaveText(name);
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.textLayer span').filter({ hasText: firstPassage }).first()).toBeVisible();
  return (await library(page)).documents.find(document => document.name === name).id;
}

async function selectPassage(page, passage) {
  const text = page.locator('.textLayer span').filter({ hasText: passage }).first();
  const rect = await text.evaluate((element, selectedText) => {
    const node = element.firstChild;
    const start = node.textContent.indexOf(selectedText);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + selectedText.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const bounds = range.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }, passage);
  await expect.poll(() => page.evaluate(() => getSelection().toString())).toBe(passage);
  return rect;
}

async function addNote(page, documentId, passage, note) {
  const point = await selectPassage(page, passage);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByRole('menuitem', { name: '添加批注', exact: true }).click();
  const card = page.locator('#annotation-editor');
  await card.getByLabel('批注内容', { exact: true }).fill(note);
  await card.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(card).toBeHidden();
  const highlight = (await documentById(page, documentId)).highlights.find(item => item.note === note);
  expect(highlight).toBeTruthy();
  await expect(marker(page, highlight.id)).toBeVisible();
  return highlight;
}

async function expectOnlyNoteDeleted(page, documentId, deleted, retained) {
  const { note, ...preservedHighlight } = deleted;
  const expected = retained ? [preservedHighlight, retained] : [preservedHighlight];
  await expect.poll(async () => (await documentById(page, documentId)).highlights).toEqual(expected);
  await expect(marker(page, deleted.id)).toHaveCount(0);
  await expect(page.locator(`.highlight-layer [data-highlight-id="${deleted.id}"]`).first()).toBeVisible();
  if (retained) await expect(marker(page, retained.id)).toBeVisible();
}

test('deleting from the annotation card removes only the note and persists after reload', async ({ page }) => {
  const id = await openSample(page, 'Delete annotation from card.pdf');
  const deleted = await addNote(page, id, firstPassage, 'Delete this comment, keep its highlight.');
  const retained = await addNote(page, id, secondPassage, 'Keep this separate annotation.');
  await marker(page, deleted.id).click();
  const card = page.locator('#annotation-editor');
  await expect(card.getByRole('button', { name: '删除批注', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '删除批注', exact: true }).click();
  await expect(card).toBeHidden();
  await expectOnlyNoteDeleted(page, id, deleted, retained);
  await page.reload();
  await expectOnlyNoteDeleted(page, id, deleted, retained);
  await marker(page, retained.id).click();
  await expect(card.getByLabel('批注内容', { exact: true })).toHaveValue(retained.note);
});

test('marker context-menu deletion ignores a different selected annotation and preserves both highlights', async ({ page }) => {
  const id = await openSample(page, 'Delete annotation from marker.pdf');
  const retained = await addNote(page, id, firstPassage, 'The selected text must keep this annotation.');
  const deleted = await addNote(page, id, secondPassage, 'Delete only the right-clicked marker.');
  await selectPassage(page, firstPassage);
  await marker(page, deleted.id).click({ button: 'right' });
  const menu = page.locator('#context-menu');
  await expect(menu.getByRole('menuitem', { name: '删除批注', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: '删除批注', exact: true }).click();
  const { note, ...preservedHighlight } = deleted;
  await expect.poll(async () => (await documentById(page, id)).highlights).toEqual([retained, preservedHighlight]);
  await expect(marker(page, deleted.id)).toHaveCount(0);
  await expect(marker(page, retained.id)).toBeVisible();
  await expect(page.locator('.highlight-layer .highlight-group')).toHaveCount(2);
  await page.reload();
  await expect(marker(page, retained.id)).toBeVisible();
  await expect(marker(page, deleted.id)).toHaveCount(0);
  await expect(page.locator('.highlight-layer .highlight-group')).toHaveCount(2);
  expect((await documentById(page, id)).highlights).toEqual([retained, preservedHighlight]);
});

test('failed card deletion retains the note and draft, then succeeds when retried', async ({ page }) => {
  const id = await openSample(page, 'Retry annotation deletion.pdf');
  const original = await addNote(page, id, firstPassage, 'This stored note must survive a failed deletion.');
  await marker(page, original.id).click();
  const card = page.locator('#annotation-editor');
  await card.getByLabel('批注内容', { exact: true }).fill('An unsaved edit stays available after failure.');
  const endpoint = `**/api/documents/${id}/highlights/${original.id}`;
  await page.route(endpoint, route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试：删除批注失败，请重试。' }) })
    : route.continue());
  await expect(card.getByRole('button', { name: '删除批注', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '删除批注', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('删除批注失败');
  await expect(card.getByLabel('批注内容', { exact: true })).toHaveValue('An unsaved edit stays available after failure.');
  await expect(card.getByRole('button', { name: '删除批注', exact: true })).toBeEnabled();
  expect((await documentById(page, id)).highlights).toEqual([original]);
  await expect(marker(page, original.id)).toBeVisible();
  await page.unroute(endpoint);
  await card.getByRole('button', { name: '删除批注', exact: true }).click();
  await expect(card).toBeHidden();
  await expectOnlyNoteDeleted(page, id, original);
});

test('a pending marker deletion blocks reopening that note while another annotation remains editable', async ({ page }) => {
  const id = await openSample(page, 'Pending marker deletion.pdf');
  const deleted = await addNote(page, id, firstPassage, 'This annotation is being deleted.');
  const retained = await addNote(page, id, secondPassage, 'This other annotation can still be edited.');
  let announce, release;
  const received = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/documents/${id}/highlights/${deleted.id}`, async route => {
    if (route.request().method() !== 'PATCH' || route.request().postDataJSON().note !== '') return route.continue();
    announce();
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    await marker(page, deleted.id).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除批注', exact: true }).click();
    await received;
    await marker(page, deleted.id).click();
    const card = page.locator('#annotation-editor');
    await expect(card).toBeHidden();
    await marker(page, retained.id).click();
    const revised = { ...retained, note: 'The other annotation was saved while deletion was pending.' };
    await card.getByLabel('批注内容', { exact: true }).fill(revised.note);
    await card.getByRole('button', { name: '保存批注', exact: true }).click();
    await expect(card).toBeHidden();
    release();
    await expectOnlyNoteDeleted(page, id, deleted, revised);
    await page.reload();
    await expectOnlyNoteDeleted(page, id, deleted, revised);
  } finally { release(); }
});
