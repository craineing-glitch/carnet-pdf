const activityEvents = ['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'mousemove', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel'];

function normalizedSettings(value = {}) {
  const minutes = Number(value.minutes);
  return { enabled: value.enabled !== false, minutes: Number.isInteger(minutes) ? Math.min(120, Math.max(1, minutes)) : 1 };
}

export class IdleScreensaver {
  constructor({ element, getTheme, getSettings, onShow = () => {}, onHide = () => {} }) {
    this.element = element;
    this.getTheme = getTheme;
    this.getSettings = getSettings;
    this.onShow = onShow;
    this.onHide = onHide;
    this.document = element.ownerDocument;
    this.window = this.document.defaultView;
    this.started = false;
    this.destroyed = false;
    this._active = false;
    this.settings = null;
    this.idleTimer = null;
    this.clockTimer = null;
    this.blockedKeys = new Set();
    this.pointerHeld = false;
    this.blockMouse = false;
    this.blockTouch = false;
    this.mouseCompanion = '';
    this.moveWakeUntil = 0;
    this.wheelWakeUntil = 0;
    this.activity = event => this.handleActivity(event);
    this.visibility = () => {
      this.clearClock();
      this.resetIdle();
      if (this.active && !this.document.hidden) this.updateClock();
    };
    this.cancel = event => {
      this.consume(event);
      this.hide();
    };
    element.tabIndex = -1;
    element.setAttribute('aria-modal', 'true');
    element.innerHTML = '<div class="screensaver-photo" aria-hidden="true"></div><div class="screensaver-shade" aria-hidden="true"></div><div class="screensaver-content" lang="fr"><div class="screensaver-heading"><p class="screensaver-date"></p><time class="screensaver-clock"></time></div><div class="screensaver-message"><p class="screensaver-motto">Toujours plus loin</p><p class="screensaver-quote"></p></div></div><p class="screensaver-hint">移动鼠标或按任意键，继续阅读</p>';
    this.photo = element.querySelector('.screensaver-photo');
    this.clock = element.querySelector('time');
    this.date = element.querySelector('.screensaver-date');
    this.quote = element.querySelector('.screensaver-quote');
    this.dateFormatter = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    this.timeFormatter = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }

  get active() { return this._active; }

  start() {
    if (this.started || this.destroyed) return;
    this.started = true;
    for (const type of activityEvents) this.window.addEventListener(type, this.activity, { capture: true, passive: false });
    this.document.addEventListener('visibilitychange', this.visibility);
    this.element.addEventListener('cancel', this.cancel);
    this.configure();
    this.resetIdle();
  }

  configure() {
    if (this.destroyed) return;
    const next = normalizedSettings(this.getSettings?.() || {});
    const changed = !this.settings || next.enabled !== this.settings.enabled || next.minutes !== this.settings.minutes;
    this.settings = next;
    if (this.active) this.updateTheme();
    if (changed) this.resetIdle();
  }

  resetIdle() {
    this.window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.started || this.destroyed || this.active || this.document.hidden || !this.settings?.enabled) return;
    this.idleTimer = this.window.setTimeout(() => {
      this.idleTimer = null;
      this.show();
    }, this.settings.minutes * 60000);
  }

  show() {
    if (this.destroyed || this.document.hidden) return;
    if (!this.started) this.start();
    this.updateTheme();
    if (this.active) return;
    this._active = true;
    this.resetIdle();
    this.element.showModal();
    this.updateClock();
    this.onShow();
  }

  hide() {
    if (!this.active) return;
    this._active = false;
    this.clearClock();
    this.element.close();
    this.resetIdle();
    this.onHide();
  }

  updateTheme() {
    const theme = this.getTheme?.() || {};
    this.element.dataset.theme = theme.id || '';
    this.photo.style.backgroundImage = theme.image ? `url(${JSON.stringify(theme.image)})` : 'none';
    this.quote.textContent = theme.quote || '';
  }

  clearClock() {
    this.window.clearTimeout(this.clockTimer);
    this.clockTimer = null;
  }

  updateClock() {
    this.clearClock();
    if (!this.active || this.document.hidden) return;
    const now = new Date();
    this.clock.textContent = this.timeFormatter.format(now);
    this.clock.dateTime = now.toISOString();
    this.date.textContent = this.dateFormatter.format(now);
    this.clockTimer = this.window.setTimeout(() => this.updateClock(), 60000 - now.getTime() % 60000);
  }

  consume(event) {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }

  handleActivity(event) {
    const type = event.type;
    const key = event.code || event.key;
    const now = this.window.performance.now();
    let blocked = false;
    if (type === 'keydown' || type === 'keyup') {
      blocked = this.blockedKeys.has(key);
      if (this.active && type === 'keydown') this.blockedKeys.add(key);
      if (type === 'keyup') this.blockedKeys.delete(key);
    }

    // Retain only the waking gesture, so a second intentional click works immediately.
    if (this.active && (type === 'pointermove' || type === 'mousemove')) this.moveWakeUntil = now + 350;
    if (type === 'wheel') {
      blocked = now < this.wheelWakeUntil;
      if (this.active || blocked) this.wheelWakeUntil = now + 250;
    }
    if ((type === 'pointerdown' || type === 'mousedown') && now < this.moveWakeUntil) blocked = true;
    if (type === 'pointerdown' && !this.pointerHeld) {
      this.blockMouse = false;
      this.mouseCompanion = '';
    }
    if (type.startsWith('pointer')) {
      blocked ||= this.pointerHeld || (this.blockMouse && type !== 'pointerdown');
      if (this.active || blocked) {
        if (type === 'pointerdown' || (type === 'pointermove' && event.buttons)) {
          this.pointerHeld = true;
          this.blockMouse = true;
          this.blockTouch = event.pointerType === 'touch';
        }
        if (type === 'pointerup' || type === 'pointercancel') {
          this.pointerHeld = false;
          this.blockMouse = true;
        }
        this.mouseCompanion = type.replace('pointer', 'mouse');
      }
    }
    if (type === 'mousedown' || type === 'mouseup' || type === 'mousemove') {
      blocked ||= this.blockMouse || this.mouseCompanion === type;
      if (this.mouseCompanion === type) this.mouseCompanion = '';
      if ((this.active || blocked) && (type === 'mousedown' || type === 'mouseup')) this.blockMouse = true;
    }
    if (type.startsWith('touch')) {
      blocked ||= this.blockTouch;
      if (this.active && (type === 'touchstart' || type === 'touchmove')) {
        this.blockTouch = true;
        this.blockMouse = true;
      }
      if (type === 'touchend' || type === 'touchcancel') this.blockTouch = false;
    }
    if (type === 'click' || type === 'contextmenu') {
      blocked ||= this.blockMouse;
      this.blockMouse = false;
      this.pointerHeld = false;
      this.mouseCompanion = '';
      this.moveWakeUntil = 0;
    }
    if (this.active || blocked) {
      this.consume(event);
      this.hide();
    }
    this.resetIdle();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hide();
    this.resetIdle();
    this.clearClock();
    for (const type of activityEvents) this.window.removeEventListener(type, this.activity, true);
    this.document.removeEventListener('visibilitychange', this.visibility);
    this.element.removeEventListener('cancel', this.cancel);
    this.blockedKeys.clear();
    this.started = false;
  }
}
