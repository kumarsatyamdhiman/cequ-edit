// The list of queued changes: persistence, numbered pins on the page, and the list UI.
import { h } from './dom.js';
import { isDirect } from './kinds.js';

export function createQueue({ host, root, key, mode, onOpen, onSubmit }) {
  let items = load();
  let busy = false;
  const pins = h('div', { class: 'cequ-pins', 'aria-hidden': 'true' });
  root.append(pins);

  function load() { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } }
  function persist() { try { localStorage.setItem(key, JSON.stringify(items)); } catch { /* private mode: list lives until reload */ } }

  const find = item => {
    try {
      return window.__CEQU_EDIT?.appMode ? document.querySelector(item.target.selector) : document.querySelector(`[data-cequ-src="${item.target.src}"]`);
    } catch { return null; }
  };

  function drawPins() {
    pins.replaceChildren(...items.map((item, i) => {
      const el = find(item);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return null;
      return h('span', { class: 'cequ-pin', style: { transform: `translate(${Math.max(2, r.left - 10)}px, ${Math.max(2, r.top - 10)}px)` } }, String(i + 1));
    }));
  }
  let queued = false;
  const redrawPins = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; drawPins(); }); } };
  addEventListener('scroll', redrawPins, { passive: true });
  addEventListener('resize', redrawPins);

  function render() {
    const list = items.length
      ? h('ol', { class: 'cequ-list' }, items.map((item, i) => h('li', {},
          h('button', { type: 'button', class: 'cequ-num', title: 'Show on page', onclick: () => onOpen(item) }, String(i + 1)),
          h('button', { type: 'button', class: 'cequ-sum', onclick: () => onOpen(item) },
            h('b', {}, h('i', { class: `cequ-way ${isDirect(item) ? 'is-instant' : 'is-claude'}`,
              title: isDirect(item) ? 'Instant: CEQU-Edit applies this itself' : 'Claude applies this' }, isDirect(item) ? '⚡' : '✦'),
              ' ', item.label || item.target.tag),
            h('span', {}, item.summary || item.instruction)),
          item.payload?.image?.url && h('img', { class: 'cequ-thumb', src: item.payload.image.url, alt: '' }),
          h('button', { type: 'button', class: 'cequ-x', title: 'Remove from list', onclick: () => remove(item.id) }, '×'))))
      : h('p', { class: 'cequ-empty' }, mode === 'revise'
        ? 'Not quite right? Click any part of this preview and describe what to fix.'
        : 'Turn on edit mode (E), click any part of the page, and describe the change.');
    const actions = items.length > 0 && h('div', { class: 'cequ-actions' },
      h('button', { type: 'button', class: 'cequ-btn cequ-primary', disabled: busy, onclick: () => submit('auto') },
        mode === 'revise' ? `Add to this batch ▸` : `Edit ▸ (${items.length})`),
      h('small', { class: 'cequ-split' }, (() => {
        const fast = items.filter(isDirect).length, slow = items.length - fast;
        return [fast && `⚡ ${fast} instant`, slow && `✦ ${slow} by Claude`].filter(Boolean).join(' · ');
      })()),
      h('button', { type: 'button', class: 'cequ-link', disabled: busy, onclick: () => { if (confirm('Clear all queued changes?')) clear(); } }, 'Clear'));
    host.replaceChildren(list, actions || '');
    redrawPins();
  }

  async function submit(how) {
    busy = true; render();
    try {
      await onSubmit(items, how);
      items = []; persist();
    } finally { busy = false; render(); }
  }

  function add(item) {
    if (item.id == null) item.id = Math.max(0, ...items.map(i => i.id)) + 1;
    const at = items.findIndex(x => x.id === item.id);
    if (at >= 0) items[at] = item; else items.push(item);
    persist(); render();
  }
  function remove(id) { items = items.filter(i => i.id !== id); persist(); render(); }
  function clear() { items = []; persist(); render(); }

  render();
  return { add, remove, clear, render, redrawPins, get items() { return items; }, set busy(v) { busy = v; render(); } };
}
