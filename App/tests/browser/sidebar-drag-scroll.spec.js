import { test, expect } from '@playwright/test';

async function mountSidebar(page) {
  await page.route('**/sidebar-drag-test', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; } #sidebar { position: absolute; left: 80px; top: 80px; width: 280px; height: 360px; overflow: auto; border: 1px solid; }
    .row { display: block; width: 100%; height: 42px; box-sizing: border-box; border: 0; border-bottom: 1px solid #ccc; background: #f5f5ed; text-align: left; }
    #outside { position: absolute; left: 420px; top: 80px; width: 200px; height: 360px; background: #ddd; }
  </style></head><body><div id="sidebar">${Array.from({ length: 100 }, (_, i) => `<button class="row" draggable="true">Document ${i + 1}</button>`).join('')}</div><div id="outside">Outside sidebar</div></body></html>` }));
  await page.goto('/sidebar-drag-test');
  await page.evaluate(async () => {
    const module = await import('/src/sidebar-drag-scroll.js').catch(() => null);
    window.dragging = false;
    window.nativeStarts = 0;
    window.nativeDrops = 0;
    window.sidebar = document.querySelector('#sidebar');
    window.scroller = module?.createSidebarDragScroll(window.sidebar, { isDragging: () => window.dragging }) ?? { update() {}, stop() {}, destroy() {} };
    sidebar.addEventListener('dragstart', event => {
      window.dragging = true;
      window.nativeStarts++;
      event.dataTransfer.setData('text/plain', event.target.textContent);
      event.dataTransfer.effectAllowed = 'move';
    });
    sidebar.addEventListener('dragover', event => { event.preventDefault(); window.scroller.update(event); });
    document.addEventListener('dragend', () => { window.dragging = false; });
    sidebar.addEventListener('drop', event => { event.preventDefault(); window.nativeDrops++; window.dragging = false; });
  });
}

test('native file dragging keeps scrolling at the lower edge and stops on leaving or dropping', async ({ page }) => {
  await mountSidebar(page);
  await page.mouse.move(150, 100);
  await page.mouse.down();
  await page.mouse.move(160, 120, { steps: 6 });
  await page.mouse.move(180, 390, { steps: 12 });
  await expect.poll(() => page.evaluate(() => window.nativeStarts)).toBe(1);
  // 50 px from the bottom is outside Chromium's tiny built-in drag-scroll hot zone.
  await expect.poll(() => page.locator('#sidebar').evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  const beforeHold = await page.locator('#sidebar').evaluate(el => el.scrollTop);
  await expect.poll(() => page.locator('#sidebar').evaluate(el => el.scrollTop)).toBeGreaterThan(beforeHold + 80);
  await page.mouse.move(470, 390, { steps: 8 });
  const afterLeaving = await page.locator('#sidebar').evaluate(el => el.scrollTop);
  await page.waitForTimeout(200);
  expect(await page.locator('#sidebar').evaluate(el => el.scrollTop)).toBe(afterLeaving);
  await page.mouse.move(180, 390, { steps: 8 });
  await expect.poll(() => page.locator('#sidebar').evaluate(el => el.scrollTop)).toBeGreaterThan(afterLeaving + 60);
  // Finish over a stable row with a native dragover before releasing. During
  // auto-scroll Chromium replaces the row under the stationary pointer.
  await page.mouse.move(180, 250, { steps: 5 });
  await page.mouse.move(181, 250);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.nativeDrops)).toBe(1);
  const afterDrop = await page.locator('#sidebar').evaluate(el => el.scrollTop);
  await page.waitForTimeout(200);
  expect(await page.locator('#sidebar').evaluate(el => el.scrollTop)).toBe(afterDrop);
});

test('one drag update continues scrolling, reverses at the top, and ignores idle or horizontal escape', async ({ page }) => {
  await mountSidebar(page);
  await page.clock.install();
  await page.evaluate(() => {
    window.sidebar.scrollTop = 900;
    window.scroller.update({ clientX: 180, clientY: 425 });
  });
  await page.clock.runFor(300);
  expect(await page.locator('#sidebar').evaluate(el => el.scrollTop)).toBe(900);
  await page.evaluate(() => { window.dragging = true; window.scroller.update({ clientX: 180, clientY: 425 }); });
  await page.clock.runFor(300);
  const down = await page.locator('#sidebar').evaluate(el => el.scrollTop);
  expect(down).toBeGreaterThan(1000);
  await page.evaluate(() => window.scroller.update({ clientX: 180, clientY: 95 }));
  await page.clock.runFor(300);
  expect(await page.locator('#sidebar').evaluate(el => el.scrollTop)).toBeLessThan(down - 100);
  await page.evaluate(() => window.scroller.update({ clientX: 370, clientY: 95 }));
  const outside = await page.locator('#sidebar').evaluate(el => el.scrollTop);
  await page.clock.runFor(500);
  expect(await page.locator('#sidebar').evaluate(el => el.scrollTop)).toBe(outside);
});

test('cancellation and lifecycle events stop scrolling; wheel works only during a sidebar drag', async ({ page }) => {
  await mountSidebar(page);
  await page.clock.install();
  for (const event of ['dragend', 'drop', 'Escape', 'blur', 'hidden', 'dragleave']) {
    await page.evaluate(() => { window.dragging = true; window.sidebar.scrollTop = 900; window.scroller.update({ clientX: 180, clientY: 425 }); });
    await page.clock.runFor(100);
    expect(await page.locator('#sidebar').evaluate(el => el.scrollTop)).toBeGreaterThan(900);
    await page.evaluate(type => {
      if (type === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else if (type === 'blur') window.dispatchEvent(new Event('blur'));
      else if (type === 'hidden') {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      } else if (type === 'dragleave') document.documentElement.dispatchEvent(new DragEvent('dragleave', { clientX: 0, clientY: 0, bubbles: true }));
      else document.dispatchEvent(new DragEvent(type, { bubbles: true }));
    }, event);
    const stopped = await page.locator('#sidebar').evaluate(el => el.scrollTop);
    await page.clock.runFor(200);
    expect(await page.locator('#sidebar').evaluate(el => el.scrollTop), event).toBe(stopped);
    if (event === 'hidden') await page.evaluate(() => Object.defineProperty(document, 'hidden', { value: false, configurable: true }));
  }
  await page.evaluate(() => {
    window.dragging = true;
    window.sidebar.scrollTop = 900;
    window.scroller.update({ clientX: 180, clientY: 250 });
    sidebar.dispatchEvent(new WheelEvent('wheel', { clientX: 180, clientY: 250, deltaY: 120, bubbles: true, cancelable: true }));
  });
  expect(await page.locator('#sidebar').evaluate(el => el.scrollTop)).toBe(1020);
  await page.evaluate(() => {
    window.dragging = false;
    sidebar.dispatchEvent(new WheelEvent('wheel', { clientX: 180, clientY: 250, deltaY: 120, bubbles: true, cancelable: true }));
  });
  expect(await page.locator('#sidebar').evaluate(el => el.scrollTop)).toBe(1020);
  await page.evaluate(() => { window.scroller.destroy(); window.dragging = true; window.scroller.update({ clientX: 180, clientY: 425 }); });
  await page.clock.runFor(300);
  expect(await page.locator('#sidebar').evaluate(el => el.scrollTop)).toBe(1020);
});
