// App mode: find the source of a clicked element. Framework dev info (the hint) is checked against the
// file; otherwise a project-wide search ranks the places that match the element's text, attributes
// and classes. Spec §9.2.
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { git } from './runner.mjs';

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|heic|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|webm|mov|wav|ogg|pdf|zip|gz|tgz|bz2|7z|rar|jar|exe|dll|so|dylib|wasm|class|pyc|sqlite3?|db|lockb|psd|ai)$/i;
const LOCK = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|go\.sum)$/;
const skipFile = f => BINARY.test(f) || LOCK.test(f) || /\.min\.[a-z]+$|\.map$/i.test(f);
const MAX_BYTES = 1024 * 1024;
const WINDOW = 3, LITERAL_LINES = 40, SHIFT = 60;
const ATTRS = [['id', 8], ['alt', 6], ['placeholder', 6], ['aria-label', 6], ['title', 6], ['href', 4]];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Framework paths (absolute, in a copy or stage folder, Vite URLs, /@fs/, stack-trace URLs) → project-relative.
// Forward slashes everywhere; Windows drive letters in lower case so C:\ and c:/ compare equal.
const fwd = p => String(p).replace(/\\/g, '/').replace(/^\/?([A-Za-z]):\//, (_, d) => `${d.toLowerCase()}:/`);

export function normalizePath(p, { siteDir, roots = [], stageRoot = null }) {
  if (!p) return null;
  let s = fwd(String(p).trim());
  if (/^[a-z][\w+.-]*:\/\//i.test(s)) { try { s = new URL(s).pathname; } catch { return null; } }
  s = s.replace(/[?#].*$/, '');
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  if (s.startsWith('/@fs/')) s = s.slice(4);
  if (s.includes('/node_modules/') || s.startsWith('node_modules/')) return null;
  s = fwd(s);
  const stage = stageRoot && fwd(stageRoot);
  if (stage && s.startsWith(stage + '/')) return s.slice(stage.length + 1).replace(/^[^/]+\//, '') || null;
  for (const r of [siteDir, ...roots].filter(Boolean).map(fwd)) if (s.startsWith(r + '/')) return s.slice(r.length + 1);
  const rel = s.replace(/^\.?\//, '');
  if (rel && existsSync(join(siteDir, rel))) return rel;
  return null;
}

const lineStarts = text => { const a = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') a.push(i + 1); return a; };
function lineOf(starts, at) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
function literalHits(text, needle) {
  const out = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}
const regexHits = (text, re) => [...text.matchAll(re)].map(m => m.index);
// Text of lines a..b (1-based, inclusive, clamped).
function span(e, a, b) {
  a = Math.max(1, a); b = Math.min(e.starts.length, b);
  if (a > b) return '';
  return e.text.slice(e.starts[a - 1], b < e.starts.length ? e.starts[b] : e.text.length);
}

export function createLocator({ siteDir, home, stageDir = () => null }) {
  const cache = new Map();
  async function read(root, f) {
    const abs = join(root, f);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile() || st.size > MAX_BYTES) return null;
    const hit = cache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.entry;
    const text = await readFile(abs, 'utf8').catch(() => null);
    const entry = text == null || text.includes('\0') ? null : { text, starts: lineStarts(text) };
    cache.set(abs, { mtimeMs: st.mtimeMs, entry });
    return entry;
  }

  async function locate({ hint = null, tag = '', ownText = [], attributes = {}, classes = [], imgSrc = null, batch = null, devFiles = [] } = {}) {
    const stage = batch ? stageDir(batch) : null;
    const root = stage && existsSync(stage) ? stage : siteDir;
    const list = (await git(root, 'ls-files', '-co', '--exclude-standard', '-z')).split('\0').filter(f => f && !skipFile(f));
    const files = new Map();
    for (const f of list) { const e = await read(root, f); if (e) files.set(f, e); }

    // needles: [name, weight, find(text) → offsets]
    const own = [...new Set(ownText.map(s => String(s).replace(/\s+/g, ' ').trim()).filter(s => s.length >= 4).map(s => s.slice(0, 80)))];
    const ownRes = own.map(s => new RegExp(s.split(' ').map(esc).join('\\s+'), 'g'));
    const needles = ownRes.map(re => ['text', 10, t => regexHits(t, re)]);
    // literal pieces of text that mixes in computed values ("© {year} Lantern" → "Lantern")
    const parts = [...new Set(own.flatMap(s => s.split(/[^\p{L}\s'’-]+/u).map(p => p.trim()).filter(p => p.length >= 4 && p !== s)))].slice(0, 6);
    const partStart = needles.length;
    for (const p of parts) { const re = new RegExp(p.split(/\s+/).map(esc).join('\\s+'), 'gu'); needles.push(['text-part', 6, t => regexHits(t, re)]); }
    const srcVal = attributes.src || imgSrc;
    if (srcVal && !/^data:/.test(srcVal)) {
      const path = srcVal.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
      const name = path.split('/').pop();
      needles.push(['src', 8, t => { const a = literalHits(t, path); return a.length || name === path ? a : literalHits(t, name); }]);
    }
    for (const [a, w] of ATTRS) {
      const v = attributes[a];
      if (typeof v === 'string' && v.trim().length >= 2 && !(a === 'href' && /^#?$/.test(v))) needles.push([a, w, t => literalHits(t, v)]);
    }
    const rare = [];
    const cls = [...new Set(classes.filter(c => c && c.length >= 2 && !c.startsWith('cequ-') && !/^cq-[0-9a-f]{6}$/.test(c)))].slice(0, 12);
    for (const c of cls) {
      const re = new RegExp(`(?<![\\w-])${esc(c)}(?![\\w-])`, 'g');
      let df = 0;
      for (const { text } of files.values()) if (text.search(re) >= 0) df++;
      if (df) needles.push([`class:${c}`, df <= 3 ? 3 : 1, t => regexHits(t, re)]);
      if (df && df <= 3) rare.push(re);
    }
    const tagRe = tag ? new RegExp(`<${esc(tag)}(?=[\\s>/])`, 'i') : null;

    // hits per file: name → sorted line numbers (+ offsets for the first match of each)
    const hitLines = new Map(), totals = own.map(() => []);
    let partFound = false;
    for (const [f, e] of files) {
      const per = new Map();
      needles.forEach(([name, w, find], i) => {
        const offs = find(e.text);
        if (!offs.length) return;
        per.set(i, offs.map(o => lineOf(e.starts, o)));
        if (name === 'text') for (const o of offs) totals[i].push({ f, o });
        if (i >= partStart && name === 'text-part') partFound = true;
      });
      if (per.size) hitLines.set(f, per);
    }

    const norm = f => normalizePath(f, { siteDir, roots: [join(home, 'preview'), join(home, 'build')], stageRoot: join(home, 'stage') });
    const hintFile = hint?.file ? norm(hint.file) : null;
    const windowScore = (f, L) => {
      const per = hitLines.get(f) || new Map(), why = [];
      let score = 0;
      for (const [i, lines] of per) {
        if (lines.some(l => Math.abs(l - L) <= WINDOW)) { score += needles[i][1]; why.push(needles[i][0]); }
      }
      if (tagRe && tagRe.test(span(files.get(f), L - WINDOW, L + WINDOW))) { score += tagRe.test(span(files.get(f), L, L)) ? 2 : 1; why.push('tag'); }
      if (f === hintFile) { score += 5; why.push('hint-file'); }
      return { score, why };
    };

    // candidate windows, one per region
    const wins = [];
    for (const [f, per] of hitLines) {
      const anchors = [...new Set([...per.values()].flat())].sort((a, b) => a - b);
      for (const L of anchors) { const s = windowScore(f, L); if (s.score >= 3) wins.push({ file: f, line: L, ...s }); }
    }
    wins.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
    const candidates = [];
    for (const w of wins) {
      if (candidates.some(c => c.file === w.file && Math.abs(c.line - w.line) <= 2 * WINDOW)) continue;
      candidates.push(w);
      if (candidates.length === 5) break;
    }

    const textInCode = own.length ? totals.some(t => t.length > 0) || partFound : null;
    let src = null;
    // A framework's exact hint counts only with real evidence there: the element's own text, one of its
    // attribute values, or a rare class next to its tag. A tag alone (another <button>) is not enough.
    const attrVals = [...ATTRS.map(([a]) => attributes[a]), srcVal].filter(v => typeof v === 'string' && v.length >= 2);
    const evidence = (e, L) => {
      const near = span(e, L - WINDOW, L + WINDOW);
      return ownRes.some(re => near.search(re) >= 0) || attrVals.some(v => near.includes(v))
        || (tagRe && tagRe.test(near) && rare.some(re => near.search(re) >= 0));
    };
    if (hint?.exact && hintFile && files.has(hintFile) && hint.line) {
      const e = files.get(hintFile);
      let at = evidence(e, hint.line) ? { line: hint.line, col: hint.col || 1 } : null;
      // Dev-server transforms can shift line numbers: the nearest <tag> followed by the element's own text
      // or an attribute value (classes are shared by siblings, so they don't count here).
      const follows = L => { const t = span(e, L, L + 2 * WINDOW); return ownRes.some(re => t.search(re) >= 0) || attrVals.some(v => t.includes(v)); };
      for (let d = 1; !at && tagRe && d <= SHIFT; d++) {
        for (const L of [hint.line - d, hint.line + d]) {
          const m = L >= 1 && L <= e.starts.length ? tagRe.exec(span(e, L, L)) : null;
          if (m && follows(L)) { at = { line: L, col: m.index + 1 }; break; }
        }
      }
      if (at) src = `${hintFile}:${at.line}:${at.col}`;
      else if (!candidates.some(c => c.file === hintFile && Math.abs(c.line - hint.line) <= WINDOW)) {
        candidates.unshift({ file: hintFile, line: hint.line, score: 5, why: ['hint'] });
        candidates.splice(5);
      }
    }
    // own text that occurs exactly once in the whole project
    if (!src) {
      const unique = totals.find(t => t.length === 1);
      if (unique) {
        const e = files.get(unique[0].f);
        const line = lineOf(e.starts, unique[0].o);
        src = `${unique[0].f}:${line}:${unique[0].o - e.starts[line - 1] + 1}`;
      }
    }

    // stylesheet files the browser knows by absolute path (Vite's data-vite-dev-id) → project paths
    const files_ = Object.fromEntries(devFiles.slice(0, 50).map(f => [f, norm(f)]).filter(([, r]) => r));
    const res = { kind: src ? 'exact' : candidates.length ? 'candidates' : 'none', candidates, textInCode, files: files_ };
    if (src) {
      res.src = src;
      const [file, line] = [src.slice(0, src.lastIndexOf(':', src.lastIndexOf(':') - 1)), Number(src.split(':').at(-2))];
      const range = span(files.get(file), line, line + LITERAL_LINES);
      const once = offs => offs.length === 1;
      const imgPath = srcVal ? srcVal.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '') : null;
      res.literal = {
        text: ownRes.some(re => once(regexHits(range, re))),
        src: Boolean(imgPath && imgPath.startsWith('/') && once(literalHits(range, imgPath))
          && ['public', 'static'].some(d => existsSync(join(root, d, imgPath)))),
      };
    }
    return res;
  }

  return { locate };
}
