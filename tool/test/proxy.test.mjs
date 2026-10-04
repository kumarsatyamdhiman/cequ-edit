import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy, injectAfterHead, wantsDocument, rewriteLocation } from '../proxy.mjs';
import { startApp } from '../apps.mjs';

const fakeApp = new URL('./fake-app.mjs', import.meta.url).pathname;
const TAG = '<script>INJECTED</script>';
let app, server, base, upOn = true;

before(async () => {
  const h = mkdtempSync(join(tmpdir(), 'cequ-proxy-'));
  app = await startApp({ name: 'live', cwd: h, home: h, command: `"${process.execPath}" "${fakeApp}" --port {port}` });
  const proxy = createProxy({
    pick: () => (upOn ? { port: app.port } : null),
    injectHead: () => TAG,
    onDown: (req, res) => { res.writeHead(502); res.end('down'); },
  });
  server = http.createServer(proxy.handle);
  server.on('upgrade', proxy.upgrade);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await app.stop(); });

const doc = path => fetch(base + path, { headers: { 'sec-fetch-dest': 'document', 'accept-encoding': 'gzip, br' }, redirect: 'manual' });

test('pure helpers', () => {
  assert.equal(injectAfterHead('<!doctype html><html><head lang="x"><title>', '<i>'), '<!doctype html><html><head lang="x"><i><title>');
  assert.equal(injectAfterHead('<!doctype html>\n<header>x</header>', '<i>'), '<!doctype html><i>\n<header>x</header>');
  assert.equal(wantsDocument({ headers: { 'sec-fetch-dest': 'empty' }, method: 'GET' }), false);
  assert.equal(wantsDocument({ headers: { accept: 'text/html,*/*' }, method: 'GET' }), true);
  assert.equal(rewriteLocation('http://localhost:5173/x?y', 5173), '/x?y');
  assert.equal(rewriteLocation('https://example.com/x', 5173), 'https://example.com/x');
});

test('page loads get the editor right after <head>', async () => {
  const res = await doc('/');
  const body = await res.text();
  assert.match(body, /<head><script>INJECTED<\/script><title>t<\/title>/);
  assert.equal(res.headers.get('content-length'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'never reused across Before / After');
  assert.equal(res.headers.get('etag'), null);
});

test('page loads never send conditional headers upstream', async () => {
  const headers = await (await fetch(`${base}/headers`, { headers: { 'sec-fetch-dest': 'document', 'if-none-match': 'W/"x"' } })).text();
  assert.doesNotMatch(headers, /if-none-match/);
});

test('a <head> split across chunks and pages without <head> still work', async () => {
  assert.match(await (await doc('/split')).text(), /<head lang="x"><script>INJECTED<\/script><title>s/);
  assert.match(await (await doc('/nohead')).text(), /^<!doctype html><script>INJECTED<\/script>\n<p>bare/);
});

test('fetches, JSON and other responses are never touched', async () => {
  const json = await (await fetch(`${base}/json`, { headers: { 'sec-fetch-dest': 'empty' } })).text();
  assert.equal(json, '{"a":"<head>"}');
  const frag = await (await fetch(`${base}/`, { headers: { 'sec-fetch-dest': 'empty' } })).text();
  assert.doesNotMatch(frag, /INJECTED/);
});

test('compression is not requested, CSP is dropped, app redirects stay on the proxy', async () => {
  const headers = await (await fetch(`${base}/headers`, { headers: { 'accept-encoding': 'gzip' } })).json();
  assert.equal(headers['accept-encoding'], undefined);
  assert.equal(headers.host, new URL(base).host, 'Host kept');
  const csp = await doc('/csp');
  assert.equal(csp.headers.get('content-security-policy'), null);
  assert.match(await csp.text(), /INJECTED/);
  const r = await doc('/redirect');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/landed');
});

test('WebSocket upgrades pass through (hot reload)', async () => {
  const { port } = server.address();
  const echoed = await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
    let got = '';
    s.on('data', d => {
      got += d;
      if (got.includes('101') && !got.includes('ping')) s.write('ping');
      if (got.includes('ping')) { s.end(); resolve(got); }
    });
    s.on('error', reject);
  });
  assert.match(echoed, /101 Switching Protocols[\s\S]*ping/);
});

test('no reachable app → onDown answers', async () => {
  upOn = false;
  try { assert.equal((await doc('/')).status, 502); } finally { upOn = true; }
});
