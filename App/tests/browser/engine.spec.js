import { test, expect } from '@playwright/test';
import { textPdf } from '../fixtures.mjs';

function pagesPdf(count) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let number = 1; number <= count; number++) {
    const id = objects.length + 1;
    kids.push(`${id} 0 R`);
    const stream = `BT /F1 18 Tf 72 720 Td (Page ${number} Bonjour le monde.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`;
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(content);
}

async function setup(page, text = 'Bonjour le monde. Hello world.') {
  await page.goto('/');
  const { token } = await (await page.request.get('/api/session')).json();
  const name = `Engine ${Date.now()}.pdf`;
  const response = await page.request.post('/api/documents', {
    headers: { 'x-carnet-token': token, 'x-file-name': encodeURIComponent(name), 'x-category-id': 'fr', 'content-type': 'application/pdf' },
    data: Buffer.isBuffer(text) ? text : textPdf(text),
  });
  expect(response.ok()).toBeTruthy();
  const library = await response.json();
  const document = library.documents.find(item => item.name === name);
  await page.addStyleTag({ content: '#engine-host:empty{display:none} #engine-host{position:fixed;left:0;top:0;width:900px;height:700px;z-index:999999;background:#697b7c}' });
  await page.evaluate(async () => {
    const { PdfReader } = await import('/src/reader.js');
    const host = document.createElement('main');
    host.id = 'engine-host';
    document.body.append(host);
    window.engineErrors = [];
    window.engineStates = [];
    window.engine = new PdfReader({ host, onError: message => engineErrors.push(message), onState: state => engineStates.push(state) });
  });
  return `/api/documents/${document.id}/file`;
}

test('opening a hidden empty reader does not replace its ready text page after resize debounce', async ({ page }) => {
  const url = await setup(page);
  await page.evaluate(async url => { await engine.open(url); window.readyPage = document.querySelector('#engine-host .pdf-page'); }, url);
  await expect(page.locator('#engine-host')).toHaveAttribute('aria-busy', 'false');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => readyPage === document.querySelector('#engine-host .pdf-page'))).toBe(true);
  await expect(page.locator('#engine-host .textLayer span').first()).toContainText('Bonjour');
});

test('wheel scrolls through continuous pages and page navigation bounds the rendered window', async ({ page }) => {
  const url = await setup(page, pagesPdf(12));
  await page.evaluate(async url => { await engine.open(url); }, url);
  await expect(page.locator('#engine-host .pdf-page')).toHaveCount(12);
  const firstPage = page.locator('#engine-host .pdf-page[data-page-number="1"]');
  const secondPage = page.locator('#engine-host .pdf-page[data-page-number="2"]');
  const firstBox = await firstPage.boundingBox();
  const secondBox = await secondPage.boundingBox();
  expect(secondBox.y).toBeGreaterThan(firstBox.y + firstBox.height);
  await page.mouse.move(450, 350);
  await page.mouse.wheel(0, firstBox.height + 24);
  await expect.poll(() => page.evaluate(() => engine.page)).toBe(2);
  await expect(secondPage.locator('.textLayer span').first()).toContainText('Page 2');
  await page.evaluate(async () => { await engine.goTo(9); });
  await expect.poll(() => page.evaluate(() => engine.page)).toBe(9);
  const ninthBox = await page.locator('#engine-host .pdf-page[data-page-number="9"]').boundingBox();
  expect(ninthBox.y).toBeGreaterThanOrEqual(0);
  expect(ninthBox.y).toBeLessThan(50);
  await expect.poll(() => page.locator('#engine-host canvas').count()).toBeLessThanOrEqual(5);
  await expect(page.locator('#engine-host .pdf-page[data-page-number="1"] canvas')).toHaveCount(0);
  // Returning after eviction must build fresh selectable content.
  await page.evaluate(async () => { await engine.goTo(1); });
  await expect(firstPage.locator('.textLayer span').first()).toContainText('Page 1');
});

test('zoom preserves the page position and selections belong to the selected page', async ({ page }) => {
  const url = await setup(page, pagesPdf(6));
  await page.evaluate(async url => {
    await engine.open(url);
    const host = document.querySelector('#engine-host');
    host.scrollTop = host.querySelector('[data-page-number="1"]').offsetHeight - 400;
  }, url);
  await expect.poll(() => page.evaluate(() => engine.page)).toBe(1);
  const span = page.locator('#engine-host .pdf-page[data-page-number="2"] .textLayer span').first();
  await expect(span).toContainText('Page 2');
  const selected = await span.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const bounds = element.getBoundingClientRect();
    return engine.selectionAt({ clientX: bounds.left + 10, clientY: bounds.top + 5 });
  });
  expect(selected.page).toBe(2);
  expect(selected.text).toContain('Page 2');
  await page.evaluate(selection => engine.setHighlights([{ ...selection, id: 'page-two', color: '#ffe066' }]), selected);
  await page.evaluate(async () => { await engine.goTo(2); });
  const before = await page.evaluate(() => {
    const host = document.querySelector('#engine-host');
    host.scrollTop += 320;
    const element = host.querySelector('[data-page-number="2"]');
    return (host.getBoundingClientRect().top - element.getBoundingClientRect().top) / element.offsetHeight;
  });
  await page.evaluate(async () => { await engine.setZoom(2); });
  const after = await page.evaluate(() => {
    const host = document.querySelector('#engine-host');
    const element = host.querySelector('[data-page-number="2"]');
    return (host.getBoundingClientRect().top - element.getBoundingClientRect().top) / element.offsetHeight;
  });
  expect(after).toBeCloseTo(before, 2);
  expect(await page.evaluate(() => engine.page)).toBe(2);
  await expect(page.locator('#engine-host [data-highlight-id="page-two"]').first()).toHaveCount(1);
  await page.evaluate(async () => { await engine.goTo(6); await engine.goTo(2); });
  await expect(page.locator('#engine-host [data-highlight-id="page-two"]').first()).toHaveCount(1);
});

test('25 percent zoom renders every page visible in a tall reader', async ({ page }) => {
  const url = await setup(page, pagesPdf(12));
  await page.evaluate(async url => {
    const host = document.querySelector('#engine-host');
    host.style.height = '900px';
    await engine.open(url);
    await engine.setZoom(.25);
  }, url);
  // Four 198px pages, with 24px gaps, fit in this viewport. The fourth must
  // retain its canvas/text even while the page indicator remains on page one.
  await expect(page.locator('#engine-host .pdf-page[data-page-number="4"] .textLayer span').first()).toContainText('Page 4');
  await expect(page.locator('#engine-host .pdf-page[data-page-number="4"] canvas')).toHaveCount(1);
  await expect.poll(() => page.locator('#engine-host canvas').count()).toBeLessThanOrEqual(8);
  await page.evaluate(() => { document.querySelector('#engine-host').style.height = '1500px'; });
  await expect(page.locator('#engine-host .pdf-page[data-page-number="7"] .textLayer span').first()).toContainText('Page 7');
  await page.evaluate(async () => { await engine.goTo(7); });
  const visible = await page.evaluate(() => {
    const host = document.querySelector('#engine-host');
    const bounds = host.getBoundingClientRect();
    return [...host.querySelectorAll('.pdf-page')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.top < bounds.bottom && rect.bottom > bounds.top;
    }).map(element => Number(element.dataset.pageNumber));
  });
  for (const number of visible) {
    await expect(page.locator(`#engine-host .pdf-page[data-page-number="${number}"] .textLayer span`).first()).toContainText(`Page ${number}`);
  }
  await expect.poll(() => page.locator('#engine-host canvas').count()).toBeLessThanOrEqual(visible.length + 4);
});

test('native drag selection, persistent PDF geometry, rotation and rapid changes use the current page', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = await setup(page);
  await page.evaluate(async url => { await engine.open(url); }, url);
  const span = page.locator('#engine-host .textLayer span').first();
  const box = await span.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  const selection = await page.evaluate(() => engine.selectionAt({ clientX: 100, clientY: 100 }));
  expect(selection.text).toContain('Bonjour');
  expect(selection.rects.length).toBeGreaterThan(0);
  expect(selection.page).toBe(1);
  const rect = selection.rects[0];
  expect(rect[0]).toBeCloseTo(72, 0);
  expect(rect[1]).toBeGreaterThan(700);
  expect(rect[3]).toBeLessThan(750);
  await page.evaluate(selection => engine.setHighlights([{ id: 'engine-highlight', page: 1, text: selection.text, rects: selection.rects, color: '#ffe066' }]), selection);
  await expect(page.locator('#engine-host [data-highlight-id="engine-highlight"]').first()).toBeVisible();
  await page.evaluate(async () => { await Promise.all([engine.setZoom(.75), engine.setZoom(1.5), engine.rotate()]); });
  expect(await page.evaluate(() => ({ zoom: engine.zoom, rotation: engine.rotation, loading: engine.loading }))).toEqual({ zoom: 1.5, rotation: 90, loading: false });
  const marker = page.locator('#engine-host [data-highlight-id="engine-highlight"]').first();
  const dimensions = await marker.evaluate(element => ({ left: parseFloat(element.style.left), top: parseFloat(element.style.top), width: parseFloat(element.style.width), height: parseFloat(element.style.height) }));
  expect(dimensions.left).toBeCloseTo(rect[1] * 1.5, 1);
  expect(dimensions.top).toBeCloseTo(rect[0] * 1.5, 1);
  expect(dimensions.width).toBeCloseTo((rect[3] - rect[1]) * 1.5, 1);
  expect(dimensions.height).toBeCloseTo((rect[2] - rect[0]) * 1.5, 1);
  const rotated = await span.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return engine.selectionAt({ clientX: 100, clientY: 100 });
  });
  expect(rotated.highlightIds).toContain('engine-highlight');
  await page.evaluate(async url => { await Promise.all([engine.open(url), engine.open(url)]); }, url);
  await expect(page.locator('#engine-host .pdf-page')).toHaveCount(1);
  expect(await page.evaluate(() => engine.loading)).toBe(false);
  const canvas = await page.locator('#engine-host canvas').evaluate(element => ({ width: element.width, height: element.height }));
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_000_000);
  expect(canvas.width).toBeLessThanOrEqual(8192);
  expect(canvas.height).toBeLessThanOrEqual(8192);
  expect(errors).toEqual([]);
});

test('current invalid PDF shows a readable error and closing a loaded document cancels page retrieval', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = await setup(page);
  await page.evaluate(async () => { try { await engine.open('/src/reader.css'); } catch {} });
  await expect(page.locator('#engine-host .pdf-error')).toContainText('无法读取');
  expect(await page.evaluate(() => engineErrors.length)).toBe(1);
  expect(await page.evaluate(() => engine.loading)).toBe(false);
  const cancelled = await page.evaluate(async url => {
    const { PdfReader } = await import('/src/reader.js');
    engine.close();
    const racing = new PdfReader({ host: document.querySelector('#engine-host'), onState: state => { if (state.pageCount && state.loading) racing.close(); } });
    await racing.open(url);
    return { page: racing.page, pageCount: racing.pageCount, loading: racing.loading };
  }, url);
  expect(cancelled).toEqual({ page: 0, pageCount: 0, loading: false });
  await expect(page.locator('#engine-host .pdf-page')).toHaveCount(0);
  expect(errors).toEqual([]);
});
