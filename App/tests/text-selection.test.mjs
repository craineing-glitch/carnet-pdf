import test from 'node:test';
import assert from 'node:assert/strict';
import { readingOrder } from '../src/text-selection.js';
import { getDocument } from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { centralLines, detailedNewspaperPdf, rightLines } from './newspaper-fixture.mjs';

const run = (str, x, y, width = 100, height = 10) => ({ str, width, height, transform: [height || 10, 0, 0, height || 10, x, y], dir: 'ltr' });

test('reconstructs columns when PDF drawing order interleaves headings and body paragraphs', () => {
  const items = [run('Left first', 20, 700), run('Left last', 20, 680),
    run('Middle last', 150, 680), run('Right first', 280, 700), run('Right last', 280, 680),
    run('Article heading', 20, 750, 360, 22), run('Middle first', 150, 700)];
  assert.deepEqual(readingOrder(items).map(index => items[index].str),
    ['Article heading', 'Left first', 'Left last', 'Middle first', 'Middle last', 'Right first', 'Right last']);
});

test('keeps styled fragments and ordinary spaces in visual line order while ignoring phantom cross-column spaces', () => {
  const items = [run('right', 200, 700, 60), run('world', 60, 700, 40),
    run(' ', 50, 700, 10, 0), run('Hello', 20, 700, 30), run(' ', 100, 700, 100, 0)];
  assert.deepEqual(readingOrder(items).map(index => items[index].str), ['Hello', ' ', 'world', 'right']);
});

test('keeps vertical frames intact without changing horizontal column order and handles empty scanned pages', () => {
  const items = [run('vertical', 20, 700), run('other', 200, 700), run('vertical continued', 20, 680)];
  items[0].transform = [0, 10, -10, 0, 20, 700];
  items[2].transform = [0, 10, -10, 0, 20, 680];
  assert.deepEqual(readingOrder(items), [1, 0, 2]);
  assert.deepEqual(readingOrder([]), []);
});

for (const variant of [
  { title: 'rotated margin credit', rotatedCredit: true, touchingHeadline: false },
  { title: 'full-width headline touching the last staggered line', rotatedCredit: false, touchingHeadline: true },
]) {
  test(`dense newspaper isolates the central text frame beside a ${variant.title}`, async () => {
    const task = getDocument({ data: new Uint8Array(detailedNewspaperPdf(variant)), useSystemFonts: true });
    try {
      const pdf = await task.promise, page = await pdf.getPage(1), { items } = await page.getTextContent();
      const ordered = readingOrder(items).map(index => items[index].str);
      const start = ordered.indexOf(centralLines[0]), end = ordered.indexOf(centralLines.at(-1));
      assert.ok(start >= 0 && end > start);
      assert.deepEqual(ordered.slice(start, end + 1), centralLines);
      const visible = items.filter(item => item.str?.trim());
      assert.equal(ordered.filter(text => text.trim()).length, visible.length, 'all other frames remain selectable');
      if (variant.rotatedCredit) assert.ok(ordered.includes('Photo credit / newspaper archive'));
    } finally { await task.destroy(); }
  });
}

test('offset two-column headlines leave the unrelated right-column paragraph contiguous', async () => {
  const task = getDocument({ data: new Uint8Array(detailedNewspaperPdf({ offsetHeadlines: true, touchingHeadline: false })), useSystemFonts: true });
  try {
    const pdf = await task.promise, page = await pdf.getPage(1), { items } = await page.getTextContent();
    const ordered = readingOrder(items).map(index => items[index].str);
    const expected = rightLines.slice(0, 17);
    assert.deepEqual(ordered.slice(ordered.indexOf(expected[0]), ordered.indexOf(expected.at(-1)) + 1), expected);
    assert.equal(new Set(readingOrder(items)).size, items.filter(item => item.str?.trim()).length);
  } finally { await task.destroy(); }
});

test('a true full-width article heading separates the upper and lower sets of columns', () => {
  const rows = (prefix, top) => Array.from({ length: 5 }, (_, row) => ['Left', 'Middle', 'Right'].map((column, index) =>
    run(`${prefix} ${column} ${row}`, 20 + index * 120, top - row * 12, 90))).flat();
  const items = [...rows('Upper', 700), run('Full-width next story', 20, 626, 330, 18), ...rows('Lower', 596)];
  const ordered = readingOrder(items).map(index => items[index].str);
  const columns = prefix => ['Left', 'Middle', 'Right'].flatMap(column => Array.from({ length: 5 }, (_, row) => `${prefix} ${column} ${row}`));
  assert.deepEqual(ordered, [...columns('Upper'), 'Full-width next story', ...columns('Lower')]);
});

test('drop capitals precede their opening line instead of pulling the third line to the top', () => {
  const items = [run('D', 20, 680, 25, 40), run('ebut', 50, 700, 30), run('second line', 50, 690, 85), run('third line', 20, 680, 115)];
  assert.deepEqual(readingOrder(items).map(index => items[index].str), ['D', 'ebut', 'second line', 'third line']);
});

test('numbered and lettered list markers stay with their own item text', () => {
  for (const markers of [['1.', '2.', '3.'], ['a)', 'b)', 'c)'], ['•', '•', '•']]) {
    const items = markers.flatMap((marker, i) => [run(marker, 20, 700 - i * 20, 9), run(`Item ${i + 1}`, 45, 700 - i * 20, 90)]);
    assert.deepEqual(readingOrder(items).map(index => items[index].str), [markers[0], 'Item 1', markers[1], 'Item 2', markers[2], 'Item 3']);
  }
});
