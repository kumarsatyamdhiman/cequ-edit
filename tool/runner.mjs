// Batch lifecycle: staging worktree → Claude (headless or chat hand-off) → preview → approve / reject / undo.
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, createWriteStream, statSync } from 'node:fs';
import { readFile, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { join, basename, relative, isAbsolute, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { applyDirect } from './direct.mjs';

const exec = promisify(execFile);
export const BATCH_FILE = '.cequ-batch.json';
export const RESULT_FILE = '.cequ-result.json';
const MAIN = 'main';
const KINDS = new Set(['general', 'image', 'color', 'text', 'remove', 'layout', 'build-fix']);
const ACTIVE = new Set(['STAGING', 'RUNNING']);
// Windows: `claude` may be claude.cmd (npm install), which only starts through the shell. Only flags are passed
// as arguments (the prompt goes in on stdin), so nothing needs quoting.
const WIN = process.platform === 'win32';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export async function git(cwd, ...args) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// Stage everything and commit; returns the new commit id, or null when nothing changed.
async function commitAll(cwd, message) {
  await git(cwd, 'add', '-A');
  if (!(await git(cwd, 'status', '--porcelain')).trim()) return null;
  await git(cwd, 'commit', '-q', '-m', message);
  return (await git(cwd, 'rev-parse', 'HEAD')).trim();
}

// Dependencies, build output and secrets never go into a repository CEQU-Edit creates for an app.
const APP_IGNORE = ['node_modules/', '.env', '.env.*', '!.env.example', 'dist/', 'build/', '.next/', '.nuxt/', '.svelte-kit/',
  '.astro/', '.output/', '.vite/', '.cache/', '.venv/', 'venv/', '__pycache__/', 'vendor/', '*.log'];

// The site folder becomes a git repo (a new one starts on `main`); its checked-out branch is the live site.
export async function ensureRepo(siteDir, { app = false, maxFiles = 20_000, maxBytes = 200 * 1024 * 1024 } = {}) {
  const fresh = !existsSync(join(siteDir, '.git'));
  if (fresh) {
    const top = await git(siteDir, 'rev-parse', '--show-toplevel').then(s => s.trim(), () => null);
    if (top) throw Object.assign(new Error(`Point CEQU-Edit at ${top}; use \`cd ${relative(top, siteDir)} && …\` in app.command.`), { status: 400 });
  }
  const ignore = join(siteDir, '.gitignore');
  const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const wanted = [BATCH_FILE, RESULT_FILE, '.DS_Store', ...(fresh && app ? APP_IGNORE : [])];
  const missing = wanted.filter(l => !current.split('\n').includes(l));
  if (missing.length) writeFileSync(ignore, current + (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  if (fresh) {
    await git(siteDir, 'init', '-q', '-b', MAIN);
    const files = (await git(siteDir, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
    let bytes = 0;
    for (const f of files) { try { bytes += statSync(join(siteDir, f)).size; } catch { /* vanished */ } }
    if (files.length > maxFiles || bytes > maxBytes) {
      rmSync(join(siteDir, '.git'), { recursive: true, force: true });      // only the repository just created
      throw Object.assign(new Error(`This folder has ${files.length} files (${Math.round(bytes / 1048576)} MB) to put under version control; add the large folders to .gitignore and start again.`), { status: 400 });
    }
  }
  try { await git(siteDir, 'config', 'user.name'); }
  catch {
    await git(siteDir, 'config', 'user.name', 'CEQU-Edit');
    await git(siteDir, 'config', 'user.email', 'cequ-edit@localhost');
  }
  await commitAll(siteDir, fresh ? 'Baseline' : 'Manual edits');
}

// A merge / rebase / cherry-pick in progress, or no branch checked out: batches must wait.
async function gitBusy(siteDir) {
  const gd = (await git(siteDir, 'rev-parse', '--git-dir')).trim();
  const dir = isAbsolute(gd) ? gd : join(siteDir, gd);
  if (['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some(f => existsSync(join(dir, f)))) return true;
  return git(siteDir, 'symbolic-ref', '-q', 'HEAD').then(() => false, () => true);
}

function validateItems(items) {
  if (!Array.isArray(items) || !items.length) throw fail(400, 'The batch has no items.');
  for (const it of items) {
    if (!it || !KINDS.has(it.kind)) throw fail(400, `Unknown item kind "${it?.kind}".`);
    if (it.kind !== 'build-fix' && typeof it.target?.src !== 'string' && !it.target?.located) throw fail(400, 'Every item needs target.src.');
    const hasPayload = it.payload && Object.keys(it.payload).length > 0;
    if (!hasPayload && !String(it.instruction || '').trim()) throw fail(400, 'An item needs an instruction or a control value.');
  }
}

// Edits are paid for by the owner's Claude subscription only, never API billing.
// So the background Claude gets no ANTHROPIC_* variables (API keys, auth tokens, proxy URLs)
// and none of the desktop session's private CLAUDE* variables (a host-managed login it cannot
// renew). It uses Claude Code's own subscription sign-in, or a long-lived subscription token
// from `claude setup-token` saved in ~/.cequ-edit/claude-token (only `sk-ant-oat…` tokens accepted).
const STRIP = /^(CLAUDE|ANTHROPIC_|AI_AGENT$|BAGGAGE$|AWS_BEARER_TOKEN_BEDROCK$|__CF)/;
export function cleanEnv(env = process.env, tokenFile = null) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!STRIP.test(k)) out[k] = v;
  // where Claude Code installs itself (and Homebrew on macOS), in front of whatever PATH says
  const bins = [join(homedir(), '.local', 'bin'), ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'])];
  const key = Object.keys(out).find(k => k.toUpperCase() === 'PATH') || 'PATH';          // "Path" on Windows
  const path = String(out[key] || (process.platform === 'win32' ? '' : '/usr/bin:/bin')).split(delimiter).filter(Boolean);
  delete out[key];
  out.PATH = [...new Set([...bins, ...path])].join(delimiter);
  if (tokenFile && existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, 'utf8').trim();
    if (/^sk-ant-oat/.test(token)) out.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return out;
}

// Before every run: confirm Claude Code is signed in with a Claude subscription (not Console/API).
export async function subscriptionCheck(claude, env) {
  if (/^sk-ant-oat/.test(env.CLAUDE_CODE_OAUTH_TOKEN || '')) return { ok: true };
  const [cmd, ...pre] = claude;
  try {
    const { stdout } = await exec(cmd, [...pre, 'auth', 'status', '--json'], { env, timeout: 20_000, shell: WIN, windowsHide: true });
    const s = JSON.parse(stdout);
    if (!s.loggedIn) return { ok: false, why: 'not signed in' };
    if (s.authMethod !== 'claude.ai' || (s.apiProvider && s.apiProvider !== 'firstParty')) {
      return { ok: false, why: `signed in with ${s.authMethod || 'an API account'} instead of a Claude subscription` };
    }
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, why: 'unable to report its sign-in' };
  }
}
const AUTH_PROBLEM = /OAuth access token has expired|authentication_error|not logged in|please run \/login|invalid api key|re-authenticate/i;

const slug = s => String(s || 'photo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'photo';

const DEFAULT_CONFIG = { breakpoints: { phone: '(max-width: 768px)', desktop: '(min-width: 769px)' }, uploadsDir: 'uploads', rules: [], guidance: [] };

// Optional long-lived subscription token from `claude setup-token`, shared by every site.
export const TOKEN_FILE = join(homedir(), '.cequ-edit', 'claude-token');

export function createRunner({ siteDir, home, claude = ['claude'], timeoutMs = 10 * 60_000, promptFile, config = DEFAULT_CONFIG, tokenFile = TOKEN_FILE }) {
  const ev = new EventEmitter();
  const stageRoot = join(home, 'stage'), uploadsDir = join(home, 'uploads'), logsDir = join(home, 'logs');
  const statePath = join(home, 'state.json');
  for (const d of [stageRoot, uploadsDir, logsDir]) mkdirSync(d, { recursive: true });

  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { next: 1, batches: {} };
  const procs = new Map(), watchers = new Map();
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
  const emit = (batchId, type, extra = {}) => ev.emit('event', { batchId, type, ...extra });
  const setStatus = (b, status, extra = {}) => {
    Object.assign(b, { status }, extra);
    save();
    emit(b.id, 'status', { status, ...extra });
  };
  const stageDir = id => join(stageRoot, String(id));
  const branch = id => `cequ/batch-${id}`;
  const busy = () => Object.values(state.batches).some(b => ACTIVE.has(b.status));

  function need(id, statuses) {
    const b = state.batches[String(id)];
    if (!b) throw fail(404, `Batch ${id} does not exist.`);
    if (statuses && !statuses.includes(b.status)) throw fail(409, `Batch #${b.n} is ${b.status}.`);
    return b;
  }

  const view = b => b && JSON.parse(JSON.stringify({
    id: b.id, n: b.n, mode: b.mode, status: b.status, page: b.page, items: b.items, results: b.results,
    question: b.question ?? null, error: b.error ?? null, fix: b.fix ?? null, command: b.command ?? null,
    previewUrl: b.previewUrl ?? null, commit: b.commit ?? null, summary: b.summary ?? null, errorCode: b.errorCode ?? null,
    base: b.base ?? null, head: b.head ?? null, previewError: b.previewError ?? null,
    progress: (b.progress || []).slice(-60), createdAt: b.createdAt,
  }));

  const prompt = extra => {
    let contract = '';
    try { contract = readFileSync(promptFile, 'utf8'); } catch { contract = 'Apply the batch in .cequ-batch.json and write .cequ-result.json.'; }
    return `${contract}\n\n${extra}`;
  };

  // Copy uploads into the staging copy and give every item an id.
  async function addItems(b, items) {
    const dir = join(stageDir(b.id), ...config.uploadsDir.split('/'));
    for (const raw of items) {
      const it = JSON.parse(JSON.stringify(raw));
      it.id = b.items.length + 1;
      const img = it.payload?.image;
      if (img?.uploadName) {
        await mkdir(dir, { recursive: true });
        const ext = img.uploadName.split('.').pop();
        const dest = `${slug(it.target.section?.id)}-${b.n}-${it.id}.${ext}`;
        await copyFile(join(uploadsDir, basename(img.uploadName)), join(dir, dest));
        img.file = `${config.uploadsDir}/${dest}`;
      }
      b.items.push(it);
    }
    save();
    return b.items.slice(-items.length);
  }

  // CEQU-Edit applies control-only changes itself (instant, no Claude); returns the items left for Claude.
  async function instant(b, fresh) {
    const res = await applyDirect({ dir: stageDir(b.id), items: fresh, breakpoints: config.breakpoints });
    for (const r of res) {
      if (r.status === 'done') {
        (b.instantIds ||= []).push(r.id);
        b.instantResults = [...(b.instantResults || []).filter(x => x.id !== r.id), r];
        progress(b, `⚡ ${r.id}. ${r.summary}`);
      } else progress(b, `✦ ${r.id}. Passing to Claude: ${r.reason}`);
    }
    save();
    return fresh.filter(it => !(b.instantIds || []).includes(it.id));
  }

  const merged = b => [...(b.instantResults || []), ...(b.claudeResults || [])].sort((x, y) => x.id - y.id);

  // Everything is applied (no Claude work outstanding): straight to the preview.
  async function readyNow(b) {
    b.results = merged(b);
    for (const r of b.instantResults || []) emit(b.id, 'item', r);
    const q = (b.claudeResults || []).find(r => r.status === 'needs_input');
    if (q) return setStatus(b, 'NEEDS_INPUT', { question: q.question || 'Claude needs more information.' });
    await becomeReady(b, { error: null, fix: null });
  }

  // The staged changes become one commit `Batch #n: …` on the batch branch (re-made on every READY),
  // so a preview copy can check it out and approve can merge it.
  async function commitReady(b) {
    const dir = stageDir(b.id);
    if (!b.base || !existsSync(dir)) return;
    await git(dir, 'reset', '-q', '--soft', b.base);
    await commitAll(dir, `Batch #${b.n}: ${summarize(b)}`);
    b.head = (await git(dir, 'rev-parse', 'HEAD')).trim();
  }

  const previewUrlFor = b => (config.appMode
    ? `/__cequ/view/${b.id}?to=${encodeURIComponent(b.page || '/')}`
    : `/__cequ/preview/${b.id}/${b.page}`);

  async function becomeReady(b, extra = {}) {
    try { await commitReady(b); }
    catch (e) { return setStatus(b, 'FAILED', { error: `Could not record the staged changes: ${e.message}`, fix: 'Press Retry or Reject.' }); }
    const previewUrl = previewUrlFor(b);
    setStatus(b, 'READY', { previewUrl, previewError: null, ...extra });
    emit(b.id, 'ready', { previewUrl });
  }

  const writeBatchFile = b => writeFile(join(stageDir(b.id), BATCH_FILE), JSON.stringify({
    batchId: b.id, number: b.n, page: b.page, appMode: Boolean(config.appMode),
    breakpoints: config.breakpoints,
    projectFiles: config.guidance, projectRules: config.rules,
    items: b.items.filter(it => !(b.instantIds || []).includes(it.id)),   // only what Claude must do
    answers: b.answers || [],
  }, null, 2));

  async function readResult(b) {
    try {
      const r = JSON.parse(await readFile(join(stageDir(b.id), RESULT_FILE), 'utf8'));
      return Array.isArray(r.items) ? r : null;
    } catch { return null; }
  }

  async function finish(b) {
    const result = await readResult(b);
    if (b.status !== 'RUNNING') return;
    if (!result) {
      return setStatus(b, 'FAILED', {
        error: b.lastError || 'Claude finished without writing its report (.cequ-result.json).',
        fix: 'Press Retry, or use "Send to chat instead".',
      });
    }
    b.claudeResults = result.items;
    b.results = merged(b);
    for (const r of result.items) emit(b.id, 'item', r);
    const q = result.items.find(r => r.status === 'needs_input');
    if (q) return setStatus(b, 'NEEDS_INPUT', { question: q.question || 'Claude needs more information.' });
    await becomeReady(b);
  }

  const progress = (b, line) => {
    (b.progress ||= []).push(line);
    if (b.progress.length > 200) b.progress.splice(0, b.progress.length - 200);
    emit(b.id, 'progress', { line });
  };

  function onStreamLine(b, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.session_id) b.sessionId = msg.session_id;
    if (msg.type === 'assistant') {
      for (const c of msg.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) progress(b, c.text.trim().split('\n')[0].slice(0, 180));
        if (c.type === 'tool_use') {
          const target = c.input?.file_path ? basename(c.input.file_path) : (c.input?.pattern || '');
          progress(b, `${{ Read: 'Reading', Edit: 'Editing', Write: 'Writing', Grep: 'Searching', Glob: 'Looking for' }[c.name] || c.name} ${target}`.trim());
        }
      }
    }
    if (msg.type === 'result' && msg.is_error) b.lastError = String(msg.result || msg.subtype || 'Claude reported an error.');
  }

  function watchResult(b) {
    clearInterval(watchers.get(b.id));
    watchers.set(b.id, setInterval(async () => {
      if (b.status !== 'RUNNING') return clearInterval(watchers.get(b.id));
      if (await readResult(b)) { clearInterval(watchers.get(b.id)); finish(b); }
    }, 700));
  }

  function start(b, text, resume = false) {
    rmSync(join(stageDir(b.id), RESULT_FILE), { force: true });
    b.lastError = null;
    b.errorCode = null;
    if (b.mode === 'chat') {
      const command = `apply edit batch ${b.id} in ${stageDir(b.id)} (follow ${promptFile || 'PROMPT.md'})`;
      setStatus(b, 'RUNNING', { command, question: null, error: null, fix: null });
      emit(b.id, 'handoff', { command });
      return watchResult(b);
    }
    setStatus(b, 'RUNNING', { question: null, error: null, fix: null });
    const env = cleanEnv(process.env, tokenFile);
    subscriptionCheck(claude, env).then(check => {
      if (b.status !== 'RUNNING') return;                       // rejected meanwhile
      if (check.missing) return setStatus(b, 'FAILED', {
        error: `Claude Code (${claude[0]}) was not found on this Mac.`,
        fix: 'Install Claude Code, then click Retry.',
      });
      if (!check.ok) {
        b.sessionId = null;
        return setStatus(b, 'FAILED', {
          error: `Edits run only on your Claude subscription, and Claude Code is ${check.why}. Nothing was sent.`,
          fix: 'Click "Sign in" and sign in with your Claude account (not an Anthropic Console / API account). Then click Retry.',
          errorCode: 'auth',
        });
      }
      run(b, text, resume, env);
    });
  }

  function run(b, text, resume, env) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep', '--disallowedTools', 'Bash,WebFetch,WebSearch,Task'];
    if (resume && b.sessionId) args.push('--resume', b.sessionId);
    const [cmd, ...pre] = claude;
    const log = createWriteStream(join(logsDir, `${b.id}.log`), { flags: 'a' });
    const child = spawn(cmd, [...pre, ...args], { cwd: stageDir(b.id), stdio: ['pipe', 'pipe', 'pipe'], env, shell: WIN, windowsHide: true });
    child.stdin.on('error', () => {});                         // claude missing: reported by 'error' below
    child.stdin.end(text);
    procs.set(b.id, child);
    let buf = '', errTail = '', spawnError = null, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.on('error', e => { spawnError = e.code || e.message; });
    child.stdout.on('data', d => {
      log.write(d);
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) { onStreamLine(b, buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', d => { log.write(d); errTail = (errTail + d).slice(-2000); });
    child.on('close', async () => {
      clearTimeout(timer);
      procs.delete(b.id);
      log.end();
      if (b.status !== 'RUNNING') return;                       // rejected meanwhile
      save();
      if (spawnError) return setStatus(b, 'FAILED', {
        error: `Claude Code (${cmd}) was not found on this Mac.`,
        fix: 'Install Claude Code, run `claude` once in Terminal to log in, or use "Send to chat instead".',
      });
      if (timedOut) return setStatus(b, 'FAILED', {
        error: 'Claude took longer than 10 minutes and was stopped.',
        fix: 'Press Retry to continue where it stopped.',
      });
      if (AUTH_PROBLEM.test(errTail + (b.lastError || '')) && !(await readResult(b))) {
        b.sessionId = null;                                    // nothing ran: retry from the start
        return setStatus(b, 'FAILED', {
          error: 'Claude Code needs you to sign in again.',
          fix: 'Click "Sign in": Terminal opens and your browser asks you to approve. Then click Retry.',
          errorCode: 'auth',
        });
      }
      if (!b.lastError && errTail.trim() && !(await readResult(b))) b.lastError = errTail.trim().split('\n').pop();
      finish(b);
    });
  }

  async function cleanup(b) {
    await git(siteDir, 'worktree', 'remove', '--force', stageDir(b.id)).catch(() => rm(stageDir(b.id), { recursive: true, force: true }));
    await git(siteDir, 'worktree', 'prune').catch(() => {});
    await git(siteDir, 'branch', '-D', branch(b.id)).catch(() => {});
    for (const it of b.items) {
      if (it.payload?.image?.uploadName) await rm(join(uploadsDir, basename(it.payload.image.uploadName)), { force: true });
    }
  }

  const summarize = b => {
    const done = (b.results || []).filter(r => r.status === 'done' && r.summary).map(r => r.summary);
    const s = (done.length ? done.join('; ') : `${b.items.length} changes`).replace(/\s+/g, ' ');
    return s.length > 100 ? s.slice(0, 99) + '…' : s;
  };

  // Recover after a restart: headless runs died with the server, chat hand-offs keep waiting.
  for (const b of Object.values(state.batches)) {
    if (!ACTIVE.has(b.status)) continue;
    if (b.mode === 'chat' && b.status === 'RUNNING' && existsSync(stageDir(b.id))) watchResult(b);
    else Object.assign(b, { status: 'FAILED', error: 'The editor server restarted while this batch was running.', fix: 'Press Retry.' });
  }
  save();

  async function submit(items, mode = 'auto', page = 'index.html') {
    validateItems(items);
    if (busy()) throw fail(409, 'Another batch is still running. Wait for it to finish.');
    if (await gitBusy(siteDir)) throw fail(409, 'Finish or abort the git operation in progress (or check out a branch), then try again.');
    if (!state.seeded) {                                   // continue numbering after batches already in git history
      const done = (await history()).map(h => Number(/^Batch #(\d+)/.exec(h.subject)?.[1] || 0));
      state.next = Math.max(state.next, ...done.map(x => x + 1));
      state.seeded = true;
    }
    const n = state.next++;
    const id = String(n);
    const b = state.batches[id] = { id, n, page, mode: mode === 'chat' ? 'chat' : 'auto', status: 'STAGING', items: [], results: [], createdAt: new Date().toISOString() };
    setStatus(b, 'STAGING');
    try {
      await commitAll(siteDir, `Manual edits before batch #${n}`);
      await git(siteDir, 'worktree', 'prune');
      await git(siteDir, 'branch', '-D', branch(id)).catch(() => {});
      await rm(stageDir(id), { recursive: true, force: true });
      b.base = (await git(siteDir, 'rev-parse', 'HEAD')).trim();
      await git(siteDir, 'worktree', 'add', '-q', '-b', branch(id), stageDir(id), b.base);
      var left = await instant(b, await addItems(b, items));
      await writeBatchFile(b);
    } catch (e) {
      setStatus(b, 'FAILED', { error: `Could not prepare the staging copy: ${e.message}`, fix: 'Press Retry or Reject.' });
      throw e;
    }
    if (left.length) start(b, prompt(`Batch file: ${BATCH_FILE} (batch #${n}). Apply every item, then write ${RESULT_FILE}.`));
    else await readyNow(b);
    return { batchId: id };
  }

  async function answer(id, text) {
    const b = need(id, ['NEEDS_INPUT']);
    (b.answers ||= []).push({ question: b.question, answer: String(text) });
    await writeBatchFile(b);
    start(b, `The owner answered your question.\nQuestion: ${b.question}\nAnswer: ${text}\n\nContinue applying ${BATCH_FILE} under the same contract, then rewrite ${RESULT_FILE} with the status of every item.`, true);
    return view(b);
  }

  async function revise(id, items) {
    const b = need(id, ['READY', 'FAILED', 'NEEDS_INPUT']);
    validateItems(items);
    const left = await instant(b, await addItems(b, items));
    await writeBatchFile(b);
    const claudeOpen = b.items.some(it => !(b.instantIds || []).includes(it.id)
      && !(b.claudeResults || []).some(r => r.id === it.id && r.status === 'done'));
    if (!left.length && !claudeOpen) { await readyNow(b); return view(b); }
    start(b, b.sessionId
      ? `New items were added to ${BATCH_FILE} (ids ${left.map(it => it.id).join(', ')}). Keep the earlier changes, apply the new items under the same contract, then rewrite ${RESULT_FILE} with the status of every item in the file, old and new.`
      : prompt(`Batch file: ${BATCH_FILE} (batch #${b.n}). Apply every item, then write ${RESULT_FILE}.`), Boolean(b.sessionId));
    return view(b);
  }

  async function retry(id) {
    const b = need(id, ['FAILED']);
    if (!existsSync(stageDir(b.id))) throw fail(409, 'The staging copy is gone; reject this batch and queue the changes again.');
    start(b, b.sessionId
      ? `Continue applying ${BATCH_FILE} under the same contract, then write ${RESULT_FILE} with the status of every item.`
      : prompt(`Batch file: ${BATCH_FILE} (batch #${b.n}). Apply every item, then write ${RESULT_FILE}.`), Boolean(b.sessionId));
    return view(b);
  }

  // Switch a failed or waiting batch to the chat hand-off (e.g. when the CLI login has expired).
  async function toChat(id) {
    const b = need(id, ['FAILED', 'NEEDS_INPUT']);
    if (!existsSync(stageDir(b.id))) throw fail(409, 'The staging copy is gone; reject this batch and queue the changes again.');
    b.mode = 'chat';
    start(b, '');
    return view(b);
  }

  async function approve(id) {
    const b = need(id, ['READY']);
    const summary = summarize(b);
    let staged = true;
    if (b.base) {                                          // re-record (e.g. chat edits after READY), then merge if anything changed
      await commitReady(b);
      staged = b.head !== b.base;
    } else staged = await commitAll(stageDir(b.id), `Batch #${b.n}: ${summary}`);
    let commit = null;
    if (staged) {
      await commitAll(siteDir, `Manual edits before approving batch #${b.n}`);
      try { await git(siteDir, 'merge', '--ff-only', '-q', branch(b.id)); }
      catch {
        try { await git(siteDir, 'merge', '--no-edit', '-q', branch(b.id)); }
        catch {
          const files = (await git(siteDir, 'diff', '--name-only', '--diff-filter=U').catch(() => '')).trim().split('\n').filter(Boolean);
          await git(siteDir, 'merge', '--abort').catch(() => {});
          emit(b.id, 'error', { message: 'The same lines were changed on the live site meanwhile.', fix: 'Reject this batch and queue it again on the latest version.', files });
          return { conflict: true, files };
        }
      }
      commit = (await git(siteDir, 'rev-parse', 'HEAD')).trim();
    }
    await cleanup(b);
    setStatus(b, 'APPROVED', { commit, summary, previewUrl: null });
    emit(b.id, 'approved', { commit });
    return { commit };
  }

  async function reject(id) {
    const b = need(id);
    if (b.status === 'APPROVED' || b.status === 'REJECTED') throw fail(409, `Batch #${b.n} is ${b.status}.`);
    clearInterval(watchers.get(b.id));
    const child = procs.get(b.id);
    setStatus(b, 'REJECTED', { previewUrl: null });
    if (child) child.kill('SIGTERM');
    await cleanup(b);
    emit(b.id, 'rejected');
    return view(b);
  }

  async function diff(id) {
    const b = need(id);
    if (b.status === 'APPROVED' && b.commit) return git(siteDir, 'show', '--format=', b.commit);
    if (!existsSync(stageDir(b.id))) return '';
    await git(stageDir(b.id), 'add', '-A');
    return b.base ? git(stageDir(b.id), 'diff', '--cached', b.base) : git(stageDir(b.id), 'diff', '--cached');
  }

  async function history() {
    const out = await git(siteDir, 'log', '-n', '60', '--format=%H%x09%aI%x09%s');
    return out.trim().split('\n').filter(Boolean).map(l => {
      const [commit, date, subject] = l.split('\t');
      return { commit, date, subject };
    }).filter(h => /^(Batch #|Revert ")/.test(h.subject));
  }

  async function undo(commit) {
    if (!/^[0-9a-f]{7,40}$/.test(String(commit))) throw fail(400, 'Not a commit id.');
    await commitAll(siteDir, 'Manual edits before undo');
    try { await git(siteDir, 'revert', '--no-edit', commit); }
    catch (e) {
      await git(siteDir, 'revert', '--abort').catch(() => {});
      throw fail(409, 'Could not undo automatically: later changes touch the same lines.');
    }
    const head = (await git(siteDir, 'rev-parse', 'HEAD')).trim();
    emit(null, 'undone', { commit: head, reverted: commit });
    return { commit: head };
  }

  // Commit hand edits in the project (e.g. before a build), so the result matches what is live.
  const commitLive = message => commitAll(siteDir, message);

  // App mode: why the preview copy could not run this batch (shown in the preview bar), or null.
  function setPreviewError(id, message) {
    const b = state.batches[String(id)];
    if (!b) return;
    b.previewError = message;
    save();
  }

  const list = () => Object.values(state.batches).sort((a, b) => b.n - a.n).slice(0, 20).map(view);

  function close() {
    for (const t of watchers.values()) clearInterval(t);
    for (const c of procs.values()) c.kill('SIGTERM');
  }

  return Object.assign(ev, {
    submit, answer, revise, retry, toChat, approve, reject, diff, history, undo, list, close, setPreviewError, commitLive,
    get: id => view(state.batches[String(id)]),
    stageDir, uploadsDir,
  });
}

