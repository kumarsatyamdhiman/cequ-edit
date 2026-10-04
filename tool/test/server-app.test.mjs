import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { ensureRepo } from '../runner.mjs';
import { loadConfig } from '../config.mjs';

const fake = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const fakeApp = fileURLToPath(new URL('./fake-app.mjs', import.meta.url));
const PAGE = '<!doctype html>\n<html><head><title>App</title></head><body><h1 class="hero">Welcome back</h1></body></html>\n';
let app, base, site;

async function makeApp(command) {
  const dir = mkdtempSync(join(tmpdir(), 'cequ-app-site-'));
  writeFileSync(join(dir, 'page.html'), PAGE);
  writeFileSync(join(dir, 'package.json'), '{}');
  writeFileSync(join(dir, '.cequ-edit.json'), JSON.stringify({ app: { command } }));
  await ensureRepo(dir, { app: true });
  return dir;
}
const get = (path, { cookie, doc = true } = {}) => fetch(base + path, { redirect: 'manual',
  headers: { ...(doc ? { 'sec-fetch-dest': 'document' } : {}), ...(cookie ? { cookie } : {}) } });
const api = (path, opts = {}) => fetch(`${base}/__cequ/api/${path}`, { ...opts,
  headers: { 'X-CEQU-Token': app.token, Origin: new URL(base).origin, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const until = async (id, status) => {
  for (let i = 0; i < 100; i++) {
    const b = await (await api(`batches/${id}`)).json();
    if (b.status === status) return b;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for ' + status);
};
const cookieOf = res => (res.headers.get('set-cookie') || '').split(';')[0];

before(async () => {
  site = await makeApp(`"${process.execPath}" "${fakeApp}" --port {port}`);
  app = await startServer({ siteDir: site, home: mkdtempSync(join(tmpdir(), 'cequ-home-')), port: 0, claude: [process.execPath, fake],
    timeoutMs: 5000, quiet: true, config: loadConfig(site), readyMs: 10_000 });
  base = app.url;
});
after(() => app.close());

test('app pages come through the proxy with the editor injected', async () => {
  assert.match(base, /^http:\/\/localhost:\d+$/);
  const html = await (await get('/')).text();
  assert.match(html, /<head><script>window\.__CEQU_EDIT=\{"token":"[0-9a-f]{32}","appMode":true,"mode":"live"/);
  assert.match(html, /Welcome back/);
  assert.equal((await get('/__cequ/overlay/main.js', { doc: false })).status, 200);
});

test('view routes need the token and set the cookie', async () => {
  assert.equal((await get('/__cequ/view/live?to=/')).status, 401);
  const r = await get(`/__cequ/view/live?to=/about&token=${app.token}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/about');
  assert.equal(cookieOf(r), 'cequ-view=live');
  assert.equal((await get(`/__cequ/view/live?to=//evil.example&token=${app.token}`)).headers.get('location'), '/');
});

test('a READY batch runs in the preview copy; Before/After switch by cookie; approve goes live', async () => {
  const item = { kind: 'text', screens: 'all', instruction: 'friendlier',
    target: { src: 'page.html:3:1', located: { kind: 'exact' }, route: '/' }, payload: { text: { from: 'Welcome back', to: 'Hello again' } } };
  const { batchId } = await (await api('batches', { method: 'POST', body: JSON.stringify({ items: [item], mode: 'auto', page: '/' }) })).json();
  const b = await until(batchId, 'READY');
  assert.equal(b.previewUrl, `/__cequ/view/${batchId}?to=%2F`);
  const v = await get(`${b.previewUrl}&token=${app.token}`);
  assert.equal(v.status, 302);
  const cookie = cookieOf(v);
  assert.equal(cookie, `cequ-view=${encodeURIComponent(`preview:${batchId}`)}`);
  const after = await (await get('/', { cookie })).text();
  assert.match(after, /Hello again/);
  assert.match(after, /"mode":"preview","batchId":"\d+"/);
  assert.match(await (await get('/', { cookie: `cequ-view=compare:${batchId}` })).text(), /Welcome back[\s\S]*|"compare"/);
  assert.match(await (await get('/')).text(), /Welcome back/, 'live untouched before approve');
  await api(`batches/${batchId}/approve`, { method: 'POST' });
  assert.match(readFileSync(join(site, 'page.html'), 'utf8'), /Hello again/);
  const stale = await get('/', { cookie });
  assert.equal(stale.status, 302, 'a finished preview sends the page back to live');
  assert.equal(cookieOf(stale), 'cequ-view=live');
});

test('a preview that cannot start falls back to Before with the reason', async () => {
  writeFileSync(join(site, 'page.html'), PAGE.replace('Welcome back', 'Second'));
  const item = { kind: 'text', screens: 'all', instruction: 'x',
    target: { src: 'page.html:3:1', located: { kind: 'exact' } }, payload: { text: { from: 'Second', to: 'Third' } } };
  // break the preview copy's start: the copy has no fake-app.mjs relative path issue, so use an env switch instead
  process.env.MODE = 'crash';
  try {
    const { batchId } = await (await api('batches', { method: 'POST', body: JSON.stringify({ items: [item], mode: 'auto', page: '/' }) })).json();
    const b = await until(batchId, 'READY');
    const v = await get(`${b.previewUrl}&token=${app.token}`);
    assert.equal(cookieOf(v), `cequ-view=${encodeURIComponent(`compare:${batchId}`)}`);
    assert.match((await (await api(`batches/${batchId}`)).json()).previewError, /stopped while starting/);
    await api(`batches/${batchId}/reject`, { method: 'POST' });
  } finally { delete process.env.MODE; }
});

test('a crashed app shows the log and a working Restart', async () => {
  const crashSite = await makeApp(`"${process.execPath}" "${fakeApp}" --port {port} --crash`);
  const down = await startServer({ siteDir: crashSite, home: mkdtempSync(join(tmpdir(), 'cequ-home-')), port: 0,
    claude: [process.execPath, fake], quiet: true, config: loadConfig(crashSite), readyMs: 5000 });
  try {
    const r = await fetch(down.url + '/', { headers: { 'sec-fetch-dest': 'document' } });
    assert.equal(r.status, 502);
    const html = await r.text();
    assert.match(html, /isn’t running/);
    assert.match(html, /boom: cannot start/);
    assert.match(html, /Restart/);
    const restart = await fetch(`${down.url}/__cequ/api/app/restart`, { method: 'POST', headers: { 'X-CEQU-Token': down.token, Origin: down.url } });
    assert.equal(restart.status, 502, 'still crashing, reported');
  } finally { await down.close(); }
});
