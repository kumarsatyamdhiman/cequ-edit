import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createBuilder, serveFolder, outGuard } from '../build.mjs';
import { createRunner, ensureRepo } from '../runner.mjs';
import { loadConfig } from '../config.mjs';

const fake = new URL('./fake-claude.mjs', import.meta.url).pathname;
const fakeBuild = new URL('./fake-build.mjs', import.meta.url).pathname;
let site, home, runner, builder, events;

async function makeSite({ app = true, build = `"${process.execPath}" "${fakeBuild}"`, out = 'dist', extra = {} } = {}) {
  site = mkdtempSync(join(tmpdir(), 'cequ-build-site-'));
  home = mkdtempSync(join(tmpdir(), 'cequ-build-home-'));
  mkdirSync(join(home, 'logs'));
  writeFileSync(join(site, 'page.html'), '<!doctype html><h1>Final</h1>');
  writeFileSync(join(site, 'PRODUCT.md'), 'notes');
  if (app) writeFileSync(join(site, '.cequ-edit.json'), JSON.stringify({ app: { command: 'true', build, out, ...extra } }));
  else writeFileSync(join(site, 'index.html'), '<h1>Static</h1>');
  await ensureRepo(site, { app });
  const config = loadConfig(site);
  runner = createRunner({ siteDir: site, home, claude: [process.execPath, fake], timeoutMs: 5000, config });
  events = [];
  builder = createBuilder({ siteDir: site, home, config, runner, emit: e => events.push(e), limitMs: 3000 });
}
// file names from a zip's central directory
function zipNames(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const names = [];
  for (let at = buf.readUInt32LE(end + 16), n = buf.readUInt16LE(end + 10); n--;) {
    const len = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
    names.push(buf.toString('utf8', at + 46, at + 46 + len));
    at += 46 + len + extra + comment;
  }
  return names;
}
const settled = async () => { for (let i = 0; i < 100 && builder.state().status === 'BUILDING'; i++) await new Promise(r => setTimeout(r, 50)); return builder.state(); };
const zipList = async () => {
  const res = new PassThrough();
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  const chunks = [];
  res.on('data', c => chunks.push(c));
  const done = new Promise(r => res.on('end', r));
  builder.zip(res);
  await done;
  const f = join(home, 'out.zip');
  writeFileSync(f, Buffer.concat(chunks));
  return { names: zipNames(readFileSync(f)), headers: res.headers };
};
beforeEach(() => { delete process.env.FAIL; delete process.env.SLOW; });
afterEach(async () => { await builder?.close(); runner?.close(); });

test('builds in the build copy, copies dist/ into the project, counts files', async () => {
  await makeSite();
  writeFileSync(join(site, 'page.html'), '<!doctype html><h1>Hand edited</h1>');
  assert.equal((await builder.start()).status, 'BUILDING');
  await settled();
  const s = builder.state();
  assert.equal(s.status, 'BUILT', s.error);
  assert.equal(s.files, 3);
  assert.match(readFileSync(join(site, 'dist/index.html'), 'utf8'), /Hand edited/, 'hand edits are in the build');
  assert.match(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: site, encoding: 'utf8' }), /Manual edits before build/);
  assert.equal(readFileSync(join(site, 'dist/built-in.txt'), 'utf8'), realpathSync(join(home, 'build')), 'never built in the project folder');
  assert.ok(events.some(e => e.type === 'build-log' && e.lines.some(l => /vite building/.test(l))));
  // stale output in the build copy is removed before the next build
  writeFileSync(join(home, 'build/dist/old.txt'), 'stale');
  await builder.start(); await settled();
  assert.ok(!existsSync(join(site, 'dist/old.txt')));
  const { names, headers } = await zipList();
  assert.ok(names.includes('assets/app.js'));
  const { execFileSync: run } = await import('node:child_process');
  if (process.platform !== 'win32') assert.match(run('unzip', ['-t', join(home, 'out.zip')], { encoding: 'utf8' }), /No errors detected/, 'a valid zip');
  assert.ok(names.includes('index.html'), 'index.html at the zip root');
  assert.match(headers['Content-Disposition'], /attachment; filename=".+-\d{4}-\d\d-\d\d\.zip"/);
});

test('waiting changes need "Build anyway"', async () => {
  await makeSite();
  const { batchId } = await runner.submit([{ kind: 'general', screens: 'all', instruction: 'ASK first', target: { src: 'page.html:1:1' }, payload: {} }], 'auto');
  for (let i = 0; i < 80 && runner.get(batchId).status !== 'NEEDS_INPUT'; i++) await new Promise(r => setTimeout(r, 50));
  await assert.rejects(builder.start(), e => e.status === 409 && e.waiting === 1);
  await builder.start({ force: true });
  assert.equal((await settled()).status, 'BUILT');
});

test('a failing build keeps the log; Fix with Claude makes a build-fix batch', async () => {
  await makeSite();
  process.env.FAIL = '1';
  await builder.start(); const s = await settled();
  assert.equal(s.status, 'FAILED');
  assert.match(s.error, /exit code 2/);
  assert.match(s.logTail, /error TS2322: boom/);
  const { batchId } = await builder.fix();
  const b = runner.get(batchId);
  assert.equal(b.items[0].kind, 'build-fix');
  assert.match(b.items[0].target.log, /TS2322/);
});

test('a build that runs too long is stopped', async () => {
  await makeSite();
  process.env.SLOW = '1';
  await builder.start();
  for (let i = 0; i < 120 && builder.state().status === 'BUILDING'; i++) await new Promise(r => setTimeout(r, 50));
  assert.match(builder.state().error, /longer than/);
});

test('app.out must be a build folder, never source', async () => {
  await makeSite();
  mkdirSync(join(site, 'src')); writeFileSync(join(site, 'src/a.js'), '1');
  execFileSync('git', ['add', '-A'], { cwd: site }); execFileSync('git', ['commit', '-qm', 'src'], { cwd: site });
  await assert.rejects(outGuard(site, 'src'), /files under version control/);
  await assert.rejects(outGuard(site, '../x'), /files under version control/);
  await assert.rejects(outGuard(site, '.'), /files under version control/);
  await outGuard(site, 'dist');
});

test('missing app.build asks to set it up', async () => {
  await makeSite({ build: '' });
  await assert.rejects(builder.start(), /Ask Claude: set up building/);
});

test('static sites: Download final site zips the approved site without editor files', async () => {
  await makeSite({ app: false });
  const s = await builder.start();
  assert.equal(s.status, 'BUILT');
  const { names } = await zipList();
  assert.ok(names.includes('index.html'));
  assert.ok(!names.includes('PRODUCT.md') && !names.includes('.gitignore'), names.join(','));
});

test('serveFolder: files, .html, folders, single-page fallback, 404 page, no escapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cequ-serve-'));
  mkdirSync(join(dir, 'blog'));
  writeFileSync(join(dir, 'index.html'), 'home');
  writeFileSync(join(dir, 'about.html'), 'about');
  writeFileSync(join(dir, 'blog/index.html'), 'blog');
  writeFileSync(join(dir, '404.html'), 'missing');
  const s = await serveFolder(dir);
  const get = async p => { const r = await fetch(`http://127.0.0.1:${s.port}${p}`); return [r.status, await r.text()]; };
  try {
    assert.deepEqual(await get('/'), [200, 'home']);
    assert.deepEqual(await get('/about'), [200, 'about']);
    assert.deepEqual(await get('/blog/'), [200, 'blog']);
    assert.deepEqual(await get('/dashboard/settings'), [200, 'home']);
    assert.deepEqual(await get('/missing.png'), [404, 'missing']);
    assert.notEqual((await get('/..%2f..%2fetc/hosts'))[1], readFileSync('/etc/hosts', 'utf8'));
  } finally { await s.close(); }
});
