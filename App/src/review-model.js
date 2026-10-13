export function parsePageSelection(value, pageCount) {
  if (typeof value !== 'string' || !value.trim() || !Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error('请选择要收录的页码。');
  }
  const tokens = value.normalize('NFKC').trim().replace(/[–—−~～]/g, '-').split(/[,，、;；\s]+/);
  const pages = new Set();
  for (const token of tokens) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) throw new Error('页码格式无效，例如：1, 3-5。');
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > pageCount || start > end) {
      throw new Error(`页码须在 1-${pageCount} 之间，区间应从小到大。`);
    }
    for (let page = start; page <= end; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export function formatPageList(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b), parts = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}-${sorted[i]}`);
  }
  return parts.join(', ');
}

export function reviewEntries(documents, query = '') {
  const needle = query.trim().toLocaleLowerCase();
  return documents.filter(doc => doc.review && !doc.deletedAt && (!needle || doc.name.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => b.review.collectedAt.localeCompare(a.review.collectedAt) || b.id.localeCompare(a.id));
}

export function collectionTime(value) {
  const date = new Date(value), pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
