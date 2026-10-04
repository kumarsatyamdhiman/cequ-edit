// Instant edits: CEQU-Edit applies control-only changes itself, straight from the exact source
// positions it already knows. No Claude, no plan usage. Anything it cannot do with certainty
// comes back as `fallback` and goes to Claude instead.
import { readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tags, elementSource, position } from './stamp.mjs';
import { cssRules, setDeclaration, appendRule } from './css.mjs';
import { listFiles } from './config.mjs';
import { isDirect, plainText } from './overlay/kinds.js';
import { parseSrc, normSelector } from './overlay/capture.js';

const TEXTUAL = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'span', 'a', 'blockquote', 'figcaption', 'label',
  'button', 'small', 'strong', 'em', 'b', 'i', 'td', 'th', 'dt', 'dd', 'caption', 'q', 'cite', 'address']);
const ALIGN = { left: '0 auto', center: 'auto', right: 'auto 0' };
const WIDTH_LABEL = { '100%': 'full width', '75%': '¾ width', '50%': '½ width', '33.333%': '⅓ width', auto: 'natural width' };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const fail = msg => { throw new Error(msg); };

// ---------- start-tag helpers (pure, exported for tests) ----------

export function getAttr(tag, name) {
  const m = new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=[\\s/>]|$)`, 'i').exec(tag.slice(tag.indexOf(' ')));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

// Set (or remove, with null) attributes in place, leaving the rest of the tag exactly as written.
export function setAttrs(tag, changes) {
  const head = /^<[a-zA-Z][\w-]*/.exec(tag)[0];
  const close = /\s*\/?>$/.exec(tag);
  let body = tag.slice(head.length, close.index);
  for (const [name, value] of Object.entries(changes)) {
    const m = new RegExp(`(\\s)${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=\\s|$)`, 'i').exec(body);
    const raw = value == null ? '' : `${name}="${escAttr(value)}"`;
    if (m) body = body.slice(0, m.index) + (raw ? m[1] + raw : '') + body.slice(m.index + m[0].length);
    else if (raw) body += ` ${raw}`;
  }
  return head + body + close[0];
}

export function mergeStyle(style, decls) {
  const parts = String(style || '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf(':');
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
  });
  for (const [p, v] of Object.entries(decls)) {
    const i = parts.findIndex(([k]) => k.toLowerCase() === p);
    if (v == null) { if (i >= 0) parts.splice(i, 1); }
    else if (i >= 0) parts[i][1] = v;
    else parts.push([p, v]);
  }
  return parts.map(([k, v]) => `${k}: ${v}`).join('; ');
}

// #rrggbb → oklch(L C H), for stylesheets written in OKLCH.
export function hexToOklch(hex) {
  const lin = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${C < 0.002 ? 0 : Math.round(H)})`;
}

// Write a picked colour the way the stylesheet already writes colours.
export function formatColor(to, cssText = '') {
  if (!/^#[0-9a-f]{6}$/i.test(to)) return to;
  const oklch = (cssText.match(/oklch\(/g) || []).length;
  const hex = (cssText.match(/#[0-9a-f]{3,8}\b/gi) || []).length;
  return oklch > hex ? hexToOklch(to) : to.toLowerCase();
}

// ---------- the editor ----------

export async function applyDirect({ dir, items, breakpoints }) {
  const cache = new Map();
  const read = async f => {
    if (!cache.has(f)) cache.set(f, await readFile(join(dir, f), 'utf8').catch(() => fail(`${f} is missing`)));
    return cache.get(f);
  };
  const write = (f, text) => cache.set(f, text);
  const pages = listFiles(dir, ['.html', '.htm']);
  const sheets = listFiles(dir, ['.css']);
  const results = [];

  for (const item of items) {
    if (!isDirect(item)) continue;
    const before = new Map(cache);
    try {
      const ctx = { read, write, pages, sheets, breakpoints, dir };
      const out = item.target?.located ? await applyItemApp(item, ctx) : await applyItem(item, ctx);
      results.push({ id: item.id, status: 'done', by: 'cequ', summary: out.summary, files: out.files, question: null, reason: null });
    } catch (e) {
      cache.clear();
      for (const [k, v] of before) cache.set(k, v);
      results.push({ id: item.id, status: 'fallback', reason: e.message });
    }
  }
  for (const [f, text] of cache) await writeFile(join(dir, f), text);
  return results;
}

// Find the clicked element: at its recorded line:col if the source still matches, else the snippet's unique occurrence.
function locate(html, src, snippet) {
  const loc = parseSrc(src);
  if (!loc) fail('no source location');
  const el = elementSource(html, loc.line, loc.col);
  if (el && (!snippet || el.text === snippet)) return el.start;
  if (snippet) {
    const first = html.indexOf(snippet);
    if (first >= 0 && html.indexOf(snippet, first + 1) === -1) return first;
  }
  fail('the element changed since it was selected');
}

function elementAt(html, start) {
  const { line, col } = position(html, start);
  const el = elementSource(html, line, col);
  if (!el) fail('the element could not be read');
  const startTag = tags(html, start).next().value;
  const name = /^<([a-zA-Z][\w-]*)/.exec(el.text)[1].toLowerCase();
  return { ...el, name, tagEnd: startTag.end, tag: html.slice(start, startTag.end) };
}

const replaceTag = (html, el, newTag) => html.slice(0, el.start) + newTag + html.slice(el.tagEnd);
const lineOf = (html, at) => position(html, at).line;
const classFor = item => `cq-${createHash('sha1').update(`${item.target.src}|${item.target.snippet}`).digest('hex').slice(0, 6)}`;

function addClass(tag, cls) {
  const current = getAttr(tag, 'class');
  if (current != null && current.split(/\s+/).includes(cls)) return tag;
  return setAttrs(tag, { class: current ? `${current} ${cls}` : cls });
}

// The stylesheet that styles this element (from the click), else the first one the page links.
async function stylesheetFor(item, ctx, page) {
  const fromRules = (item.target.cssRules || []).map(r => String(r.at || '').replace(/:\d+$/, '')).find(f => /\.css$/i.test(f));
  if (fromRules) return fromRules;
  const html = await ctx.read(page);
  for (const t of tags(html)) {
    if (t.type !== 'start' || t.name !== 'link') continue;
    const tag = html.slice(t.start, t.end);
    if (/stylesheet/i.test(getAttr(tag, 'rel') || '') && getAttr(tag, 'href')) {
      const href = getAttr(tag, 'href');
      if (/^(https?:)?\/\//i.test(href)) continue;
      return href.startsWith('/') ? href.slice(1) : posix.normalize(posix.join(posix.dirname(page), href));
    }
  }
  fail('the page links no stylesheet for a phone/desktop-only rule');
}

// Styles for one element: inline when they apply on all screens, else a class + media rule.
async function styleElement(item, ctx, file, start, decls) {
  const media = item.screens === 'phone' ? ctx.breakpoints?.phone : item.screens === 'desktop' ? ctx.breakpoints?.desktop : null;
  let html = await ctx.read(file);
  const el = elementAt(html, start);
  if (!media) {
    const style = mergeStyle(getAttr(el.tag, 'style'), decls);
    ctx.write(file, replaceTag(html, el, setAttrs(el.tag, { style: style || null })));
    return [`${file}:${lineOf(html, start)}`];
  }
  const cls = classFor(item);
  html = replaceTag(html, el, addClass(el.tag, cls));
  ctx.write(file, html);
  const sheet = await stylesheetFor(item, ctx, file);
  const css = await ctx.read(sheet);
  const clean = Object.fromEntries(Object.entries(decls).filter(([, v]) => v != null).map(([p, v]) => [p, `${v} !important`]));
  ctx.write(sheet, appendRule(css, `.${cls}`, clean, media));
  return [`${file}:${lineOf(html, start)}`, sheet];
}

const where = s => (s === 'phone' ? ' on phones' : s === 'desktop' ? ' on desktop' : '');

// Whole-site colour variable: edit its :root declaration, in the element's own stylesheets first.
async function setToken(item, c, ctx) {
  const token = c.token;
  if (!token) fail('which colour variable to change is unknown');
  const own = (item.target.cssRules || []).map(r => String(r.at || '').replace(/:\d+$/, '')).filter(f => /\.css$/i.test(f) && !/^https?:/.test(f));
  for (const sheet of [...new Set([...own, ...ctx.sheets])]) {
    const css = await ctx.read(sheet).catch(() => null);
    if (css == null) continue;
    const rule = cssRules(css).find(r => r.selector === ':root' && new RegExp(`(^|[;{\\s])${token.replace(/[-]/g, '\\-')}\\s*:`).test(css.slice(r.open + 1, r.close)));
    if (!rule) continue;
    const media = item.screens === 'phone' ? ctx.breakpoints?.phone : item.screens === 'desktop' ? ctx.breakpoints?.desktop : null;
    const value = formatColor(c.to, css);
    ctx.write(sheet, media ? appendRule(css, ':root', { [token]: value }, media) : setDeclaration(css, rule, token, value));
    return { summary: `Site colour ${token} → ${value}${where(item.screens)}`, at: `${sheet}:${rule.line}` };
  }
  fail(`colour variable ${token} is not defined in a :root rule`);
}

// ---------- app projects (spec §11): literal swaps at an exact position, in any source language ----------

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LITERAL_LINES = 40;

// Offsets of the lines from `line` to `line + LITERAL_LINES` in `text`.
function rangeFrom(text, line) {
  let from = 0;
  for (let l = 1; l < line; l++) { const i = text.indexOf('\n', from); if (i < 0) fail('the file changed since it was selected'); from = i + 1; }
  let to = from;
  for (let l = 0; l <= LITERAL_LINES && to >= 0; l++) to = text.indexOf('\n', to + 1);
  return [from, to < 0 ? text.length : to];
}
function onlyOnce(text, [from, to], re, what) {
  const hits = [...text.slice(from, to).matchAll(re)];
  if (hits.length !== 1) fail(hits.length ? `${what} appears more than once there` : `${what} changed since it was selected`);
  return { at: from + hits[0].index, len: hits[0][0].length };
}

async function applyItemApp(item, ctx) {
  const { file, line } = parseSrc(item.target.src);
  const p = item.payload;
  const said = [], files = new Set();
  const note = (summary, fs) => { said.push(summary); for (const f of fs) files.add(f); };

  if (p.text) {
    const old = String(p.text.fromPlain || '').replace(/\s+/g, ' ').trim();
    const neu = String(p.text.plain || '').replace(/\s+/g, ' ').trim();
    if (!plainText(old) || !plainText(neu)) fail('the text has markup or template characters');
    const text = await ctx.read(file);
    const { at, len } = onlyOnce(text, rangeFrom(text, line), new RegExp(old.split(' ').map(reEsc).join('\\s+'), 'g'), 'the text');
    const quote = text[at - 1];
    if (`'"\``.includes(quote) && neu.includes(quote)) fail(`the new text contains ${quote}, which would end the string it sits in`);
    ctx.write(file, text.slice(0, at) + neu + text.slice(at + len));
    note(`Text changed to "${neu.slice(0, 60)}"`, [`${file}:${line}`]);
  }

  if (p.image) {
    const img = p.image;
    if (img.scope === 'everywhere') fail('replacing a photo everywhere needs Claude in an app');
    const oldSrc = String(item.target.attributes?.src || item.target.imgSrc || '').replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
    const pub = ['public', 'static'].find(d => oldSrc.startsWith('/') && existsSync(join(ctx.dir, d, oldSrc)));
    if (!pub) fail('the photo is not a file in public/ or static/');
    if (!String(img.file || '').startsWith(`${pub}/`)) fail(`the upload folder is not inside ${pub}/`);
    let text = await ctx.read(file);
    const range = rangeFrom(text, line);
    const { at, len } = onlyOnce(text, range, new RegExp(reEsc(oldSrc), 'g'), 'the photo path');
    const newSrc = img.file.slice(pub.length);
    text = text.slice(0, at) + newSrc + text.slice(at + len);
    const oldAlt = item.target.attributes?.alt;
    if (img.alt != null && oldAlt != null && img.alt !== oldAlt) {
      if (!plainText(img.alt) || /"/.test(img.alt)) fail('the caption has characters that need Claude');
      const r2 = rangeFrom(text, line);
      const a = onlyOnce(text, r2, new RegExp(`alt=(["'])${reEsc(oldAlt)}\\1`, 'g'), 'the alt text');
      text = text.slice(0, a.at) + `alt="${img.alt}"` + text.slice(a.at + a.len);
    }
    ctx.write(file, text);
    note('Photo replaced (this place only)', [`${file}:${line}`]);
  }

  for (const c of [].concat(p.color || [])) {
    if (c.scope !== 'token') fail('element colours need Claude in an app');
    const { summary, at } = await setToken(item, c, ctx);
    note(summary, [at]);
  }
  for (const k of Object.keys(p)) if (!['text', 'image', 'color'].includes(k)) fail(`${k} changes need Claude in an app`);
  return { summary: said.join('; '), files: [...files] };
}

async function applyItem(item, ctx) {
  const { file } = parseSrc(item.target.src);
  const html0 = await ctx.read(file);
  const start = locate(html0, item.target.src, item.target.snippet);
  const p = item.payload;
  const said = [], files = new Set();
  const note = (summary, fs) => { said.push(summary); for (const f of fs) files.add(f); };

  if (p.remove) {
    if (p.remove.mode === 'remove') {
      const el = elementAt(html0, start);
      const lineStart = html0.lastIndexOf('\n', el.start - 1) + 1;
      const rest = /^[ \t]*\r?\n/.exec(html0.slice(el.end));
      const wholeLine = !html0.slice(lineStart, el.start).trim() && rest;
      const [a, b] = wholeLine ? [lineStart, el.end + rest[0].length] : [el.start, el.end];
      ctx.write(file, html0.slice(0, a) + html0.slice(b));
      return { summary: `Removed <${el.name}>`, files: [`${file}:${lineOf(html0, a)}`] };
    }
    note(`Hidden${where(p.remove.mode === 'hide-phone' ? 'phone' : 'desktop')}`,
      await styleElement({ ...item, screens: p.remove.mode === 'hide-phone' ? 'phone' : 'desktop' }, ctx, file, start, { display: 'none' }));
  }

  if (p.text) {
    const html = await ctx.read(file);
    const el = elementAt(html, start);
    const innerStart = el.tagEnd, innerEnd = el.start + el.text.lastIndexOf('</');
    const inner = html.slice(innerStart, innerEnd);
    if (inner !== p.text.from && inner.trim() !== String(p.text.from).trim()) fail('the text changed since it was selected');
    ctx.write(file, html.slice(0, innerStart) + p.text.to + html.slice(innerEnd));
    note(`Text changed to "${(p.text.plain || p.text.to).replace(/<[^>]+>/g, '').slice(0, 60)}"`, [`${file}:${lineOf(html, start)}`]);
  }

  if (p.image) {
    const img = p.image;
    let imgFile = file, imgStart = start;
    if (item.target.tag !== 'img') {
      if (!img.imgAt) fail('no image to replace in this component');
      imgFile = parseSrc(img.imgAt).file;
      imgStart = locate(await ctx.read(imgFile), img.imgAt, null);
    }
    let html = await ctx.read(imgFile);
    const el = elementAt(html, imgStart);
    if (el.name !== 'img') fail('the selected image is not an <img>');
    const oldSrc = getAttr(el.tag, 'src');
    const oldAlt = getAttr(el.tag, 'alt');
    const relSrc = posix.relative(posix.dirname(imgFile), img.file) || img.file;
    const change = tag => setAttrs(tag, {
      src: relSrc, width: img.width, height: img.height, alt: img.alt ?? getAttr(tag, 'alt'),
      style: mergeStyle(getAttr(tag, 'style'), { 'object-position': img.focal || null }) || null,
    });
    html = replaceTag(html, el, change(el.tag));
    // caption of the same <figure>, when the alt text was changed
    if (img.alt != null && img.alt !== oldAlt) {
      for (const t of tags(html)) {
        if (t.type !== 'start' || t.name !== 'figure' || t.start > imgStart) continue;
        const at = position(html, t.start);
        const fig = elementSource(html, at.line, at.col);
        if (!fig || fig.end < imgStart) continue;
        const capAt = fig.text.indexOf('<figcaption');
        if (capAt < 0) continue;
        const cap = elementAt(html, fig.start + capAt);
        const capInnerEnd = cap.start + cap.text.lastIndexOf('</');
        html = html.slice(0, cap.tagEnd) + esc(img.alt) + html.slice(capInnerEnd);
      }
    }
    ctx.write(imgFile, html);
    let count = 1;
    if (img.scope === 'everywhere' && oldSrc) {
      const oldAbs = posix.normalize(posix.join(posix.dirname(imgFile), oldSrc));
      for (const page of ctx.pages) {
        let text = await ctx.read(page);
        const hits = [...tags(text)].filter(t => t.type === 'start' && t.name === 'img' && !(page === imgFile && t.start === imgStart))
          .filter(t => { const s = getAttr(text.slice(t.start, t.end), 'src'); return s && posix.normalize(posix.join(posix.dirname(page), s)) === oldAbs; });
        for (const t of hits.reverse()) {
          const rel = posix.relative(posix.dirname(page), img.file) || img.file;
          const tag = text.slice(t.start, t.end);
          const next = setAttrs(change(tag), { src: rel });
          text = text.slice(0, t.start) + next + text.slice(t.end);
          count++;
        }
        ctx.write(page, text);
      }
    }
    note(`Photo replaced${img.scope === 'everywhere' ? ` everywhere (${count} places)` : ' (this place only)'}`, [`${imgFile}:${lineOf(html, imgStart)}`]);
  }

  if (p.layout) {
    const L = p.layout;
    const html = await ctx.read(file);
    const el = elementAt(html, start);
    const box = {};
    if (L.align) {
      if (TEXTUAL.has(el.name)) box['text-align'] = L.align;
      else { box.display = 'block'; box['margin-inline'] = ALIGN[L.align]; }
    }
    if (L.width) { box.width = L.width === 'auto' ? null : L.width; if (el.name === 'img' && L.width !== 'auto') box.height = 'auto'; }
    const imgBox = {};
    if (L.fit) imgBox['object-fit'] = L.fit;
    if (L.focal) imgBox['object-position'] = L.focal;
    const bits = [L.align && `aligned ${L.align}`, L.width && WIDTH_LABEL[L.width], L.fit && (L.fit === 'cover' ? 'fills its frame' : 'shows whole photo'), L.focal && `focal point ${L.focal}`].filter(Boolean);
    if (el.name === 'img') Object.assign(box, imgBox);
    if (Object.keys(box).length) note(`Layout: ${bits.join(', ')}${where(item.screens)}`, await styleElement(item, ctx, file, start, box));
    if (el.name !== 'img' && Object.keys(imgBox).length) {
      if (!L.imgAt) fail('no image in this component for fit / focal point');
      const imgFile = parseSrc(L.imgAt).file;
      const imgStart = locate(await ctx.read(imgFile), L.imgAt, null);
      const fs = await styleElement({ ...item, target: { ...item.target, src: L.imgAt, snippet: '' } }, ctx, imgFile, imgStart, imgBox);
      note(Object.keys(box).length ? '' : `Photo ${bits.join(', ')}${where(item.screens)}`, fs);
    }
  }

  if (p.color) {
    for (const c of [].concat(p.color)) {
      const label = `${c.property.replace('-color', '')} → ${c.to}`;
      if (c.scope === 'element') {
        const sheet = (item.target.cssRules || []).map(r => String(r.at || '').replace(/:\d+$/, '')).find(f => /\.css$/i.test(f));
        const value = formatColor(c.to, sheet ? await ctx.read(sheet) : '');
        note(`Colour ${label} (this element${where(item.screens)})`, await styleElement(item, ctx, file, start, { [c.property]: value }));
        continue;
      }
      if (c.scope === 'token') {
        const { summary, at } = await setToken(item, c, ctx);
        note(summary, [at]);
        continue;
      }
      if (c.scope === 'alike') {
        const sel = item.target.alike?.selector;
        if (!sel) fail('no shared selector for "all like it"');
        const sheet = await stylesheetFor(item, ctx, file);
        const css = await ctx.read(sheet);
        const value = formatColor(c.to, css);
        const media = item.screens === 'phone' ? ctx.breakpoints?.phone : item.screens === 'desktop' ? ctx.breakpoints?.desktop : null;
        const rule = !media && cssRules(css).find(r => !r.media && normSelector(r.selector) === normSelector(sel));
        ctx.write(sheet, rule ? setDeclaration(css, rule, c.property, value) : appendRule(css, sel, { [c.property]: value }, media));
        note(`Colour ${label} (all ${sel}${where(item.screens)})`, [rule ? `${sheet}:${rule.line}` : sheet]);
        continue;
      }
      fail(`unknown colour scope ${c.scope}`);
    }
  }

  return { summary: said.filter(Boolean).join('; '), files: [...files] };
}
