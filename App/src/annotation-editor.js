// A nonmodal comment card. The quote is captured before focusing the editor,
// so browser selection changes cannot change the annotation being saved.
export class AnnotationEditor {
  constructor({ host, getAnchorRect, onSave, onDelete }) {
    this.host = host;
    this.getAnchorRect = getAnchorRect;
    this.onSave = onSave;
    this.onDelete = onDelete;
    this.anchor = null;
    this.saving = false;
    this.generation = 0;
    document.addEventListener('scroll', () => this.position(), { capture: true, passive: true });
    window.addEventListener('resize', () => this.position());
    this.observer = new ResizeObserver(() => this.position());
    this.observer.observe(host);
    host.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); this.close();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); this.host.querySelector('form')?.requestSubmit();
      }
    });
  }

  open({ id, anchor, highlightId, color, note = '' }) {
    if (this.saving) return;
    const generation = ++this.generation;
    this.anchor = structuredClone(anchor);
    this.context = { id, anchor: this.anchor, highlightId, color };
    const host = this.host;
    host.replaceChildren();
    host.innerHTML = `<form>
      <header class="comment-heading"><span class="comment-dot" aria-hidden="true"></span><div><h2></h2><span class="comment-page"></span></div><button type="button" class="comment-close" aria-label="关闭批注">×</button></header>
      <blockquote class="comment-quote"></blockquote>
      <label class="comment-label" for="comment-text">批注内容</label>
      <textarea id="comment-text" name="note" maxlength="10000" rows="4" required placeholder="写下你的想法…"></textarea>
      <p class="comment-error" role="alert" hidden></p>
      <p class="comment-shortcut">Ctrl + Enter 保存</p>
      <footer class="comment-footer">${note && highlightId ? '<button type="button" class="comment-delete danger-action">删除批注</button>' : ''}<button type="button" class="comment-cancel">取消</button><button type="submit" class="comment-save">保存批注</button></footer>
    </form>`;
    const title = note ? '编辑批注' : '添加批注';
    host.setAttribute('aria-label', title);
    host.style.setProperty('--comment-color', color);
    host.querySelector('h2').textContent = title;
    host.querySelector('.comment-page').textContent = `第 ${anchor.page} 页 · 文字批注`;
    host.querySelector('blockquote').textContent = anchor.text;
    const input = host.querySelector('textarea');
    input.value = note;
    host.querySelector('.comment-close').onclick = () => this.close();
    host.querySelector('.comment-cancel').onclick = () => this.close();
    const commit = async (operation, fallback) => {
      if (this.saving) return;
      const error = host.querySelector('.comment-error');
      this.setBusy(true);
      error.hidden = true;
      try {
        await operation();
        if (generation !== this.generation) return;
        this.saving = false;
        this.close();
      } catch (failure) {
        if (generation !== this.generation) return;
        this.setBusy(false);
        error.textContent = failure.message || fallback; error.hidden = false;
        input.focus();
      }
    };
    host.querySelector('form').onsubmit = event => {
      event.preventDefault();
      if (this.saving) return;
      const text = input.value.trim(), error = host.querySelector('.comment-error');
      if (!text) { error.textContent = '请填写批注内容。'; error.hidden = false; input.focus(); return; }
      const context = { ...this.context, note: text };
      return commit(() => this.onSave(context), '未能保存，请重试。');
    };
    const deleteButton = host.querySelector('.comment-delete');
    if (deleteButton) deleteButton.onclick = () => {
      const context = { ...this.context };
      return commit(() => this.onDelete(context), '未能删除，请重试。');
    };
    host.hidden = false;
    this.position();
    input.focus({ preventScroll: true });
  }

  setBusy(busy) {
    this.saving = busy;
    this.host.querySelectorAll('button,textarea').forEach(el => el.disabled = busy);
  }

  position() {
    if (this.host.hidden || !this.anchor) return;
    const rect = this.getAnchorRect(this.anchor);
    const width = this.host.offsetWidth, height = this.host.offsetHeight, gap = 12;
    const bounds = document.querySelector('#reader-host').getBoundingClientRect();
    const origin = rect || { left: bounds.right - width - gap, right: bounds.right - gap, top: bounds.top + 20, bottom: bounds.top + 20 };
    let x = origin.right + gap;
    let y = origin.top;
    if (x + width > innerWidth - gap) {
      if (origin.left - width - gap >= bounds.left) x = origin.left - width - gap;
      else { x = origin.left; y = origin.bottom + gap; }
    }
    this.host.style.left = `${Math.max(gap, Math.min(x, innerWidth - width - gap))}px`;
    this.host.style.top = `${Math.max(gap, Math.min(y, innerHeight - height - gap))}px`;
  }

  close({ force = false } = {}) {
    if (this.saving && !force) return;
    ++this.generation;
    this.saving = false;
    this.host.hidden = true;
    this.anchor = null;
    this.context = null;
  }
}
