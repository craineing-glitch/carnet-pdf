import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const samplePdf = readFileSync(path.resolve('tests/pdfs/reading-sample.pdf'));

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
}

async function importPdf(page, name) {
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: samplePdf });
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
}

async function expectHome(page) {
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#reader-host .pdf-page')).toHaveCount(0);
  await expect(page.locator('#reader-toolbar')).toBeHidden();
  await expect(page.locator('#notes-panel')).toBeHidden();
  await expect(page.locator('#download')).toBeHidden();
  await expect(page.locator('#highlights-button')).toBeDisabled();
  await expect(page.locator('#welcome')).toContainText('Sensation');
  await expect(page.locator('#welcome')).toContainText('Arthur Rimbaud');
}

test('home displays the poem and brand returns without reloading or losing the saved page', async ({ page }) => {
  await ready(page);
  await expectHome(page);
  const name = 'Return home keeps my place.pdf';
  await importPdf(page, name);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('#page-number')).toHaveValue('2');
  await expect.poll(async () => {
    const library = await (await page.request.get('/api/library')).json();
    return library.documents.find(doc => doc.name === name)?.lastPage;
  }).toBe(2);
  await page.getByRole('button', { name: '查看高亮笔记', exact: true }).click();
  await expect(page.locator('#notes-panel')).toBeVisible();

  await page.evaluate(() => { window.homeNavigationSentinel = 'same document'; });
  await page.locator('.brand').click();
  await expectHome(page);
  expect(await page.evaluate(() => window.homeNavigationSentinel)).toBe('same document');
  expect(await page.evaluate(() => sessionStorage.getItem('carnet-pdf-current'))).toBeFalsy();

  await page.reload();
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await expectHome(page);
  await page.getByRole('button', { name: '打开 ' + name, exact: true }).click();
  await expect(page.locator('#page-number')).toHaveValue('2');
  await expect(page.locator('.textLayer span').filter({ hasText: 'A little room' })).toBeVisible();
});

test('reader enters native fullscreen, Escape exits, and the current page survives', async ({ page }) => {
  await ready(page);
  await importPdf(page, 'Fullscreen native.pdf');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('#page-number')).toHaveValue('2');
  await page.getByRole('button', { name: '全屏阅读', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  await expect(page.locator('.library')).toBeHidden();
  await expect(page.locator('#fullscreen-button')).toHaveAttribute('aria-label', '退出全屏');
  await expect(page.locator('#page-number')).toHaveValue('2');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(page.locator('#fullscreen-button')).toHaveAttribute('aria-label', '全屏阅读');
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#page-number')).toHaveValue('2');
  await expect(page.locator('.brand')).toBeVisible();
});

test('fullscreen button exits fullscreen and returning home clears fullscreen state', async ({ page }) => {
  await ready(page);
  await importPdf(page, 'Fullscreen home cleanup.pdf');
  await page.getByRole('button', { name: '全屏阅读', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出全屏', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);

  await page.getByRole('button', { name: '全屏阅读', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出全屏', exact: true })).toBeVisible();
  await page.locator('.brand').click();
  await expectHome(page);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

test('denied native fullscreen falls back to a full-window reader and Escape restores the layout', async ({ page }) => {
  await ready(page);
  await importPdf(page, 'Fullscreen fallback.pdf');
  await page.evaluate(() => {
    document.documentElement.requestFullscreen = () => Promise.reject(new DOMException('Fullscreen denied by embedding policy', 'NotAllowedError'));
  });
  await page.getByRole('button', { name: '全屏阅读', exact: true }).click();
  await expect(page.locator('#fullscreen-button')).toHaveAttribute('aria-label', '退出全屏');
  await expect(page.locator('html')).toHaveClass(/reading-fullscreen/);
  await expect(page.locator('.library')).toBeHidden();
  await expect(page.locator('.app-footer')).toBeHidden();
  await expect(page.locator('.brand')).toBeVisible();
  await expect.poll(async () => {
    const shell = await page.locator('.reader-shell').boundingBox();
    const viewport = page.viewportSize();
    return shell.x < 48 && shell.width > viewport.width - 96 && shell.height > viewport.height - 130;
  }).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#fullscreen-button')).toHaveAttribute('aria-label', '全屏阅读');
  await expect(page.locator('html')).not.toHaveClass(/reading-fullscreen/);
  await expect.poll(async () => (await page.locator('.reader-shell').boundingBox()).x).toBeGreaterThan(100);
  await expect(page.locator('.brand')).toBeVisible();
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
});
