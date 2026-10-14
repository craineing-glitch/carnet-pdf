import { themes, getTheme } from './themes.js';
import { getPresentation } from './presentation.js';
import { EnvironmentScene } from './environment.js';
import { dateGroups, filterDocuments, humanSize } from './library-model.js';
import { PdfReader } from './reader.js';
import { AnnotationEditor } from './annotation-editor.js';
import { formatPageList, reviewEntries, collectionTime } from './review-model.js';
import { openReviewCollection } from './review-collection.js';
import { IdleScreensaver } from './screensaver.js';
import { getDocument, GlobalWorkerOptions } from '/vendor/pdfjs/build/pdf.mjs';

const $ = id => document.getElementById(id);
const pdfFileName = name => /\.pdf$/i.test(name) ? name : name + '.pdf';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const colors = [
  { value: '#ffe066', name: '黄色' }, { value: '#9cddb1', name: '绿色' },
  { value: '#9fc8ff', name: '蓝色' }, { value: '#f5aac8', name: '粉色' },
  { value: '#c9b2ff', name: '紫色' }
];
let library = { revision: -1, categories: [], documents: [], settings: { theme: 'mediterranean', screensaver: { enabled: true, minutes: 1 } } };
let token = '', currentId = '', filter = { categoryId: '', date: '', query: '' };
let tab = 'categories', expandedKey = '', notesTab = 'highlights';
let busy = false, ready = false, openGeneration = 0, motion = true, highlightColor = colors[0].value;
let lastReaderState = { page: 1, pageCount: 0, zoom: 1, loading: false };
let menuContext = null, toastTimer, bookmarkBusy = false, pendingSaves = 0, draggedDocument = '', dragSuppressUntil = 0;
let readingFullscreen = false, fullscreenBusy = false, fullscreenRequest = 0;
let screensaverSaveQueue = Promise.resolve(), pendingScreensaverSettings = null;
const pendingPositions = new Map();
const pendingAnnotationDeletes = new Set();
try {
  motion = localStorage.getItem('carnet-pdf-motion') !== 'off';
  const saved = localStorage.getItem('carnet-pdf-highlight-color');
  if (colors.some(c => c.value === saved)) highlightColor = saved;
} catch {}
const scene = new EnvironmentScene($('effects'));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const reader = new PdfReader({ host: $('reader-host'), onState: readerState, onError: message => toast(message, true) });
const screensaver = new IdleScreensaver({
  element: $('screensaver'),
  getTheme: () => getTheme(library.settings.theme),
  getSettings: () => library.settings.screensaver || { enabled: true, minutes: 1 },
  onShow: () => { hideMenu(); scene.set(getTheme(library.settings.theme), 'still'); },
  onHide: () => scene.set(getTheme(library.settings.theme), motion && !reducedMotion.matches ? 'gentle' : 'still')
});
const currentDocument = () => library.documents.find(d => d.id === currentId);

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => $('toast').hidden = true, error ? 11000 : 3200);
}

async function api(url, { method = 'GET', body, headers = {} } = {}) {
  const binary = body instanceof Blob || body instanceof ArrayBuffer;
  const payload = binary ? body : body ? JSON.stringify(body) : undefined;
  const response = await fetch(url, {
    method,
    headers: { ...(method === 'GET' ? {} : { 'x-carnet-token': token }), ...(!binary && body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: payload,
    keepalive: method !== 'GET' && !binary && (!payload || new TextEncoder().encode(payload).length < 60000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
  return result;
}

function accept(next) {
  if (next.revision < library.revision) return;
  library = next;
  screensaver.configure();
  renderLibrary();
  const doc = currentDocument();
  if (currentId && (!doc || doc.deletedAt)) { showHome(); return; }
  if (doc) {
    updateDocumentHeading();
    reader.setHighlights(doc.highlights);
    renderNotes();
  }
}

async function mutate(url, options) {
  pendingSaves++;
  $('save-status').textContent = '保存中…';
  try {
    const next = await api(url, options);
    accept(next);
    if (pendingSaves === 1) $('save-status').textContent = '已保存';
    return next;
  } catch (error) {
    $('save-status').textContent = '保存失败';
    throw error;
  } finally { pendingSaves--; }
}

function applyTheme(id) {
  const theme = getTheme(id), presentation = getPresentation(theme.id), root = document.documentElement;
  const variables = { 'editor-ink': presentation.text, 'chrome-ink': presentation.chrome, 'editor-panel': presentation.panel,
    'surface-glass': presentation.surface, 'control-glass': presentation.control, 'editor-filter': presentation.filter,
    teal: theme.color, accent: theme.accent, serif: `'${theme.font}',Georgia,serif` };
  for (const [name, value] of Object.entries(variables)) root.style.setProperty('--' + name, value);
  root.dataset.presentation = presentation.mode;
  root.dataset.theme = theme.id;
  document.querySelector('.scene-photo').style.backgroundImage = `url("${theme.image}")`;
  document.querySelector('.scene-photo').style.backgroundPosition = theme.id === 'shinchan' ? 'right center' : theme.id === 'rose-dusk' ? 'center 47%' : theme.id === 'mediterranean' ? 'center 58%' : 'center';
  $('theme-name').textContent = theme.name;
  $('scene-quote').textContent = theme.quote;
  const animated = motion && !reducedMotion.matches && !screensaver.active && theme.effect !== 'none';
  scene.set(theme, animated ? 'gentle' : 'still');
  $('motion-button').textContent = `动态 · ${motion && reducedMotion.matches ? '系统已关闭' : motion ? '开' : '关'}`;
  $('motion-button').setAttribute('aria-pressed', String(animated));
  $('motion-button').title = reducedMotion.matches ? '系统已启用减少动态效果' : '开启或关闭背景动画';
}

function fileRows(files) {
  if (!files.length) return '<div class="library-empty">' + (tab === 'trash' ? '回收站为空' : '暂无文件') + '</div>';
  return files.map(d => `<div class="file-row ${d.id === currentId ? 'active' : ''} ${d.deletedAt ? 'is-trashed' : ''} ${d.review ? 'review-file' : ''}" draggable="${!d.deletedAt && !d.review}" data-drag-document="${escape(d.id)}">
    <button class="file-open" data-open="${escape(d.id)}" aria-label="${d.deletedAt ? '回收站文件' : '打开'} ${escape(d.name)}">
      <span class="pdf-icon">PDF</span><span class="file-details"><span class="file-name" title="${escape(d.name)}">${escape(d.name)}</span>
      ${d.review ? `<span class="file-source" title="${escape(d.review.sourceName)} · 第 ${formatPageList(d.review.pages)} 页">${escape(d.review.sourceName)} · 第 ${formatPageList(d.review.pages)} 页</span>` : ''}
      <span class="file-meta">${d.deletedAt ? '已删除 · ' : ''}${d.review ? collectionTime(d.review.collectedAt) : (d.deletedAt || d.importedAt).slice(5, 10).replace('-', '/')} · ${d.review ? `${d.review.pages.length} 页` : humanSize(d.size)}</span></span>
    </button><button class="file-menu" data-file-menu="${escape(d.id)}" aria-label="文件选项" title="文件选项">⋯</button></div>`).join('');
}

function renderLibrary() {
  const active = library.documents.filter(d => !d.deletedAt && !d.review), trash = library.documents.filter(d => d.deletedAt);
  $('total-count').textContent = active.length;
  for (const kind of ['categories', 'dates', 'trash']) $(kind + '-tab').classList.toggle('active', tab === kind);
  $('trash-count').textContent = trash.length || '';
  $('review-tab').classList.toggle('active', tab === 'review');
  $('review-tab').setAttribute('aria-pressed', String(tab === 'review'));
  $('review-count').textContent = reviewEntries(library.documents).length;
  $('add-category').hidden = tab !== 'categories';
  if (tab === 'review') {
    const files = reviewEntries(library.documents, filter.query);
    const groups = new Map();
    for (const doc of files) {
      const day = collectionTime(doc.review.collectedAt).slice(0, 10);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(doc);
    }
    $('filters').innerHTML = `<div class="review-shelf"><p class="review-caption">按收录时间 · 最近在前</p>${files.length ? [...groups].map(([day, entries]) => `<section class="review-day"><h3>${formatDate(day)}<span>${entries.length} 份</span></h3>${fileRows(entries)}</section>`).join('') : `<div class="library-empty">${filter.query ? '没有匹配的收藏资料' : '把想重读的报道留在这里<br>打开 PDF，点击工具栏的爱心。'}</div>`}</div>`;
    return;
  }
  if (tab === 'trash') {
    const files = trash.filter(d => d.name.toLocaleLowerCase().includes(filter.query.trim().toLocaleLowerCase())).sort((a,b) => b.deletedAt.localeCompare(a.deletedAt));
    $('filters').innerHTML = `<p class="trash-description">删除的文件可在这里还原。</p><div class="trash-files">${fileRows(files)}</div>`;
    return;
  }
  const items = tab === 'categories'
    ? [{ id: '', name: '全部文件', count: active.length, icon: '▤' }, ...library.categories.map(c => ({ ...c, count: active.filter(d => d.categoryId === c.id).length, icon: c.id === 'fr' ? 'Fr' : c.id === 'en' ? 'En' : '◇' }))]
    : [{ id: '', name: '全部日期', count: active.length, icon: '◷' }, ...dateGroups(active).map(d => ({ id: d.date, name: formatDate(d.date), count: d.count, icon: '·' }))];
  $('filters').innerHTML = items.map(item => {
    const expanded = expandedKey === item.id;
    const files = expanded ? filterDocuments(active, { query: filter.query, categoryId: tab === 'categories' ? item.id : '', date: tab === 'dates' ? item.id : '' }) : [];
    return `<section class="library-group"><div class="category-heading"><button class="filter-button ${expanded ? 'active' : ''}" data-filter="${escape(item.id)}" aria-expanded="${expanded}">
      <span class="filter-icon">${item.icon}</span><span class="filter-name">${escape(item.name)}</span><span class="filter-count">${item.count}</span><span class="filter-chevron" aria-hidden="true">›</span>
      </button>${tab === 'categories' && item.id ? `<button class="category-menu" data-category-menu="${escape(item.id)}" aria-label="分类选项" title="分类选项">⋯</button>` : ''}</div>${expanded ? `<div class="category-files">${fileRows(files)}</div>` : ''}</section>`;
  }).join('');
}

function formatDate(date) { const [y, m, d] = date.split('-'); return `${y}年${Number(m)}月${Number(d)}日`; }

function updateBookmarkButton() {
  const doc = currentDocument();
  const bookmarked = (doc?.bookmarks || []).some(b => b.page === lastReaderState.page);
  $('bookmark-button').setAttribute('aria-pressed', String(bookmarked));
  $('bookmark-button').setAttribute('aria-label', bookmarked ? '移除书签' : '添加书签');
  $('bookmark-button').title = bookmarked ? '移除书签' : '添加书签';
  $('bookmark-button').disabled = bookmarkBusy || !doc || !lastReaderState.pageCount || lastReaderState.loading;
  $('collect-pages-button').disabled = !doc || Boolean(doc.review) || !lastReaderState.pageCount || lastReaderState.loading;
  const collected = doc && !doc.review ? reviewEntries(library.documents).filter(item => item.review.sourceId === doc.id && item.review.pages.includes(lastReaderState.page)) : [];
  $('collect-pages-button').dataset.collected = String(Boolean(doc?.review || collected.length));
  $('collect-pages-button').title = doc?.review ? '已在收藏夹' : collected.length ? '本页已收藏 · 收录页面\n' + collected.map(item => item.name).join('\n') : '收藏页面';
}

function updateDocumentHeading() {
  const doc = currentDocument();
  if (!doc) return;
  $('document-title').textContent = doc.name;
  $('reader-label').textContent = doc.review ? `收藏夹 · ${doc.review.sourceName} · 原第 ${formatPageList(doc.review.pages)} 页` : library.categories.find(c => c.id === doc.categoryId)?.name || '全部文件';
  $('reader-label').title = $('reader-label').textContent;
  const count = doc.highlights.length + (doc.bookmarks || []).length;
  $('highlight-count').textContent = `笔记${count ? ' · ' + count : ''}`;
  $('highlights-button').disabled = false;
  $('download').hidden = false;
  $('download').href = `/api/documents/${doc.id}/file`;
  $('download').setAttribute('download', pdfFileName(doc.name));
  $('fullscreen-button').disabled = fullscreenBusy;
  updateBookmarkButton();
}

function setReadingFullscreen(active) {
  readingFullscreen = active;
  document.documentElement.classList.toggle('reading-fullscreen', active);
  const label = active ? '退出全屏' : '全屏阅读';
  $('fullscreen-button').setAttribute('aria-label', label);
  $('fullscreen-button').setAttribute('aria-pressed', String(active));
  $('fullscreen-button').title = active ? '退出全屏 · Esc' : label;
  $('fullscreen-button').querySelector('path').setAttribute('d', active
    ? 'M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3'
    : 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5');
}

async function exitReadingFullscreen() {
  ++fullscreenRequest;
  fullscreenBusy = false;
  setReadingFullscreen(false);
  $('fullscreen-button').disabled = !currentId;
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch {}
  }
}

async function toggleFullscreen() {
  if (readingFullscreen || document.fullscreenElement) return exitReadingFullscreen();
  if (!currentId || fullscreenBusy) return;
  const request = ++fullscreenRequest;
  fullscreenBusy = true;
  $('fullscreen-button').disabled = true;
  hideMenu();
  try {
    // Keep the backdrop and all menus inside the fullscreen root.
    await document.documentElement.requestFullscreen?.();
    if (request !== fullscreenRequest || !currentId) {
      if (document.fullscreenElement) await document.exitFullscreen();
      return;
    }
    setReadingFullscreen(true);
  } catch {
    // Embedded browsers may deny native fullscreen. The same layout still
    // expands to the available window and can be reversed with Escape.
    if (request === fullscreenRequest && currentId) setReadingFullscreen(true);
  } finally {
    if (request === fullscreenRequest) {
      fullscreenBusy = false;
      $('fullscreen-button').disabled = !currentId;
    }
  }
}

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement && !currentId) { exitReadingFullscreen(); return; }
  setReadingFullscreen(Boolean(document.fullscreenElement));
});

function showHome() {
  annotationEditor.close({ force: true });
  ++openGeneration;
  cancelWheelZoom();
  hideMenu();
  currentId = '';
  try { sessionStorage.removeItem('carnet-pdf-current'); } catch {}
  exitReadingFullscreen();
  reader.close();
  $('notes-panel').hidden = true;
  $('notes-content').replaceChildren();
  $('highlights-button').disabled = true;
  $('highlights-button').setAttribute('aria-expanded', 'false');
  $('highlight-count').textContent = '笔记';
  $('download').hidden = true;
  $('download').removeAttribute('href');
  $('fullscreen-button').disabled = true;
  $('reader-toolbar').hidden = true;
  $('document-title').textContent = '阅读';
  $('reader-label').textContent = 'PDF';
  $('welcome').hidden = false;
  document.querySelector('.reader-shell').classList.add('is-home');
  renderLibrary();
}

async function openDocument(id) {
  annotationEditor.close({ force: true });
  const doc = library.documents.find(d => d.id === id);
  if (!doc) return;
  if (doc.deletedAt) return toast('此文件在回收站中，请先还原。');
  if (doc.review) tab = 'review';
  hideMenu();
  cancelWheelZoom();
  const generation = ++openGeneration;
  currentId = id;
  renderLibrary();
  updateDocumentHeading();
  renderNotes();
  document.querySelector('.reader-shell').classList.remove('is-home');
  $('welcome').hidden = true;
  $('reader-toolbar').hidden = false;
  try { sessionStorage.setItem('carnet-pdf-current', id); } catch {}
  try {
    await reader.open(`/api/documents/${id}/file`, { page: pendingPositions.get(id)?.page || doc.lastPage || 1, highlights: doc.highlights });
  } catch {
    if (generation === openGeneration) $('reader-hint').textContent = '打开失败';
  }
}

// Keep one save in flight per document and coalesce intermediate scroll positions.
function savePosition(docId, page) {
  const pending = pendingPositions.get(docId);
  if (pending) { pending.page = page; return; }
  const entry = { page };
  pendingPositions.set(docId, entry);
  (async () => {
    try {
      let saved;
      do {
        saved = entry.page;
        await mutate(`/api/documents/${docId}`, { method: 'PATCH', body: { lastPage: saved } });
      } while (entry.page !== saved);
    } catch (error) { toast(error.message, true); }
    finally { pendingPositions.delete(docId); }
  })();
}

function readerState(state) {
  lastReaderState = state;
  $('page-number').value = state.page || 1;
  $('page-number').max = state.pageCount || 1;
  $('page-count').textContent = state.pageCount || '…';
  $('zoom-value').textContent = `${Math.round((state.zoom || 1) * 100)}%`;
  $('previous-page').disabled = state.loading || state.page <= 1;
  $('next-page').disabled = state.loading || state.page >= state.pageCount;
  for (const id of ['page-number', 'zoom-out', 'zoom-in', 'fit-width', 'rotate-page']) $(id).disabled = state.loading || !state.pageCount;
  $('reader-footer-right').textContent = state.pageCount ? `${state.page} / ${state.pageCount}` : 'PDF';
  $('reader-hint').textContent = state.loading ? '加载中…' : state.pageCount && !state.hasText ? '无文字层' : '';
  updateBookmarkButton();
  const doc = currentDocument();
  if (!state.loading && state.pageCount && doc && (doc.lastPage !== state.page || pendingPositions.has(doc.id))) savePosition(doc.id, state.page);
}

function closeDialog() { $('dialog').close(); }
function dialog(title, html, { wide = false } = {}) {
  hideMenu();
  const el = $('dialog');
  el.classList.toggle('theme-dialog', wide);
  el.classList.remove('collection-dialog', 'screensaver-settings-dialog');
  el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="dialog-heading"><h2>${escape(title)}</h2><button class="icon-button" data-close-dialog aria-label="关闭">×</button></div>${html}`;
  el.showModal();
  el.querySelector('[data-close-dialog]').onclick = closeDialog;
  return el;
}

function formDialog(title, field, submitLabel, save) {
  const el = dialog(title, `<form>${field}<div class="dialog-error" role="alert"></div><div class="dialog-actions"><button type="button" class="quiet-button" data-cancel>取消</button><button class="primary-button">${submitLabel}</button></div></form>`);
  el.querySelector('[data-cancel]').onclick = closeDialog;
  el.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    event.submitter.disabled = true;
    try { await save(new FormData(event.target)); closeDialog(); }
    catch (error) { el.querySelector('.dialog-error').textContent = error.message; event.submitter.disabled = false; }
  };
  return el;
}

function editName(id) {
  const doc = library.documents.find(d => d.id === id);
  if (!doc) return;
  const el = formDialog('重命名', `<label class="form-field">文件名称<input name="name" value="${escape(doc.name)}" maxlength="180" required autofocus></label>`, '保存', data => mutate(`/api/documents/${id}`, { method: 'PATCH', body: { name: data.get('name') } }));
  el.querySelector('input').select();
}

function collectPages() {
  const source = currentDocument();
  if (!source || source.review || lastReaderState.loading || !lastReaderState.pageCount) return;
  openReviewCollection({ source: structuredClone(source), page: lastReaderState.page, pageCount: lastReaderState.pageCount, dialog,
    collect: async (id, data) => {
      const before = new Set(library.documents.map(doc => doc.id));
      const next = await mutate(`/api/documents/${id}/review`, { method: 'POST', body: data });
      return next.documents.find(doc => doc.review && !before.has(doc.id));
    },
    collected: () => {
      tab = 'review'; filter = { categoryId: '', date: '', query: '' }; $('search').value = '';
      renderLibrary(); updateBookmarkButton(); toast('已收录到收藏夹');
    }
  });
}

function moveCategory(id) {
  const doc = library.documents.find(d => d.id === id);
  if (!doc) return;
  formDialog('移动到分类', `<label class="form-field">文件分类<select name="categoryId" aria-label="文件分类"><option value="" ${!doc.categoryId ? 'selected' : ''}>全部文件</option>${library.categories.map(c => `<option value="${escape(c.id)}" ${doc.categoryId === c.id ? 'selected' : ''}>${escape(c.name)}</option>`).join('')}</select></label>`, '保存', data => mutate(`/api/documents/${id}`, { method: 'PATCH', body: { categoryId: data.get('categoryId') } }));
}

function screensaverSettings() {
  const settings = pendingScreensaverSettings || library.settings.screensaver || { enabled: true, minutes: 1 };
  const el = dialog('屏保设置', `<form class="screensaver-controls" novalidate>
    <div class="screensaver-control-row"><label class="screensaver-switch" title="开启屏保"><input type="checkbox" role="switch" name="enabled" aria-label="开启屏保" ${settings.enabled ? 'checked' : ''}><span aria-hidden="true"></span></label>
    <div class="screensaver-wait"><div class="minute-stepper"><input type="number" name="minutes" aria-label="等待时间（分钟）" min="1" max="120" step="1" value="${settings.minutes}" required><div class="minute-arrows"><button type="button" data-step="1" aria-label="增加等待时间"><svg viewBox="0 0 12 8" aria-hidden="true"><path d="m3 5 3-3 3 3"/></svg></button><button type="button" data-step="-1" aria-label="减少等待时间"><svg viewBox="0 0 12 8" aria-hidden="true"><path d="m3 3 3 3 3-3"/></svg></button></div></div><span>分钟</span></div></div>
    <div class="dialog-error" role="alert" hidden></div></form>`);
  el.classList.add('screensaver-settings-dialog');
  const form = el.querySelector('form'), enabled = form.elements.enabled, minutes = form.elements.minutes, error = form.querySelector('[role="alert"]');
  let attempt = 0;
  const commit = () => {
    if (!minutes.checkValidity()) {
      minutes.setAttribute('aria-invalid', 'true');
      error.textContent = '请输入 1–120 的整数分钟。'; error.hidden = false;
      return;
    }
    minutes.removeAttribute('aria-invalid');
    const next = { enabled: enabled.checked, minutes: Number(minutes.value) };
    const previous = pendingScreensaverSettings || library.settings.screensaver;
    if (previous?.enabled === next.enabled && previous.minutes === next.minutes) { error.hidden = true; return; }
    const generation = ++attempt;
    error.hidden = true;
    pendingScreensaverSettings = next;
    // Serialize automatic saves across dialog closes/reopens so the last choice wins.
    const saved = screensaverSaveQueue.then(() => mutate('/api/settings', { method: 'PATCH', body: { screensaver: next } }));
    screensaverSaveQueue = saved.catch(() => {});
    saved.catch(failure => {
      if (generation !== attempt || pendingScreensaverSettings !== next) return;
      const visibleError = el.open && el.classList.contains('screensaver-settings-dialog') ? el.querySelector('[role="alert"]') : null;
      if (visibleError) { visibleError.textContent = failure.message; visibleError.hidden = false; }
      else toast(failure.message, true);
    }).finally(() => { if (pendingScreensaverSettings === next) pendingScreensaverSettings = null; });
  };
  form.onchange = commit;
  form.onsubmit = event => { event.preventDefault(); commit(); };
  for (const button of form.querySelectorAll('[data-step]')) button.onclick = () => {
    if (!minutes.checkValidity()) minutes.value = String((pendingScreensaverSettings || library.settings.screensaver).minutes);
    minutes.stepUp(Number(button.dataset.step)); commit();
  };
  el.addEventListener('close', () => { if (el.contains(form)) commit(); }, { once: true });
}

function addCategory() {
  formDialog('新增分类', '<label class="form-field">分类名称<input name="name" maxlength="60" required autofocus></label>', '创建分类', data => mutate('/api/categories', { method: 'POST', body: { name: data.get('name') } }));
}

async function trashDocument(id) {
  const doc = library.documents.find(d => d.id === id);
  if (!doc || doc.deletedAt) return;
  await mutate(`/api/documents/${id}`, { method: 'DELETE' });
  if (currentId === id) showHome();
  toast('已移到回收站，可随时还原');
}

async function restoreDocument(id) {
  await mutate(`/api/documents/${id}/restore`, { method: 'POST' });
  toast('已还原文件');
}

function permanentlyDelete(id) {
  const doc = library.documents.find(d => d.id === id && d.deletedAt);
  if (!doc) return;
  formDialog('永久删除', `<p class="dialog-description">永久删除「${escape(doc.name)}」及其高亮、批注和书签？此操作无法还原。</p>`, '永久删除', async () => {
    await mutate(`/api/documents/${id}/permanent`, { method: 'DELETE' });
    toast('已永久删除');
  });
}

function renameCategory(id) {
  const category = library.categories.find(c => c.id === id);
  if (!category) return;
  const el = formDialog('重命名分类', `<label class="form-field">分类名称<input name="name" value="${escape(category.name)}" maxlength="60" required autofocus></label>`, '保存', data => mutate(`/api/categories/${id}`, { method: 'PATCH', body: { name: data.get('name') } }));
  el.querySelector('input').select();
}

function deleteCategory(id) {
  const category = library.categories.find(c => c.id === id);
  if (!category) return;
  formDialog('删除分类', `<p class="dialog-description">删除「${escape(category.name)}」分类？其中的文件会保留在「全部文件」，高亮、批注和书签也会保留。</p>`, '删除分类', async () => {
    await mutate(`/api/categories/${id}`, { method: 'DELETE' });
    if (filter.categoryId === id || expandedKey === id) { filter.categoryId = ''; expandedKey = ''; }
    renderLibrary();
    updateDocumentHeading();
    toast('分类已删除，文件已保留');
  });
}

const annotationEditor = new AnnotationEditor({
  host: $('annotation-editor'),
  getAnchorRect: anchor => reader.getAnchorRect(anchor),
  onDelete: ({ id, highlightId }) => deleteAnnotation(id, highlightId),
  onSave: async ({ id, anchor, highlightId, color, note }) => {
    if (highlightId) await mutate(`/api/documents/${id}/highlights/${highlightId}`, { method: 'PATCH', body: { note } });
    else await mutate(`/api/documents/${id}/highlights`, { method: 'POST', body: { page: anchor.page, text: anchor.text, rects: anchor.rects, color, note } });
    if (currentId === id) reader.clearSelection();
    toast('批注已保存，点击原文旁的批注图标可查看');
  }
});

async function deleteAnnotation(id, highlightId) {
  const key = `${id}/${highlightId}`;
  if (pendingAnnotationDeletes.has(key)) return;
  pendingAnnotationDeletes.add(key);
  const editing = annotationEditor.context;
  const lockedGeneration = editing?.id === id && editing.highlightId === highlightId && !annotationEditor.saving ? annotationEditor.generation : null;
  if (lockedGeneration !== null) annotationEditor.setBusy(true);
  try {
    await mutate(`/api/documents/${id}/highlights/${highlightId}`, { method: 'PATCH', body: { note: '' } });
    const current = annotationEditor.context;
    if (current?.id === id && current.highlightId === highlightId) annotationEditor.close({ force: true });
    toast('批注已删除，高亮已保留');
  } finally {
    pendingAnnotationDeletes.delete(key);
    if (lockedGeneration === annotationEditor.generation) annotationEditor.setBusy(false);
  }
}

function editAnnotation(id, selection, highlightId = '') {
  if (pendingAnnotationDeletes.has(`${id}/${highlightId}`)) return;
  const doc = library.documents.find(d => d.id === id && !d.deletedAt);
  if (!doc) return;
  const highlight = doc.highlights.find(h => h.id === highlightId);
  const anchor = highlight || selection;
  if (!anchor?.text || !anchor.rects?.length) return;
  hideMenu();
  annotationEditor.open({ id, anchor, highlightId: highlight?.id, color: highlight?.color || highlightColor, note: highlight?.note || '' });
}

function showThemes() {
  const el = dialog('环境', `<div class="theme-grid">${themes.map(t => `<button class="theme-card ${library.settings.theme === t.id ? 'selected' : ''}" data-theme-id="${t.id}"><img src="${t.image}" alt=""><span>${escape(t.name)}</span></button>`).join('')}</div>`, { wide: true });
  el.querySelectorAll('[data-theme-id]').forEach(button => button.onclick = async () => {
    el.querySelectorAll('.theme-card').forEach(b => b.disabled = true);
    try {
      await mutate('/api/settings', { method: 'PATCH', body: { theme: button.dataset.themeId } });
      applyTheme(library.settings.theme);
      closeDialog();
    } catch (error) { toast(error.message, true); el.querySelectorAll('.theme-card').forEach(b => b.disabled = false); }
  });
}

function palette(selected, attributes = '') {
  return `<div class="color-palette" role="group" aria-label="高亮颜色">${colors.map(c => `<button type="button" class="color-swatch" style="--swatch:${c.value}" data-color="${c.value}" aria-label="${c.name}" title="${c.name}" aria-pressed="${selected === c.value}" ${attributes}></button>`).join('')}</div>`;
}
function rememberColor(color) {
  if (!colors.some(c => c.value === color)) return;
  highlightColor = color;
  try { localStorage.setItem('carnet-pdf-highlight-color', color); } catch {}
}
function showNotes() {
  $('notes-panel').hidden = !$('notes-panel').hidden;
  $('highlights-button').setAttribute('aria-expanded', String(!$('notes-panel').hidden));
  renderNotes();
}
function renderNotes() {
  if ($('notes-panel').hidden) return;
  const doc = currentDocument();
  if (!doc) return;
  const bookmarks = doc.bookmarks || [];
  $('notes-highlights-tab').textContent = `高亮与批注 ${doc.highlights.length}`;
  $('notes-bookmarks-tab').textContent = `书签 ${bookmarks.length}`;
  for (const kind of ['highlights', 'bookmarks']) $('notes-' + kind + '-tab').setAttribute('aria-selected', String(notesTab === kind));
  $('notes-content').setAttribute('aria-labelledby', 'notes-' + notesTab + '-tab');
  $('notes-content').innerHTML = notesTab === 'highlights'
    ? doc.highlights.map(h => `<article class="note-item" style="--note-color:${/^#[0-9a-f]{6}$/i.test(h.color) ? h.color : '#ffe066'}"><header><button class="note-page" data-jump="${h.page}">第 ${h.page} 页 ↗</button><button class="note-delete" data-remove-highlight="${escape(h.id)}" aria-label="取消高亮" title="取消高亮">×</button></header><blockquote>${escape(h.text)}</blockquote>${h.note ? `<p class="annotation-body">${escape(h.note)}</p>` : ''}<div class="annotation-actions"><button data-edit-note="${escape(h.id)}">${h.note ? '编辑批注' : '添加批注'}</button>${h.note ? `<button data-delete-note="${escape(h.id)}">删除批注</button>` : ''}</div>${palette(h.color, `data-recolor="${escape(h.id)}"`)}</article>`).join('') || '<p class="notes-empty">暂无高亮</p>'
    : [...bookmarks].sort((a, b) => a.page - b.page).map(b => `<article class="bookmark-item"><button data-jump="${b.page}"><svg class="bookmark-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4-6 4z"/></svg><span>${escape(b.label || '第 ' + b.page + ' 页')}${b.label && b.label !== '第 ' + b.page + ' 页' ? `<small>第 ${b.page} 页</small>` : ''}</span></button><button class="note-delete" data-remove-bookmark="${escape(b.id)}" aria-label="删除书签" title="删除书签">×</button></article>`).join('') || '<p class="notes-empty">暂无书签</p>';
}

async function toggleBookmark() {
  const doc = currentDocument(), page = lastReaderState.page;
  if (!doc || bookmarkBusy || !lastReaderState.pageCount) return;
  const bookmark = (doc.bookmarks || []).find(b => b.page === page);
  bookmarkBusy = true;
  updateBookmarkButton();
  try {
    await mutate(`/api/documents/${doc.id}/bookmarks${bookmark ? '/' + bookmark.id : ''}`, bookmark ? { method: 'DELETE' } : { method: 'POST', body: { page } });
  } catch (error) { toast(error.message, true); }
  finally { bookmarkBusy = false; updateBookmarkButton(); }
}

$('notes-content').onclick = async event => {
  const button = event.target.closest('button'), doc = currentDocument();
  if (!button || !doc) return;
  if (button.dataset.jump) return reader.goTo(Number(button.dataset.jump)).catch(() => {});
  if (button.dataset.editNote) return editAnnotation(doc.id, null, button.dataset.editNote);
  if (button.dataset.deleteNote && annotationEditor.saving) return;
  button.disabled = true;
  try {
    if (button.dataset.removeHighlight) await mutate(`/api/documents/${doc.id}/highlights/${button.dataset.removeHighlight}`, { method: 'DELETE' });
    if (button.dataset.deleteNote) await deleteAnnotation(doc.id, button.dataset.deleteNote);
    if (button.dataset.removeBookmark) await mutate(`/api/documents/${doc.id}/bookmarks/${button.dataset.removeBookmark}`, { method: 'DELETE' });
    if (button.dataset.recolor) {
      await mutate(`/api/documents/${doc.id}/highlights/${button.dataset.recolor}`, { method: 'PATCH', body: { color: button.dataset.color } });
      rememberColor(button.dataset.color);
    }
  } catch (error) { toast(error.message, true); button.disabled = false; }
};

function hideMenu() { $('context-menu').hidden = true; menuContext = null; }
function showMenu(x, y, html, context) {
  const menu = $('context-menu');
  menu.innerHTML = html;
  menu.hidden = false;
  menuContext = context;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 12))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 12))}px`;
}
function fileMenu(id, event) {
  const doc = library.documents.find(d => d.id === id);
  if (!doc) return;
  event.preventDefault();
  const actions = doc.deletedAt
    ? '<button role="menuitem" data-action="restore">还原</button><button role="menuitem" class="danger-action" data-action="permanent">永久删除</button>'
    : `<button role="menuitem" data-action="rename">重命名</button>${doc.review ? '' : '<button role="menuitem" data-action="move">移动到分类</button>'}<button role="menuitem" class="danger-action" data-action="trash">移到回收站</button>`;
  showMenu(event.clientX, event.clientY, `${actions}<a role="menuitem" href="/api/documents/${id}/file?download" download="${escape(pdfFileName(doc.name))}">${doc.review ? '导出 PDF' : '导出原始 PDF'}</a>`, { id, type: 'file' });
}
function categoryMenu(id, event) {
  if (!library.categories.some(c => c.id === id)) return;
  event.preventDefault();
  showMenu(event.clientX, event.clientY, '<button role="menuitem" data-action="rename-category">重命名分类</button><button role="menuitem" data-action="delete-category">删除分类</button>', { id, type: 'category' });
}
$('context-menu').addEventListener('pointerdown', event => event.preventDefault());
$('context-menu').onclick = async event => {
  const button = event.target.closest('[data-action], [data-color]');
  if (!button || !menuContext || button.disabled) return;
  const action = button.dataset.color ? 'highlight' : button.dataset.action;
  const context = menuContext;
  if (button.dataset.color) rememberColor(button.dataset.color);
  hideMenu();
  if (action === 'rename') return editName(context.id);
  if (action === 'move') return moveCategory(context.id);
  if (action === 'permanent') return permanentlyDelete(context.id);
  if (action === 'rename-category') return renameCategory(context.id);
  if (action === 'delete-category') return deleteCategory(context.id);
  if (action === 'annotation') return editAnnotation(context.id, context.selection, context.annotationId);
  try {
    if (action === 'delete-annotation') {
      if (annotationEditor.saving) return;
      await deleteAnnotation(context.id, context.annotationId);
    }
    if (action === 'trash') await trashDocument(context.id);
    if (action === 'restore') await restoreDocument(context.id);
    if (action === 'copy') { await navigator.clipboard.writeText(context.selection.text); toast('已复制'); }
    if (action === 'highlight') {
      await mutate(`/api/documents/${context.id}/highlights`, { method: 'POST', body: { page: context.selection.page, text: context.selection.text, rects: context.selection.rects, color: highlightColor } });
      reader.clearSelection();
    }
    if (action === 'remove') {
      for (const id of context.selection.highlightIds) await mutate(`/api/documents/${context.id}/highlights/${id}`, { method: 'DELETE' });
      reader.clearSelection();
    }
  } catch (error) { toast(action === 'copy' ? '复制失败，请使用 Ctrl+C。' : error.message, true); }
};
$('reader-host').addEventListener('click', event => {
  const marker = event.target.closest('[data-annotation-id]');
  if (marker && currentId) editAnnotation(currentId, null, marker.dataset.annotationId);
});
$('reader-host').addEventListener('contextmenu', event => {
  if (!currentId) return;
  event.preventDefault();
  const marker = event.target.closest('[data-annotation-id]');
  if (marker) {
    const annotation = currentDocument()?.highlights.find(h => h.id === marker.dataset.annotationId && h.note);
    if (!annotation) return hideMenu();
    const disabled = annotationEditor.saving || pendingAnnotationDeletes.has(`${currentId}/${annotation.id}`) ? 'disabled' : '';
    return showMenu(event.clientX, event.clientY, `<button role="menuitem" data-action="annotation" ${disabled}>编辑批注</button><button role="menuitem" class="danger-action" data-action="delete-annotation" ${disabled}>删除批注</button>`, { type: 'annotation', id: currentId, annotationId: annotation.id });
  }
  const selection = reader.selectionAt(event);
  if (!selection) return hideMenu();
  const hasSelection = selection.text.trim() && selection.rects.length;
  if (!hasSelection && !selection.highlightIds.length) return hideMenu();
  const highlighted = currentDocument()?.highlights.find(h => selection.highlightIds.includes(h.id));
  showMenu(event.clientX, event.clientY, `<button role="menuitem" data-action="copy" ${!hasSelection ? 'disabled' : ''}>复制<span class="menu-shortcut">Ctrl+C</span></button><button role="menuitem" data-action="highlight" ${!hasSelection ? 'disabled' : ''}>高亮所选文字</button>${hasSelection ? palette(highlightColor) : ''}<button role="menuitem" data-action="annotation">${highlighted?.note ? '编辑批注' : '添加批注'}</button><button role="menuitem" data-action="remove" ${!selection.highlightIds.length ? 'disabled' : ''}>取消高亮</button>`, { type: 'pdf', id: currentId, selection, annotationId: highlighted?.id });
});

GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
async function validatePdf(file) {
  if (file.size > 1024 * 1024 * 1024) throw new Error('单个 PDF 最大支持 1 GB。');
  if (!file.size) throw new Error('这是一个空文件。');
  const header = await file.slice(0,1024).arrayBuffer();
  if (!new TextDecoder('latin1').decode(header).includes('%PDF-')) throw new Error('文件不是有效的 PDF。');
  const url = URL.createObjectURL(file);
  const task = getDocument({ url, isEvalSupported: false });
  let password = false;
  task.onPassword = () => { password = true; task.destroy(); };
  try { const pdf = await task.promise; if (!pdf.numPages) throw new Error('PDF 中没有页面。'); }
  catch { throw new Error(password ? '此 PDF 需要密码，请先解密后再导入。' : '无法解析此 PDF，文件可能已损坏。'); }
  finally { await task.destroy(); URL.revokeObjectURL(url); }
}
async function importFiles(files) {
  if (!ready || busy) return;
  const candidates = [...files];
  if (!candidates.length) return;
  busy = true;
  const navigationVersion = openGeneration;
  const category = tab === 'categories' ? filter.categoryId || '' : '';
  $('import-button').disabled = true;
  $('welcome-import').disabled = true;
  let latest = '', success = 0, failures = [];
  for (let i = 0; i < candidates.length; i++) {
    const file = candidates[i];
    $('save-status').textContent = `导入中 ${i + 1}/${candidates.length}…`;
    try {
      await validatePdf(file);
      const before = new Set(library.documents.map(d => d.id));
      await mutate('/api/documents', { method: 'POST', body: file, headers: { 'Content-Type': 'application/pdf', 'x-file-name': encodeURIComponent(file.name), 'x-category-id': category } });
      latest = library.documents.find(d => !before.has(d.id))?.id || latest;
      success++;
    } catch (error) { failures.push(`${file.name}：${error.message}`); }
  }
  busy = false;
  $('import-button').disabled = false;
  $('welcome-import').disabled = false;
  $('file-input').value = '';
  $('save-status').textContent = failures.length ? '导入未完成' : '已保存';
  if (latest && navigationVersion === openGeneration) {
    filter = { categoryId: category, date: '', query: '' };
    tab = 'categories';
    expandedKey = category;
    $('search').value = '';
    await openDocument(latest);
  }
  if (failures.length) dialog('导入失败', `<div class="dialog-description">${failures.map(x => `<p>${escape(x)}</p>`).join('')}</div>`);
  else toast(`已导入 ${success} 份 PDF`);
}

// Cancel browser-level zoom for the entire app. The PDF gets the wheel gesture.
let wheelTimer, wheelZoom, wheelAnchor;
function cancelWheelZoom() { clearTimeout(wheelTimer); wheelZoom = undefined; }
window.addEventListener('wheel', event => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  if (!currentId || !lastReaderState.pageCount || $('dialog').open) return;
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
  wheelZoom = Math.min(4, Math.max(.25, (wheelZoom ?? reader.zoom) * Math.exp(-delta * .002)));
  const host = $('reader-host').getBoundingClientRect();
  wheelAnchor = event.clientX >= host.left && event.clientX <= host.right && event.clientY >= host.top && event.clientY <= host.bottom ? { clientX: event.clientX, clientY: event.clientY } : {};
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { const zoom = wheelZoom; wheelZoom = undefined; reader.setZoom(zoom, wheelAnchor).catch(() => {}); }, 45);
}, { passive: false, capture: true });

for (const id of ['import-button', 'welcome-import']) $(id).onclick = () => $('file-input').click();
$('file-input').onchange = event => importFiles(event.target.files);
$('search').oninput = event => { filter.query = event.target.value; if (expandedKey === null) expandedKey = ''; renderLibrary(); };
$('filters').onclick = event => {
  if(Date.now()<dragSuppressUntil)return;
  const open = event.target.closest('[data-open]'), menu = event.target.closest('[data-file-menu]'), category = event.target.closest('[data-category-menu]'), button = event.target.closest('[data-filter]');
  if (open) return openDocument(open.dataset.open);
  if (menu) return fileMenu(menu.dataset.fileMenu, event);
  if (category) return categoryMenu(category.dataset.categoryMenu, event);
  if (!button) return;
  expandedKey = expandedKey === button.dataset.filter ? null : button.dataset.filter;
  filter.categoryId = tab === 'categories' && expandedKey !== null ? button.dataset.filter : '';
  filter.date = tab === 'dates' ? button.dataset.filter : '';
  renderLibrary();
};
for (const kind of ['categories', 'dates', 'trash', 'review']) $(kind + '-tab').onclick = () => { tab = kind; expandedKey = ''; filter.categoryId = ''; filter.date = ''; renderLibrary(); };
document.querySelector('.library').addEventListener('contextmenu', event => {
  event.preventDefault();
  const file = event.target.closest('[data-drag-document]');
  if (file) return fileMenu(file.dataset.dragDocument, event);
  const category = event.target.closest('[data-category-menu], [data-filter]');
  const id = category?.dataset.categoryMenu || category?.dataset.filter;
  if (tab === 'categories' && id) return categoryMenu(id, event);
  hideMenu();
});
$('add-category').onclick = addCategory;
$('theme-button').onclick = showThemes;
$('fullscreen-button').onclick = toggleFullscreen;
document.querySelector('.brand').onclick = event => { event.preventDefault(); showHome(); };
$('highlights-button').onclick = showNotes;
$('close-notes').onclick = showNotes;
for (const kind of ['highlights', 'bookmarks']) $('notes-' + kind + '-tab').onclick = () => { notesTab = kind; renderNotes(); };
$('bookmark-button').onclick = toggleBookmark;
$('collect-pages-button').onclick = collectPages;
$('previous-page').onclick = () => reader.goTo(lastReaderState.page - 1).catch(() => {});
$('next-page').onclick = () => reader.goTo(lastReaderState.page + 1).catch(() => {});
$('page-number').onchange = event => reader.goTo(Number(event.target.value)).catch(() => {});
$('zoom-out').onclick = () => { cancelWheelZoom(); reader.setZoom(Math.max(.25, lastReaderState.zoom - .15)).catch(() => {}); };
$('zoom-in').onclick = () => { cancelWheelZoom(); reader.setZoom(lastReaderState.zoom + .15).catch(() => {}); };
$('fit-width').onclick = () => { cancelWheelZoom(); reader.setZoom('fit').catch(() => {}); };
$('rotate-page').onclick = () => { cancelWheelZoom(); reader.rotate().catch(() => {}); };
$('motion-button').onclick = () => { motion = !motion; try { localStorage.setItem('carnet-pdf-motion', motion ? 'on' : 'off'); } catch {} applyTheme(library.settings.theme); };
$('screensaver-settings').onclick = screensaverSettings;
document.addEventListener('pointerdown', event => { if (!event.target.closest('#context-menu') && !event.target.closest('[data-file-menu]')) hideMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    hideMenu();
    if (!$('annotation-editor').hidden) { event.preventDefault(); annotationEditor.close(); return; }
  }
  if ($('dialog').open || event.target.matches('input,textarea,select')) return;
  if (event.key === 'Escape' && readingFullscreen) { event.preventDefault(); exitReadingFullscreen(); return; }
  if (event.key === '/') { event.preventDefault(); $('search').focus(); }
  if (event.key === 'ArrowRight' && currentId && !lastReaderState.loading) { event.preventDefault(); reader.goTo(lastReaderState.page + 1).catch(() => {}); }
  if (event.key === 'ArrowLeft' && currentId && !lastReaderState.loading) { event.preventDefault(); reader.goTo(lastReaderState.page - 1).catch(() => {}); }
});
let dragDepth = 0;
document.addEventListener('dragenter', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; } });
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
document.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; if (event.dataTransfer.files.length) importFiles(event.dataTransfer.files); });
document.addEventListener('visibilitychange', () => scene.setHidden(document.hidden));
reducedMotion.addEventListener('change', () => applyTheme(library.settings.theme));
const dragType='application/x-carnet-pdf';
$('filters').addEventListener('dragstart',event=>{
  const row=event.target.closest('[data-drag-document]');
  if(!row||row.getAttribute('draggable') !== 'true'||busy){event.preventDefault();return;}
  draggedDocument=row.dataset.dragDocument;event.dataTransfer.setData(dragType,draggedDocument);event.dataTransfer.effectAllowed='move';
  row.classList.add('dragging');hideMenu();
});
function clearDropTargets(){document.querySelectorAll('.category-drop-target,.dragging').forEach(el=>el.classList.remove('category-drop-target','dragging'));}
$('filters').addEventListener('dragend',()=>{draggedDocument='';dragSuppressUntil=Date.now()+250;clearDropTargets();});
$('filters').addEventListener('dragover',event=>{
  const target=event.target.closest('[data-filter]');
  if(tab!=='categories'||!target||!draggedDocument||!event.dataTransfer.types.includes(dragType))return;
  event.preventDefault();event.dataTransfer.dropEffect='move';
  document.querySelectorAll('.category-drop-target').forEach(el=>{if(el!==target)el.classList.remove('category-drop-target');});
  target.classList.add('category-drop-target');
});
$('filters').addEventListener('dragleave',event=>{
  const target=event.target.closest('[data-filter]');if(target&&!target.contains(event.relatedTarget))target.classList.remove('category-drop-target');
});
$('filters').addEventListener('drop',async event=>{
  if(!event.dataTransfer.types.includes(dragType))return;
  event.preventDefault();event.stopPropagation();clearDropTargets();
  const target=event.target.closest('[data-filter]'),id=event.dataTransfer.getData(dragType);
  draggedDocument='';dragSuppressUntil=Date.now()+250;
  if(tab!=='categories'||!target||busy)return;
  const doc=library.documents.find(d=>d.id===id),categoryId=target.dataset.filter;
  if(!doc||doc.deletedAt||doc.review||doc.categoryId===categoryId||categoryId&&!library.categories.some(c=>c.id===categoryId))return;
  try{await mutate(`/api/documents/${id}`,{method:'PATCH',body:{categoryId}});toast(`已移至 ${library.categories.find(c=>c.id===categoryId)?.name||'全部文件'}`);}
  catch(error){toast(error.message,true);}
});
window.addEventListener('pagehide', () => {
  if (!ready || !token) return;
  const positions = new Map([...pendingPositions].map(([id, entry]) => [id, entry.page]));
  if (currentId && lastReaderState.pageCount && !lastReaderState.loading && currentDocument()?.lastPage !== lastReaderState.page) positions.set(currentId, lastReaderState.page);
  for (const [id, lastPage] of positions) {
    fetch(`/api/documents/${id}`, { method: 'PATCH', headers: { 'x-carnet-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ lastPage }), keepalive: true }).catch(() => {});
  }
});
window.addEventListener('resize', () => { scene.resize(); hideMenu(); });
window.addEventListener('focus', async () => {
  if (!ready || busy) return;
  try { const next = await api('/api/library'); if (next.revision > library.revision) { accept(next); applyTheme(library.settings.theme); } } catch {}
});

async function initialize() {
  try {
    ({ token } = await api('/api/session'));
    accept(await api('/api/library'));
    ready = true;
    screensaver.start();
    $('save-status').textContent = '已保存';
    applyTheme(library.settings.theme);
    let remembered = '';
    try { remembered = sessionStorage.getItem('carnet-pdf-current'); } catch {}
    if (remembered && library.documents.some(d => d.id === remembered && !d.deletedAt)) await openDocument(remembered);
  } catch (error) {
    $('save-status').textContent = '连接失败';
    $('welcome').innerHTML = `<div class="fatal-message"><h3>无法打开资料库</h3><p>${escape(error.message)}</p><button class="primary-button" id="retry">重试</button></div>`;
    $('retry').onclick = () => location.reload();
    toast(error.message, true);
  }
}
applyTheme('mediterranean');
initialize();
