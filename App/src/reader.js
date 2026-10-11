import { getDocument, GlobalWorkerOptions, DrawLayer } from '/vendor/pdfjs/build/pdf.mjs';
import { TextLayerBuilder } from '/vendor/pdfjs/web/pdf_viewer.mjs';
import { clientPointToPdf, clientRectsToPdf, pdfRectToViewport, highlightIdsAt } from './geometry.js';
import { normalizeTextLayer, selectionClientRects } from './text-selection.js';

GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';

function readableError(error) {
  if (error?.name === 'PasswordException') return '请先解锁这个 PDF。';
  if (error?.name === 'InvalidPDFException') return '无法读取 PDF，文件可能已损坏。';
  if (error?.name === 'MissingPDFException' || error?.name === 'UnexpectedResponseException') return '无法取得 PDF，请重新打开。';
  return '页面读取失败，请重新打开。';
}

/** Stable placeholders; visible pages and two neighbours retain canvases. */
export class PdfReader {
  constructor({ host, onError = () => {}, onState = () => {}, onSelection = () => {} }) {
    if (!host) throw new Error('A reader host is required');
    this.host = host;
    this.onError = onError;
    this.onState = onState;
    this.onSelection = onSelection;
    this._documentVersion = 0;
    this._page = 0;
    this._pageCount = 0;
    this._zoom = 1;
    this._zoomMode = 'fit';
    this._rotation = 0;
    this._loading = false;
    this._hasText = false;
    this._highlights = [];
    this._records = [];
    host.classList.add('pdf-reader');
    host.addEventListener('mouseup', event => {
      if (event.button === 0) this.onSelection(this.selectionAt(event));
    });
    host.addEventListener('scroll', () => {
      if (this._scrollFrame) return;
      this._scrollFrame = requestAnimationFrame(() => {
        this._scrollFrame = 0;
        if (!this._records.length) return;
        this._updateVisiblePage();
        this._refreshWindow().catch(() => {});
      });
    }, { passive: true });
    this._resizeWidth = host.clientWidth;
    this._resizeHeight = host.clientHeight;
    this._resizeObserver = new ResizeObserver(() => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (Math.abs(width - this._resizeWidth) < 1 && Math.abs(height - this._resizeHeight) < 1) return;
      this._resizeWidth = width;
      this._resizeHeight = height;
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        if (!this._pdf || !this._records.length) return;
        if (this._zoomMode === 'fit' && Math.abs(this.host.clientWidth - this._renderedWidth) >= 1) {
          this._relayout(this._captureAnchor()).catch(() => {});
        } else {
          this._updateVisiblePage();
          this._refreshWindow().catch(() => {});
        }
      }, 120);
    });
    this._resizeObserver.observe(host);
  }

  get page() { return this._page; }
  get pageCount() { return this._pageCount; }
  get zoom() { return this._zoom; }
  get zoomMode() { return this._zoomMode; }
  get rotation() { return this._rotation; }
  get loading() { return this._loading; }
  get hasText() { return this._hasText; }

  _emit() {
    this.host.setAttribute('aria-busy', String(this._loading));
    this.onState({ page: this._page, pageCount: this._pageCount, zoom: this._zoom,
      loading: this._loading, hasText: this._hasText });
  }

  _message(text, error = false) {
    const message = document.createElement('div');
    message.className = `pdf-message${error ? ' pdf-error' : ''}`;
    message.setAttribute('role', error ? 'alert' : 'status');
    message.textContent = text;
    this.host.replaceChildren(message);
  }

  _cancelRecord(record, releasePage = false) {
    const canvasDone = record.canvasTask?.promise;
    ++record.version;
    record.canvasTask?.cancel();
    record.textTask?.cancel();
    record.textLayerBuilder?.cancel();
    record.drawLayer?.destroy();
    record.textLayerBuilder = null;
    record.drawLayer = null;
    record.canvasTask = null;
    record.textTask = null;
    record.promise = null;
    record.ready = false;
    record.error = false;
    // Release backing stores immediately rather than awaiting garbage collection.
    for (const canvas of record.element.querySelectorAll('canvas')) { canvas.width = 0; canvas.height = 0; }
    record.element.replaceChildren();
    record.element.dataset.rendered = 'false';
    record.highlightLayer = null;
    record.annotationLayer = null;
    if (releasePage) {
      const version = record.version;
      // PDF.js keeps decoded images/operator lists per visited page. Wait until
      // cancellation settles, and never clean a page that was re-entered meanwhile.
      Promise.resolve(canvasDone).catch(() => {}).then(() => {
        if (record.version === version && !record.active) record.pdfPage.cleanup();
      }).catch(() => {});
    }
  }

  close() {
    ++this._documentVersion;
    this.clearSelection();
    this._records.forEach(record => this._cancelRecord(record));
    this._records = [];
    clearTimeout(this._resizeTimer);
    cancelAnimationFrame(this._scrollFrame);
    this._scrollFrame = 0;
    this._loadingTask?.destroy().catch(() => {});
    this._loadingTask = null;
    this._pdf = null;
    this._page = 0;
    this._pageCount = 0;
    this._hasText = false;
    this._loading = false;
    this._highlights = [];
    this.host.replaceChildren();
    this._emit();
  }

  async open(url, { page = 1, highlights = [] } = {}) {
    this.close();
    const version = this._documentVersion;
    this._rotation = 0;
    this._zoomMode = 'fit';
    this._highlights = Array.isArray(highlights) ? highlights : [];
    this._loading = true;
    this._emit();
    if (version !== this._documentVersion) return;
    this._message('正在打开…');
    try {
      const task = getDocument({ url, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/',
        isEvalSupported: false });
      this._loadingTask = task;
      const pdf = await task.promise;
      if (version !== this._documentVersion) { await task.destroy().catch(() => {}); return; }
      this._pdf = pdf;
      this._pageCount = pdf.numPages;
      this._page = Math.min(this._pageCount, Math.max(1, Math.trunc(Number(page)) || 1));
      this._emit();
      if (version !== this._documentVersion) return;
      // Read metadata sequentially without extracting text/operator lists. Mixed
      // page sizes then reserve exact space without painting the whole document.
      const records = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const pdfPage = await pdf.getPage(number);
        if (version !== this._documentVersion) return;
        const element = document.createElement('div');
        element.className = 'pdf-page';
        element.dataset.pageNumber = String(number);
        element.dataset.rendered = 'false';
        element.setAttribute('aria-label', `PDF 第 ${number} 页`);
        records.push({ number, pdfPage, element, version: 0, active: false, ready: false, hasText: false });
      }
      this._records = records;
      const pages = document.createElement('div');
      pages.className = 'pdf-pages';
      pages.append(...records.map(record => record.element));
      this.host.replaceChildren(pages);
      this._sizePages();
      this._scrollToPage(this._page);
      await this._refreshWindow();
    } catch (error) {
      if (version !== this._documentVersion) return;
      if (!this._records.length) {
        const message = readableError(error);
        this._loading = false;
        this._message(message, true);
        this._emit();
        this.onError(message, error);
      }
      throw error;
    }
  }

  _sizePages() {
    this._renderedWidth = this.host.clientWidth;
    const style = getComputedStyle(this.host);
    const availableWidth = Math.max(100, this._renderedWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    for (const record of this._records) {
      const rotation = (record.pdfPage.rotate + this._rotation) % 360;
      const natural = record.pdfPage.getViewport({ scale: 1, rotation });
      const scale = this._zoomMode === 'fit' ? Math.min(4, Math.max(0.1, availableWidth / natural.width)) : this._zoomMode;
      record.viewport = record.pdfPage.getViewport({ scale, rotation });
      record.element.style.width = `${record.viewport.width}px`;
      record.element.style.height = `${record.viewport.height}px`;
      record.element.style.setProperty('--scale-factor', String(scale));
      record.element.style.setProperty('--user-unit', String(record.pdfPage.userUnit));
    }
    this._syncState();
  }

  _syncState() {
    const record = this._records[this._page - 1];
    if (!record) return;
    this._zoom = record.viewport.scale;
    this._hasText = record.ready && record.hasText;
    this._loading = !record.ready && !record.error;
  }

  _recordAt(clientY) {
    let low = 0, high = this._records.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const bounds = this._records[middle].element.getBoundingClientRect();
      if (bounds.bottom < clientY) low = middle + 1;
      else high = middle;
    }
    return this._records[low];
  }

  _updateVisiblePage() {
    const record = this._recordAt(this.host.getBoundingClientRect().top + Math.min(100, this.host.clientHeight / 4));
    if (record) this._page = record.number;
  }

  _captureAnchor({ clientX, clientY } = {}) {
    if (!this._records.length) return null;
    const bounds = this.host.getBoundingClientRect();
    const y = Number.isFinite(clientY) ? clientY : bounds.top;
    const x = Number.isFinite(clientX) ? clientX : bounds.left + this.host.clientWidth / 2;
    const record = this._recordAt(y);
    const pageBounds = record.element.getBoundingClientRect();
    return { page: record.number, x: (x - pageBounds.left) / pageBounds.width,
      y: (y - pageBounds.top) / pageBounds.height, clientX: x, clientY: y };
  }

  _restoreAnchor(anchor) {
    const record = anchor && this._records[anchor.page - 1];
    if (!record) return;
    const bounds = record.element.getBoundingClientRect();
    this.host.scrollTop += bounds.top + anchor.y * bounds.height - anchor.clientY;
    this.host.scrollLeft += bounds.left + anchor.x * bounds.width - anchor.clientX;
  }

  _scrollToPage(number) {
    const element = this._records[number - 1]?.element;
    if (!element) return;
    const hostBounds = this.host.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(this.host).paddingTop);
    this.host.scrollTop += element.getBoundingClientRect().top - hostBounds.top - padding;
    this.host.scrollLeft = 0;
  }

  async goTo(page) {
    if (!this._pdf || !this._records.length) return;
    this._page = Math.min(this._pageCount, Math.max(1, Math.trunc(Number(page)) || 1));
    this._scrollToPage(this._page);
    return this._refreshWindow();
  }

  async setZoom(zoom, anchorPoint = {}) {
    if (zoom !== 'fit' && !Number.isFinite(Number(zoom))) return;
    const anchor = this._captureAnchor(anchorPoint);
    this._zoomMode = zoom === 'fit' ? 'fit' : Math.min(4, Math.max(0.25, Number(zoom)));
    if (this._records.length) return this._relayout(anchor);
  }

  async rotate() {
    const anchor = this._captureAnchor();
    this._rotation = (this._rotation + 90) % 360;
    if (this._records.length) return this._relayout(anchor);
  }

  async _relayout(anchor) {
    this.clearSelection();
    for (const record of this._records) this._cancelRecord(record);
    this._sizePages();
    this._restoreAnchor(anchor);
    this._updateVisiblePage();
    return this._refreshWindow();
  }

  async _refreshWindow() {
    if (!this._records.length) return;
    const active = this._records[this._page - 1];
    const bounds = this.host.getBoundingClientRect();
    const top = bounds.top + this.host.clientTop;
    const bottom = top + this.host.clientHeight;
    let first = this._recordAt(top).number;
    let last = this._recordAt(bottom).number;
    // Binary lookup can land on a page whose edge only touches the viewport,
    // or the page following a gap. Count actual intersections before buffering.
    if (this._records[first - 1].element.getBoundingClientRect().bottom <= top && first < this._pageCount) first++;
    if (this._records[last - 1].element.getBoundingClientRect().top >= bottom && last > first) last--;
    const start = Math.max(1, Math.min(first, this._page) - 2);
    const end = Math.min(this._pageCount, Math.max(last, this._page) + 2);
    for (const record of this._records) {
      const keep = record.number >= start && record.number <= end;
      if (!keep && record.active) this._cancelRecord(record, true);
      record.active = keep;
    }
    this._syncState();
    this._emit();
    if (!this._pdf || !this._records.includes(active)) return;
    const ready = this._renderRecord(active);
    for (let number = start; number <= end; number++) {
      const record = this._records[number - 1];
      if (record !== active) this._renderRecord(record).catch(() => {});
    }
    await ready;
  }

  _renderRecord(record) {
    if (record.ready || record.error) return Promise.resolve();
    if (record.promise) return record.promise;
    const version = record.version;
    const documentVersion = this._documentVersion;
    const current = () => documentVersion === this._documentVersion && record.version === version && record.active;
    record.promise = (async () => {
      const { viewport, element, pdfPage } = record;
      try {
        const canvas = document.createElement('canvas');
        canvas.setAttribute('aria-label', `PDF 第 ${record.number} 页`);
        const outputScale = Math.min(window.devicePixelRatio || 1,
          Math.sqrt(16_000_000 / (viewport.width * viewport.height)), 8192 / viewport.width, 8192 / viewport.height);
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        const overlay = document.createElement('div');
        overlay.className = 'highlight-layer';
        overlay.setAttribute('aria-hidden', 'true');
        const annotations = document.createElement('div');
        annotations.className = 'annotation-marker-layer';
        element.append(canvas, overlay, annotations);
        record.highlightLayer = overlay;
        record.annotationLayer = annotations;
        this._drawHighlights(record);
        const canvasTask = pdfPage.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport,
          transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0] });
        record.canvasTask = canvasTask;
        const canvasDone = canvasTask.promise;
        canvasDone.catch(() => {});
        const textContent = await pdfPage.getTextContent();
        if (!current()) return;
        // Canvas font measurement and DOM fallback fonts must use the same
        // language. Inheriting the Chinese UI locale widened Latin text spans
        // by up to 10% on Windows when the PDF omitted its language metadata.
        const textLanguage = textContent.lang || 'en';
        let textDivs;
        // Use the official viewer's drag-boundary and empty-space handling,
        // rather than only the low-level positioned text spans. Feed the same
        // extracted content through its stream API to preserve the locale fix.
        const textTask = new TextLayerBuilder({
          pdfPage: { streamTextContent: () => new ReadableStream({ start(controller) {
            controller.enqueue({ ...textContent, lang: textLanguage }); controller.close();
          } }) },
          highlighter: { setTextMapping(divs) { textDivs = divs; }, enable() {}, disable() {} },
        });
        const textContainer = textTask.div;
        textContainer.lang = textLanguage;
        textContainer.classList.add('selectionRendering');
        element.append(textContainer);
        record.textLayerBuilder = textTask;
        record.textTask = textTask;
        await Promise.all([canvasDone, textTask.render({ viewport })]);
        if (!current()) return;
        const endOfContent = textContainer.querySelector('.endOfContent');
        normalizeTextLayer(textContainer, textContent.items, textDivs);
        if (endOfContent) textContainer.append(endOfContent);
        // PDF.js paints a single clipped selection surface, so overlapping
        // fragments and synthetic word spaces cannot accumulate opacity.
        record.drawLayer = new DrawLayer({ pageIndex: record.number - 1, textLayer: textContainer });
        record.drawLayer.setParent(element);
        record.canvasTask = null;
        record.textTask = null;
        record.ready = true;
        record.hasText = textContent.items.some(item => item.str?.trim());
        element.dataset.rendered = 'true';
        if (!record.hasText) {
          const note = document.createElement('p');
          note.className = 'pdf-scan-note';
          note.textContent = '扫描页，暂不支持划词。';
          element.append(note);
        }
        if (record.number === this._page) { this._syncState(); this._emit(); }
      } catch (error) {
        if (!current()) return;
        this._cancelRecord(record);
        record.error = true;
        const message = readableError(error);
        const note = document.createElement('div');
        note.className = 'pdf-message pdf-error';
        note.setAttribute('role', 'alert');
        note.textContent = message;
        element.append(note);
        if (record.number === this._page) { this._syncState(); this._emit(); }
        this.onError(message, error);
        throw error;
      }
    })();
    return record.promise;
  }

  setHighlights(highlights) {
    this._highlights = Array.isArray(highlights) ? highlights : [];
    for (const record of this._records) this._drawHighlights(record);
  }

  _drawHighlights(record) {
    if (!record?.viewport || !record.highlightLayer) return;
    const fragment = document.createDocumentFragment();
    const annotations = document.createDocumentFragment();
    for (const highlight of this._highlights) {
      if (highlight.page !== record.number) continue;
      const group = document.createElement('div');
      group.className = 'highlight-group';
      for (const rect of highlight.rects) {
        const [left, top, right, bottom] = pdfRectToViewport(rect, record.viewport);
        const marker = document.createElement('div');
        marker.dataset.highlightId = highlight.id;
        marker.style.cssText = `left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px`;
        marker.style.backgroundColor = /^#[0-9a-f]{6}$/i.test(highlight.color) ? highlight.color : '#ffe066';
        group.append(marker);
      }
      fragment.append(group);
      if (highlight.note && highlight.rects.length) {
        const [left, top, right] = pdfRectToViewport(highlight.rects[0], record.viewport);
        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'annotation-marker';
        marker.dataset.annotationId = highlight.id;
        marker.setAttribute('aria-label', '查看批注');
        marker.title = highlight.note.slice(0, 120);
        marker.style.left = `${Math.min(record.viewport.width - 24, Math.max(left, right + 4))}px`;
        marker.style.top = `${Math.max(2, top - 4)}px`;
        marker.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z"/><path d="M8 9h9M8 13h6"/></svg>';
        annotations.append(marker);
      }
    }
    record.highlightLayer.replaceChildren(fragment);
    record.annotationLayer?.replaceChildren(annotations);
  }

  getAnchorRect(anchor) {
    const record = this._records[(anchor?.page || 0) - 1];
    if (!record?.viewport || !anchor.rects?.length) return null;
    const bounds = record.element.getBoundingClientRect();
    const rects = anchor.rects.map(rect => pdfRectToViewport(rect, record.viewport));
    const scaleX = bounds.width / record.viewport.width, scaleY = bounds.height / record.viewport.height;
    const left = bounds.left + Math.min(...rects.map(rect => rect[0])) * scaleX;
    const right = bounds.left + Math.max(...rects.map(rect => rect[2])) * scaleX;
    const top = bounds.top + Math.min(...rects.map(rect => rect[1])) * scaleY;
    const bottom = bounds.top + Math.max(...rects.map(rect => rect[3])) * scaleY;
    return { left, right, top, bottom, width: right - left, height: bottom - top };
  }

  _recordFromNode(node) {
    const element = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest('.pdf-page');
    if (!element || !this.host.contains(element)) return null;
    return this._records[Number(element.dataset.pageNumber) - 1];
  }

  selectionAt(event = {}) {
    const clientX = Number(event.clientX) || 0;
    const clientY = Number(event.clientY) || 0;
    const selection = window.getSelection();
    const selectedRecord = this._recordFromNode(selection?.anchorNode);
    const focusRecord = this._recordFromNode(selection?.focusNode);
    const pointerRecord = this._recordFromNode(document.elementFromPoint(clientX, clientY));
    const record = pointerRecord || selectedRecord || this._records[this._page - 1];
    const result = { page: record?.number || this._page, text: '', rects: [], highlightIds: [], clientX, clientY };
    if (!record?.ready) return result;
    const textLayer = record.element.querySelector('.textLayer');
    const bounds = record.element.getBoundingClientRect();
    // Do not assign a range spanning several pages to a single page number.
    if (selection && !selection.isCollapsed && selection.rangeCount && selectedRecord === record && focusRecord === record &&
      textLayer?.contains(selection.anchorNode) && textLayer.contains(selection.focusNode)) {
      const rectangles = selectionClientRects(selection, textLayer);
      result.rects = clientRectsToPdf(rectangles, bounds, record.viewport);
      if (result.rects.length) result.text = selection.toString().trim();
    }
    const insidePage = clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom;
    const point = insidePage ? clientPointToPdf([clientX, clientY], bounds, record.viewport) : null;
    result.highlightIds = highlightIdsAt(this._highlights, record.number, point, result.rects);
    return result;
  }

  clearSelection() {
    const selection = window.getSelection();
    if (selection && (this.host.contains(selection.anchorNode) || this.host.contains(selection.focusNode))) selection.removeAllRanges();
  }
}
