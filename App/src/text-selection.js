/**
 * PDF drawing order is not necessarily reading order (newspapers often paint
 * the start of a column after the byline). Native selections follow DOM order.
 * Reorder the existing PDF.js spans, never their metrics or displayed canvas.
 * Whitespace cuts and persistent gutters keep columns together even when a
 * spanning title touches the body. Rotation exceptions stay local to a frame.
 */
export function readingOrder(items) {
  const drawable = items.map((item, index) => ({ item, index })).filter(({ item }) => typeof item.str === 'string' && item.str.length);
  // A vertical credit/rotated page label is its own text frame. It must not
  // disable normal reading order for every horizontal paragraph on the page.
  const horizontal = ({ item }) => item.transform[0] > 0 && item.transform[3] > 0 &&
    Math.abs(item.transform[1]) <= Math.abs(item.transform[0]) * .15 && item.dir !== 'ttb';
  const detached = drawable.filter(entry => !horizontal(entry));
  const boxes = drawable.filter(horizontal).map(({ item, index }) => {
    const height = Math.max(.1, Math.hypot(item.transform[2], item.transform[3]));
    return { index, text: item.str, dir: item.dir, left: item.transform[4], right: item.transform[4] + Math.max(.01, item.width),
      top: -item.transform[5] - height * .85, bottom: -item.transform[5] + height * .15,
      baseline: -item.transform[5], height };
  });
  const content = boxes.filter(box => box.text.trim() && box.right > box.left);
  if (!content.length) return detached.map(({ index }) => index);
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

  function gapAlong(group, axis, minimum, accept = () => true) {
    const start = axis === 'x' ? 'left' : 'top';
    const end = axis === 'x' ? 'right' : 'bottom';
    const sorted = [...group].sort((a, b) => a[start] - b[start]);
    let edge = sorted[0][end], best = null;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i][start] - edge;
      const at = (edge + sorted[i][start]) / 2;
      if (gap > minimum && (!best || gap > best.size) && accept(at)) best = { at, size: gap };
      edge = Math.max(edge, sorted[i][end]);
    }
    return best;
  }

  function isListGutter(left, right, rtl) {
    const prefixes = rtl ? right : left, body = rtl ? left : right;
    return prefixes.length > 0 && prefixes.every(box =>
      /^(?:[•◦▪●○☐☑\-–—]|\(?\d+[.)]?|\(?[A-Za-z][.)]|[ivxIVX]+[.)])$/.test(box.text.trim()) &&
      box.right - box.left <= box.height * 3 && body.some(line =>
        Math.abs(line.baseline - box.baseline) < Math.min(line.height, box.height) * .35 &&
        (rtl ? box.left - line.right : line.left - box.right) < box.height * 4));
  }

  function textLines(group) {
    const lines = [];
    for (const box of [...group].sort((a, b) => a.baseline - b.baseline)) {
      const last = lines.at(-1);
      if (last && Math.abs(last.baseline - box.baseline) <= Math.min(last.height, box.height) * .35) {
        last.boxes.push(box); last.height = Math.min(last.height, box.height);
      } else lines.push({ baseline: box.baseline, height: box.height, boxes: [box] });
    }
    return lines;
  }

  // A page-wide title may touch the final body line. Strict XY-cut then has
  // neither a vertical nor a horizontal whitespace cut, so its row fallback
  // interleaves columns. Find gutters supported by repeated neighbouring lines
  // instead: a few spanning title/caption lines cannot erase the whole gutter.
  function persistentGutter(group, height, rtl) {
    const lines = textLines(group), gaps = [];
    for (const line of lines) {
      const row = [...line.boxes].sort((a, b) => a.left - b.left);
      let edge = row[0].right;
      for (let i = 1; i < row.length; i++) {
        if (row[i].left - edge > height * .7) gaps.push({ left: edge, right: row[i].left, line });
        edge = Math.max(edge, row[i].right);
      }
    }
    // Staggered columns need not share baselines. Candidate corridors also
    // come from repeated box edges; their vertical support is evaluated below.
    const edges = [...new Set(group.flatMap(box => [box.left, box.right]))].sort((a, b) => a - b);
    const edgeGaps = edges.slice(1).map((right, index) => ({ left: edges[index], right }))
      .filter(gap => gap.right - gap.left > height * .7);
    const candidates = [...new Set([...gaps, ...edgeGaps].map(gap => Math.round((gap.left + gap.right) / 2 / (height * .2))))]
      .map(value => value * height * .2);
    let best = null;
    for (const at of candidates) {
      const left = group.filter(box => box.right <= at), right = group.filter(box => box.left >= at);
      if (left.length < 3 || right.length < 3 || isListGutter(left, right, rtl)) continue;
      const width = Math.min(...right.map(box => box.left)) - Math.max(...left.map(box => box.right));
      if (width <= height * .7) continue;
      const overlap = Math.min(Math.max(...left.map(box => box.bottom)), Math.max(...right.map(box => box.bottom))) -
        Math.max(Math.min(...left.map(box => box.top)), Math.min(...right.map(box => box.top)));
      const support = Math.min(textLines(left).length, textLines(right).length, overlap / height);
      if (support < 3) continue;
      const crossing = group.filter(box => box.left < at && box.right > at);
      const crossingSet = new Set(crossing);
      const crossingRows = lines.filter(line => line.boxes.some(box => crossingSet.has(box)));
      if (crossingRows.length > Math.max(1, support / 3)) continue;
      const score = support * Math.min(height * 4, width) / (1 + crossingRows.length * .1);
      if (!best || score > best.score) best = { at, crossing, score };
    }
    return best;
  }

  function cut(group, depth = 0) {
    if (group.length < 2) return group;
    const height = median(group.map(box => box.height));
    const rtl = group.filter(box => box.dir === 'rtl').length > group.length / 2;
    if (depth < 48) {
      // Prefer vertical gutters so aligned newspaper rows do not interleave.
      const vertical = gapAlong(group, 'x', height * .7, at => {
        const left = group.filter(box => box.right < at), right = group.filter(box => box.left > at);
        // List markers form a narrow gutter, not a separate reading column.
        return !isListGutter(left, right, rtl);
      });
      if (vertical) {
        const left = group.filter(box => box.right < vertical.at);
        const right = group.filter(box => box.left > vertical.at);
        return rtl ? [...cut(right, depth + 1), ...cut(left, depth + 1)] : [...cut(left, depth + 1), ...cut(right, depth + 1)];
      }
      const persistent = persistentGutter(group, height, rtl);
      if (persistent) {
        // A genuine page-wide heading with clear space above/below separates
        // articles. Preserve that boundary before ordering their columns.
        // Partial-width headings and titles touching neighbouring body text
        // must stay local: turning either into a global band sweeps other
        // columns into an otherwise vertical selection.
        const pageLeft = Math.min(...group.map(box => box.left));
        const pageRight = Math.max(...group.map(box => box.right));
        const margin = (pageRight - pageLeft) * .06;
        const separators = persistent.crossing.filter(box => box.left <= pageLeft + margin && box.right >= pageRight - margin)
          .sort((a, b) => a.top - b.top);
        for (const separator of separators) {
          const others = group.filter(box => box !== separator);
          if (others.some(box => box.top < separator.bottom && box.bottom > separator.top)) continue;
          return [...cut(others.filter(box => box.bottom <= separator.top), depth + 1), separator,
            ...cut(others.filter(box => box.top >= separator.bottom), depth + 1)];
        }
        // A title crossing left+middle must not split a separate right-hand
        // article into bands. Keep the body columns contiguous and attach the
        // spanning text to its leading column. This also handles overlapping
        // left+middle / middle+right headlines (non-guillotine page layouts).
        const left = cut(group.filter(box => rtl ? box.right <= persistent.at : box.left < persistent.at), depth + 1);
        const right = cut(group.filter(box => rtl ? box.right > persistent.at : box.left >= persistent.at), depth + 1);
        return rtl ? [...right, ...left] : [...left, ...right];
      }
      // Spanning headlines divide the page into bands before column cuts.
      const horizontal = gapAlong(group, 'y', height * .3);
      if (horizontal) return [...cut(group.filter(box => box.bottom < horizontal.at), depth + 1),
        ...cut(group.filter(box => box.top > horizontal.at), depth + 1)];
    }
    // No gutter remains: collect line fragments with a tolerance for mixed
    // font ascenders, then order each line in its writing direction.
    const caps = group.filter(box => box.height > height * 1.8 && box.text.length <= 2);
    const pending = group.filter(box => !caps.includes(box)).sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const box of pending) {
      const line = lines.find(candidate => Math.abs(candidate.baseline - box.baseline) <= Math.min(candidate.height, box.height) * .35);
      if (line) { line.boxes.push(box); line.height = Math.min(line.height, box.height); }
      else lines.push({ top: box.top, baseline: box.baseline, height: box.height, boxes: [box] });
    }
    // A drop capital's baseline can sit three lines down. Attach it to the
    // first adjacent line at its top, not the line matching that baseline.
    for (const cap of caps) {
      const line = lines.filter(candidate => Math.abs(candidate.top - cap.top) < candidate.height &&
        candidate.boxes.some(box => box.left >= cap.right)).sort((a, b) => Math.abs(a.top - cap.top) - Math.abs(b.top - cap.top))[0];
      if (line) line.boxes.push(cap);
      else lines.push({ top: cap.top, baseline: cap.baseline, height: cap.height, boxes: [cap] });
    }
    lines.sort((a, b) => a.top - b.top);
    return lines.flatMap(line => line.boxes.sort((a, b) => rtl ? b.right - a.right : a.left - b.left));
  }

  const ordered = cut(content);
  const spaces = boxes.filter(box => !box.text.trim());
  const result = [];
  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i], next = ordered[i + 1];
    result.push(current.index);
    if (!next || Math.abs(current.baseline - next.baseline) > Math.min(current.height, next.height) * .35) continue;
    const left = Math.min(current.right, next.right), right = Math.max(current.left, next.left);
    // Preserve genuine word spaces; ignore PDF.js's huge synthetic spaces
    // between separate text frames, which otherwise bridge column gutters.
    if (right - left > Math.max(current.height, next.height) * 3) continue;
    result.push(...spaces.filter(space => Math.abs(space.baseline - current.baseline) < current.height * .35 &&
      space.left >= left - .1 && space.right <= right + .1).sort((a, b) => a.left - b.left).map(space => space.index));
  }
  // Keep the relative source order inside unsupported vertical/rotated text
  // frames. Appending those frames avoids inserting them into normal columns.
  result.push(...detached.map(({ index }) => index));
  return result;
}

export function normalizeTextLayer(textLayer, textItems, textDivs) {
  const items = textItems.filter(item => typeof item.str === 'string');
  // All-vertical/rotated pages keep PDF.js's original spans and line breaks.
  if (!items.some(item => item.str.trim() && item.transform[0] > 0 && item.transform[3] > 0 &&
    Math.abs(item.transform[1]) <= Math.abs(item.transform[0]) * .15 && item.dir !== 'ttb')) return;
  const ordered = readingOrder(items);
  const fragment = document.createDocumentFragment();
  for (let position = 0; position < ordered.length; position++) {
    const index = ordered[position], item = items[index], next = items[ordered[position + 1]];
    const span = textDivs[index];
    if (!span) continue;
    fragment.append(span);
    const height = Math.hypot(item.transform[2], item.transform[3]);
    const nextHeight = next ? Math.hypot(next.transform[2], next.transform[3]) : 0;
    const dropCap = next && height > nextHeight * 1.8 && item.str.length <= 2 &&
      Math.abs(item.transform[5] + height * .85 - next.transform[5] - nextHeight * .85) < nextHeight &&
      next.transform[4] >= item.transform[4] + item.width;
    const separateFrame = next && Math.max(item.transform[4], next.transform[4]) -
      Math.min(item.transform[4] + item.width, next.transform[4] + next.width) > Math.max(height, nextHeight) * 3;
    if (next && !dropCap && (separateFrame || Math.abs(item.transform[5] - next.transform[5]) > Math.min(height, nextHeight) * .35)) {
      const lineBreak = document.createElement('br');
      lineBreak.setAttribute('role', 'presentation');
      fragment.append(lineBreak);
    }
  }
  textLayer.replaceChildren(fragment);
}

/** Read glyph ranges only; a parent range also reports each span's box. */
export function selectionClientRects(selection, textLayer) {
  const rects = [];
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.length) continue;
    for (let i = 0; i < selection.rangeCount; i++) {
      const selected = selection.getRangeAt(i);
      if (!selected.intersectsNode(node)) continue;
      const glyphs = document.createRange();
      glyphs.selectNodeContents(node);
      if (glyphs.compareBoundaryPoints(Range.START_TO_START, selected) < 0) glyphs.setStart(selected.startContainer, selected.startOffset);
      if (glyphs.compareBoundaryPoints(Range.END_TO_END, selected) > 0) glyphs.setEnd(selected.endContainer, selected.endOffset);
      if (!glyphs.collapsed) rects.push(...glyphs.getClientRects());
    }
  }
  return rects;
}
