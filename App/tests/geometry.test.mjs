import test from 'node:test';
import assert from 'node:assert/strict';
import { clientRectsToPdf, clientPointToPdf, pdfRectToViewport, highlightIdsAt } from '../src/geometry.js';

// Fixtures use a 200 × 100 PDF page. At 2× the browser page is 400 × 200.
const upright = { width: 400, height: 200, transform: [2, 0, 0, -2, 0, 200] };
const bounds = { left: 20, top: 30, width: 400, height: 200 };

test('stores selection rectangles in PDF space, including the flipped vertical axis', () => {
  assert.deepEqual(clientRectsToPdf([{ left: 40, top: 70, right: 140, bottom: 90 }], bounds, upright), [[10, 70, 60, 80]]);
});

test('accounts for a CSS-scaled page instead of treating screen pixels as viewport pixels', () => {
  assert.deepEqual(clientRectsToPdf([{ left: 30, top: 50, right: 80, bottom: 60 }], { left: 20, top: 30, width: 200, height: 100 }, upright), [[10, 70, 60, 80]]);
});

test('keeps a selected word anchored when the page rotates clockwise', () => {
  const rotated = { width: 200, height: 400, transform: [0, 2, 2, 0, 0, 0] };
  assert.deepEqual(pdfRectToViewport([10, 70, 60, 80], rotated), [140, 20, 160, 120]);
  assert.deepEqual(clientRectsToPdf([{ left: 160, top: 50, right: 180, bottom: 150 }], { left: 20, top: 30, width: 200, height: 400 }, rotated), [[10, 70, 60, 80]]);
});

test('clips selections to the page, drops empty/outside rectangles and removes duplicates', () => {
  assert.deepEqual(clientRectsToPdf([
    { left: 10, top: 70, right: 40, bottom: 90 },
    { left: 10, top: 70, right: 40, bottom: 90 },
    { left: 0, top: 0, right: 10, bottom: 20 },
    { left: 40, top: 70, right: 40, bottom: 90 },
  ], bounds, upright), [[0, 70, 10, 80]]);
});

test('converts pointer coordinates with a crop-box offset and reversed rotation', () => {
  // PDF page origin is (50, 100); after 180° rotation x = 250 - x, y = y - 100.
  const cropped = { width: 200, height: 100, transform: [-1, 0, 0, 1, 250, -100] };
  assert.deepEqual(clientPointToPdf([100, 70], { left: 20, top: 30, width: 200, height: 100 }, cropped), [170, 140]);
  assert.deepEqual(pdfRectToViewport([150, 120, 180, 140], cropped), [70, 20, 100, 40]);
});

test('finds highlights under the pointer and overlapping a selected rectangle only on the active page', () => {
  const highlights = [
    { id: 'word', page: 1, rects: [[10, 70, 60, 80]] },
    { id: 'second', page: 1, rects: [[100, 20, 150, 30]] },
    { id: 'other-page', page: 2, rects: [[10, 70, 60, 80]] },
  ];
  assert.deepEqual(highlightIdsAt(highlights, 1, [20, 75], []), ['word']);
  assert.deepEqual(highlightIdsAt(highlights, 1, [0, 0], [[140, 25, 160, 35]]), ['second']);
  assert.deepEqual(highlightIdsAt(highlights, 1, [0, 0], [[60, 70, 70, 80]]), []);
});
