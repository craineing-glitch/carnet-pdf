import { test, expect } from '@playwright/test';

async function mountScreensaver(page) {
  await page.route('**/screensaver-test', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/screensaver.css"></head><body style="margin:0"><button id="underneath" style="position:fixed;left:20px;top:20px;width:200px;height:80px">Underlying action</button><dialog id="draft"><input aria-label="Draft" value="Keep my unfinished annotation"></dialog><dialog id="screensaver" aria-label="屏保"></dialog></body></html>` }));
  await page.goto('/screensaver-test');
  await page.clock.install({ time: new Date('2026-10-12T09:41:00') });
  await page.clock.pauseAt(new Date('2026-10-12T09:41:00'));
  const available = await page.evaluate(async () => {
    const module = await import('/src/screensaver.js').catch(() => null);
    if (!module?.IdleScreensaver) return false;
    window.actions = 0;
    window.saverTransitions = [];
    window.wakeEvents = [];
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'touchstart', 'touchend', 'touchcancel']) window.addEventListener(type, event => window.wakeEvents.push({ type, active: window.saver?.active, x: event.clientX, y: event.clientY }), true);
    document.querySelector('#underneath').onclick = () => window.actions++;
    window.saverSettings = { enabled: true, minutes: 1 };
    window.saverTheme = { id: 'mediterranean', image: '/assets/terrace.png', quote: 'Chaque page ouvre un nouvel horizon.' };
    window.saver = new module.IdleScreensaver({
      element: document.querySelector('#screensaver'),
      getTheme: () => window.saverTheme,
      getSettings: () => window.saverSettings,
      onShow: () => window.saverTransitions.push('show'),
      onHide: () => window.saverTransitions.push('hide'),
    });
    window.saver.start();
    return true;
  });
  expect(available, 'IdleScreensaver module must be implemented').toBe(true);
}

test('idle deadline is one minute; activity resets it but unchanged background saves do not', async ({ page }, testInfo) => {
  await mountScreensaver(page);
  await page.clock.runFor(30000);
  await page.evaluate(() => window.saver.configure());
  await page.clock.runFor(29999);
  await expect(page.locator('#screensaver')).toBeHidden();
  await page.clock.runFor(1);
  await expect(page.locator('#screensaver')).toBeVisible();
  await expect(page.locator('#screensaver time')).toHaveText('09:42');
  await expect(page.locator('.screensaver-date')).toContainText('octobre');
  await expect(page.locator('.screensaver-quote')).toHaveText('Chaque page ouvre un nouvel horizon.');
  const bounds = await page.locator('#screensaver').boundingBox();
  expect(bounds).toEqual({ x: 0, y: 0, width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('screensaver.png') });
  await page.mouse.move(600, 500);
  await expect(page.locator('#screensaver')).toBeHidden();
  await page.clock.runFor(45000);
  await page.keyboard.press('Shift');
  await page.clock.runFor(45000);
  await expect(page.locator('#screensaver')).toBeHidden();
  await page.clock.runFor(15000);
  await expect(page.locator('#screensaver')).toBeVisible();
});

test('waking click and Escape cannot activate controls or dismiss the unfinished dialog beneath', async ({ page }) => {
  await mountScreensaver(page);
  await page.mouse.move(60, 60);
  await page.evaluate(() => window.saver.show());
  await page.mouse.click(60, 60);
  await expect(page.locator('#screensaver')).toBeHidden();
  expect(await page.evaluate(() => window.actions), JSON.stringify(await page.evaluate(() => window.wakeEvents))).toBe(0);
  await page.mouse.click(60, 60);
  expect(await page.evaluate(() => window.actions)).toBe(1);
  await page.evaluate(() => { document.querySelector('#draft').showModal(); window.saver.show(); });
  await page.keyboard.press('Escape');
  await expect(page.locator('#screensaver')).toBeHidden();
  await expect(page.locator('#draft')).toBeVisible();
  await expect(page.getByLabel('Draft')).toHaveValue('Keep my unfinished annotation');
  await page.evaluate(() => window.saver.show());
  await page.keyboard.press('X');
  await expect(page.getByLabel('Draft')).toHaveValue('Keep my unfinished annotation');
});

test('disabled screensaver permits preview and a changed waiting time is respected', async ({ page }) => {
  await mountScreensaver(page);
  await page.evaluate(() => { window.saverSettings = { enabled: false, minutes: 2 }; window.saver.configure(); });
  await page.clock.runFor(180000);
  await expect(page.locator('#screensaver')).toBeHidden();
  await page.evaluate(() => window.saver.show());
  await expect(page.locator('#screensaver')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.saverSettings = { enabled: true, minutes: 2 }; window.saver.configure(); });
  await page.clock.runFor(119999);
  await expect(page.locator('#screensaver')).toBeHidden();
  await page.clock.runFor(1);
  await expect(page.locator('#screensaver')).toBeVisible();
  await page.evaluate(() => { window.saverTheme = { image: '/assets/rose-dusk.webp', quote: 'Garder une trace de ce soir.' }; window.saver.configure(); });
  await expect(page.locator('.screensaver-quote')).toHaveText('Garder une trace de ce soir.');
  await expect(page.locator('.screensaver-photo')).toHaveCSS('background-image', /rose-dusk\.webp/);
  await page.evaluate(() => window.saver.destroy());
  await expect(page.locator('#screensaver')).toBeHidden();
  await page.clock.runFor(180000);
  await expect(page.locator('#screensaver')).toBeHidden();
});

test('wake consumes the whole key gesture and wheel input without changing the draft', async ({ page }) => {
  await mountScreensaver(page);
  await page.evaluate(() => {
    window.leakedKeys = [];
    document.addEventListener('keydown', event => window.leakedKeys.push(event.key));
    document.addEventListener('keyup', event => window.leakedKeys.push(event.key));
    document.querySelector('#draft').showModal();
    document.querySelector('#draft input').focus();
    window.saver.show();
  });
  await page.keyboard.press('X');
  await expect(page.getByLabel('Draft')).toHaveValue('Keep my unfinished annotation');
  expect(await page.evaluate(() => window.leakedKeys)).toEqual([]);
  await page.keyboard.press('Y');
  expect(await page.evaluate(() => window.leakedKeys)).toEqual(['Y', 'Y']);
  await page.evaluate(() => window.saver.show());
  await page.mouse.wheel(0, 450);
  await expect(page.locator('#screensaver')).toBeHidden();
  await expect(page.locator('#draft')).toBeVisible();
  expect(await page.evaluate(() => window.saverTransitions)).toEqual(['show', 'hide', 'show', 'hide']);
});

test('hidden pages suspend idle and clock updates, then start a fresh wait when visible', async ({ page }) => {
  await mountScreensaver(page);
  await page.clock.runFor(45000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(180000);
  await expect(page.locator('#screensaver')).toBeHidden();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(59999);
  await expect(page.locator('#screensaver')).toBeHidden();
  await page.clock.runFor(1);
  await expect(page.locator('#screensaver')).toBeVisible();
  const timeBeforeHiding = await page.locator('#screensaver time').textContent();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(180000);
  await expect(page.locator('#screensaver time')).toHaveText(timeBeforeHiding);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#screensaver time')).not.toHaveText(timeBeforeHiding);
  await page.keyboard.press('Escape');
  const timeBeforeIdle = await page.locator('#screensaver time').textContent();
  await page.clock.runFor(45000);
  await expect(page.locator('#screensaver time')).toHaveText(timeBeforeIdle);
});

test('the continuing wake wheel gesture cannot scroll the reading surface', async ({ page }) => {
  await mountScreensaver(page);
  await page.evaluate(() => {
    window.wheelActions = 0;
    document.body.style.height = '3000px';
    document.addEventListener('wheel', () => window.wheelActions++);
    window.saver.show();
  });
  await page.mouse.wheel(0, 500);
  await page.clock.runFor(30);
  await page.mouse.wheel(0, 500);
  await page.clock.runFor(30);
  await page.mouse.wheel(0, 500);
  expect(await page.evaluate(() => window.wheelActions)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.clock.runFor(400);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => page.evaluate(() => window.wheelActions)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test.describe('touch wake', () => {
  test.use({ hasTouch: true });
  test('the first tap wakes without activating the button underneath', async ({ page }) => {
    await mountScreensaver(page);
    await page.evaluate(() => window.saver.show());
    await page.touchscreen.tap(60, 60);
    await expect(page.locator('#screensaver')).toBeHidden();
    expect(await page.evaluate(() => window.actions)).toBe(0);
    await page.touchscreen.tap(60, 60);
    expect(await page.evaluate(() => window.actions), JSON.stringify(await page.evaluate(() => window.wakeEvents))).toBe(1);
  });
});

test('screen settings persist and preview preserves their unsaved draft', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.locator('#screensaver-settings').click();
  const settings = page.getByRole('dialog', { name: '屏保设置', exact: true });
  await settings.getByLabel('开启屏保', { exact: true }).check();
  await settings.getByLabel('等待时间（分钟）', { exact: true }).fill('3');
  await settings.getByRole('button', { name: '预览屏保', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '屏保', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel('等待时间（分钟）', { exact: true })).toHaveValue('3');
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await expect(settings).toBeHidden();
  await page.reload();
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.locator('#screensaver-settings').click();
  await expect(settings.getByLabel('开启屏保', { exact: true })).toBeChecked();
  await expect(settings.getByLabel('等待时间（分钟）', { exact: true })).toHaveValue('3');
  await settings.getByLabel('开启屏保', { exact: true }).uncheck();
  await settings.getByRole('button', { name: '保存', exact: true }).click();
});
