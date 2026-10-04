// Where a clicked element comes from, read from the framework's own dev-mode info (spec §9.1).
// No imports and no DOM globals at module load, so it can be unit-tested in Node with fake elements.

const parseStamp = s => { const m = /^(.*):(\d+):(\d+)$/.exec(s || ''); return m ? { file: m[1], line: +m[2], col: +m[3] } : null; };
const isLib = f => /node_modules|\/\.vite\/deps\/|\/@vite\/|\/@react-refresh|\/@id\//.test(String(f || ''));

// First stack frame that points at a project file (React 19's _debugStack): file only, the line is in compiled code.
export function projectFrame(stack) {
  for (const line of String(stack || '').split('\n')) {
    const m = /\(?((?:https?:\/\/|file:\/\/|\/)[^()\s]+?):\d+:\d+\)?\s*$/.exec(line.trim());
    if (m && !isLib(m[1])) return m[1];
  }
  return null;
}

const compName = t => (t && (typeof t === 'function' || typeof t === 'object')) ? (t.displayName || t.name || t.render?.displayName || t.render?.name || null) : null;

export function sourceHint(el) {
  const components = [];
  const stamped = el.closest?.('[data-cequ-src]');
  if (stamped) { const s = parseStamp(stamped.getAttribute('data-cequ-src')); if (s) return { hint: { ...s, exact: true }, components }; }

  const astro = el.closest?.('[data-astro-source-file]');
  if (astro) {
    const [line, col] = String(astro.getAttribute('data-astro-source-loc') || '').split(':').map(Number);
    return { hint: { file: astro.getAttribute('data-astro-source-file'), line: line || null, col: col || null, exact: Boolean(line) }, components };
  }

  for (let n = el; n; n = n.parentElement) {
    const loc = n.__svelte_meta?.loc;
    if (loc?.file && !isLib(loc.file)) return { hint: { file: loc.file, line: loc.line, col: loc.column, exact: true }, components };
  }

  const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  if (key) {
    const fiber = el[key];
    for (let f = fiber; f && components.length < 6; f = f.return) {
      const n = typeof f.type === 'string' ? null : compName(f.type);
      if (n && !/^(Fragment|Suspense|StrictMode|Provider|Consumer)$/.test(n) && components[0] !== n) components.unshift(n);
    }
    // the element's own JSX, or (inside a library component) where the project uses that component
    for (let f = fiber; f; f = f._debugOwner || f.return) {
      const s = f._debugSource;
      if (s?.fileName && !isLib(s.fileName)) return { hint: { file: s.fileName, line: s.lineNumber, col: s.columnNumber, exact: true }, components };
      const file = projectFrame(f._debugStack?.stack);
      if (file) return { hint: { file, exact: false }, components };
    }
    return { hint: null, components };
  }

  const vue = el.__vueParentComponent;
  if (vue) {
    let file = null;
    for (let c = vue; c && components.length < 6; c = c.parent) {
      const n = c.type?.name || c.type?.__name;
      if (n && components[0] !== n) components.unshift(n);
      if (!file && c.type?.__file && !isLib(c.type.__file)) file = c.type.__file;
    }
    return { hint: file ? { file, exact: false } : null, components };
  }
  return { hint: null, components };
}
