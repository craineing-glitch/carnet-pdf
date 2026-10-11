function normalized([x1, y1, x2, y2]) {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

function transformPoint([x, y], [a, b, c, d, e, f]) {
  return [a * x + c * y + e, b * x + d * y + f];
}

function inverse([a, b, c, d, e, f]) {
  const determinant = a * d - b * c;
  if (!determinant) throw new Error('Invalid page transform');
  return [d / determinant, -b / determinant, -c / determinant, a / determinant,
    (c * f - d * e) / determinant, (b * e - a * f) / determinant];
}

function transformedRect(rect, matrix) {
  const [x1, y1, x2, y2] = rect;
  const points = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map(point => transformPoint(point, matrix));
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}

export function clientPointToPdf(point, bounds, viewport) {
  return transformPoint([(point[0] - bounds.left) * viewport.width / bounds.width,
    (point[1] - bounds.top) * viewport.height / bounds.height], inverse(viewport.transform));
}

export function clientRectsToPdf(rects, bounds, viewport) {
  if (!bounds.width || !bounds.height) return [];
  const matrix = inverse(viewport.transform);
  const result = [];
  const seen = new Set();
  for (const rect of rects) {
    const left = Math.max(0, (rect.left - bounds.left) * viewport.width / bounds.width);
    const top = Math.max(0, (rect.top - bounds.top) * viewport.height / bounds.height);
    const right = Math.min(viewport.width, (rect.right - bounds.left) * viewport.width / bounds.width);
    const bottom = Math.min(viewport.height, (rect.bottom - bounds.top) * viewport.height / bounds.height);
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) continue;
    const pdf = transformedRect([left, top, right, bottom], matrix).map(n => Math.round(n * 1000) / 1000);
    const key = pdf.join(',');
    if (!seen.has(key)) { seen.add(key); result.push(pdf); }
  }
  return result;
}

export function pdfRectToViewport(rect, viewport) {
  return transformedRect(rect, viewport.transform);
}

export function highlightIdsAt(highlights, page, point, selectedRects = []) {
  return highlights.filter(highlight => highlight.page === page && highlight.rects.some(raw => {
    const rect = normalized(raw);
    const underPointer = point && point[0] >= rect[0] && point[0] <= rect[2] && point[1] >= rect[1] && point[1] <= rect[3];
    return underPointer || selectedRects.some(selected => Math.min(rect[2], selected[2]) > Math.max(rect[0], selected[0]) &&
      Math.min(rect[3], selected[3]) > Math.max(rect[1], selected[1]));
  })).map(highlight => highlight.id);
}
