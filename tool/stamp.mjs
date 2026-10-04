// Source stamping: every element in the served page learns where it lives in the file.
// stamp() only ever inserts ` data-cequ-src="file:line:col"` into start tags, so removing
// those attributes gives back the original text byte for byte.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const NO_STAMP = new Set(['script', 'style', 'template', 'noscript']);

// Index just past the `>` that closes a tag, ignoring `>` inside quoted attribute values.
function tagEnd(html, i) {
  let quote = null;
  for (; i < html.length; i++) {
    const c = html[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return html.length;
}

// Minimal HTML tokenizer: start tags, end tags and comments, in document order.
export function* tags(html, from = 0) {
  const lower = html.toLowerCase();
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return;
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      i = e === -1 ? html.length : e + 3;
      yield { type: 'comment', name: '#comment', start: lt, end: i, selfClosing: false };
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {           // doctype, processing instruction
      i = tagEnd(html, lt + 2);
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 80));
    if (!m) { i = lt + 1; continue; }
    const end = tagEnd(html, lt + m[0].length);
    const name = m[2].toLowerCase();
    if (m[1]) { yield { type: 'end', name, start: lt, end, selfClosing: false }; i = end; continue; }
    yield { type: 'start', name, start: lt, end, selfClosing: html[end - 2] === '/' };
    i = end;
    if (RAW.has(name)) {                                          // skip raw text content
      const close = lower.indexOf('</' + name, end);
      i = close === -1 ? html.length : close;
    }
  }
}

function lineStarts(html) {
  const starts = [0];
  for (let i = 0; i < html.length; i++) if (html[i] === '\n') starts.push(i + 1);
  return starts;
}

function locate(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 };
}

// 1-based line/column of an offset (columns count UTF-16 code units, as the browser does).
export function position(html, offset) {
  return locate(lineStarts(html), offset);
}

export function offsetOf(html, line, col) {
  const starts = lineStarts(html);
  if (line < 1 || line > starts.length) return -1;
  return starts[line - 1] + col - 1;
}

// Add data-cequ-src to every element from <body> on (head, scripts and styles are left alone).
export function stamp(html, file) {
  const starts = lineStarts(html);
  let out = '', last = 0, inBody = false;
  for (const t of tags(html)) {
    if (t.type !== 'start') continue;
    if (t.name === 'body') inBody = true;
    if (!inBody || NO_STAMP.has(t.name)) continue;
    const { line, col } = locate(starts, t.start);
    const at = t.selfClosing ? t.end - 2 : t.end - 1;
    out += html.slice(last, at) + ` data-cequ-src="${file}:${line}:${col}"`;
    last = at;
  }
  return out + html.slice(last);
}

// Exact source text of the element whose start tag begins at line:col, or null.
export function elementSource(html, line, col) {
  const start = offsetOf(html, line, col);
  if (start < 0 || html[start] !== '<') return null;
  const it = tags(html, start);
  const first = it.next().value;
  if (!first || first.type !== 'start' || first.start !== start) return null;
  if (first.selfClosing || VOID.has(first.name)) return { text: html.slice(start, first.end), start, end: first.end };
  let depth = 1;
  for (const t of it) {
    if (t.name !== first.name) continue;
    if (t.type === 'start' && !t.selfClosing) depth++;
    else if (t.type === 'end' && --depth === 0) return { text: html.slice(start, t.end), start, end: t.end };
  }
  return null;
}
