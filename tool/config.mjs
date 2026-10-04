// Per-site settings. Everything is detected; an optional .cequ-edit.json in the site folder overrides it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

export const CONFIG_FILE = '.cequ-edit.json';
const SKIP = new Set(['node_modules', '.git']);
const GUIDANCE = ['PRODUCT.md', 'DESIGN.md', 'CLAUDE.md', 'AGENTS.md', '.impeccable.md'];

// Relative paths of files with the given extensions (dot-folders and node_modules skipped).
export function listFiles(dir, exts, max = 500, rel = '') {
  const out = [];
  let entries = [];
  try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= max) break;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) out.push(...listFiles(dir, exts, max - out.length, p)); }
    else if (exts.some(x => e.name.toLowerCase().endsWith(x))) out.push(p);
  }
  return out;
}

// index.html if there is one, else the first top-level page, else the first page anywhere.
export function detectPage(htmlFiles) {
  if (htmlFiles.includes('index.html')) return 'index.html';
  return htmlFiles.find(f => !f.includes('/')) || htmlFiles[0] || null;
}

// The site's own phone/desktop split: the most used `max-width` in its media queries (ties → nearest 800px).
export function detectBreakpoint(texts) {
  const counts = new Map();
  for (const t of texts) {
    for (const m of t.matchAll(/@media[^{]*?max-width\s*:\s*(\d+(?:\.\d+)?)px/g)) {
      const n = Math.round(Number(m[1]));
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1] || Math.abs(a[0] - 800) - Math.abs(b[0] - 800))[0];
  const n = best ? best[0] : 768;
  return { phone: `(max-width: ${n}px)`, desktop: `(min-width: ${n + 1}px)` };
}

export function detectUploadsDir(siteDir) {
  for (const d of ['assets/img', 'assets/images', 'images', 'img', 'assets']) if (existsSync(join(siteDir, d))) return `${d}/uploads`;
  return 'uploads';
}

// Class names written in the page source; anything else on an element was added by a script at runtime.
export function sourceClasses(html) {
  const set = new Set();
  for (const m of html.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    for (const c of (m[1] ?? m[2]).split(/\s+/)) if (c) set.add(c);
  }
  return [...set];
}

// No .html pages but a project manifest: an app that needs an `app` block (spec §5).
const APP_MARKERS = ['package.json', 'manage.py', 'pyproject.toml', 'requirements.txt', 'Gemfile', 'composer.json', 'go.mod'];
export function looksLikeApp(siteDir) {
  if (listFiles(siteDir, ['.html', '.htm'], 1).length) return false;
  if (APP_MARKERS.some(f => existsSync(join(siteDir, f)))) return true;
  try { return readdirSync(siteDir).some(f => f.endsWith('.csproj')); } catch { return false; }
}

function appBlock(user) {
  if (!user.app || typeof user.app !== 'object') return null;
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const app = { command: str(user.app.command), url: str(user.app.url), build: str(user.app.build), out: str(user.app.out), start: str(user.app.start) };
  if (!app.command && !app.url) throw new Error(`${CONFIG_FILE}: "app" needs a "command" (or the "url" of an app you already run).`);
  return app;
}

export function loadConfig(siteDir) {
  let user = {};
  const file = join(siteDir, CONFIG_FILE);
  if (existsSync(file)) {
    try { user = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`); }
  }
  const app = appBlock(user);
  const htmls = app ? [] : listFiles(siteDir, ['.html', '.htm']);
  const texts = [...listFiles(siteDir, ['.css']), ...htmls].slice(0, 200).map(f => {
    try { return readFileSync(join(siteDir, f), 'utf8'); } catch { return ''; }
  });
  const publicDir = ['public', 'static'].find(d => existsSync(join(siteDir, d)));
  return {
    app,
    appMode: Boolean(app),
    page: user.page || (app ? '/' : detectPage(htmls)),
    pages: htmls,
    breakpoints: user.breakpoints || detectBreakpoint(texts),
    uploadsDir: user.uploadsDir || (app && publicDir ? `${publicDir}/uploads` : detectUploadsDir(siteDir)),
    editModeCss: user.editModeCss || '',
    tokenLabels: user.tokenLabels || {},
    rules: [].concat(user.rules || []),
    guidance: GUIDANCE.filter(f => existsSync(join(siteDir, f))),
  };
}

// Runtime data for one site lives in ~/.cequ-edit/sites/<name>-<hash>, so several sites never mix.
export function siteHome(siteDir) {
  const hash = createHash('sha1').update(siteDir).digest('hex').slice(0, 8);
  const name = basename(siteDir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';
  return join(homedir(), '.cequ-edit', 'sites', `${name}-${hash}`);
}
