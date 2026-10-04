// Edit mode: hover outline + label, click to select, parent/child navigation.
// While on, a capture-phase click handler stops links, lightbox and menu from reacting.
import { pickable, describe } from './capture.js';

const div = cls => Object.assign(document.createElement('div'), { className: cls });

export function createSelector({ root, onSelect, isOverlay }) {
  const hl = div('cequ-box cequ-hl');
  const sel = div('cequ-box cequ-sel');
  const chip = div('cequ-chip');
  root.append(hl, sel, chip);

  let enabled = false, hover = null, current = null, trail = [], queued = false;

  const place = (node, el) => {
    if (!el || !el.isConnected) { node.style.display = 'none'; return null; }
    const r = el.getBoundingClientRect();
    Object.assign(node.style, { display: 'block', transform: `translate(${r.left}px, ${r.top}px)`, width: `${r.width}px`, height: `${r.height}px` });
    return r;
  };
  function draw() {
    queued = false;
    if (!enabled) { hl.style.display = sel.style.display = chip.style.display = 'none'; return; }
    const r = place(hl, hover && hover !== current?.el ? hover : null);
    place(sel, current?.el);
    if (r) {
      chip.textContent = describe(hover);
      chip.style.display = 'block';
      chip.style.transform = `translate(${Math.max(4, r.left)}px, ${Math.max(4, r.top - 26)}px)`;
    } else chip.style.display = 'none';
  }
  const redraw = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };

  const set = (el, generated = false, silent = false) => {
    current = el ? { el, generated } : null;
    redraw();
    if (!silent) onSelect(current);
  };

  const onOver = e => {
    if (isOverlay(e.target)) { hover = null; return redraw(); }
    hover = pickable(e.target)?.el || null;
    redraw();
  };
  const onClick = e => {
    if (isOverlay(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const p = pickable(e.target);
    if (!p) return;
    trail = [];
    const parent = e.altKey ? stampedParent(p.el) : null;
    set(parent || p.el, parent ? false : p.generated);
  };
  const swallow = e => { if (enabled && !isOverlay(e.target)) { e.stopPropagation(); e.stopImmediatePropagation(); } };

  // Static sites move between stamped elements; app projects between any elements.
  const appMode = Boolean(window.__CEQU_EDIT?.appMode);
  function stampedParent(el) {
    const p = appMode ? el.parentElement : el.parentElement?.closest('[data-cequ-src]');
    return p && p !== document.body && p !== document.documentElement ? p : null;
  }

  return {
    get enabled() { return enabled; },
    get current() { return current; },
    enable() {
      if (enabled) return;
      enabled = true;
      document.documentElement.classList.add('cequ-editing');
      addEventListener('pointerover', onOver, true);
      addEventListener('click', onClick, true);
      for (const t of ['pointerdown', 'pointerup', 'dblclick', 'auxclick']) addEventListener(t, swallow, true);
      addEventListener('scroll', redraw, { passive: true });
      addEventListener('resize', redraw);
      redraw();
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      document.documentElement.classList.remove('cequ-editing');
      removeEventListener('pointerover', onOver, true);
      removeEventListener('click', onClick, true);
      for (const t of ['pointerdown', 'pointerup', 'dblclick', 'auxclick']) removeEventListener(t, swallow, true);
      removeEventListener('scroll', redraw);
      removeEventListener('resize', redraw);
      hover = null;
      set(null);
    },
    select: (el, generated = false, silent = false) => { trail = []; set(el, generated, silent); },
    clear: () => { current = null; redraw(); },
    parent() {
      const p = current && stampedParent(current.el);
      if (!p) return false;
      trail.push(current.el);
      set(p);
      return true;
    },
    child() {
      if (!current) return false;
      const next = trail.pop() || (appMode ? current.el.firstElementChild : current.el.querySelector('[data-cequ-src]'));
      if (!next) return false;
      set(next);
      return true;
    },
    redraw,
  };
}
