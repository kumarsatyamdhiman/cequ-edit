import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, lstatSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startApp, killStale, ensureCopy, freePort } from '../apps.mjs';
import { ensureRepo } from '../runner.mjs';

const fakeApp = fileURLToPath(new URL('./fake-app.mjs', import.meta.url));
const cmd = `"${process.execPath}" "${fakeApp}" --port {port}`;
const started = [];
const home = () => mkdtempSync(join(tmpdir(), 'cequ-apps-home-'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(async () => { while (started.length) await started.pop().stop(); });

test('startApp runs the command on a free port and waits until it answers', async () => {
  const h = home();
  const app = await startApp({ name: 'live', cwd: h, command: cmd, home: h, env: { ANTHROPIC_API_KEY: 'leak?' } });
  started.push(app);
  const env = await (await fetch(`${app.url}/env`)).json();
  assert.equal(env.port, String(app.port));
  assert.equal(env.browser, 'none');
  assert.ok(env.keys.includes('ANTHROPIC_API_KEY'), 'variables the caller passes on purpose do arrive');
  assert.ok(existsSync(join(h, 'pids', 'live.pid')));
});

test('apps never receive Claude or Anthropic variables from the editor', async () => {
  const h = home();
  process.env.ANTHROPIC_BASE_URL = 'http://desktop-proxy';
  process.env.CLAUDE_CODE_SESSION_ID = 'x';
  try {
    const app = await startApp({ name: 'live', cwd: h, command: cmd, home: h });
    started.push(app);
    const env = await (await fetch(`${app.url}/env`)).json();
    assert.ok(!env.keys.some(k => /^(ANTHROPIC_|CLAUDE)/.test(k)), env.keys.join(','));
  } finally { delete process.env.ANTHROPIC_BASE_URL; delete process.env.CLAUDE_CODE_SESSION_ID; }
});

test('a crash while starting rejects with the log tail', async () => {
  const h = home();
  await assert.rejects(startApp({ name: 'live', cwd: h, command: cmd, home: h, env: { MODE: 'crash' } }),
    e => /stopped while starting/.test(e.message) && /boom: cannot start/.test(e.log));
});

test('an app that never answers times out', async () => {
  const h = home();
  await assert.rejects(startApp({ name: 'live', cwd: h, command: `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`, home: h, readyMs: 800 }), /did not answer/);
});

test('stop kills the whole process group, grandchildren included', async () => {
  const h = home();
  const pidFile = join(h, 'child.pid');
  const app = await startApp({ name: 'live', cwd: h, command: cmd, home: h, env: { MODE: 'child', CHILD_PID_FILE: pidFile } });
  const child = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(child));
  await app.stop();
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!alive(child), 'grandchild stopped');
  assert.ok(!existsSync(join(h, 'pids', 'live.pid')));
});

test('killStale stops apps left behind by a crashed editor', async () => {
  const h = home();
  const app = await startApp({ name: 'live', cwd: h, command: cmd, home: h });
  killStale(h);
  await app.exited;
  assert.ok(!alive(app.pid));
});

test('ensureCopy makes a worktree with cloned ignored files, refreshing files every time', async () => {
  const site = mkdtempSync(join(tmpdir(), 'cequ-apps-site-'));
  writeFileSync(join(site, 'package.json'), '{}');
  writeFileSync(join(site, 'package-lock.json'), '{}');
  mkdirSync(join(site, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(site, 'node_modules', '.bin'));
  writeFileSync(join(site, 'node_modules', 'x', 'index.js'), 'v1');
  const links = process.platform !== 'win32';                      // creating symlinks needs admin rights on Windows
  if (links) symlinkSync('../x/index.js', join(site, 'node_modules', '.bin', 'x'));
  writeFileSync(join(site, '.env'), 'KEY=1');
  await ensureRepo(site, { app: true });
  const h = home();
  const dir = await ensureCopy({ siteDir: site, home: h, name: 'preview' });
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{}');
  assert.equal(readFileSync(join(dir, 'node_modules/x/index.js'), 'utf8'), 'v1');
  if (links) assert.ok(lstatSync(join(dir, 'node_modules/.bin/x')).isSymbolicLink(), 'symlinks inside node_modules kept');
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'KEY=1');
  // a write in the copy never reaches the project
  writeFileSync(join(dir, 'node_modules/x/index.js'), 'changed in copy');
  assert.equal(readFileSync(join(site, 'node_modules/x/index.js'), 'utf8'), 'v1');
  // files are re-copied each time; directories only when a lockfile changed
  writeFileSync(join(site, '.env'), 'KEY=2');
  writeFileSync(join(site, 'node_modules/x/index.js'), 'v2');
  await ensureCopy({ siteDir: site, home: h, name: 'preview' });
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'KEY=2');
  assert.equal(readFileSync(join(dir, 'node_modules/x/index.js'), 'utf8'), 'changed in copy');
  const later = new Date(Date.now() + 5000);
  utimesSync(join(site, 'package-lock.json'), later, later);
  await ensureCopy({ siteDir: site, home: h, name: 'preview' });
  assert.equal(readFileSync(join(dir, 'node_modules/x/index.js'), 'utf8'), 'v2');
  assert.match(execFileSync('git', ['worktree', 'list'], { cwd: site, encoding: 'utf8' }), /preview/);
});

test('freePort gives a usable port', async () => {
  const p = await freePort();
  assert.ok(p > 1024);
});
