import { parsePageSelection, formatPageList, collectionTime } from './review-model.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

/** A collection is a snapshot: the source and page count are captured on open. */
export function openReviewCollection({ source, page, pageCount, dialog, collect, collected }) {
  const highlighted = [...new Set(source.highlights.map(item => item.page))].filter(p => p <= pageCount);
  const bookmarked = (source.bookmarks || []).map(item => item.page).filter(p => p <= pageCount);
  const el = dialog('收录到复习仓库', `<form class="collection-form">
    <p class="collection-source" title="${escape(source.name)}">${escape(source.name)}<span>共 ${pageCount} 页</span></p>
    <label class="form-field">收录页码<input name="pages" aria-label="收录页码" value="${page}" maxlength="4000" autocomplete="off" required autofocus></label>
    <div class="collection-shortcuts"><button type="button" data-page-choice="current">当前页</button><button type="button" data-page-choice="highlights" ${highlighted.length ? '' : 'disabled'}>有高亮的页</button><button type="button" data-page-choice="bookmarks" ${bookmarked.length ? '' : 'disabled'}>有书签的页</button></div>
    <p class="collection-help">可填单页、区间或多页，例如 2, 5-7。按原页序合为一份。</p>
    <p class="collection-summary" aria-live="polite"></p>
    <label class="form-field">资料名称<input name="name" aria-label="资料名称" maxlength="180" placeholder="${collectionTime(new Date()).replaceAll(':', '-')}"></label>
    <p class="collection-help">留空以收录时间命名。保留所选页的高亮、批注和书签。</p>
    <div class="dialog-error" role="alert"></div>
    <div class="dialog-actions"><button type="button" class="quiet-button" data-cancel>取消</button><button class="primary-button" type="submit">收录</button></div>
  </form>`);
  el.classList.add('collection-dialog');
  const form = el.querySelector('form'), pagesInput = form.elements.pages;
  const summary = el.querySelector('.collection-summary'), error = el.querySelector('.dialog-error');
  const submit = form.querySelector('[type="submit"]');
  let saving = false;
  const validate = () => {
    try {
      const pages = parsePageSelection(pagesInput.value, pageCount);
      summary.textContent = `将收录 ${pages.length} 页 · 第 ${formatPageList(pages)} 页`;
      summary.classList.remove('invalid'); error.textContent = ''; return pages;
    } catch (failure) {
      summary.textContent = failure.message; summary.classList.add('invalid'); return null;
    }
  };
  pagesInput.oninput = validate;
  for (const button of form.querySelectorAll('[data-page-choice]')) button.onclick = () => {
    pagesInput.value = formatPageList(button.dataset.pageChoice === 'highlights' ? highlighted : button.dataset.pageChoice === 'bookmarks' ? bookmarked : [page]);
    validate(); pagesInput.focus();
  };
  el.querySelector('[data-cancel]').onclick = () => { if (!saving) el.close(); };
  const preventCancel = event => { if (saving) event.preventDefault(); };
  el.addEventListener('cancel', preventCancel);
  el.addEventListener('close', () => el.removeEventListener('cancel', preventCancel), { once: true });
  form.onsubmit = async event => {
    event.preventDefault();
    if (saving) return;
    const pages = validate();
    if (!pages) { error.textContent = summary.textContent; pagesInput.focus(); return; }
    const name = form.elements.name.value;
    const controls = [...el.querySelectorAll('input, button')];
    const disabled = controls.map(control => control.disabled);
    saving = true;
    controls.forEach(control => { control.disabled = true; });
    submit.textContent = '正在收录…';
    try {
      const entry = await collect(source.id, { pages, name });
      saving = false; el.close(); collected(entry);
    } catch (failure) {
      error.textContent = failure.message;
      saving = false;
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      submit.textContent = '收录';
    }
  };
  validate(); pagesInput.select();
  return el;
}
