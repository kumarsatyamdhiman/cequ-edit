// What the editor records about a clicked component (spec §4). No imports: the pure
// helpers at the top are unit-tested in Node; the rest runs in the browser.

// Fallback when the page's source classes are unknown: names sites commonly add from scripts.
export const RUNTIME_CLASSES = new Set(['in', 'ok', 'on', 'is-on', 'active', 'is-active', 'visible', 'is-visible', 'show', 'swap', 'live', 'hover', 'press', 'scrolled', 'open', 'is-open']);
const CSS_PROPS = ['color', 'background-color', 'background', 'border-color', 'border', 'fill', 'stroke',
  'font', 'font-size', 'font-family', 'display', 'object-position', 'width', 'height', 'aspect-ratio', 'opacity', 'filter'];
const mediaList = cfg => [cfg.breakpoints?.phone, cfg.breakpoints?.desktop, '(prefers-reduced-motion: reduce)'].filter(Boolean);

// Class names as authored: when the page's source classes are known, anything else was added by a script.
let sourceSet = null;
export const setSourceClasses = list => { sourceSet = list ? new Set(list) : null; };
export const cleanClasses = (cls = '', allowed = sourceSet) =>
  cls.split(/\s+/).filter(c => c && !c.startsWith('cequ-') && (allowed ? allowed.has(c) : !RUNTIME_CLASSES.has(c))).join(' ');

// Attributes exactly as written in the source start tag (so no runtime classes or inline styles).
export function attrsFromSnippet(snippet = '') {
  const tag = /^<[a-zA-Z][\w-]*((?:\s+[^\s=\/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/.exec(snippet);
  const out = {};
  if (!tag) return out;
  for (const m of tag[1].matchAll(/([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

// Site-relative path of a stylesheet URL (preview URLs map back to the same file).
export function sheetFile(href) {
  if (!href) return null;
  const path = decodeURIComponent(new URL(href).pathname).replace(/^\/__cequ\/preview\/\d+\//, '/');
  return path.replace(/^\//, '');
}

export function parseSrc(src) {
  const m = /^(.*):(\d+):(\d+)$/.exec(src || '');
  return m ? { file: m[1], line: Number(m[2]), col: Number(m[3]) } : null;
}

// CSSOM writes selectors with its own spacing; compare them without it.
export const normSelector = s => String(s).replace(/\s*([,>+~])\s*/g, '$1').replace(/\s+/g, ' ').trim();

// ---------- browser-only below ----------

const appMode = () => Boolean(globalThis.__CEQU_EDIT?.appMode);

// Outermost <svg> for clicks on paths/uses, then the nearest element carrying a source stamp.
// App projects have no stamps: any element of the page can be picked.
export function pickable(target) {
  if (!(target instanceof Element)) return null;
  let el = target;
  while (el.ownerSVGElement) el = el.ownerSVGElement;
  if (appMode()) return el === document.body || el === document.documentElement || el.localName === 'cequ-edit' ? null : { el, generated: false };
  const stamped = el.closest('[data-cequ-src]');
  if (!stamped || stamped === document.body) return null;
  return { el: stamped, generated: stamped !== el };
}

export function cssPath(el) {
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
    if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
    let part = n.localName;
    const cls = cleanClasses(n.getAttribute('class') || '').split(' ').filter(Boolean).slice(0, 2);
    if (cls.length) part += '.' + cls.map(c => CSS.escape(c)).join('.');
    const same = n.parentElement ? [...n.parentElement.children].filter(s => s.localName === n.localName) : [];
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
    parts.unshift(part);
    if (n.localName === 'body') break;
  }
  return parts.join(' > ');
}

export function describe(el) {
  if (!el) return '';
  const cls = cleanClasses(el.getAttribute('class') || '').split(' ')[0];
  const name = el.localName + (el.id ? '#' + el.id : cls ? '.' + cls : '');
  const img = el.localName === 'img' ? el : null;
  const detail = img ? (img.getAttribute('src') || '').split('/').pop()
    : (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28);
  return detail ? `${name} · ${detail}` : name;
}

const siteSheets = () => [...document.styleSheets].filter(s => !(s.href || '').includes('/__cequ/'));

export function matchedRules(el, props = CSS_PROPS) {
  const out = [];
  const walk = (rules, media) => {
    for (const r of rules) {
      if (r instanceof CSSMediaRule) { if (matchMedia(r.conditionText).matches) walk(r.cssRules, `@media ${r.conditionText}`); continue; }
      if (r instanceof CSSSupportsRule) { if (CSS.supports(r.conditionText)) walk(r.cssRules, media); continue; }
      if (!(r instanceof CSSStyleRule)) continue;
      let hit = false;
      try { hit = el.matches(r.selectorText); } catch { /* selector the browser can't test */ }
      if (!hit) continue;
      const decls = {};
      for (const p of props) { const v = r.style.getPropertyValue(p); if (v) decls[p] = v.trim(); }
      if (Object.keys(decls).length) out.push({ selector: r.selectorText, media, decls, href: r.parentStyleSheet?.href || null,
        devFile: r.parentStyleSheet?.ownerNode?.dataset?.viteDevId || null });
    }
  };
  for (const s of siteSheets()) { try { walk(s.cssRules, null); } catch { /* cross-origin sheet (fonts) */ } }
  return out;
}

// Colour tokens from the site's :root rule.
export function siteTokens() {
  const out = [];
  for (const s of siteSheets()) {
    let rules; try { rules = s.cssRules; } catch { continue; }
    for (const r of rules) {
      if (!(r instanceof CSSStyleRule) || r.selectorText !== ':root') continue;
      for (const name of r.style) if (name.startsWith('--')) out.push({ name, value: r.style.getPropertyValue(name).trim() });
    }
  }
  const root = getComputedStyle(document.documentElement);
  return out.filter(t => {
    const v = root.getPropertyValue(t.name).trim();
    return v && CSS.supports('color', v) && !/^(inherit|initial|unset|currentcolor|transparent)$/i.test(v);
  });
}

let ctx;
export function toRGB(color) {
  ctx ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}
export const toHex = c => { const { r, g, b } = toRGB(c); return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join(''); };
export const resolveColor = v => {
  const m = /^var\((--[\w-]+)\)$/.exec(String(v).trim());
  return m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() : v;
};
const luminance = ({ r, g, b }) => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export function contrast(fg, bg) {
  const a = luminance(toRGB(resolveColor(fg))), b = luminance(toRGB(resolveColor(bg)));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function effectiveBackground(el) {
  for (let n = el; n; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (toRGB(c).a > 0.5) return c;
  }
  return getComputedStyle(document.documentElement).backgroundColor;
}

const cssIndexCache = new Map();
async function cssLine(fetchJSON, cfg, file, selector, media) {
  if (!cssIndexCache.has(file)) {
    const batch = cfg.mode === 'preview' ? `&batch=${cfg.batchId}` : '';
    cssIndexCache.set(file, fetchJSON(`css-index?file=${encodeURIComponent(file)}${batch}`).catch(() => []));
  }
  const idx = await cssIndexCache.get(file);
  const hit = idx.find(r => normSelector(r.selector) === normSelector(selector) && (r.media || null) === (media || null))
    || idx.find(r => normSelector(r.selector) === normSelector(selector));
  return hit ? `${file}:${hit.line}` : file;
}

// Full target record for one selected element. fetchJSON(path) calls the editor API.
export async function capture(el, { generated = false, fetchJSON, cfg }) {
  const src = el.getAttribute('data-cequ-src');
  const loc = parseSrc(src);
  const batch = cfg.mode === 'preview' ? `&batch=${cfg.batchId}` : '';
  const { text: snippet } = await fetchJSON(`snippet?file=${encodeURIComponent(loc.file)}&line=${loc.line}&col=${loc.col}${batch}`);

  const attributes = attrsFromSnippet(snippet);
  const cls = cleanClasses(el.getAttribute('class') || '').split(' ').filter(Boolean)[0];
  const sec = el.closest('section[id], footer, header, main > div[class]');
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const imgSrc = el.localName === 'img' ? el.getAttribute('src') : null;
  const rules = await Promise.all(matchedRules(el).map(async ({ href, devFile, ...r }) => {
    const file = sheetFile(href);
    return { at: file ? await cssLine(fetchJSON, cfg, file, r.selector, r.media) : `${cfg.page} (inline <style>)`, ...r };
  }));

  return {
    src, fileHash: cfg.fileHash, selector: cssPath(el), tag: el.localName, snippet,
    text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
    attributes,
    section: sec ? { id: sec.id || cleanClasses(sec.getAttribute('class') || '').split(' ')[0] || sec.localName,
      heading: (sec.querySelector('h1, h2')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) || null } : null,
    viewport: { width: innerWidth, media: mediaList(cfg).filter(q => matchMedia(q).matches) },
    cssRules: rules,
    computed: { color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize,
      fontFamily: cs.fontFamily.split(',')[0].replace(/"/g, ''), width: Math.round(rect.width), height: Math.round(rect.height) },
    alike: cls ? { selector: '.' + cls, count: document.querySelectorAll('.' + CSS.escape(cls)).length } : null,
    sameSrc: imgSrc ? { src: imgSrc, count: [...document.images].filter(i => i.getAttribute('src') === imgSrc).length } : null,
    generatedBy: generated ? 'script' : null,
  };
}

// App projects (spec §8): no source stamps; the target is described from the DOM and located by the server.
export async function captureApp(el, { post, cfg }) {
  const { sourceHint } = await import('./source.js');
  const { hint, components } = sourceHint(el);
  const attributes = {};
  for (const a of el.attributes) if (!a.name.startsWith('data-cequ') && !['contenteditable', 'spellcheck', 'style'].includes(a.name)) attributes[a.name] = a.value;
  const imgs = el.localName === 'img' ? [el] : [...el.querySelectorAll('img')];
  const imgSrc = imgs.length === 1 ? imgs[0].getAttribute('src') : null;
  const ownText = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const whole = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (whole && whole.length <= 200 && !ownText.includes(whole) && [...el.querySelectorAll('*')].every(n => /^(b|i|em|strong|span|a|small|br|sup|sub|mark|code|u)$/.test(n.localName))) ownText.push(whole);
  const classes = cleanClasses(el.getAttribute('class') || '').split(' ').filter(Boolean);
  const matched = matchedRules(el);
  const devFiles = [...new Set(matched.map(r => r.devFile).filter(Boolean))];
  const located = await post('locate', { hint, tag: el.localName, ownText, attributes, classes, imgSrc, devFiles,
    batch: cfg.mode === 'preview' ? cfg.batchId : null }).catch(() => ({ kind: 'none', candidates: [], textInCode: null, files: {} }));
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const cls = classes[0];
  const html = el.outerHTML;
  const params = new URLSearchParams(location.search);
  for (const k of [...params.keys()]) if (k.startsWith('cequ-')) params.delete(k);
  return {
    src: located.src || null, located, components, route: location.pathname + (params.size ? `?${params}` : ''),
    selector: cssPath(el), tag: el.localName, snippet: html.length > 600 ? `${html.slice(0, 600)}…` : html,
    text: whole.slice(0, 200), ownText, attributes, imgSrc,
    viewport: { width: innerWidth, media: mediaList(cfg).filter(q => matchMedia(q).matches) },
    cssRules: matched.map(({ href, devFile, ...r }) => ({
      at: (devFile && located.files?.[devFile]) || (href ? new URL(href).pathname : 'inline <style>'), ...r })),
    computed: { color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize,
      fontFamily: cs.fontFamily.split(',')[0].replace(/"/g, ''), width: Math.round(rect.width), height: Math.round(rect.height) },
    alike: cls ? { selector: '.' + CSS.escape(cls), count: document.querySelectorAll('.' + CSS.escape(cls)).length } : null,
    sameSrc: imgSrc ? { src: imgSrc, count: [...document.images].filter(i => i.getAttribute('src') === imgSrc).length } : null,
    generatedBy: null,
  };
}
