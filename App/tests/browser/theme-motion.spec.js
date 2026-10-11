import { test, expect } from '@playwright/test';
import { textPdf } from '../fixtures.mjs';

async function open(page, theme = 'shinchan') {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await chooseTheme(page, theme);
}

async function chooseTheme(page, theme) {
  await page.getByRole('button', { name: '切换环境', exact: true }).click();
  await page.locator(`[data-theme-id="${theme}"]`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('#effects canvas')).toHaveCount(1);
}

async function pixels(page) {
  return page.locator('#effects canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0, hash = 2166136261;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3]) painted++;
      hash = Math.imul(hash ^ data[index], 16777619);
      hash = Math.imul(hash ^ data[index + 1], 16777619);
      hash = Math.imul(hash ^ data[index + 2], 16777619);
      hash = Math.imul(hash ^ data[index + 3], 16777619);
    }
    return { painted, hash: hash >>> 0, frame: canvas.dataset.frame || '' };
  });
}

async function expectMoving(page) {
  await expect.poll(async () => (await pixels(page)).painted).toBeGreaterThan(0);
  const first = await pixels(page);
  await page.waitForTimeout(200);
  await expect.poll(async () => (await pixels(page)).hash).not.toBe(first.hash);
}

async function expectStopped(page) {
  await expect.poll(async () => (await pixels(page)).painted).toBe(0);
  const first = await pixels(page);
  await page.waitForTimeout(200);
  expect(await pixels(page)).toEqual(first);
}

test('all four themes paint actual moving pixels in one background canvas', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await expectMoving(page);
  for (const theme of ['paris', 'mediterranean', 'rose-dusk', 'shinchan']) {
    await chooseTheme(page, theme);
    await expectMoving(page);
  }
  await expect(page.locator('#effects')).toHaveCSS('pointer-events', 'none');
  expect(errors).toEqual([]);
});

async function photoSamples(page, theme, points) {
  return page.locator('#effects canvas').evaluate(async (canvas, { theme, points }) => {
    const image = new Image();
    image.src = theme === 'mediterranean' ? '/assets/terrace.png' : '/assets/shinchan.png';
    await image.decode();
    const scale = Math.max(innerWidth / image.width, innerHeight / image.height);
    const width = image.width * scale, height = image.height * scale;
    const left = (innerWidth - width) * (theme === 'shinchan' ? 1 : .5);
    const top = (innerHeight - height) * (theme === 'mediterranean' ? .58 : .5);
    const dpr = canvas.width / innerWidth, ctx = canvas.getContext('2d');
    return points.map(([x, y]) => {
      const sample = ctx.getImageData(Math.round((left + x * width) * dpr) - 10,
        Math.round((top + y * height) * dpr) - 10, 20, 20).data;
      return Array.from(sample, (channel, index) => index % 4 === 3 ? channel : channel * sample[index - index % 4 + 3] / 255);
    });
  }, { theme, points });
}

test('water moves inside the sea and river while buildings and the character stay still', async ({ page }) => {
  await open(page, 'mediterranean');
  const delta = (before, after) => after.reduce((sum, value, index) => sum + Math.abs(value - before[index]), 0) / after.length;
  for (const [theme, points] of [
    ['mediterranean', [[.15, .53], [.88, .57]]],
    ['shinchan', [[.35, .80], [.88, .65]]],
  ]) {
    await chooseTheme(page, theme);
    await expectMoving(page);
    const before = await photoSamples(page, theme, points);
    // Compare actual image-space change, not simply a counter or a flashing dot.
    await expect.poll(async () => {
      const after = await photoSamples(page, theme, points);
      const waterChange = delta(before[0], after[0]);
      const protectedChange = delta(before[1], after[1]);
      return waterChange - protectedChange * 1.5;
    }, { timeout: 15000 }).toBeGreaterThan(.05);
  }
});

test('motion switch clears animation, stays stopped after reload, and resumes', async ({ page }) => {
  await open(page, 'paris');
  await expectMoving(page);
  const toggle = page.getByRole('button', { name: '切换环境动画', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expectStopped(page);
  await page.reload();
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await expect(toggle).toHaveText('动态 · 关');
  await expectStopped(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expectMoving(page);
});

test('live reduced-motion preference stops drawing and resumes without reload', async ({ page }) => {
  await open(page, 'mediterranean');
  await expectMoving(page);
  const toggle = page.getByRole('button', { name: '切换环境动画', exact: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('动态 · 系统已关闭');
  await expectStopped(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expectMoving(page);
});

test('PDF mouse selection and persistent highlight work while the scene animates', async ({ page }) => {
  await open(page, 'paris');
  await page.locator('#file-input').setInputFiles({
    name: 'Animated reading.pdf', mimeType: 'application/pdf',
    buffer: textPdf('Bonjour le monde. Hello world.'),
  });
  const text = page.locator('#reader-host .textLayer span').first();
  await expect(text).toBeVisible();
  await expectMoving(page);
  const points = await text.evaluate(span => {
    const node = span.firstChild, range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 1);
    const start = range.getBoundingClientRect();
    range.setStart(node, node.length - 1); range.setEnd(node, node.length);
    const end = range.getBoundingClientRect();
    return [{ x: start.left + .5, y: start.top + start.height / 2 },
      { x: end.right - .5, y: end.top + end.height / 2 }];
  });
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection().toString())).toContain('Bonjour le monde');
  await page.mouse.click(points[1].x, points[1].y, { button: 'right' });
  await page.getByRole('menuitem', { name: '高亮所选文字', exact: true }).click();
  await expect(page.locator('[data-highlight-id]').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-highlight-id]').first()).toBeVisible();
  await expectMoving(page);
});
