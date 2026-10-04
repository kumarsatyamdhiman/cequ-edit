// Batch status (progress, questions, results), the preview bar, code diff, history/undo, and Build final site.
import { CFG, api, here, viewUrl, withToken } from './api.js';
import { h, toast } from './dom.js';

const DONE = new Set(['APPROVED', 'REJECTED']);
const LABEL = {
  STAGING: 'Preparing a staging copy…', RUNNING: 'Claude is editing…', NEEDS_INPUT: 'Claude has a question',
  READY: 'Preview ready', FAILED: 'Stopped', APPROVED: 'Live ✓', REJECTED: 'Discarded',
};

export function saveScroll() {
  try { sessionStorage.setItem('cequ-scroll', String(scrollY)); } catch { /* storage off */ }
}
const go = url => { saveScroll(); location.href = url; };
const kids = (...xs) => xs.flat(Infinity).filter(x => x != null && x !== false);
const flash = msg => { try { sessionStorage.setItem('cequ-toast', msg); } catch { /* storage off */ } };
const WAITING = new Set(['STAGING', 'RUNNING', 'NEEDS_INPUT', 'READY', 'FAILED']);
const secs = ms => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s` : `${Math.max(1, Math.round(ms / 1000))} s`);
const size = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const downloadZip = () => { location.href = withToken('/__cequ/build/site.zip'); };

function modal(root, title, body) {
  const close = () => m.remove();
  const m = h('div', { class: 'cequ cequ-modal', onclick: e => e.target === m && close(),
    onkeydown: e => e.key === 'Escape' && close() },
    h('div', { class: 'cequ-modalbox', tabindex: -1 },
      h('header', {}, h('b', {}, title), h('button', { type: 'button', onclick: close }, '✕')), body));
  root.append(m);
  m.querySelector('.cequ-modalbox').focus();
  return m;
}

function phone(root, url) {
  const u = new URL(url, location.origin);
  u.searchParams.set('cequ-frame', '1');
  modal(root, 'Phone view (390px)', h('iframe', { class: 'cequ-phone', src: u.pathname + u.search, title: 'Phone preview' }));
}

// App projects: the Built view shows the production build; the editor is only a bar here (spec §13.5).
export async function bootBuilt(root) {
  let s = null;
  try { s = await api('build'); } catch { /* shown without a time */ }
  const when = s?.startedAt ? new Date(s.startedAt).toLocaleString() : '';
  root.append(h('div', { class: 'cequ cequ-pbar', role: 'toolbar', 'aria-label': 'Built site' },
    h('b', {}, `Built site${when ? ` · ${when}` : ''}`),
    h('span', { class: 'cequ-grow' }),
    h('button', { type: 'button', class: 'cequ-btn', onclick: () => phone(root, here()) }, '📱 Phone'),
    h('button', { type: 'button', class: 'cequ-btn', onclick: downloadZip }, 'Download zip'),
    h('button', { type: 'button', class: 'cequ-btn cequ-primary', onclick: () => go(viewUrl('live')) }, 'Back to live')));
}

export function createPanel({ root, runHost, histHost, buildHost, isBusyEditing, queuedCount = () => 0 }) {
  let batch = null;
  const previewId = CFG.appMode ? CFG.batchId
    : CFG.mode === 'preview' ? CFG.batchId : new URLSearchParams(location.search).get('cequ-compare');
  const live = () => (CFG.appMode ? viewUrl('live') : `/${batch?.page || CFG.page}`);

  const fail = e => toast(root, [e.message, e.fix && h('small', {}, e.fix)], 'error', 8000);

  async function refresh() {
    try {
      const list = await api('batches');
      batch = (previewId ? list.find(b => b.id === previewId) : null) || list.find(b => !DONE.has(b.status)) || null;
    } catch (e) { fail(e); }
    renderRun();
    if (previewId) renderBar();
    if (buildHost) { try { build = await api('build'); } catch { /* no build yet */ } renderBuild(); }
  }
  const reload = async () => { if (batch) { batch = await api(`batches/${batch.id}`); renderRun(); if (previewId) renderBar(); } };

  async function submit(items, mode) {
    const clean = items.map(({ id, label, ...rest }) => rest);
    try {
      const { batchId } = await api('batches', { method: 'POST', body: { items: clean, mode, page: CFG.appMode ? here() : CFG.page } });
      batch = await api(`batches/${batchId}`);
      renderRun();
    } catch (e) { fail(e); throw e; }
  }

  async function revise(items) {
    const clean = items.map(({ id, label, ...rest }) => rest);
    try { batch = await api(`batches/${previewId}/revise`, { method: 'POST', body: { items: clean } }); renderRun(); }
    catch (e) { fail(e); throw e; }
  }

  async function act(action, body) {
    try {
      const r = await api(`batches/${batch.id}/${action}`, { method: 'POST', body });
      if (action === 'approve' && r.conflict) {
        toast(root, `Could not apply: the same lines changed meanwhile (${r.files.join(', ')}). Reject and queue again.`, 'error', 10000);
        return;
      }
      if (action === 'approve') { flash(`Batch #${batch.n} is live ✓`); return go(live()); }
      if (action === 'reject') { flash(`Batch #${batch.n} discarded`); if (previewId) return go(live()); }
      await reload();
    } catch (e) { fail(e); }
  }

  function onEvent(e) {
    if (e.type === 'build') { build = e.build; shownBuild = true; if (build.status === 'BUILDING') buildLog = []; return renderBuild(); }
    if (e.type === 'build-log') {
      buildLog = [...buildLog, ...e.lines].slice(-50);
      const log = buildHost?.querySelector('.cequ-log');
      if (log) log.replaceChildren(...buildLog.slice(-8).map(l => h('li', {}, l)));
      return;
    }
    if (e.type === 'reload' || e.type === 'undone') { if (histHost.isConnected) renderHistory(); return; }
    if (!batch || e.batchId !== batch.id) { if (e.type === 'status' && !DONE.has(e.status)) refresh(); return; }
    if (e.type === 'progress') {
      batch.progress.push(e.line);
      runHost.querySelector('.cequ-log')?.append(h('li', {}, e.line));
      const log = runHost.querySelector('.cequ-log');
      if (log) { while (log.children.length > 8) log.firstChild.remove(); }
      return;
    }
    if (e.type === 'error') toast(root, [e.message, e.fix && h('small', {}, e.fix)], 'error', 9000);
    if (e.type === 'ready' && CFG.mode === 'live' && !previewId && !isBusyEditing()) {
      toast(root, 'Preview ready, opening…');
      return setTimeout(() => go(withToken(e.previewUrl)), 700);
    }
    if (e.type === 'status' || e.type === 'handoff' || e.type === 'item' || e.type === 'ready') reload();
  }

  function renderRun() {
    if (!batch || (DONE.has(batch.status) && !previewId)) { runHost.replaceChildren(); runHost.hidden = true; return; }
    runHost.hidden = false;
    const s = batch.status;
    const results = (batch.results || []).map(r => h('li', { class: `is-${r.status}` },
      h('b', {}, { done: '✓', needs_input: '?', failed: '✗' }[r.status] || '·'), ` ${r.id}. `, r.by === 'cequ' && h('i', { class: 'cequ-way is-instant', title: 'Applied instantly by CEQU-Edit' }, '⚡ '),
      r.summary || r.question || r.reason || ''));
    const answerBox = h('textarea', { rows: 2, placeholder: 'Your answer' });
    runHost.replaceChildren(...kids(
      h('header', {}, h('b', {}, `Batch #${batch.n}`), h('span', { class: `cequ-badge is-${s}` }, LABEL[s] || s),
        (s === 'RUNNING' || s === 'STAGING') && batch.mode === 'auto' && h('i', { class: 'cequ-spin', 'aria-hidden': 'true' })),
      s === 'RUNNING' && batch.mode === 'chat' && h('div', { class: 'cequ-handoff' },
        h('p', {}, 'Paste this line into your Claude Code chat. The preview opens here when Claude finishes.'),
        h('code', {}, batch.command),
        h('button', { type: 'button', class: 'cequ-btn', onclick: async ev => {
          await navigator.clipboard.writeText(batch.command); ev.target.textContent = 'Copied ✓'; } }, 'Copy')),
      (s === 'RUNNING' || s === 'STAGING') && batch.mode === 'auto' && h('ol', { class: 'cequ-log' },
        (batch.progress || []).slice(-8).map(l => h('li', {}, l))),
      results.length > 0 && h('ul', { class: 'cequ-results' }, results),
      s === 'NEEDS_INPUT' && h('div', { class: 'cequ-question' },
        h('p', {}, batch.question),
        batch.mode === 'auto'
          ? [answerBox, h('button', { type: 'button', class: 'cequ-btn cequ-primary',
              onclick: () => answerBox.value.trim() && act('answer', { text: answerBox.value.trim() }) }, 'Send answer')]
          : h('small', {}, 'Answer it in the chat.')),
      s === 'FAILED' && h('div', { class: 'cequ-failed' }, h('p', {}, batch.error), batch.fix && h('small', {}, batch.fix)),
      h('div', { class: 'cequ-actions' },
        s === 'READY' && !previewId && h('button', { type: 'button', class: 'cequ-btn cequ-primary', onclick: () => go(withToken(batch.previewUrl)) }, 'Open preview ▸'),
        s === 'READY' && previewId && h('small', {}, 'Compare Before / After in the bar below, then Approve or Reject.'),
        s === 'FAILED' && batch.errorCode === 'auth' && h('button', { type: 'button', class: 'cequ-btn cequ-primary', onclick: signIn }, 'Sign in'),
        s === 'FAILED' && h('button', { type: 'button', class: 'cequ-btn' + (batch.errorCode === 'auth' ? '' : ' cequ-primary'), onclick: () => act('retry') }, 'Retry'),
        !DONE.has(s) && h('button', { type: 'button', class: 'cequ-btn', onclick: () => {
          if (confirm(`Discard batch #${batch.n}? The live site stays as it is.`)) act('reject');
        } }, 'Reject')),
      s === 'FAILED' && batch.mode === 'auto' && h('button', { type: 'button', class: 'cequ-link cequ-manual', onclick: () => act('chat') },
        'Or apply it manually in a Claude chat'),
    ));
  }

  async function signIn() {
    try {
      const r = await api('claude/sign-in', { method: 'POST' });
      const copy = h('button', { type: 'button', class: 'cequ-btn', onclick: async ev => {
        await navigator.clipboard.writeText(r.command); ev.target.textContent = 'Copied ✓'; } }, 'Copy command');
      toast(root, r.ok
        ? ['Terminal opened.', h('small', {}, 'Approve the sign-in in your browser, then click Retry here.')]
        : ['Could not open Terminal automatically.', h('small', {}, 'Open Terminal yourself, paste this command, approve in the browser, then click Retry:'),
          h('code', { class: 'cequ-cmd' }, r.command), copy],
        r.ok ? 'ok' : 'error', r.ok ? 12000 : 60000);
    } catch (e) { fail(e); }
  }

  async function renderHistory() {
    histHost.replaceChildren(h('p', { class: 'cequ-empty' }, 'Loading…'));
    try {
      const list = await api('history');
      histHost.replaceChildren(list.length
        ? h('ol', { class: 'cequ-hist' }, list.map(x => h('li', {},
            h('div', {}, h('b', {}, x.subject.replace(/^Revert "(.*)"$/, 'Undo: $1')), h('small', {}, new Date(x.date).toLocaleString())),
            !x.subject.startsWith('Revert') && h('button', { type: 'button', class: 'cequ-btn', onclick: async () => {
              if (!confirm(`Undo "${x.subject}"?\nThe site goes back to how it was before this change.`)) return;
              try { await api(`history/${x.commit}/undo`, { method: 'POST' }); toast(root, 'Undone ✓'); renderHistory(); } catch (e) { fail(e); }
            } }, 'Undo'))))
        : h('p', { class: 'cequ-empty' }, 'No approved changes yet.'));
    } catch (e) { fail(e); }
  }

  // ---------- preview bar (on the staged page and on the live "Before" page) ----------
  let bar = null;
  function renderBar() {
    if (!previewId || !batch) return;
    if (DONE.has(batch.status)) { bar?.remove(); bar = null; return; }
    const before = CFG.mode !== 'preview';
    const toBefore = CFG.appMode ? viewUrl('live', { compare: previewId }) : `/${batch.page}?cequ-compare=${previewId}`;
    const toAfter = CFG.appMode ? viewUrl(previewId) : `/__cequ/preview/${previewId}/${batch.page}`;
    const next = h('div', { class: 'cequ cequ-pbar', role: 'toolbar', 'aria-label': 'Preview' },
      h('b', {}, `Preview · batch #${batch.n}`),
      h('div', { class: 'cequ-seg' },
        h('button', { type: 'button', class: before ? 'is-on' : '', onclick: () => before || go(toBefore) }, 'Before'),
        h('button', { type: 'button', class: before ? '' : 'is-on', disabled: Boolean(CFG.previewError), onclick: () => before && go(toAfter) }, 'After')),
      CFG.previewError && h('span', { class: 'cequ-err', title: CFG.previewError }, `⚠ The preview copy could not start: ${CFG.previewError.slice(0, 140)}`),
      h('button', { type: 'button', class: 'cequ-btn', onclick: () => phone(root, CFG.appMode ? here() : before ? `/${batch.page}` : `/__cequ/preview/${previewId}/${batch.page}`) }, '📱 Phone'),
      h('button', { type: 'button', class: 'cequ-btn', onclick: showDiff }, 'Code changes'),
      h('span', { class: 'cequ-grow' }),
      batch.status === 'READY'
        ? [h('button', { type: 'button', class: 'cequ-btn', onclick: () => confirm(`Discard batch #${batch.n}?`) && act('reject') }, 'Reject'),
          h('button', { type: 'button', class: 'cequ-btn cequ-primary', onclick: () => act('approve') }, 'Approve ✓')]
        : h('span', { class: `cequ-badge is-${batch.status}` }, LABEL[batch.status]));
    if (bar) bar.replaceWith(next); else root.append(next);
    bar = next;
    if (!before && !CFG.appMode) markChanged();
  }

  // Pins on the elements Claude reports it changed (best effort: file:line → stamped element).
  function markChanged() {
    root.querySelectorAll('.cequ-changed').forEach(n => n.remove());
    for (const r of batch.results || []) {
      for (const f of r.files || []) {
        const m = /^(.+?\.html?):(\d+)/.exec(f);
        const el = m && document.querySelector(`[data-cequ-src^="${m[1]}:${m[2]}:"]`);
        if (!el) continue;
        const pin = h('span', { class: 'cequ-changed', title: r.summary }, String(r.id));
        root.append(pin);
        const place = () => {
          const b = el.getBoundingClientRect();
          pin.hidden = b.bottom < 0 || b.top > innerHeight;          // only pin what is on screen
          pin.style.transform = `translate(${Math.max(2, b.right - 14)}px, ${Math.max(2, b.top - 10)}px)`;
        };
        place();
        addEventListener('scroll', place, { passive: true });
      }
    }
  }

  async function showDiff() {
    const pre = h('pre', { class: 'cequ-diff' }, 'Loading…');
    modal(root, `Code changes · batch #${batch.n}`, pre);
    try {
      const text = await api(`batches/${previewId}/diff`);
      pre.replaceChildren(...(text || 'No changes.').split('\n').map(l => h('span', {
        class: l.startsWith('+') && !l.startsWith('+++') ? 'is-add' : l.startsWith('-') && !l.startsWith('---') ? 'is-del' : l.startsWith('@@') ? 'is-hunk' : l.startsWith('diff ') ? 'is-file' : '',
      }, l + '\n')));
    } catch (e) { pre.textContent = e.message; }
  }

  // ---------- Build final site (spec §13) ----------
  let build = null, buildLog = [], shownBuild = false;
  const word = CFG.appMode ? 'build' : 'download';

  async function startBuild() {
    let waiting = queuedCount();
    try { waiting += (await api('batches')).filter(b => WAITING.has(b.status)).length; } catch { /* the server checks too */ }
    const force = waiting > 0;
    if (force && !confirm(`${waiting} change${waiting > 1 ? 's' : ''} ${waiting > 1 ? "aren't" : "isn't"} approved yet and won't be in the ${word}. ${CFG.appMode ? 'Build' : 'Download'} anyway?`)) return;
    try {
      build = await api('build', { method: 'POST', body: { force } });
      shownBuild = true;
      buildLog = [];
      if (!CFG.appMode && build.status === 'BUILT') downloadZip();
      renderBuild();
    } catch (e) {
      if (e.status === 409 && e.data?.waiting && !force) {
        if (confirm(`${e.data.waiting} change${e.data.waiting > 1 ? 's' : ''} aren't approved yet and won't be in the ${word}. Continue anyway?`)) {
          try { build = await api('build', { method: 'POST', body: { force: true } }); shownBuild = true; if (!CFG.appMode) downloadZip(); renderBuild(); } catch (e2) { fail(e2); }
        }
        return;
      }
      fail(e);
    }
  }

  async function fixBuild() {
    try {
      const { batchId } = await api('build/fix', { method: 'POST' });
      batch = await api(`batches/${batchId}`);
      renderRun();
      toast(root, 'Claude is fixing the build. Preview and approve the fix, then press Build again.', 'ok', 8000);
    } catch (e) { fail(e); }
  }

  function renderBuild() {
    if (!buildHost) return;
    const s = build?.status;
    if (!s || s === 'IDLE' || (!shownBuild && s !== 'BUILDING') || (!CFG.appMode && s !== 'BUILT')) { buildHost.hidden = true; buildHost.replaceChildren(); return; }
    buildHost.hidden = false;
    const btn = (label, onclick, primary = false) => h('button', { type: 'button', class: `cequ-btn${primary ? ' cequ-primary' : ''}`, onclick }, label);
    const hide = h('button', { type: 'button', class: 'cequ-x', title: 'Hide', onclick: () => { shownBuild = false; renderBuild(); } }, '×');
    const head = (text, busy = false) => h('header', {}, h('b', {}, text), busy && h('i', { class: 'cequ-spin', 'aria-hidden': 'true' }), h('span', { class: 'cequ-grow' }), !busy && hide);
    if (s === 'BUILDING') {
      buildHost.replaceChildren(head('Building the final site…', true), h('ol', { class: 'cequ-log' }, buildLog.slice(-8).map(l => h('li', {}, l))));
    } else if (s === 'BUILT') {
      const title = !CFG.appMode ? 'Final site downloaded'
        : build.out ? `Built in ${secs(build.durationMs)} · ${build.out}/${build.files != null ? ` · ${build.files} files · ${size(build.bytes)}` : ''}`
          : `Build passed in ${secs(build.durationMs)}`;
      buildHost.replaceChildren(head(`✓ ${title}`), h('div', { class: 'cequ-actions' },
        build.hasPreview && btn('Preview built site', () => go(viewUrl('built')), true),
        btn(CFG.appMode ? 'Download zip' : 'Download again', downloadZip),
        build.canReveal && btn({ darwin: 'Show in Finder', win32: 'Show in Explorer' }[build.os] || 'Open folder', () => api('build/reveal', { method: 'POST' }).catch(fail))));
    } else if (s === 'FAILED') {
      buildHost.replaceChildren(head('Build failed'), h('p', {}, build.error),
        build.logTail && h('pre', {}, build.logTail),
        h('div', { class: 'cequ-actions' }, btn('Fix with Claude', fixBuild, true), btn('Build again', startBuild)));
    }
  }

  return { refresh, submit, revise, onEvent, renderHistory, build: startBuild, get batch() { return batch; } };
}
