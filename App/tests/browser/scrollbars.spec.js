import { test, expect } from '@playwright/test';
import path from 'node:path';

async function openSample(page) {
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.locator('#file-input').setInputFiles(path.resolve('tests/pdfs/reading-sample.pdf'));
  await expect(page.locator('#reader-host')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.textLayer span').first()).toBeVisible();
}

async function scrollMetrics(page) {
  return page.locator('#reader-host').evaluate(host => {
    const bounds = host.getBoundingClientRect();
    return {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      verticalBar: host.offsetWidth - host.clientWidth,
      horizontalBar: host.offsetHeight - host.clientHeight,
      clientWidth: host.clientWidth, clientHeight: host.clientHeight,
      scrollWidth: host.scrollWidth, scrollHeight: host.scrollHeight,
      left: host.scrollLeft, top: host.scrollTop,
    };
  });
}

test('PDF scrollbars have usable tracks and dragging either thumb moves the page', async ({ page }, testInfo) => {
  await openSample(page);
  const host = page.locator('#reader-host');
  const initial = await scrollMetrics(page);
  expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
  expect(initial.verticalBar, 'vertical thumb needs a visible, usable hit area').toBeGreaterThanOrEqual(12);
  expect(initial.scrollWidth - initial.clientWidth, 'fit width must not clip the PDF').toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect(host).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => (await scrollMetrics(page)).horizontalBar).toBeGreaterThanOrEqual(12);
  await host.evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0; });
  const zoomed = await scrollMetrics(page);
  expect(zoomed.scrollWidth - zoomed.clientWidth).toBeGreaterThan(50);
  const leftEdge = await page.locator('.pdf-page').first().boundingBox();
  expect(leftEdge.x).toBeGreaterThanOrEqual(zoomed.x);
  await testInfo.attach('reader-visible-scrollbars', { body: await host.screenshot(), contentType: 'image/png' });

  const horizontalThumbWidth = zoomed.clientWidth * zoomed.clientWidth / zoomed.scrollWidth;
  await page.mouse.move(zoomed.x + horizontalThumbWidth / 2, zoomed.y + zoomed.clientHeight + zoomed.horizontalBar / 2);
  await page.mouse.down();
  await page.mouse.move(zoomed.x + horizontalThumbWidth / 2 + 80, zoomed.y + zoomed.clientHeight + zoomed.horizontalBar / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => host.evaluate(el => el.scrollLeft)).toBeGreaterThan(30);

  const verticalThumbHeight = zoomed.clientHeight * zoomed.clientHeight / zoomed.scrollHeight;
  await page.mouse.move(zoomed.x + zoomed.clientWidth + zoomed.verticalBar / 2, zoomed.y + verticalThumbHeight / 2);
  await page.mouse.down();
  await page.mouse.move(zoomed.x + zoomed.clientWidth + zoomed.verticalBar / 2, zoomed.y + verticalThumbHeight / 2 + 100, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => host.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await expect(page.locator('body')).toHaveJSProperty('scrollTop', 0);

  await page.getByRole('button', { name: '适合宽度', exact: true }).click();
  await expect(host).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => { const value = await scrollMetrics(page); return value.scrollWidth - value.clientWidth; }).toBeLessThanOrEqual(1);
});
