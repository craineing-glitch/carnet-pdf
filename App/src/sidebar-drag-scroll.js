/** Keep a native file drag moving through a long sidebar, including while held still. */
export function createSidebarDragScroll(container, { isDragging }) {
  const doc = container.ownerDocument, view = doc.defaultView;
  let point = null, frame = null, previousTime = null, remainder = 0, destroyed = false;
  const removers = [];

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  }

  function inside(position, rect = container.getBoundingClientRect()) {
    return position && position.x >= rect.left && position.x < rect.right
      && position.y >= rect.top && position.y < rect.bottom;
  }

  function stop() {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    point = null;
    previousTime = null;
    remainder = 0;
  }

  function velocity() {
    if (destroyed || !point || !isDragging() || doc.hidden || !container.isConnected) return 0;
    const rect = container.getBoundingClientRect();
    if (!inside(point, rect) || rect.height <= 0) return 0;
    const edge = Math.min(80, rect.height / 4);
    const top = point.y - rect.top, bottom = rect.bottom - point.y;
    const distance = Math.min(top, bottom);
    if (distance >= edge) return 0;
    const strength = 1 - distance / edge;
    return (top < bottom ? -1 : 1) * (80 + 640 * strength * strength);
  }

  function tick(time) {
    frame = null;
    const speed = velocity();
    if (!speed) { previousTime = null; return; }
    // A bounded elapsed time prevents a large jump when a busy frame is delayed.
    const elapsed = previousTime === null ? 16 : Math.min(32, Math.max(0, time - previousTime));
    previousTime = time;
    const distance = remainder + speed * elapsed / 1000;
    const pixels = Math.trunc(distance);
    remainder = distance - pixels;
    container.scrollTop += pixels;
    // scrollTop rounds to whole pixels. A subpixel frame is not an edge;
    // carry its distance forward so a stationary slow drag keeps moving.
    const canScroll = speed < 0 ? container.scrollTop > 0 : container.scrollTop < container.scrollHeight - container.clientHeight;
    if (canScroll) frame = view.requestAnimationFrame(tick);
    else { previousTime = null; remainder = 0; }
  }

  function update(event) {
    const next = { x: event.clientX, y: event.clientY };
    if (destroyed || !isDragging() || doc.hidden || !inside(next)) { stop(); return; }
    point = next;
    if (!velocity()) {
      if (frame !== null) view.cancelAnimationFrame(frame);
      frame = null;
      previousTime = null;
      return;
    }
    if (frame === null) frame = view.requestAnimationFrame(tick);
  }

  // Native dragover can arrive only a few times per second. It updates position;
  // animation frames supply movement until the next position or cancellation.
  listen(container, 'dragenter', update);
  listen(doc, 'dragover', event => {
    if (point && (!container.contains(event.target) || !inside({ x: event.clientX, y: event.clientY }))) stop();
  }, true);
  listen(doc, 'dragleave', event => {
    if (!point) return;
    if (event.relatedTarget && container.contains(event.relatedTarget)) return;
    const outside = !inside({ x: event.clientX, y: event.clientY });
    const leftDocument = !event.relatedTarget && (event.target === doc || event.target === doc.documentElement);
    if (outside || leftDocument || event.relatedTarget && !container.contains(event.relatedTarget)) stop();
  }, true);
  for (const type of ['dragend', 'drop']) listen(doc, type, stop, true);
  listen(doc, 'keydown', event => { if (event.key === 'Escape') stop(); }, true);
  listen(doc, 'visibilitychange', () => { if (doc.hidden) stop(); });
  listen(view, 'blur', stop);
  listen(view, 'pagehide', stop);
  listen(container, 'wheel', event => {
    if (destroyed || !point || !isDragging() || doc.hidden || !inside({ x: event.clientX, y: event.clientY })) return;
    // Some browsers deliver wheel events during native drags, others suppress
    // them. Edge scrolling remains available in both cases.
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1;
    container.scrollTop += event.deltaY * unit;
    update(event);
  }, { passive: false });

  function destroy() {
    stop();
    destroyed = true;
    for (const remove of removers) remove();
  }

  return { update, stop, destroy };
}
