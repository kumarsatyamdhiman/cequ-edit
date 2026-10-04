// CEQU-Edit: boots the editor overlay on pages served by the CEQU-Edit server.
import { CFG, listen } from './api.js';
import { createSelector } from './select.js';
import { createDialog } from './dialog.js';
import { createQueue } from './queue.js';
import { createPanel, saveScroll, bootBuilt } from './panel.js';
import { h, toast } from './dom.js';
import { setSourceClasses } from './capture.js';

const params = new URLSearchParams(location.search);
// After the page has loaded (and an app has hydrated), so the editor never disturbs the app's own start-up.
if (CFG.token && !params.has('cequ-frame')) {
  if (document.readyState === 'complete') setTimeout(boot, 0);
  else addEventListener('load', () => setTimeout(boot, 0), { once: true });
}

function restoreScroll() {
  let y = null;
  try { y = sessionStorage.getItem('cequ-scroll'); sessionStorage.removeItem('cequ-scroll'); } catch { /* storage off */ }
  if (y == null) return;
  const to = () => { document.documentElement.style.scrollBehavior = 'auto'; scrollTo(0, Number(y)); document.documentElement.style.scrollBehavior = ''; };
  document.fonts.ready.then(() => { to(); setTimeout(to, 300); });
}

function boot() {
  // The editor UI lives in a shadow root: the site's CSS cannot restyle it, and its CSS cannot leak into the site.
  const host = document.createElement('cequ-edit');
  const shadow = host.attachShadow({ mode: 'open' });
  const root = h('div', { id: 'cequ-root' });
  shadow.append(h('link', { rel: 'stylesheet', href: '/__cequ/overlay/editor.css' }), root);
  document.body.append(host);
  document.head.append(h('link', { rel: 'stylesheet', href: '/__cequ/overlay/page.css', 'data-cequ': 'page' }));
  // some apps re-render <body>; put the editor back if it is removed
  new MutationObserver(() => { if (!host.isConnected) document.body.append(host); }).observe(document.body, { childList: true });
  restoreScroll();
  try {
    const msg = sessionStorage.getItem('cequ-toast');
    if (msg) { sessionStorage.removeItem('cequ-toast'); setTimeout(() => toast(root, msg, 'ok'), 400); }
  } catch { /* storage off */ }

  const previewId = CFG.mode === 'preview' ? CFG.batchId : null;
  const isOverlay = t => t === host || (t instanceof Element && Boolean(t.closest('.cequ-typing')));
  setSourceClasses(CFG.sourceClasses);
  // per-site extras for edit mode (e.g. hide a custom cursor, show scroll-revealed content) from .cequ-edit.json
  const modeCss = CFG.editModeCss ? h('style', { 'data-cequ': 'edit-mode' }, CFG.editModeCss) : null;

  if (CFG.mode === 'built') return bootBuilt(root);

  // ---------- drawer skeleton ----------
  const runHost = h('section', { class: 'cequ-run', hidden: true });
  const buildHost = h('section', { class: 'cequ-build', hidden: true });
  const listHost = h('div', { class: 'cequ-q' });
  const histHost = h('div', { class: 'cequ-h' });
  const tabQ = h('button', { type: 'button', class: 'is-on', onclick: () => showTab('q') }, 'Changes');
  const tabH = h('button', { type: 'button', onclick: () => showTab('h') }, 'History');
  const drawer = h('aside', { class: 'cequ cequ-drawer', 'aria-label': 'Editor' },
    h('header', {}, h('div', { class: 'cequ-seg' }, tabQ, tabH),
      h('button', { type: 'button', class: 'cequ-x', title: 'Hide panel', onclick: () => drawer.classList.toggle('is-min') }, '–')),
    runHost, buildHost, listHost,
    !previewId && !CFG.compare && h('button', { type: 'button', class: 'cequ-btn cequ-buildbtn', onclick: () => panel.build() },
      CFG.appMode ? '🏗 Build final site' : '⬇ Download final site'));
  function showTab(which) {
    tabQ.classList.toggle('is-on', which === 'q');
    tabH.classList.toggle('is-on', which === 'h');
    if (which === 'h') { listHost.replaceWith(histHost); panel.renderHistory(); }
    else { histHost.replaceWith(listHost); queue.render(); }
  }
  root.append(drawer);

  // ---------- modules ----------
  let dialog;
  const selector = createSelector({ root, isOverlay, onSelect: sel => { if (sel) dialog.open(sel); } });
  dialog = createDialog({ root, selector, onSave: item => { queue.add(item); updateVisibility(); } });
  const panel = createPanel({ root, runHost, histHost, buildHost, isBusyEditing: () => dialog.isOpen(), queuedCount: () => queue.items.length });
  const queue = createQueue({
    host: listHost, root,
    key: previewId ? `cequ-q:preview:${previewId}` : 'cequ-q:live',
    mode: previewId ? 'revise' : 'new',
    onOpen(item) {
      setEditing(true);
      let el = null;
      try { el = CFG.appMode ? document.querySelector(item.target.selector) : document.querySelector(`[data-cequ-src="${item.target.src}"]`); } catch { /* bad selector */ }
      if (!el) return toast(root, 'That component is no longer on this page; delete the item and select it again.', 'error');
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      selector.select(el, Boolean(item.target.generatedBy), true);
      dialog.open({ el, generated: Boolean(item.target.generatedBy) }, item);
    },
    async onSubmit(items, how) {
      dialog.close();
      if (previewId) await panel.revise(items);
      else await panel.submit(items, how);
    },
  });

  // ---------- edit mode toggle ----------
  const toggle = h('button', { type: 'button', class: 'cequ cequ-toggle', title: 'CEQU-Edit: edit mode (E)', onclick: () => setEditing(!selector.enabled) },
    h('span', {}, '✎'), h('b', {}, 'Edit mode'), h('kbd', {}, 'E'));
  root.append(toggle);

  function setEditing(on) {
    if (on) { selector.enable(); if (modeCss) document.head.append(modeCss); }
    else { dialog.close(); selector.disable(); modeCss?.remove(); }
    toggle.classList.toggle('is-on', on);
    try { sessionStorage.setItem('cequ-on', on ? '1' : ''); } catch { /* storage off */ }
    updateVisibility();
  }
  function updateVisibility() {
    drawer.classList.toggle('is-shown', selector.enabled || queue.items.length > 0 || !runHost.hidden || !buildHost.hidden || Boolean(previewId));
    queue.redrawPins();
    root.classList.toggle('is-editing', selector.enabled);
  }
  let start = false;
  try { start = sessionStorage.getItem('cequ-on') === '1'; } catch { /* storage off */ }
  setEditing(start);

  // ---------- keyboard ----------
  addEventListener('keydown', e => {
    const t = e.composedPath()[0];                 // inside the editor's shadow root too
    const typing = t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); setEditing(!selector.enabled); }
    else if (e.key === '[' && dialog.isOpen()) selector.parent();
    else if (e.key === ']' && dialog.isOpen()) selector.child();
    else if (e.key === 'Escape' && dialog.isOpen()) dialog.close();
  });

  let staleShown = false;
  addEventListener('cequ-stale', () => {
    if (staleShown) return;
    staleShown = true;
    toast(root, [h('b', {}, 'The editor server was restarted.'), h('button', { type: 'button', class: 'cequ-btn', onclick: () => { saveScroll(); location.reload(); } }, 'Reload this page')], 'error', 60000);
  });

  // ---------- live events ----------
  listen(e => {
    panel.onEvent(e);
    if (e.type === 'status' || e.type === 'ready' || e.type === 'build') setTimeout(updateVisibility, 50);
    if (e.type === 'reload' && CFG.mode === 'live' && !CFG.compare && !dialog.isOpen()) { saveScroll(); location.reload(); }
  });
  panel.refresh().then(updateVisibility);
}
