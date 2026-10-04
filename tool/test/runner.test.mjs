import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRunner, ensureRepo } from '../runner.mjs';

const fake = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const PAGE = '<!doctype html>\n<html><body>\n<h1>Old title</h1>\n<p>Keep me</p>\n</body></html>\n';
let site, home, runner;

const git = (...a) => execFileSync('git', a, { cwd: site, encoding: 'utf8' });
// Items carry an instruction so they go to (fake) Claude; instant items are tested separately below.
const item = (to, instruction = 'Use this wording') => ({
  kind: 'text', screens: 'all', instruction,
  target: { src: 'index.html:3:1', snippet: '<h1>Old title</h1>', selector: 'h1' },
  payload: { text: { from: 'Old title', to } },
});
const until = (id, status, ms = 8000) => new Promise((resolve, reject) => {
  const b = runner.get(id);
  if (b?.status === status) return resolve(b);
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${status}, got ${runner.get(id)?.status}`)), ms);
  runner.on('event', function on(e) {
    if (e.batchId === id && e.type === 'status' && e.status === status) { clearTimeout(t); runner.off('event', on); resolve(runner.get(id)); }
  });
});

beforeEach(async () => {
  site = mkdtempSync(join(tmpdir(), 'cequ-site-'));
  home = mkdtempSync(join(tmpdir(), 'cequ-home-'));
  writeFileSync(join(site, 'index.html'), PAGE);
  writeFileSync(join(site, 'site.css'), 'h1 { color: red; }\n');
  await ensureRepo(site);
  runner = createRunner({ siteDir: site, home, claude: [process.execPath, fake], timeoutMs: 5000 });
  delete process.env.FAKE_CLAUDE_MODE;
});
afterEach(() => runner.close());

test('ensureRepo makes a baseline commit and ignores editor files', () => {
  assert.match(git('log', '--format=%s'), /Baseline/);
  assert.match(readFileSync(join(site, '.gitignore'), 'utf8'), /^\.cequ-batch\.json$/m);
});

test('submit → ready → approve changes live and records history', async () => {
  const { batchId } = await runner.submit([item('New title')], 'auto');
  const b = await until(batchId, 'READY');
  assert.equal(b.results[0].status, 'done');
  assert.equal(b.previewUrl, `/__cequ/preview/${batchId}/index.html`);
  assert.equal(readFileSync(join(site, 'index.html'), 'utf8'), PAGE, 'live untouched before approve');
  assert.match(await runner.diff(batchId), /\+<h1>New title<\/h1>/);
  const { commit } = await runner.approve(batchId);
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.match(readFileSync(join(site, 'index.html'), 'utf8'), /New title/);
  assert.match((await runner.history())[0].subject, /^Batch #1: /);
  assert.ok(!existsSync(runner.stageDir(batchId)), 'staging copy removed');
});

test('reject leaves live byte-identical', async () => {
  const { batchId } = await runner.submit([item('Nope')], 'auto');
  await until(batchId, 'READY');
  await runner.reject(batchId);
  assert.equal(runner.get(batchId).status, 'REJECTED');
  assert.equal(readFileSync(join(site, 'index.html'), 'utf8'), PAGE);
  assert.ok(!existsSync(runner.stageDir(batchId)));
});

test('undo restores the previous file exactly', async () => {
  const { batchId } = await runner.submit([item('Temp title')], 'auto');
  await until(batchId, 'READY');
  const { commit } = await runner.approve(batchId);
  await runner.undo(commit);
  assert.equal(readFileSync(join(site, 'index.html'), 'utf8'), PAGE);
});

test('a question pauses the batch; the answer resumes it', async () => {
  const { batchId } = await runner.submit([item('Asked title', 'ASK me first')], 'auto');
  const b = await until(batchId, 'NEEDS_INPUT');
  assert.equal(b.question, 'Which heading do you mean?');
  await runner.answer(batchId, 'The main one');
  const ready = await until(batchId, 'READY');
  assert.equal(ready.results[0].status, 'done');
});

test('chat mode hands off and picks up the result file', async () => {
  const events = [];
  runner.on('event', e => events.push(e));
  const { batchId } = await runner.submit([item('Chat title')], 'chat');
  assert.ok(events.some(e => e.type === 'handoff' && e.command.includes(`apply edit batch ${batchId}`)));
  writeFileSync(join(runner.stageDir(batchId), '.cequ-result.json'), JSON.stringify({ items: [{ id: 1, status: 'done', summary: 'by chat' }] }));
  const b = await until(batchId, 'READY');
  assert.equal(b.results[0].summary, 'by chat');
});

test('uncommitted hand edits on live are committed before staging', async () => {
  writeFileSync(join(site, 'site.css'), 'h1 { color: blue; }\n');
  const { batchId } = await runner.submit([item('X')], 'auto');
  await until(batchId, 'READY');
  assert.match(git('log', '--format=%s'), /Manual edits before batch #1/);
  assert.match(readFileSync(join(runner.stageDir(batchId), 'site.css'), 'utf8'), /blue/);
});

test('missing claude binary fails with a fix', async () => {
  runner.close();
  runner = createRunner({ siteDir: site, home, claude: ['/nonexistent/claude'], timeoutMs: 5000 });
  const { batchId } = await runner.submit([item('Y')], 'auto');
  const b = await until(batchId, 'FAILED');
  assert.match(b.error, /not found/);
  assert.ok(b.fix);
});

test('a run longer than the limit is stopped and can be retried', async () => {
  runner.close();
  runner = createRunner({ siteDir: site, home, claude: [process.execPath, fake], timeoutMs: 400 });
  process.env.FAKE_CLAUDE_MODE = 'sleep';
  const { batchId } = await runner.submit([item('Z')], 'auto');
  const b = await until(batchId, 'FAILED');
  assert.match(b.error, /10 minutes|stopped/);
  delete process.env.FAKE_CLAUDE_MODE;
  await runner.retry(batchId);
  await until(batchId, 'READY');
});

test('a second batch is refused while one is running', async () => {
  process.env.FAKE_CLAUDE_MODE = 'sleep';
  await runner.submit([item('A')], 'auto');
  await assert.rejects(runner.submit([item('B')], 'auto'), e => e.status === 409);
});

test('a failed batch can be handed to the chat', async () => {
  runner.close();
  runner = createRunner({ siteDir: site, home, claude: ['/nonexistent/claude'], timeoutMs: 5000 });
  const events = [];
  runner.on('event', e => events.push(e));
  const { batchId } = await runner.submit([item('Via chat')], 'auto');
  await until(batchId, 'FAILED');
  await runner.toChat(batchId);
  assert.ok(events.some(e => e.type === 'handoff'));
  writeFileSync(join(runner.stageDir(batchId), '.cequ-result.json'), JSON.stringify({ items: [{ id: 1, status: 'done', summary: 'chat' }] }));
  await until(batchId, 'READY');
});

test('the background Claude gets a clean environment and an optional saved token', async () => {
  const { cleanEnv } = await import('../runner.mjs');
  const env = cleanEnv({ PATH: '/usr/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', ANTHROPIC_BASE_URL: 'http://proxy',
    ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1', AI_AGENT: 'y' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH'], 'no API keys, tokens or session variables reach Claude');
  const parts = env.PATH.split(delimiter);
  assert.equal(parts[0], join(homedir(), '.local', 'bin'));
  assert.ok(parts.includes('/usr/bin'));
  const tokenFile = join(home, 'claude-token');
  writeFileSync(tokenFile, 'sk-ant-oat-test\n');
  assert.equal(cleanEnv({ PATH: '/usr/bin' }, tokenFile).CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-test');
  writeFileSync(tokenFile, 'sk-ant-api03-not-a-subscription\n');
  assert.equal(cleanEnv({ PATH: '/usr/bin' }, tokenFile).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'API keys are refused');
});

test('a run never starts unless Claude Code is on a Claude subscription', async () => {
  process.env.FAKE_AUTH_METHOD = 'console';
  const { batchId } = await runner.submit([item('Paid')], 'auto');
  const b = await until(batchId, 'FAILED');
  assert.equal(b.errorCode, 'auth');
  assert.match(b.error, /only on your Claude subscription/);
  assert.equal(b.progress.length, 0, 'nothing was sent to Claude');
  delete process.env.FAKE_AUTH_METHOD;
  await runner.retry(batchId);
  await until(batchId, 'READY');
});

test('an expired login fails with a sign-in fix and retries from the start', async () => {
  process.env.FAKE_CLAUDE_MODE = 'expired';
  const { batchId } = await runner.submit([item('Later')], 'auto');
  const b = await until(batchId, 'FAILED');
  assert.equal(b.errorCode, 'auth');
  assert.match(b.fix, /Sign in/);
  delete process.env.FAKE_CLAUDE_MODE;
  await runner.retry(batchId);
  await until(batchId, 'READY');
});

test('batch numbers continue after numbers already in the git history', async () => {
  writeFileSync(join(site, 'site.css'), 'h1 { color: green; }\n');
  execFileSync('git', ['commit', '-qam', 'Batch #41: earlier change'], { cwd: site });
  runner.close();
  runner = createRunner({ siteDir: site, home: mkdtempSync(join(tmpdir(), 'cequ-home-')), claude: [process.execPath, fake], timeoutMs: 5000 });
  const { batchId } = await runner.submit([item('Numbered')], 'auto');
  assert.equal(batchId, '42');
  await until(batchId, 'READY');
});

test('instant-only batch: applied by CEQU-Edit, ready without Claude', async () => {
  runner.close();
  runner = createRunner({ siteDir: site, home, claude: ['/nonexistent/claude'], timeoutMs: 5000 });
  const { batchId } = await runner.submit([item('Instant title', '')], 'auto');
  const b = await until(batchId, 'READY');
  assert.equal(b.results[0].by, 'cequ');
  assert.match(b.progress.join(' '), /⚡ 1\. Text changed to "Instant title"/);
  assert.equal(readFileSync(join(site, 'index.html'), 'utf8'), PAGE, 'live untouched until approve');
  await runner.approve(batchId);
  assert.match(readFileSync(join(site, 'index.html'), 'utf8'), /<h1>Instant title<\/h1>/);
});

test('mixed batch: instant part by CEQU-Edit, the rest by Claude, results merged', async () => {
  const claudeItem = { kind: 'text', screens: 'all', instruction: 'friendlier please',
    target: { src: 'index.html:4:1', snippet: '<p>Keep me</p>', selector: 'p' }, payload: { text: { from: 'Keep me', to: 'Kept, kindly' } } };
  const { batchId } = await runner.submit([item('Mixed title', ''), claudeItem], 'auto');
  const b = await until(batchId, 'READY');
  assert.deepEqual(b.results.map(r => [r.id, r.status, r.by || 'claude']), [[1, 'done', 'cequ'], [2, 'done', 'claude']]);
  const batchFile = JSON.parse(readFileSync(join(runner.stageDir(batchId), '.cequ-batch.json'), 'utf8'));
  assert.deepEqual(batchFile.items.map(i => i.id), [2], 'Claude only sees its own item');
  assert.match(await runner.diff(batchId), /\+<h1>Mixed title<\/h1>[\s\S]*\+<p>Kept, kindly<\/p>/);
});

// ---------- any-stack git fixes (spec §10.1, §10.2, §14) ----------

test('batches start from the checked-out branch, not a fixed "main"', async () => {
  git('branch', '-m', 'master');
  git('checkout', '-q', '-b', 'feature');
  const { batchId } = await runner.submit([item('On feature')], 'auto');
  await until(batchId, 'READY');
  await runner.approve(batchId);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature');
  assert.match(git('log', '-1', '--format=%s'), /^Batch #1: /);
  assert.doesNotMatch(git('log', 'master', '--format=%s'), /Batch #1/);
});

test('a detached HEAD or a git operation in progress stops the batch', async () => {
  git('checkout', '-q', '--detach');
  await assert.rejects(runner.submit([item('Detached')], 'auto'), /Finish or abort the git operation/);
});

test('a READY batch is one commit, even after a revise', async () => {
  const { batchId } = await runner.submit([item('First')], 'auto');
  const b = await until(batchId, 'READY');
  assert.match(b.head, /^[0-9a-f]{40}$/);
  await runner.revise(batchId, [{ ...item('Second'), payload: { text: { from: 'First', to: 'Second' } } }]);
  const again = await until(batchId, 'READY');
  const count = execFileSync('git', ['rev-list', '--count', `${again.base}..cequ/batch-${batchId}`], { cwd: site, encoding: 'utf8' }).trim();
  assert.equal(count, '1');
  assert.match(await runner.diff(batchId), /\+<h1>Second<\/h1>/);
});

test('a build-fix item needs no element source', async () => {
  const { batchId } = await runner.submit([{ kind: 'build-fix', instruction: 'The production build fails.', target: { log: 'Error: x' }, payload: {} }], 'auto');
  await until(batchId, 'READY');
});

test('fresh app repo ignores dependencies and secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cequ-app-'));
  mkdirSync(join(dir, 'node_modules/x'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/x/index.js'), '');
  writeFileSync(join(dir, '.env'), 'KEY=secret\n');
  writeFileSync(join(dir, 'package.json'), '{}\n');
  await ensureRepo(dir, { app: true });
  const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
  assert.match(tracked, /package\.json/);
  assert.doesNotMatch(tracked, /node_modules|\.env\n/);
});

test('a fresh repo that would be too big is refused before committing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cequ-big-'));
  for (let i = 0; i < 8; i++) writeFileSync(join(dir, `f${i}.txt`), 'x');
  await assert.rejects(ensureRepo(dir, { maxFiles: 5 }), /This folder has \d+ files/);
  assert.ok(!existsSync(join(dir, '.git')), 'no half-made repository is left behind');
});

test('a site folder inside another repository is refused', async () => {
  const sub = join(site, 'sub');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'index.html'), '<p>x</p>');
  await assert.rejects(ensureRepo(sub), /Point CEQU-Edit at/);
});
