import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { startServer, cssIndex } from '../server.mjs';
import { ensureRepo } from '../runner.mjs';

const fake = new URL('./fake-claude.mjs', import.meta.url).pathname;
const PAGE = '<!doctype html>\n<html><head><title>t</title></head><body>\n<h1 class="t">Old title</h1>\n<img src="assets/a.jpg" alt="a">\n</body></html>\n';
const CSS = ':root {\n  --accent: oklch(0.62 0.19 45);\n}\n/* note { not a rule } */\n.t { color: var(--accent); }\n@media (max-width: 900px) {\n  .t { color: red; }\n}\n';
let app, base, origin;

function png() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(6, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 6 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 90)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// raw request so we control Host and the exact path
const raw = (path, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: '127.0.0.1', port: u.port, path, headers }, res => {
    let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});
const api = (path, { method = 'GET', body, headers = {} } = {}) => fetch(`${base}/__cequ/api/${path}`, {
  method, body: body && !(body instanceof Buffer) ? JSON.stringify(body) : body,
  headers: { 'X-CEQU-Token': app.token, Origin: origin, ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...headers },
});
const until = async (id, status) => {
  for (let i = 0; i < 80; i++) {
    const b = await (await api(`batches/${id}`)).json();
    if (b.status === status) return b;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for ' + status);
};

before(async () => {
  const site = mkdtempSync(join(tmpdir(), 'cequ-site-'));
  writeFileSync(join(site, 'index.html'), PAGE);
  writeFileSync(join(site, 'site.css'), CSS);
  await ensureRepo(site);
  app = await startServer({ siteDir: site, home: mkdtempSync(join(tmpdir(), 'cequ-home-')), port: 0, claude: [process.execPath, fake], timeoutMs: 5000, quiet: true });
  base = app.url; origin = new URL(base).origin;
});
after(() => app.close());

test('HTML is stamped and gets the overlay; CSS is served untouched', async () => {
  const html = await (await fetch(`${base}/index.html`)).text();
  assert.match(html, /<h1 class="t" data-cequ-src="index.html:3:1">/);
  assert.match(html, /window\.__CEQU_EDIT=\{"token":"[0-9a-f]{32}","mode":"live"/);
  assert.match(html, /<script type="module" src="\/__cequ\/overlay\/main.js"><\/script><\/head>/);
  assert.equal(await (await fetch(`${base}/site.css`)).text(), CSS);
});

test('path traversal, dotfiles and foreign hosts are refused', async () => {
  for (const p of ['/%2e%2e/%2e%2e/etc/hosts', '/..%2f..%2fetc/hosts', '/assets/..%2f..%2f..%2fetc/hosts']) {
    const r = await raw(p);
    assert.notEqual(r.status, 200, p);
    assert.doesNotMatch(r.body, /localhost/, p);
  }
  assert.equal((await raw('/.git/config')).status, 404);
  assert.equal((await raw('/index.html', { Host: 'evil.example:8125' })).status, 421);
});

test('API needs the token, and POSTs need the editor origin', async () => {
  assert.equal((await fetch(`${base}/__cequ/api/batches`)).status, 401);
  assert.equal((await api('batches', { method: 'POST', body: { items: [] }, headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('snippet returns the exact element source; css-index has lines and media', async () => {
  const s = await (await api('snippet?file=index.html&line=3&col=1')).json();
  assert.equal(s.text, '<h1 class="t">Old title</h1>');
  assert.deepEqual(cssIndex(CSS).map(r => [r.selector, r.line, r.media]),
    [[':root', 1, null], ['.t', 5, null], ['.t', 7, '@media (max-width: 900px)']]);
});

test('upload → batch → preview → approve over HTTP', async () => {
  const up = await (await api('upload', { method: 'POST', body: png(), headers: { 'X-Filename': 'x.png' } })).json();
  assert.equal(up.width, 8);
  assert.equal((await fetch(`${base}${up.url}`)).status, 200);
  const items = [{ kind: 'text', screens: 'all', instruction: '', target: { src: 'index.html:3:1', snippet: '<h1 class="t">Old title</h1>', section: { id: 'top' } },
    payload: { text: { from: 'Old title', to: 'New title' }, image: { uploadId: up.uploadId, uploadName: up.uploadName } } }];
  const { batchId } = await (await api('batches', { method: 'POST', body: { items, mode: 'auto' } })).json();
  const b = await until(batchId, 'READY');
  assert.equal(b.items[0].payload.image.file, `uploads/top-${b.n}-1.png`);
  const preview = await (await fetch(`${base}${b.previewUrl}`)).text();
  assert.match(preview, /New title/);
  assert.match(preview, /"mode":"preview","batchId":"1"/);
  assert.match(await (await api(`batches/${batchId}/diff`)).text(), /\+<h1 class="t">New title<\/h1>/);
  assert.match(await (await fetch(`${base}/index.html`)).text(), /Old title/);
  const ok = await (await api(`batches/${batchId}/approve`, { method: 'POST' })).json();
  assert.match(ok.commit, /^[0-9a-f]{40}$/);
  assert.match(await (await fetch(`${base}/index.html`)).text(), /New title/);
  assert.equal((await fetch(`${base}${b.previewUrl}`)).status, 404);
  const hist = await (await api('history')).json();
  assert.match(hist[0].subject, /^Batch #1/);
});

test('the token survives a restart, so open pages keep working', async () => {
  const site = mkdtempSync(join(tmpdir(), 'cequ-site-'));
  writeFileSync(join(site, 'index.html'), PAGE);
  await ensureRepo(site);
  const home = mkdtempSync(join(tmpdir(), 'cequ-home-'));
  const a = await startServer({ siteDir: site, home, port: 0, quiet: true });
  a.close();
  const b = await startServer({ siteDir: site, home, port: 0, quiet: true });
  b.close();
  assert.equal(a.token, b.token);
});

test('sign-in opens Terminal via the injected opener and always returns the command', async () => {
  const site = mkdtempSync(join(tmpdir(), 'cequ-site-'));
  writeFileSync(join(site, 'index.html'), PAGE);
  await ensureRepo(site);
  const home = mkdtempSync(join(tmpdir(), 'cequ-home-'));
  let opened = null;
  const s1 = await startServer({ siteDir: site, home, port: 0, quiet: true, openSignIn: h => { opened = h; } });
  const call = srv => fetch(`${srv.url}/__cequ/api/claude/sign-in`, { method: 'POST', headers: { 'X-CEQU-Token': srv.token, Origin: srv.url } }).then(r => r.json());
  assert.deepEqual(await call(s1), { ok: true, command: 'claude auth login --claudeai' });
  assert.equal(opened, home);
  s1.close();
  const s2 = await startServer({ siteDir: site, home, port: 0, quiet: true, openSignIn: () => { throw new Error('blocked'); } });
  assert.deepEqual(await call(s2), { ok: false, command: 'claude auth login --claudeai' });
  s2.close();
});

test('API calls and failures are logged', async () => {
  await fetch(`${base}/__cequ/api/batches`, { method: 'POST', headers: { Origin: origin } });
  await api('batches');
  const { readFileSync: rf } = await import('node:fs');
  const log = rf(join(app.runner.uploadsDir, '..', 'logs', 'requests.log'), 'utf8');
  assert.match(log, /POST \/__cequ\/api\/batches 401/);
  assert.match(log, /GET \/__cequ\/api\/batches 200/);
});
