// The change dialog for one selected component: instruction + photo / colour / text / remove controls.
import { capture, captureApp, siteTokens, toHex, contrast, effectiveBackground, resolveColor, matchedRules, describe, cleanClasses } from './capture.js';
import { CFG, api, fetchJSON, uploadImage } from './api.js';
import { h, escapeHTML } from './dom.js';
import { isDirect } from './kinds.js';

// Site colour variables get friendly names: from tokenLabels in .cequ-edit.json, else "--accent-ink" → "Accent ink".
const tokenLabel = name => CFG.tokenLabels?.[name] || name.replace(/^--/, '').replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());
const INLINE = new Set(['b', 'i', 'em', 'strong', 'span', 'br', 'small', 'a', 'u', 'sup', 'sub', 'mark', 'svg', 'abbr', 'code']);
const TABS = [['image', '🖼 Photo'], ['layout', '📐 Layout'], ['color', '🎨 Colour'], ['text', '✏️ Text'], ['remove', '🗑 Remove']];
const ALIGNS = [['left', '⇤ Left'], ['center', '↔ Centre'], ['right', '⇥ Right']];
const WIDTHS = [['auto', 'Natural'], ['100%', 'Full'], ['75%', '¾'], ['50%', '½'], ['33.333%', '⅓']];
const FITS = [['cover', 'Fill frame'], ['contain', 'Show whole']];

const imageIn = el => el.localName === 'img' ? el : (el.querySelectorAll('img').length === 1 ? el.querySelector('img') : null);
const isTextual = el => (el.textContent || '').trim() && [...el.querySelectorAll('*')].every(n => INLINE.has(n.localName) || n.ownerSVGElement);
const snippetInner = s => s.slice(s.indexOf('>') + 1, s.lastIndexOf('</'));
const sheets = () => [...document.styleSheets].filter(s => !(s.href || '').includes('/__cequ/'));

function countTokenUses(name) {
  let n = 0;
  const walk = rules => {
    for (const r of rules) {
      if (r instanceof CSSStyleRule) { if (r.style.cssText.includes(`var(${name})`)) n++; }
      if (r.cssRules?.length) walk(r.cssRules);         // @media blocks (and nested rules)
    }
  };
  for (const s of sheets()) { try { walk(s.cssRules); } catch { /* cross-origin */ } }
  return n;
}
function tokenFor(el, prop) {
  const lookup = prop === 'fill' ? ['fill', 'color'] : [prop, prop === 'background-color' ? 'background' : prop];
  const rules = matchedRules(el, lookup);
  for (let i = rules.length - 1; i >= 0; i--) {
    for (const p of lookup) { const m = /var\((--[\w-]+)\)/.exec(rules[i].decls[p] || ''); if (m) return m[1]; }
  }
  return null;
}

// Plain summary for the list drawer.
export function summarize(item) {
  const p = item.payload || {}, bits = [];
  const scope = { here: 'only here', everywhere: 'everywhere', element: 'this element', alike: 'all like it', token: 'whole site' };
  if (p.image) bits.push(`🖼 New photo (${scope[p.image.scope] || 'only here'})`);
  if (p.color) bits.push(`🎨 ${p.color.map(c => `${c.property.replace('-color', '')} → ${c.to.startsWith('var(') ? tokenLabel(c.to.slice(4, -1)) : c.to}`).join(', ')} (${scope[p.color[0].scope]})`);
  if (p.text) bits.push(`✏️ “${(p.text.plain || p.text.to).replace(/<[^>]+>/g, '').slice(0, 40)}”`);
  if (p.remove) bits.push({ remove: '🗑 Remove', 'hide-phone': '🗑 Hide on phone', 'hide-desktop': '🗑 Hide on desktop' }[p.remove.mode]);
  if (p.layout) {
    const L = p.layout;
    bits.push(`📐 ${[L.align && `align ${L.align}`, L.width && `width ${(WIDTHS.find(w => w[0] === L.width) || [])[1] || L.width}`,
      L.fit && (L.fit === 'cover' ? 'fill frame' : 'show whole'), L.focal && `focal ${L.focal}`].filter(Boolean).join(', ')}`);
  }
  if (item.instruction) bits.push(item.instruction.slice(0, 70));
  if (item.screens !== 'all') bits.push(item.screens === 'phone' ? '📱 phone only' : '🖥 desktop only');
  return bits.join(' · ');
}

// App projects: where the code for this element is (spec §9.3).
function whereLine(t) {
  if (!t) return h('p', { class: 'cequ-where' }, '🔎 Finding the code…');
  const L = t.located || {};
  const comps = t.components?.length ? ` · ${t.components.slice(-3).join(' › ')}` : '';
  if (t.src) return h('p', { class: 'cequ-where' }, '📍 ', h('code', {}, t.src.replace(/:\d+$/, '')), comps);
  if (L.kind === 'candidates') {
    return h('details', { class: 'cequ-where' }, h('summary', {}, `🔎 ${L.candidates.length} possible place${L.candidates.length > 1 ? 's' : ''}${comps}`),
      h('ol', {}, L.candidates.map(c => h('li', {}, h('code', {}, `${c.file}:${c.line}`), ` · ${c.why.join(', ')}`))));
  }
  if (L.textInCode === false) return h('p', { class: 'cequ-where' }, '🗄 Not in the code: this text comes from data (database, API or CMS). Claude can still restyle or move it.');
  return h('p', { class: 'cequ-where' }, `🔎 Claude will look for it${comps}`);
}

export function createDialog({ root, selector, onSave, onClose }) {
  let node = null, st = null, el = null, target = null, targetReady = null, editing = null;

  const isOpen = () => Boolean(node);

  function endTextEdit(save) {
    if (!editing) return;
    const { el: tEl, original } = editing;
    if (save) {
      const clean = node => {
        for (const n of [node, ...node.querySelectorAll('*')]) {
          for (const a of ['data-cequ-src', 'contenteditable', 'spellcheck']) n.removeAttribute(a);
          if (n.getAttribute('class') != null) {
            const c = cleanClasses(n.getAttribute('class'));
            c ? n.setAttribute('class', c) : n.removeAttribute('class');
          }
        }
        return node.innerHTML;
      };
      const plain = tEl.textContent.replace(/\s+/g, ' ').trim();
      const hasChildren = tEl.children.length > 0;
      const before = tEl.cloneNode(false);
      before.innerHTML = original;
      editing.result = { plain, html: hasChildren ? clean(tEl.cloneNode(true)) : escapeHTML(plain), fromPlain: editing.fromPlain,
        fromHtml: hasChildren ? clean(before) : escapeHTML(editing.fromPlain) };
    }
    tEl.innerHTML = original;
    tEl.removeAttribute('contenteditable');
    tEl.removeAttribute('spellcheck');
    tEl.classList.remove('cequ-typing');
    const res = editing.result;
    editing = null;
    return res;
  }

  function close() {
    endTextEdit(false);
    document.removeEventListener('paste', onPaste, true);
    node?.remove();
    node = st = el = target = targetReady = null;
    selector.clear();
    onClose?.();
  }

  function open(selection, item = null) {
    const keep = st && !item ? { instruction: st.instruction, screens: st.screens } : null;
    endTextEdit(false);
    el = selection.el;
    const img = imageIn(el);
    st = {
      itemId: item?.id ?? null,
      instruction: item?.instruction ?? keep?.instruction ?? '',
      screens: item?.screens ?? keep?.screens ?? 'all',
      image: item?.payload?.image ?? null,
      colors: Object.fromEntries((item?.payload?.color || []).map(c => [c.property, c.to])),
      colorScope: item?.payload?.color?.[0]?.scope ?? 'element',
      text: item?.payload?.text ?? null,
      remove: item?.payload?.remove?.mode ?? null,
      layout: { ...(item?.payload?.layout || {}) },
      generated: selection.generated,
      tab: item?.payload?.image ? 'image' : item?.payload?.layout ? 'layout' : item?.payload?.color ? 'color' : item?.payload?.text ? 'text' : item?.payload?.remove ? 'remove'
        : img ? 'image' : isTextual(el) ? 'text' : 'color',
      error: null, uploading: false, pos: st?.pos ?? null,
    };
    target = item?.target ?? null;
    targetReady = target ? Promise.resolve(target)
      : (CFG.appMode ? captureApp(el, { post: (path, body) => api(path, { method: 'POST', body }), cfg: CFG })
        : capture(el, { generated: selection.generated, fetchJSON, cfg: CFG }))
        .then(t => { if (selection.el === el) { target = t; render(); } return t; });
    targetReady.catch(e => { if (st) { st.error = `Could not read this component: ${e.message}`; render(); } });
    document.addEventListener('paste', onPaste, true);
    render();
  }

  async function onPaste(e) {
    if (!st || st.tab !== 'image') return;
    const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/') || /\.heic$/i.test(f.name));
    if (file) { e.preventDefault(); upload(file); }
  }

  async function upload(file) {
    const img = imageIn(el);
    st.uploading = true; st.error = null; render();
    try {
      const r = await uploadImage(file);
      st.image = {
        uploadId: r.uploadId, uploadName: r.uploadName, url: r.url, width: r.width, height: r.height,
        focal: st.image?.focal ?? '50% 50%', alt: st.image?.alt ?? img?.getAttribute('alt') ?? '',
        scope: st.image?.scope ?? 'here', imgAt: img?.getAttribute('data-cequ-src') ?? null, originalName: file.name,
      };
    } catch (e) { st.error = e.message; }
    st.uploading = false;
    render();
  }

  function currentPayload() {
    const payload = {};
    if (st.image) payload.image = st.image;
    const colors = Object.entries(st.colors).filter(([, v]) => v).map(([property, to]) => ({
      property, to, scope: st.colorScope, ...(st.colorScope === 'token' ? { token: tokenFor(el, property) } : {}),
    }));
    if (colors.length) payload.color = colors;
    if (st.text && st.text.to !== st.text.from) payload.text = st.text;
    if (st.remove) payload.remove = { mode: st.remove };
    const L = Object.fromEntries(Object.entries(st.layout).filter(([, v]) => v));
    if (Object.keys(L).length) {
      const img = imageIn(el);
      if (img && img !== el && (L.fit || L.focal)) L.imgAt = img.getAttribute('data-cequ-src');
      payload.layout = L;
    }
    return payload;
  }

  // ⚡ when CEQU-Edit can apply it itself, ✦ when it needs Claude.
  function route() {
    const payload = currentPayload();
    const any = Object.keys(payload).length || st.instruction.trim();
    if (!any) return { cls: '', text: '' };
    const t = CFG.appMode ? (target || { located: {} }) : { generatedBy: st.generated ? 'script' : null };
    return isDirect({ instruction: st.instruction, target: t, payload })
      ? { cls: 'is-instant', text: '⚡ Instant: CEQU-Edit applies this itself, no Claude needed' }
      : { cls: 'is-claude', text: '✦ Claude applies this (uses your Claude plan)' };
  }

  async function save() {
    if (editing) {
      const res = endTextEdit(true);
      try { if (res) await applyTextResult(res); } catch (e) { st.error = `Could not read this component: ${e.message}`; return render(); }
    }
    let t;
    try { t = await targetReady; } catch { return; }
    const payload = currentPayload();
    const kind = payload.image ? 'image' : payload.color ? 'color' : payload.text ? 'text' : payload.remove ? 'remove' : payload.layout ? 'layout' : 'general';
    if (kind === 'general' && !st.instruction.trim()) { st.error = 'Write what should change, or use one of the controls below.'; return render(); }
    const item = { id: st.itemId, kind, screens: st.screens, instruction: st.instruction.trim(), target: t, payload, label: describe(el) };
    item.summary = summarize(item);
    onSave(item);
    close();
  }

  async function applyTextResult(res) {
    const t = await targetReady;
    const from = CFG.appMode ? res.fromHtml : snippetInner(t.snippet);
    st.text = { from, to: res.html, plain: res.plain, ...(CFG.appMode ? { fromPlain: res.fromPlain } : {}) };
  }

  function startTextEdit() {
    const original = el.innerHTML;
    editing = { el, original, fromPlain: el.textContent.replace(/\s+/g, ' ').trim() };
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    el.classList.add('cequ-typing');
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el); range.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    render();
  }

  // ---------- rendering ----------
  function tabBody() {
    const img = imageIn(el);
    if (st.tab === 'image') {
      const same = img ? [...document.images].filter(i => i.getAttribute('src') === img.getAttribute('src')).length : 0;
      const pick = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,.heic', hidden: true,
        onchange: e => e.target.files[0] && upload(e.target.files[0]) });
      const drop = h('div', {
        class: 'cequ-drop' + (st.uploading ? ' is-busy' : ''), tabindex: 0,
        ondragover: e => { e.preventDefault(); e.currentTarget.classList.add('is-over'); },
        ondragleave: e => e.currentTarget.classList.remove('is-over'),
        ondrop: e => { e.preventDefault(); const f = e.dataTransfer.files[0]; f && upload(f); },
        onclick: () => pick.click(),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick.click(); } },
      }, st.uploading ? 'Processing photo…' : ['Drop a photo here, paste it (⌘V), or ', h('u', {}, 'choose a file'), h('small', {}, 'JPG · PNG · WEBP · iPhone HEIC · up to 25 MB')], pick);
      const fresh = st.image && h('div', { class: 'cequ-newimg' },
        h('div', { class: 'cequ-focal', title: 'Click to set the focal point',
          onclick: e => {
            const r = e.currentTarget.getBoundingClientRect();
            st.image.focal = `${Math.round(((e.clientX - r.left) / r.width) * 100)}% ${Math.round(((e.clientY - r.top) / r.height) * 100)}%`;
            render();
          } },
          h('img', { src: st.image.url, alt: '' }),
          h('i', { style: { left: st.image.focal.split(' ')[0], top: st.image.focal.split(' ')[1] } })),
        h('div', { class: 'cequ-row' }, h('small', {}, `${st.image.width}×${st.image.height} · focal ${st.image.focal}`),
          h('button', { type: 'button', class: 'cequ-link', onclick: () => { st.image = null; render(); } }, 'Remove photo')));
      return [
        h('div', { class: 'cequ-swap' },
          img ? h('figure', {}, h('img', { src: img.currentSrc || img.src, alt: '' }), h('figcaption', {}, 'Now')) : h('p', { class: 'cequ-hint' }, 'No photo in this component: the new photo will be used as your instruction says.'),
          h('span', { class: 'cequ-arrow' }, '→'),
          fresh || drop),
        st.image && h('label', { class: 'cequ-field' }, 'Caption / alt text',
          h('input', { type: 'text', value: st.image.alt, 'data-key': 'alt', oninput: e => { st.image.alt = e.target.value; } })),
        st.image && img && same > 1 && h('fieldset', { class: 'cequ-radios' }, h('legend', {}, 'Replace'),
          radio('imgscope', 'here', 'Only here', st.image.scope, v => { st.image.scope = v; }),
          radio('imgscope', 'everywhere', `Everywhere this photo appears (${same} places)`, st.image.scope, v => { st.image.scope = v; })),
      ];
    }
    if (st.tab === 'color') {
      const cs = getComputedStyle(el);
      const isSvg = el.localName === 'svg' || Boolean(el.querySelector('svg'));
      const rows = [
        { prop: 'color', label: 'Text', current: cs.color },
        { prop: 'background-color', label: 'Background', current: cs.backgroundColor },
        ...(parseFloat(cs.borderTopWidth) > 0 ? [{ prop: 'border-color', label: 'Border', current: cs.borderTopColor }] : []),
        ...(isSvg ? [{ prop: 'fill', label: 'Symbol', current: cs.color }] : []),
      ];
      const tokens = siteTokens().slice(0, 24);
      const chosenProps = Object.keys(st.colors).filter(p => st.colors[p]);
      const token = (chosenProps[0] && tokenFor(el, chosenProps[0])) || tokenFor(el, rows[0].prop);
      const alike = target?.alike;
      const fg = st.colors.color || cs.color;
      const bg = st.colors['background-color'] || effectiveBackground(el);
      const ratio = contrast(fg, bg);
      const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
      const okRatio = large ? 3 : 4.5;
      return [
        ...rows.map(r => h('div', { class: 'cequ-colorrow' },
          h('span', { class: 'cequ-sw cequ-sw--now', style: { background: r.current }, title: `Now: ${r.current}` }),
          h('b', {}, r.label),
          h('div', { class: 'cequ-tokens' }, tokens.map(t => h('button', {
            type: 'button', class: 'cequ-sw' + (st.colors[r.prop] === `var(${t.name})` ? ' is-on' : ''),
            style: { background: `var(${t.name})` }, title: `${tokenLabel(t.name)} (${t.name})`,
            onclick: () => { st.colors[r.prop] = `var(${t.name})`; render(); },
          }))),
          h('input', { type: 'color', title: 'Custom colour', value: toHex(resolveColor(st.colors[r.prop] || r.current)),
            onchange: e => { st.colors[r.prop] = e.target.value; render(); } }),
          st.colors[r.prop] && h('button', { type: 'button', class: 'cequ-x', title: 'Keep current colour', onclick: () => { delete st.colors[r.prop]; render(); } }, '×'),
        )),
        chosenProps.length > 0 && h('fieldset', { class: 'cequ-radios' }, h('legend', {}, 'Apply to'),
          radio('cscope', 'element', 'This element only', st.colorScope, v => { st.colorScope = v; }),
          alike && alike.count > 1 && radio('cscope', 'alike', `All like it (${alike.selector} × ${alike.count})`, st.colorScope, v => { st.colorScope = v; }),
          token && radio('cscope', 'token', `Whole site colour "${tokenLabel(token)}" (${token}, ${countTokenUses(token)} rules)`, st.colorScope, v => { st.colorScope = v; })),
        h('p', { class: 'cequ-contrast' + (ratio < okRatio ? ' is-bad' : '') },
          `Readability ${ratio.toFixed(1)}:1 `, ratio < okRatio ? '⚠ hard to read' : '✓'),
      ];
    }
    if (st.tab === 'text') {
      if (!isTextual(el)) return h('p', { class: 'cequ-hint' }, 'This component holds other blocks. Press ↓ to pick the exact text, or describe the change above.');
      if (editing) {
        return [h('p', { class: 'cequ-hint' }, 'Type directly on the page (the highlighted text). Inline formatting is kept.'),
          h('div', { class: 'cequ-row' },
            h('button', { type: 'button', class: 'cequ-btn', onclick: () => { endTextEdit(false); render(); } }, 'Cancel'),
            h('button', { type: 'button', class: 'cequ-btn cequ-primary', onclick: async () => {
              const r = endTextEdit(true);
              try { if (r) await applyTextResult(r); } catch (e) { st.error = `Could not read this component: ${e.message}`; }
              render();
            } }, 'Done'))];
      }
      return [
        st.text && h('div', { class: 'cequ-textnew' }, h('small', {}, 'New text'), h('p', {}, st.text.plain || st.text.to)),
        h('div', { class: 'cequ-row' },
          h('button', { type: 'button', class: 'cequ-btn', onclick: startTextEdit }, st.text ? 'Edit again on page' : '✏️ Edit on page'),
          st.text && h('button', { type: 'button', class: 'cequ-link', onclick: () => { st.text = null; render(); } }, 'Undo text change')),
      ];
    }
    if (st.tab === 'layout') {
      const img = imageIn(el);
      const seg = (key, options) => h('div', { class: 'cequ-segrow' },
        h('button', { type: 'button', class: st.layout[key] ? '' : 'is-on', onclick: () => { delete st.layout[key]; render(); } }, 'Keep'),
        options.map(([v, l]) => h('button', { type: 'button', class: st.layout[key] === v ? 'is-on' : '', onclick: () => { st.layout[key] = v; render(); } }, l)));
      const focal = st.layout.focal || (img ? getComputedStyle(img).objectPosition : '50% 50%');
      return [
        h('div', { class: 'cequ-field' }, 'Align', seg('align', ALIGNS)),
        h('div', { class: 'cequ-field' }, 'Width', seg('width', WIDTHS)),
        img && h('div', { class: 'cequ-field' }, 'Photo fit', seg('fit', FITS)),
        img && h('div', { class: 'cequ-field' }, 'Focal point: click the part of the photo that must stay in view',
          h('div', { class: 'cequ-focal', onclick: e => {
            const r = e.currentTarget.getBoundingClientRect();
            st.layout.focal = `${Math.round(((e.clientX - r.left) / r.width) * 100)}% ${Math.round(((e.clientY - r.top) / r.height) * 100)}%`;
            render();
          } },
            h('img', { src: img.currentSrc || img.src, alt: '' }),
            h('i', { style: { left: focal.split(' ')[0], top: focal.split(' ')[1] || '50%' } })),
          st.layout.focal && h('button', { type: 'button', class: 'cequ-link', onclick: () => { delete st.layout.focal; render(); } }, 'Keep current focal point')),
      ];
    }
    return h('fieldset', { class: 'cequ-radios' }, h('legend', {}, 'This component'),
      radio('remove', '', 'Keep it', st.remove || '', v => { st.remove = v || null; }),
      radio('remove', 'remove', 'Remove from the page', st.remove || '', v => { st.remove = v; }),
      radio('remove', 'hide-phone', 'Hide on phone only', st.remove || '', v => { st.remove = v; }),
      radio('remove', 'hide-desktop', 'Hide on desktop only', st.remove || '', v => { st.remove = v; }));
  }

  function radio(name, value, label, current, set) {
    return h('label', { class: 'cequ-radio' },
      h('input', { type: 'radio', name: `cequ-${name}`, value, checked: current === value, onchange: () => { set(value); render(); } }), label);
  }

  function render() {
    if (!st) return;
    const active = root.getRootNode().activeElement || document.activeElement;   // the editor lives in a shadow root
    const focusKey = active?.dataset?.key;
    const caret = focusKey ? [active.selectionStart, active.selectionEnd] : null;
    const crumbs = (target?.selector || '').split(' > ').slice(-3).join(' › ');
    const has = { image: Boolean(st.image), color: Object.values(st.colors).some(Boolean), text: Boolean(st.text), remove: Boolean(st.remove),
      layout: Object.values(st.layout).some(Boolean) };
    const way = route();

    const next = h('div', { class: 'cequ cequ-dialog', role: 'dialog', 'aria-label': 'Change this component',
      onkeydown: e => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      } },
      h('header', { class: 'cequ-dh', onpointerdown: startDrag },
        h('div', {}, h('b', {}, describe(el)), h('small', {}, crumbs || 'reading component…')),
        h('div', { class: 'cequ-nav' },
          h('button', { type: 'button', title: 'Select the parent ( [ )', onclick: () => selector.parent() }, '↑'),
          h('button', { type: 'button', title: 'Select a child ( ] )', onclick: () => selector.child() }, '↓'),
          h('button', { type: 'button', title: 'Close (Esc)', onclick: close }, '✕'))),
      st.generated && h('p', { class: 'cequ-note' }, 'This part is generated by a script; its source element is selected.'),
      CFG.appMode && whereLine(target),
      h('div', { class: 'cequ-screens' }, 'Screens',
        ...[['all', 'All'], ['desktop', 'Desktop'], ['phone', 'Phone']].map(([v, l]) => h('button', {
          type: 'button', class: st.screens === v ? 'is-on' : '', onclick: () => { st.screens = v; render(); } }, l)),
        h('small', {}, `viewing ${innerWidth}px`)),
      h('textarea', { class: 'cequ-instr', rows: 3, 'data-key': 'instr', placeholder: 'What should change? (any language)',
        value: st.instruction, oninput: e => {
          st.instruction = e.target.value;
          const r = route(), tag = node?.querySelector('.cequ-route');
          if (tag) { tag.className = `cequ-route ${r.cls}`; tag.textContent = r.text; }
        } }),
      h('nav', { class: 'cequ-tabs' }, TABS.map(([k, l]) => h('button', {
        type: 'button', class: (st.tab === k ? 'is-on' : '') + (has[k] ? ' has-value' : ''), onclick: () => { st.tab = k; render(); } }, l))),
      h('section', { class: 'cequ-tab' }, tabBody()),
      h('p', { class: `cequ-route ${way.cls}` }, way.text),
      h('footer', { class: 'cequ-df' },
        h('span', { class: 'cequ-err', role: 'alert' }, st.error || ''),
        h('button', { type: 'button', class: 'cequ-btn', onclick: close }, 'Cancel'),
        h('button', { type: 'button', class: 'cequ-btn cequ-primary', disabled: st.uploading,
          onclick: save }, st.itemId ? 'Save change' : 'Add to list ⌘↵')));

    if (node) node.replaceWith(next); else root.append(next);
    node = next;
    position();
    if (focusKey) {
      const f = node.querySelector(`[data-key="${focusKey}"]`);
      if (f) { f.focus(); if (caret) f.setSelectionRange(...caret); }
    } else if (!editing && !st.pos && !target) node.querySelector('.cequ-instr')?.focus();
  }

  function position() {
    const w = node.offsetWidth, ht = node.offsetHeight;
    let left, top;
    if (st.pos) ({ left, top } = st.pos);
    else {
      const r = el.getBoundingClientRect();
      left = r.right + 16 + w < innerWidth ? r.right + 16 : r.left - 16 - w > 0 ? r.left - 16 - w : innerWidth - w - 16;
      top = Math.min(Math.max(16, r.top), innerHeight - ht - 16);
    }
    node.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(top, innerHeight - ht - 8))}px`;
  }

  function startDrag(e) {
    if (e.target.closest('button')) return;
    const r = node.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => { st.pos = { left: ev.clientX - dx, top: ev.clientY - dy }; position(); };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  return { open, close, isOpen, get element() { return el; } };
}
