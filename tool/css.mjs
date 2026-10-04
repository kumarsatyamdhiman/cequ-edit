// Minimal CSS scanner and editor: rule ranges, declaration updates, appended rules.
// Comments and strings are skipped; nesting inside @media / @supports is tracked.

const lines = (s, from, to) => { let n = 0; for (let i = from; i < to; i++) if (s[i] === '\n') n++; return n; };

// [{ selector, line, media, open, close }] — open/close are the offsets of the rule's { and }.
export function cssRules(css) {
  const out = [], stack = [];
  let line = 1, buf = '', selLine = 1;
  for (let i = 0; i < css.length;) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2);
      const end = e === -1 ? css.length : e + 2;
      line += lines(css, i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
      if (!buf.trim()) selLine = line;
      buf += css.slice(i, j + 1);
      line += lines(css, i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '{') {
      const prelude = buf.trim().replace(/\s+/g, ' ');
      if (prelude.startsWith('@')) stack.push({ at: prelude });
      else {
        const rule = { selector: prelude, line: selLine, media: stack.filter(s => s.at).map(s => s.at).join(' ') || null, open: i, close: -1 };
        stack.push({ rule });
        out.push(rule);
      }
      buf = ''; i++;
      continue;
    }
    if (c === '}') { const top = stack.pop(); if (top?.rule) top.rule.close = i; buf = ''; i++; continue; }
    if (c === ';') { buf = ''; i++; continue; }
    if (!buf.trim() && !/\s/.test(c)) selLine = line;
    buf += c;
    if (c === '\n') line++;
    i++;
  }
  return out;
}

export const cssIndex = css => cssRules(css).map(({ selector, line, media }) => ({ selector, line, media }));

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Set `prop: value` inside one rule: replace the existing declaration, or add it keeping the rule's layout.
export function setDeclaration(css, rule, prop, value) {
  const body = css.slice(rule.open + 1, rule.close);
  const m = new RegExp(`(^|[;{\\s])(${escapeRe(prop)}\\s*:\\s*)([^;}]*)`, 'i').exec(body);
  if (m) {
    const at = rule.open + 1 + m.index + m[1].length + m[2].length;
    const old = m[3];
    const trailing = old.slice(old.replace(/\s+$/, '').length);
    return css.slice(0, at) + value + trailing + css.slice(at + old.length);
  }
  let k = rule.close - 1;
  while (k > rule.open && /\s/.test(css[k])) k--;
  const needsSemi = css[k] !== ';' && css[k] !== '{';
  const multiline = body.includes('\n');
  const indent = multiline ? (/\n([ \t]+)\S/.exec(body)?.[1] ?? '  ') : '';
  const decl = `${needsSemi ? ';' : ''}${multiline ? `\n${indent}` : ' '}${prop}: ${value};`;
  return css.slice(0, k + 1) + decl + css.slice(k + 1);
}

// Append `selector { decls }` (inside `@media <media>` when given) under a CEQU-Edit marker.
export function appendRule(css, selector, decls, media = null) {
  const body = Object.entries(decls).map(([p, v]) => `${p}: ${v};`).join(' ');
  const rule = media ? `@media ${media} { ${selector} { ${body} } }` : `${selector} { ${body} }`;
  const marker = css.includes('/* CEQU-Edit */') ? '' : '\n/* CEQU-Edit */\n';
  return `${css}${css.endsWith('\n') ? '' : '\n'}${marker}${rule}\n`;
}
