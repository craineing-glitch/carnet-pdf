import { test, expect } from '@playwright/test';
import path from 'node:path';

async function openSample(page) {
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.locator('[data-filter="en"]').click();
  await page.locator('#file-input').setInputFiles(path.resolve('tests/pdfs/reading-sample.pdf'));
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-page-number="1"] .textLayer span').first()).toBeVisible();
}

test('categories expand in place, four themes are available, and Ctrl+wheel zooms just the PDF', async ({ page }) => {
  await openSample(page);
  await expect(page.locator('#import-category')).toHaveCount(0);
  const category = page.locator('[data-filter="en"]');
  await expect(category).toHaveAttribute('aria-expanded', 'true');
  await expect(category.locator('xpath=ancestor::section').locator('.file-row').first()).toBeVisible();
  await category.click();
  await expect(category).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.file-row')).toHaveCount(0);
  await category.click();
  const before = await page.locator('.app-header').boundingBox();
  const pdfBefore = await page.locator('.pdf-page').first().boundingBox();
  const host = await page.locator('#reader-host').boundingBox();
  await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await page.locator('.pdf-page').first().boundingBox()).width).toBeGreaterThan(pdfBefore.width);
  expect(await page.locator('.app-header').boundingBox()).toEqual(before);
  await page.getByRole('button', { name: '切换环境', exact: true }).click();
  await expect(page.locator('.theme-card')).toHaveCount(4);
  await page.locator('[data-theme-id="rose-dusk"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'rose-dusk');
});

test('highlight colors, themed notes and bookmarks survive reload and can be removed', async ({ page }) => {
  await openSample(page);
  const text = page.locator('[data-page-number="1"] .textLayer span').filter({ hasText: 'Lire,' }).first();
  await text.evaluate(el => { const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range); });
  await text.click({ button: 'right' });
  await page.locator('#context-menu').getByRole('button', { name: '蓝色' }).click();
  await expect(page.locator('[data-highlight-id]').first()).toHaveCSS('background-color', 'rgb(159, 200, 255)');
  await page.getByRole('button', { name: '查看高亮笔记' }).click();
  await expect(page.locator('#notes-panel')).toBeVisible();
  await page.locator('#notes-panel .note-item').first().getByRole('button', { name: '粉色' }).click();
  await expect(page.locator('[data-highlight-id]').first()).toHaveCSS('background-color', 'rgb(245, 170, 200)');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('#page-number')).toHaveValue('2');
  await expect(page.locator('#bookmark-button')).toBeEnabled();
  await page.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect(page.getByRole('button', { name: '移除书签', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('#page-number')).toHaveValue('2');
  await expect(page.getByRole('button', { name: '移除书签', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看高亮笔记' }).click();
  await expect(page.locator('#notes-panel .note-item')).toHaveCount(1);
  await page.locator('#notes-panel [data-jump="1"]').click();
  await expect(page.locator('[data-highlight-id]').first()).toHaveCSS('background-color', 'rgb(245, 170, 200)');
  await page.getByRole('tab', { name: /书签/ }).click();
  await page.locator('#notes-panel [data-jump="2"]').click();
  await expect(page.locator('#page-number')).toHaveValue('2');
  await page.locator('#notes-panel [data-remove-bookmark]').click();
  await expect(page.locator('#notes-panel [data-remove-bookmark]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加书签', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /高亮/ }).click();
  await page.locator('#notes-panel [data-remove-highlight]').click();
  await page.reload();
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-highlight-id]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加书签', exact: true })).toBeVisible();
});
