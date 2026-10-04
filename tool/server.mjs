#!/usr/bin/env node
// CEQU-Edit server. Static mode: serves the site's files with source stamps + the editor overlay.
// App mode: runs the project's own dev server behind a proxy that adds the editor (spec §5–§7).
// Runs change batches through Claude Code. Local only (127.0.0.1).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, watch, readFileSync, writeFileSync, mkdirSync, chmodSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve, extname, sep, dirname, basename } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stamp, elementSource } from './stamp.mjs';
import { processUpload, MAX_BYTES } from './images.mjs';
import { createRunner, ensureRepo, git } from './runner.mjs';
import { loadConfig, siteHome, sourceClasses, looksLikeApp } from './config.mjs';
import { startApp, killStale, ensureCopy, answers, tail } from './apps.mjs';
import { createProxy, wantsDocument } from './proxy.mjs';
import { createLocator } from './locate.mjs';
import { createBuilder, MIME } from './build.mjs';
import { cssIndex } from './css.mjs';
import { openTerminal, openPath } from './platform.mjs';

export const SIGN_IN_COMMAND = 'claude auth login --claudeai';

// Opens Claude Code's subscription sign-in in a new terminal window; the owner approves it in the browser.
const openClaudeSignIn = home => openTerminal(SIGN_IN_COMMAND, home);

const HERE = dirname(fileURLToPath(import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });

export { cssIndex } from './css.mjs';

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > limit) { reject(fail(413, 'The upload is larger than 25 MB.')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
const text = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

const VIEW_COOKIE = 'cequ-view';
const viewCookie = req => {
  const m = new RegExp(`(?:^|;\\s*)${VIEW_COOKIE}=([^;]*)`).exec(req.headers.cookie || '');
  const [kind, id = null] = decodeURIComponent(m?.[1] || 'live').split(':');
  return { kind: ['compare', 'preview', 'built'].includes(kind) ? kind : 'live', id };
};
const setView = value => `${VIEW_COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
const safeRoute = to => (typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') && to.length < 2000 ? to : '/');
const escHTML = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startServer({ siteDir, home, port = 8125, claude = ['claude'], timeoutMs, quiet = false, openSignIn = openClaudeSignIn, config, readyMs = 120_000 }) {
  siteDir = resolve(siteDir);
  home ||= siteHome(siteDir);
  config ||= loadConfig(siteDir);
  const appMode = Boolean(config.appMode);
  if (!appMode && !config.page) throw new Error(`No .html page found in ${siteDir}.`);
  // One token per editor home, kept across restarts so open pages keep working (file is owner-only).
  mkdirSync(home, { recursive: true });
  const tokenFile = join(home, 'token');
  let token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  if (!/^[0-9a-f]{32}$/.test(token)) { token = randomBytes(16).toString('hex'); writeFileSync(tokenFile, token, { mode: 0o600 }); }
  const runner = createRunner({ siteDir, home, claude, timeoutMs, promptFile: join(HERE, 'PROMPT.md'), config });
  const locator = createLocator({ siteDir, home, stageDir: runner.stageDir });
  const clients = new Set();
  const broadcast = e => { const s = `data: ${JSON.stringify(e)}\n\n`; for (const c of clients) c.write(s); };
  runner.on('event', broadcast);
  const builder = createBuilder({ siteDir, home, config, runner, emit: broadcast, readyMs });

  let actualPort = port;
  const hosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  const origins = () => new Set([...hosts()].map(h => `http://${h}`));

  const headTag = cfg => `<script>window.__CEQU_EDIT=${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script>`
    + `<script type="module" src="/__cequ/overlay/main.js"></script>`;
  const inject = (html, cfg) => (html.includes('</head>') ? html.replace('</head>', `${headTag(cfg)}</head>`) : headTag(cfg) + html);

  // ---------- app mode: live app, preview copy, proxy ----------
  let live = null, liveError = null, liveStarting = null;
  const livePort = () => (config.app?.url ? Number(new URL(config.app.url).port || 80) : live?.running ? live.port : null);
  function startLive() {
    if (!appMode || config.app.url) return Promise.resolve();
    liveError = null;
    liveStarting = startApp({ name: 'live', cwd: siteDir, command: config.app.command, home, readyMs })
      .then(a => { live = a; }, e => { liveError = e; live = null; })
      .finally(() => { liveStarting = null; });
    return liveStarting;
  }

  let preview = null, previewLock = Promise.resolve();
  const stopPreview = async () => { const p = preview; preview = null; await p?.app.stop(); };
  // Show batch `b` in the preview copy: check out its READY commit and (re)start the app there (spec §10.3).
  const showPreview = b => (previewLock = previewLock.catch(() => {}).then(async () => {
    if (!config.app.command) throw new Error('There is no app.command, so CEQU-Edit cannot run a preview copy.');
    if (preview?.head === b.head && preview.app.running) return;
    await stopPreview();
    const dir = await ensureCopy({ siteDir, home, name: 'preview' });
    await git(dir, 'checkout', '-q', '--detach', '--force', b.head);
    const app = await startApp({ name: 'preview', cwd: dir, command: config.app.command, home, readyMs });
    preview = { app, batchId: b.id, head: b.head };
  }));

  // Which app a request goes to, from the cequ-view cookie (spec §7).
  function route(req) {
    const v = viewCookie(req);
    if (v.kind === 'preview') {
      const b = runner.get(v.id);
      if (b?.status === 'READY' && preview?.batchId === v.id && preview.head === b.head && preview.app.running) return { port: preview.app.port, mode: 'preview', v };
      return { port: livePort(), mode: 'live', v, stale: true };
    }
    if (v.kind === 'built') {
      const port = builtPort();
      return port ? { port, mode: 'built', v } : { port: livePort(), mode: 'live', v, stale: true };
    }
    return { port: livePort(), mode: 'live', v };
  }
  const builtPort = () => builder.builtPort();

  const appCfg = r => {
    const compare = r.v.kind === 'compare' ? r.v.id : null;
    const batchId = r.mode === 'preview' ? r.v.id : compare;
    return {
      token, appMode: true, mode: r.mode, batchId, compare, previewError: batchId ? runner.get(batchId)?.previewError ?? null : null,
      page: config.page, breakpoints: config.breakpoints, editModeCss: config.editModeCss, tokenLabels: config.tokenLabels,
    };
  };

  function appDown(req, res) {
    if (!wantsDocument(req)) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('The app is not running.'); }
    const starting = Boolean(liveStarting);
    const log = liveError?.log || (live ? tail(live.logFile, 30) : '') || tail(join(home, 'logs', 'app-live.log'), 30);
    res.writeHead(starting ? 503 : 502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${starting ? 'Starting' : 'App stopped'} · CEQU-Edit</title>
${starting ? '<meta http-equiv="refresh" content="2">' : ''}<meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:52rem;margin:3rem auto;padding:0 1rem;background:Canvas;color:CanvasText}
pre{background:color-mix(in oklch,CanvasText 7%,Canvas);padding:1rem;border-radius:8px;overflow:auto;font-size:12.5px}button{font:inherit;padding:.5rem 1rem;border-radius:8px;cursor:pointer}</style></head><body>
<h1>${starting ? 'Starting your app…' : 'Your app isn’t running'}</h1>
${starting ? '<p>This page refreshes by itself.</p>' : `<p>${escHTML(liveError?.message || 'The dev server stopped.')}</p>
${log ? `<pre>${escHTML(log)}</pre>` : ''}<p><small>Full log: ${escHTML(join(home, 'logs', 'app-live.log'))}</small></p>
<button id="r">Restart</button><script>
document.getElementById('r').onclick = async e => { e.target.disabled = true; e.target.textContent = 'Restarting…';
  const r = await fetch('/__cequ/api/app/restart', { method: 'POST', headers: { 'X-CEQU-Token': ${JSON.stringify(token)} } });
  if (r.ok) location.reload(); else { e.target.disabled = false; e.target.textContent = 'Restart'; alert((await r.json()).error); } };
</script>`}</body></html>`);
  }

  const proxy = appMode && createProxy({
    pick: req => { const { port } = route(req); return port ? { port } : null; },
    injectHead: req => headTag(appCfg(route(req))),
    onDown: appDown,
  });
  function appRequest(req, res) {
    const r = route(req);
    if (r.stale && wantsDocument(req)) {                    // that preview / build is gone: back to the live app
      res.writeHead(302, { 'Set-Cookie': setView('live'), Location: req.url, 'Cache-Control': 'no-store' });
      return res.end();
    }
    proxy.handle(req, res);
  }

  async function viewRoute(req, res, url, what) {
    if (url.searchParams.get('token') !== token) return text(res, 401, 'Missing or wrong editor token. Reload the page.');
    const to = safeRoute(url.searchParams.get('to'));
    const go = value => { res.writeHead(302, { 'Set-Cookie': setView(value), Location: to, 'Cache-Control': 'no-store' }); res.end(); };
    if (what === 'live') {
      const compare = url.searchParams.get('compare');
      await stopBuilt?.();                                   // a production server for the Built view is no longer needed
      return go(compare && runner.get(compare) ? `compare:${compare}` : 'live');
    }
    if (what === 'built') {
      try { await builder.showBuilt(); return go('built'); } catch (e) { return text(res, e.status || 500, e.message); }
    }
    const b = runner.get(what);
    if (!b) return text(res, 404, 'No such batch.');
    if (b.status !== 'READY' || !b.head) return go('live');
    try {
      await showPreview(b);
      runner.setPreviewError(b.id, null);
      return go(`preview:${b.id}`);
    } catch (e) {
      runner.setPreviewError(b.id, `${e.message}${e.logFile ? ` (log: ${e.logFile})` : ''}`);
      return go(`compare:${b.id}`);
    }
  }
  const stopBuilt = () => builder.stopBuilt();

  // Resolve a request path inside root; refuse escapes and dotfiles (.git, .cequ-*).
  function safePath(root, rel) {
    const full = resolve(root, '.' + sep + rel);
    if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) throw fail(403, 'Outside the site folder.');
    if (rel.split(/[\\/]/).some(seg => seg.startsWith('.'))) throw fail(404, 'Not found.');
    return full;
  }

  async function serveFile(res, root, rel, cfg) {
    const full = safePath(root, rel || config.page);
    let info;
    try { info = await stat(full); } catch { throw fail(404, 'Not found.'); }
    if (!info.isFile()) throw fail(404, 'Not found.');
    const ext = extname(full).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html' && cfg) {
      const html = await readFile(full, 'utf8');
      const page = rel || config.page;
      const fileHash = createHash('sha1').update(html).digest('hex').slice(0, 12);
      return text(res, 200, inject(stamp(html, page), {
        token, mode: cfg.mode, batchId: cfg.batchId ?? null, page, fileHash,
        breakpoints: config.breakpoints, editModeCss: config.editModeCss, tokenLabels: config.tokenLabels,
        sourceClasses: sourceClasses(html),
      }), type);
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': info.size });
    res.end(await readFile(full));
  }

  async function apiRoute(req, res, url, route) {
    const given = req.headers['x-cequ-token'] || (route === 'events' ? url.searchParams.get('token') : null);
    if (given !== token) return json(res, 401, { error: 'Missing or wrong editor token. Open the page from the editor server again.' });
    if (req.method !== 'GET' && !origins().has(req.headers.origin)) return json(res, 403, { error: 'Requests must come from the editor page.' });
    const body = async () => {
      const buf = await readBody(req, 1024 * 1024);
      try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { throw fail(400, 'Body is not JSON.'); }
    };
    const m = /^batches\/(\d+)(?:\/(\w+))?$/.exec(route);
    const h = /^history\/([0-9a-f]{7,40})\/undo$/.exec(route);

    if (route === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (route === 'snippet' && req.method === 'GET') {
      const batch = url.searchParams.get('batch');
      const root = batch ? runner.stageDir(batch) : siteDir;
      const html = await readFile(safePath(root, url.searchParams.get('file') || config.page), 'utf8');
      const el = elementSource(html, Number(url.searchParams.get('line')), Number(url.searchParams.get('col')));
      return el ? json(res, 200, { text: el.text }) : json(res, 404, { error: 'No element starts at that position.' });
    }
    if (route === 'css-index' && req.method === 'GET') {
      const batch = url.searchParams.get('batch');
      const css = await readFile(safePath(batch ? runner.stageDir(batch) : siteDir, url.searchParams.get('file') || ''), 'utf8');
      return json(res, 200, cssIndex(css));
    }
    if (route === 'upload' && req.method === 'POST') {
      const buf = await readBody(req, MAX_BYTES + 1);
      const name = decodeURIComponent(String(req.headers['x-filename'] || 'photo'));
      const r = await processUpload(buf, name, runner.uploadsDir);
      return json(res, 200, { uploadId: r.uploadId, uploadName: r.name, url: `/__cequ/upload/${r.name}`, width: r.width, height: r.height });
    }
    if (route === 'batches' && req.method === 'GET') return json(res, 200, runner.list());
    if (route === 'batches' && req.method === 'POST') {
      const { items, mode, page } = await body();
      const where = appMode ? safeRoute(page) : config.pages.includes(page) ? page : config.page;
      return json(res, 202, await runner.submit(items, mode, where));
    }
    if (m && req.method === 'GET' && !m[2]) {
      const b = runner.get(m[1]);
      return b ? json(res, 200, b) : json(res, 404, { error: 'No such batch.' });
    }
    if (m && req.method === 'GET' && m[2] === 'diff') return text(res, 200, await runner.diff(m[1]));
    if (m && req.method === 'POST') {
      const [id, action] = [m[1], m[2]];
      if (action === 'answer') return json(res, 200, await runner.answer(id, (await body()).text || ''));
      if (action === 'revise') return json(res, 200, await runner.revise(id, (await body()).items));
      if (action === 'retry') return json(res, 200, await runner.retry(id));
      if (action === 'chat') return json(res, 200, await runner.toChat(id));
      if (action === 'approve') return json(res, 200, await runner.approve(id));
      if (action === 'reject') return json(res, 200, await runner.reject(id));
    }
    if (route === 'claude/sign-in' && req.method === 'POST') {
      try { await openSignIn(home); return json(res, 200, { ok: true, command: SIGN_IN_COMMAND }); }
      catch { return json(res, 200, { ok: false, command: SIGN_IN_COMMAND }); }
    }
    if (route === 'locate' && req.method === 'POST') return json(res, 200, await locator.locate(await body()));
    if (route === 'build' && req.method === 'GET') return json(res, 200, builder.state());
    if (route === 'build' && req.method === 'POST') {
      try { return json(res, 202, await builder.start(await body())); }
      catch (e) { if (e.waiting) return json(res, 409, { error: e.message, waiting: e.waiting }); throw e; }
    }
    if (route === 'build/fix' && req.method === 'POST') return json(res, 202, await builder.fix());
    if (route === 'build/reveal' && req.method === 'POST') { await builder.reveal(); return json(res, 200, { ok: true }); }
    if (route === 'app/restart' && req.method === 'POST') {
      if (!appMode || config.app.url) return json(res, 400, { error: 'CEQU-Edit did not start this app, so it cannot restart it.' });
      await live?.stop();
      live = null;
      await startLive();
      return liveError ? json(res, 502, { error: liveError.message, log: liveError.log }) : json(res, 200, { ok: true });
    }
    if (route === 'history' && req.method === 'GET') return json(res, 200, await runner.history());
    if (h && req.method === 'POST') return json(res, 200, await runner.undo(h[1]));
    return json(res, 404, { error: 'Unknown editor API route.' });
  }

  // Small request log (API calls and anything that failed) for troubleshooting: <home>/logs/requests.log
  const reqLog = join(home, 'logs', 'requests.log');
  mkdirSync(join(home, 'logs'), { recursive: true });
  function logRequest(req, res, t0) {
    const path = (req.url || '').split('?')[0];
    if (path === '/__cequ/api/events' || (res.statusCode < 400 && !path.startsWith('/__cequ/api/'))) return;
    try { appendFileSync(reqLog, `${new Date().toISOString()} ${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms\n`); } catch { /* logging is best effort */ }
  }

  async function handle(req, res) {
    const t0 = Date.now();
    res.on('finish', () => logRequest(req, res, t0));
    if (!hosts().has(req.headers.host)) return text(res, 421, 'This editor only answers on 127.0.0.1.');
    const url = new URL(req.url, `http://${req.headers.host}`);
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return text(res, 400, 'Bad path.'); }
    try {
      if (path.startsWith('/__cequ/api/')) return await apiRoute(req, res, url, path.slice('/__cequ/api/'.length));
      if (path.startsWith('/__cequ/overlay/')) return await serveFile(res, join(HERE, 'overlay'), path.slice('/__cequ/overlay/'.length));
      if (path.startsWith('/__cequ/upload/')) return await serveFile(res, runner.uploadsDir, basename(path));
      if (path === '/__cequ/build/site.zip') {
        if (url.searchParams.get('token') !== token) return text(res, 401, 'Missing or wrong editor token. Reload the page.');
        return builder.zip(res);
      }
      if (appMode) {
        if (path.startsWith('/__cequ/view/')) return await viewRoute(req, res, url, path.slice('/__cequ/view/'.length));
        if (path.startsWith('/__cequ/')) return text(res, 404, 'Not found.');
        return appRequest(req, res);
      }
      const pv = /^\/__cequ\/preview\/(\d+)\/(.*)$/.exec(path);
      if (pv) {
        if (!existsSync(runner.stageDir(pv[1]))) return text(res, 404, 'This preview is gone (the batch was approved or rejected).');
        return await serveFile(res, runner.stageDir(pv[1]), pv[2], { mode: 'preview', batchId: pv[1] });
      }
      if (path === '/') { res.writeHead(302, { Location: `/${config.page}` }); return res.end(); }
      return await serveFile(res, siteDir, path.slice(1), { mode: 'live' });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500 && !quiet) console.error(e);
      if (res.headersSent) return res.end();
      return path.startsWith('/__cequ/api/') ? json(res, status, { error: e.message, fix: e.fix }) : text(res, status, e.message);
    }
  }

  // Several sites can run at once: if the port is taken, try the next ones.
  const server = http.createServer(handle);
  for (let p = port, tries = 0; ; p++, tries++) {
    try {
      await new Promise((ok, bad) => { server.once('error', bad); server.listen(p, '127.0.0.1', () => { server.off('error', bad); ok(); }); });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || port === 0 || tries >= 20) throw e;
    }
  }
  actualPort = server.address().port;

  let timer, watcher = null;
  if (appMode) {
    server.on('upgrade', (req, socket, head) => {
      if (!hosts().has(req.headers.host) || req.url.startsWith('/__cequ/')) return socket.destroy();
      proxy.upgrade(req, socket, head);
    });
    // Approve / undo change files on disk; once the app answers again, open pages reload (spec §10.4).
    runner.on('event', async e => {
      if (e.type === 'approved' || e.type === 'undone') {
        for (let i = 0; i < 20 && livePort() && !(await answers(livePort())); i++) await new Promise(r => setTimeout(r, 500));
        broadcast({ batchId: null, type: 'reload', scope: 'live' });
      }
      if (e.type === 'status' && preview && !runner.list().some(b => b.status === 'READY')) previewLock = previewLock.then(stopPreview, stopPreview);
    });
  } else {
    // live files changed (approve, undo, hand edits): tell open pages to reload
    watcher = watch(siteDir, { recursive: true }, (_, file) => {
      if (!file || file.split(sep).some(s => s.startsWith('.'))) return;
      clearTimeout(timer);
      timer = setTimeout(() => broadcast({ batchId: null, type: 'reload', scope: 'live', file }), 250);
    });
  }
  const ping = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000);

  if (appMode) { killStale(home); await startLive(); }
  const url = `http://${appMode ? 'localhost' : '127.0.0.1'}:${actualPort}`;
  return {
    url, token, runner, server,
    get liveError() { return liveError; },
    async close() {
      clearInterval(ping); clearTimeout(timer); watcher?.close(); runner.close();
      for (const c of clients) c.end();
      server.close();
      await Promise.all([live?.stop(), stopPreview(), builder.close()]);
    },
  };
}

// CLI: node server.mjs [--site <folder, default: current folder>] [--page index.html] [--port 8125] [--open]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
  const siteDir = resolve(arg('site', process.cwd()));
  let config;
  try { config = loadConfig(siteDir); } catch (e) { console.error(e.message); process.exit(1); }
  if (arg('page')) config.page = arg('page');
  if (!config.appMode && (!config.page || !existsSync(join(siteDir, config.page)))) {
    console.error(looksLikeApp(siteDir)
      ? 'This looks like an app project. Ask Claude: set up CEQU-Edit for this project.'
      : `No HTML page found in ${siteDir}. Use --site <folder> (and --page <file.html> if needed).`);
    process.exit(1);
  }
  // One editor per site: a second one would fight over the same state, copies and apps.
  const home = siteHome(siteDir);
  mkdirSync(home, { recursive: true });
  const running = join(home, 'server.json');
  try {
    const other = JSON.parse(readFileSync(running, 'utf8'));
    process.kill(other.pid, 0);
    console.log(`\n  CEQU-Edit is already running for this site → ${other.start}\n  (stop it with Ctrl+C in its Terminal window first to start a new one)\n`);
    if (process.argv.includes('--open')) await openPath(other.start).catch(() => {});
    process.exit(0);
  } catch { /* not running */ }
  try { await ensureRepo(siteDir, { app: config.appMode }); }
  catch (e) { console.error(e.message); process.exit(1); }
  const app = await startServer({ siteDir, home, port: Number(arg('port', 8125)), config });
  const start = config.appMode ? `${app.url}${config.page}` : `${app.url}/${config.page}`;
  writeFileSync(join(home, 'site.json'), JSON.stringify({ site: siteDir }));
  writeFileSync(running, JSON.stringify({ pid: process.pid, start }));
  process.on('exit', () => { try { rmSync(running); } catch { /* gone */ } });
  if (process.argv.includes('--open')) openPath(start).catch(() => console.log(`  Open ${start} in your browser.`));
  console.log(`\n  CEQU-Edit ready → ${start}\n  ${config.appMode ? 'project' : 'site'}: ${siteDir}\n  phone/desktop split: ${config.breakpoints.phone}\n  Press E on the page to start selecting.\n`);
  if (app.liveError) console.log(`  ⚠ The app did not start: ${app.liveError.message}\n${app.liveError.log}\n`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
}
