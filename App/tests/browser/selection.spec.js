import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { centralLines, detailedNewspaperPdf, rightLines } from '../newspaper-fixture.mjs';

function newspaperPdf() {
  // Visually adjacent column fragments are deliberately painted out of order.
  const runs = [
    ['Left first', 50, 690], ['Left second', 50, 670], ['Left last', 50, 650],
    ['Middle second', 220, 670], ['Middle last', 220, 650],
    ['Right first', 390, 690], ['Right second', 390, 670], ['Right last', 390, 650],
    ['Newspaper heading', 50, 740], ['Middle first', 220, 690],
  ];
  const stream = runs.map(([text, x, y]) => `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`).join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let content = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(`${content}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
}

async function setup(page, buffer = newspaperPdf(), number = 1) {
  if (process.env.CARNET_TEXT_SELECTION_BASELINE) {
    const source = await readFile(process.env.CARNET_TEXT_SELECTION_BASELINE, 'utf8');
    await page.route('**/src/text-selection.js', route => route.fulfill({ contentType: 'text/javascript', body: source }));
  }
  if (process.env.CARNET_SELECTION_BASELINE) {
    const source = await readFile(process.env.CARNET_SELECTION_BASELINE, 'utf8');
    await page.route('**/src/reader.js', route => route.fulfill({ contentType: 'text/javascript', body: source }));
  }
  await page.goto('/');
  const { token } = await (await page.request.get('/api/session')).json();
  const name = `Selection ${Date.now()}.pdf`;
  const response = await page.request.post('/api/documents', { headers: {
    'x-carnet-token': token, 'x-file-name': encodeURIComponent(name), 'x-category-id': 'fr', 'content-type': 'application/pdf',
  }, data: buffer });
  expect(response.ok()).toBeTruthy();
  const library = await response.json();
  const document = library.documents.find(item => item.name === name);
  await page.addStyleTag({ content: '#selection-host{position:fixed;inset:0;width:1100px;height:900px;z-index:999999;background:#697b7c}' });
  await page.evaluate(async ({ url, number }) => {
    const { PdfReader } = await import('/src/reader.js');
    const host = document.createElement('main'); host.id = 'selection-host'; document.body.append(host);
    window.selectionReader = new PdfReader({ host });
    await selectionReader.open(url, { page: number });
    await selectionReader.setZoom(1);
  }, { url: `/api/documents/${document.id}/file`, number });
}

for (const variant of [
  { title: 'a rotated photo credit', rotatedCredit: true, touchingHeadline: false },
  { title: 'a touching full-width headline', rotatedCredit: false, touchingHeadline: true },
]) {
  test(`dense newspaper native dragging stays in the middle column beside ${variant.title}`, async ({ page }) => {
    await setup(page, detailedNewspaperPdf(variant));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const expected = centralLines.join(' ');
    for (const zoom of [1, 1.5]) {
      await page.evaluate(async zoom => {
        await selectionReader.setZoom(zoom);
        document.querySelector('#selection-host').scrollTop = 0;
      }, zoom);
      for (const reverse of [false, true]) {
        const selected = await drag(page, centralLines[0], centralLines.at(-1), reverse);
        // Test the actual browser selection before the reader translates it.
        // Filtering only the saved highlight would leave wrong copy feedback.
        const native = await page.evaluate(() => getSelection().toString());
        expect(native.replace(/\s+/g, ' ').trim()).toBe(expected);
        expect(selected.text.replace(/\s+/g, ' ').trim()).toBe(expected);
        expect(selected.text).not.toMatch(/Left|Right|Photo credit|next story|HEALTH/);
        expect(selected.rects).toHaveLength(centralLines.length);
        for (const rect of selected.rects) {
          expect(rect[0]).toBeGreaterThanOrEqual(219.5);
          expect(rect[2]).toBeLessThan(385);
        }
        await page.keyboard.press('Control+c');
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied.replace(/\s+/g, ' ').trim()).toBe(expected);
        await page.evaluate(selected => selectionReader.setHighlights([
          { ...selected, id: 'dense-central-column', color: '#ffe066' },
        ]), selected);
        const markers = page.locator('#selection-host [data-highlight-id="dense-central-column"]');
        await expect(markers).toHaveCount(centralLines.length);
        const boxes = await markers.evaluateAll(elements => elements.map(element => ({
          left: parseFloat(element.style.left), right: parseFloat(element.style.left) + parseFloat(element.style.width),
        })));
        for (const box of boxes) {
          expect(box.left / zoom).toBeGreaterThanOrEqual(219.5);
          expect(box.right / zoom).toBeLessThan(385);
        }
      }
    }
  });
}

test('offset two-column newspaper headlines do not interrupt dragging the adjacent right column', async ({ page }) => {
  await setup(page, detailedNewspaperPdf({ offsetHeadlines: true, touchingHeadline: false }));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const expectedLines = rightLines.slice(0, 17), expected = expectedLines.join(' ');
  for (const zoom of [1, 1.5]) {
    await page.evaluate(async zoom => {
      await selectionReader.setZoom(zoom);
      document.querySelector('#selection-host').scrollTop = 0;
    }, zoom);
    for (const reverse of [false, true]) {
      const selected = await drag(page, expectedLines[0], expectedLines.at(-1), reverse);
      expect((await page.evaluate(() => getSelection().toString())).replace(/\s+/g, ' ').trim()).toBe(expected);
      expect(selected.text.replace(/\s+/g, ' ').trim()).toBe(expected);
      expect(selected.rects).toHaveLength(expectedLines.length);
      for (const rect of selected.rects) {
        expect(rect[0]).toBeGreaterThanOrEqual(409.5);
        expect(rect[2]).toBeLessThan(585);
      }
      await page.keyboard.press('Control+c');
      expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\s+/g, ' ').trim()).toBe(expected);
      await page.evaluate(selected => selectionReader.setHighlights([
        { ...selected, id: 'offset-headline-right-column', color: '#ffe066' },
      ]), selected);
      const markers = page.locator('#selection-host [data-highlight-id="offset-headline-right-column"]');
      await expect(markers).toHaveCount(expectedLines.length);
      const boxes = await markers.evaluateAll(elements => elements.map(element => ({
        left: parseFloat(element.style.left), right: parseFloat(element.style.left) + parseFloat(element.style.width),
      })));
      for (const box of boxes) {
        expect(box.left / zoom).toBeGreaterThanOrEqual(409.5);
        expect(box.right / zoom).toBeLessThan(585);
      }
    }
  }
});

async function drag(page, first, last, reverse = false) {
  const points = await page.evaluate(({ first, last }) => {
    selectionReader.clearSelection();
    const spans = [...document.querySelectorAll('#selection-host .textLayer span')];
    function point(text, end) {
      const span = spans.find(element => element.textContent === text);
      const range = document.createRange(); range.selectNodeContents(span);
      const node = span.firstChild;
      if (end) range.setStart(node, node.length - 1); else range.setEnd(node, 1);
      const rect = range.getBoundingClientRect();
      return { x: end ? rect.right - .5 : rect.left + .5, y: rect.top + rect.height / 2 };
    }
    return [point(first, false), point(last, true)];
  }, { first, last });
  if (reverse) points.reverse();
  await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 20 }); await page.mouse.up();
  return page.evaluate(point => selectionReader.selectionAt({ clientX: point.x, clientY: point.y }), points[1]);
}

test('native drag follows a newspaper column despite scrambled PDF text order', async ({ page }) => {
  await setup(page);
  const metrics = await page.evaluate(async () => {
    const record = selectionReader._records[0];
    const { items } = await record.pdfPage.getTextContent();
    return [...record.element.querySelectorAll('.textLayer span')].filter(span => span.textContent.trim()).map(span => ({
      actual: span.getBoundingClientRect().width / record.viewport.scale,
      expected: items.find(item => item.str === span.textContent).width,
    }));
  });
  for (const reverse of [false, true]) {
    const selected = await drag(page, 'Middle first', 'Middle last', reverse);
    expect(selected.text.replace(/\s+/g, ' ')).toBe('Middle first Middle second Middle last');
    expect(selected.rects).toHaveLength(3);
    for (const rect of selected.rects) { expect(rect[0]).toBeGreaterThanOrEqual(219); expect(rect[2]).toBeLessThan(360); }
    expect(selected.page).toBe(1);
  }
  for (const metric of metrics) expect(Math.abs(metric.actual - metric.expected)).toBeLessThan(.3);
  await page.evaluate(async () => { await selectionReader.setZoom(1.5); });
  const selected = await drag(page, 'Middle first', 'Middle last');
  expect(selected.text.replace(/\s+/g, ' ')).toBe('Middle first Middle second Middle last');
  await page.evaluate(selected => selectionReader.setHighlights([{ ...selected, id: 'column-highlight', color: '#ffe066' }]), selected);
  await page.evaluate(async () => { await selectionReader.rotate(); });
  await expect(page.locator('#selection-host [data-highlight-id="column-highlight"]').first()).toBeAttached();
  const textOrder = await page.locator('#selection-host .textLayer').evaluate(element => element.textContent);
  expect(textOrder.indexOf('Middle first')).toBeLessThan(textOrder.indexOf('Middle second'));
  expect(textOrder.indexOf('Middle second')).toBeLessThan(textOrder.indexOf('Middle last'));
});

test('selection uses one PDF.js clipped surface and keeps word-space overlaps at one opacity', async ({ page }) => {
  await setup(page);
  await drag(page, 'Middle first', 'Middle last');
  const textLayer = page.locator('#selection-host [data-page-number="1"] .textLayer');
  await expect(textLayer).toHaveClass(/selectionRendering/);
  await expect(page.locator('#selection-host [data-page-number="1"] > .selection')).toHaveCount(1);
  const colors = await textLayer.evaluate(element => ({
    native: getComputedStyle(element.querySelector('span'), '::selection').backgroundColor,
    overlay: getComputedStyle(element.parentElement.querySelector(':scope > .selection')).backgroundColor,
    path: element.parentElement.querySelector(':scope > .selection path').getAttribute('d'),
  }));
  expect(colors.native).toBe('rgba(0, 0, 0, 0)');
  expect(colors.overlay).toBe('rgba(100, 155, 211, 0.4)');
  expect(colors.path.match(/M/g)?.length).toBeGreaterThanOrEqual(3);
  // Synthetic whitespace fragments on an empty part of the actual PDF page
  // reproduce PDF.js space boxes that overlap neighbouring glyph boxes.
  const samples = await textLayer.evaluate(element => {
    const make = left => {
      const span = document.createElement('span'); span.textContent = '          ';
      span.style.cssText = `left:${left}px;top:400px;font-size:20px;font-family:monospace;transform:none`;
      element.append(span); return span;
    };
    const a = make(40), b = make(100), range = document.createRange();
    range.setStart(a.firstChild, 0); range.setEnd(b.firstChild, b.textContent.length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const bounds = a.getBoundingClientRect();
    return [{ x: bounds.left + 20, y: bounds.top + 5 }, { x: bounds.left + 80, y: bounds.top + 5 }];
  });
  await expect.poll(async () => page.locator('#selection-host .selection path').getAttribute('d')).not.toBe(colors.path);
  const screenshot = await loadImage(await page.screenshot());
  const canvas = createCanvas(screenshot.width, screenshot.height), context = canvas.getContext('2d');
  context.drawImage(screenshot, 0, 0);
  const [single, overlap] = samples.map(({ x, y }) => [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data]);
  expect(single).toEqual(overlap);
  expect(single.slice(0, 3)).not.toEqual([255, 255, 255]);
  await page.evaluate(() => selectionReader.clearSelection());
  await expect(page.locator('#selection-host .selection')).toHaveCount(0);
});

test('dragging into a column line gap keeps the selection near the pointer rather than sweeping the page', async ({ page }) => {
  await setup(page);
  const points = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('#selection-host .textLayer span')];
    const first = spans.find(el => el.textContent === 'Middle first').getBoundingClientRect();
    const second = spans.find(el => el.textContent === 'Middle second').getBoundingClientRect();
    const third = spans.find(el => el.textContent === 'Middle last').getBoundingClientRect();
    return { start: { x: first.left + 1, y: first.top + first.height / 2 },
      middle: { x: second.right - 1, y: second.top + second.height / 2 },
      end: { x: second.right + 5, y: (second.bottom + third.top) / 2 } };
  });
  await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
  await page.mouse.move(points.middle.x, points.middle.y, { steps: 12 });
  await page.mouse.move(points.end.x, points.end.y, { steps: 6 }); await page.mouse.up();
  const selected = await page.evaluate(() => getSelection().toString());
  expect(selected).toContain('Middle first');
  expect(selected).toContain('Middle second');
  expect(selected).not.toMatch(/Left|Right|heading/);
});

test('user newspaper page 28 keeps the middle column together across its heading boundary', async ({ page }) => {
  test.skip(!process.env.CARNET_SELECTION_PDF, 'Optional private local newspaper regression');
  test.setTimeout(60_000);
  await setup(page, await readFile(process.env.CARNET_SELECTION_PDF), 28);
  await page.evaluate(() => {
    const span = [...document.querySelectorAll('#selection-host [data-page-number="28"] .textLayer span')].find(element => element.textContent === 'américaine face à ses concurrents.');
    span.scrollIntoView({ block: 'start' });
    document.querySelector('#selection-host').scrollTop -= 50;
  });
  const selected = await drag(page, 'américaine face à ses concurrents.', 'centrales, la relance du nucléaire, etc.');
  if (process.env.CARNET_SELECTION_DIAGNOSTICS) console.log(JSON.stringify(await page.evaluate(async () => {
    const span = [...document.querySelectorAll('#selection-host [data-page-number="28"] .textLayer span')].find(element => element.textContent === 'américaine face à ses concurrents.');
    const style = getComputedStyle(span);
    const result = { css: span.style.cssText, computed: { font: style.font, size: style.fontSize, weight: style.fontWeight, family: style.fontFamily, transform: style.transform, letter: style.letterSpacing, word: style.wordSpacing }, width: span.getBoundingClientRect().width, languages: [] };
    for (const lang of ['', 'en', 'fr', 'zh-CN']) {
      const canvas = document.createElement('canvas'); canvas.lang = lang; document.body.append(canvas);
      const ctx = canvas.getContext('2d'); ctx.font = `${style.fontSize} ${style.fontFamily}`;
      const clone = span.cloneNode(true); clone.lang = lang; span.parentElement.append(clone);
      const range = document.createRange(); range.selectNodeContents(clone);
      result.languages.push({ lang, canvasWidth: ctx.measureText(span.textContent).width, elementWidth: clone.getBoundingClientRect().width, textWidth: range.getBoundingClientRect().width });
      canvas.remove(); clone.remove();
    }
    return result;
  })));
  expect(selected.text).toContain('Coût d’usage attractif');
  expect(selected.text).toContain('la modernisation du réseau électri-');
  expect(selected.text).not.toContain('CHRONIQUE');
  expect(selected.text).not.toContain('parti pris');
  expect(selected.text).not.toContain('Intelligence');
  expect(selected.page).toBe(28);
  for (const rect of selected.rects) { expect(rect[0]).toBeGreaterThan(180); expect(rect[2]).toBeLessThan(325); }
  const wrapped = await drag(page, 'américaine face à ses concurrents.', 'Trump compte mettre à bas les régu-');
  expect(wrapped.text).toContain('la Chine – dépendant des centres');
  expect(wrapped.text).toContain('ner des IA souveraines qui ne le sont');
  expect(wrapped.text).not.toContain('CHRONIQUE');
  expect(wrapped.text).not.toContain('Intelligence');
  expect(wrapped.text.indexOf('la Chine – dépendant des centres')).toBeLessThan(wrapped.text.indexOf('ner des IA souveraines qui ne le sont'));
});
