// A public synthetic newspaper page: unequal text frames, mixed fonts,
// staggered baselines, a low full-width headline, and an optional photo credit.
// These are ordinary page-layout features, not invalid PDF objects.
export const centralLines = [
  'Central funding starts here.',
  'Laboratories have asked for',
  'a clear account of the change.',
  'The proposed budget sets out',
  'the cost of medicines and care.',
  'Public finances are under strain',
  'but research requires patience.',
  'A first estimate was published',
  'with the annual health report.',
  'Officials will discuss the plan',
  'with representatives this week.',
  'Several firms expect more time',
  'to adjust their spending plans.',
  'The debate concerns hospitals',
  'as well as local pharmacies.',
  'Smaller suppliers also asked',
  'for a stable system of support.',
  'Researchers warn that sudden',
  'changes can delay new trials.',
  'A revised forecast is expected',
  'when the commission meets.',
  'The final proposal will include',
  'an assessment of each measure.',
  'Some details remain uncertain',
  'while the figures are checked.',
  'Parliament will review the text',
  'before the end of this month.',
  'The minister promised a reply',
  'after hearing all the evidence.',
  'No decision has yet been taken',
  'on the timetable for the reform.',
  'Central funding finishes here.',
];

export const rightLines = Array.from({ length: 32 }, (_, index) =>
  index === 4 ? 'Right: another tax proposal' : `Right report ${index + 1}: industry costs`);

export function detailedNewspaperPdf({ rotatedCredit = false, touchingHeadline = true, offsetHeadlines = false } = {}) {
  const middle = centralLines.flatMap((text, index) =>
    offsetHeadlines && (index >= 7 && index <= 9 || index >= 17 && index <= 19) ? [] :
      [{ text, x: 220, y: 748 - index * 14, font: 'F1', size: 12 }]);
  const left = [
    { text: 'HEALTH', x: 30, y: 748, font: 'F2', size: 12 },
    ...['Left summary:', 'A new plan aims', 'to support research', 'and keep access', 'to medicines open.'].map((text, index) =>
      ({ text, x: 30, y: 721 - index * 17, font: 'F2', size: 15 })),
    ...['Suppliers ask for', 'clarity about their', 'future investment.'].map((text, index) =>
      ({ text, x: 30, y: 610 - index * 17, font: 'F2', size: 15 })),
    { text: 'Left author: Alice Martin', x: 30, y: 548, font: 'F3', size: 11 },
    ...Array.from({ length: 16 }, (_, index) => ({ text: `Left report ${index + 1}: policy and care`,
      x: 30, y: 520 - index * 14, font: 'F1', size: 12 })),
  ];
  const right = rightLines.flatMap((text, index) => offsetHeadlines && index >= 17 && index <= 19 ? [] : [{
    text,
    x: 410, y: 743 - index * 14, font: index === 4 ? 'F2' : 'F1', size: 12,
  }]);
  // Layout programs can paint separate paragraphs in a different order from
  // the displayed reading order. The native drag must follow the centre frame.
  const runs = [...middle.slice(0, 10), ...left, ...middle.slice(10, 26), ...right, ...middle.slice(26)];
  if (offsetHeadlines) runs.push(
    { text: 'Left and middle: a second report', x: 30, y: 628, font: 'F2', size: 22 },
    { text: 'Middle and right: another report', x: 220, y: 488, font: 'F2', size: 22 },
  );
  if (touchingHeadline) runs.push({ text: 'The next story spans the page', x: 30, y: 282, font: 'F1', size: 32 });
  if (rotatedCredit) runs.push({ text: 'Photo credit / newspaper archive', x: 596, y: 400, font: 'F1', size: 8, rotated: true });
  const escape = text => text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = runs.map(({ text, x, y, font, size, rotated }) =>
    `BT /${font} ${size} Tf ${rotated ? '0 1 -1 0' : '1 0 0 1'} ${x} ${y} Tm (${escape(text)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(`${content}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
}
