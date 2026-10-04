// The project's own processes (dev server, preview copy, production server) and the copies they run in.
// Each app runs in its own process group, so stopping it also stops everything it started.
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, lstatSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { cleanEnv, git, BATCH_FILE, RESULT_FILE } from './runner.mjs';
import { spawnCommand, killTree, cloneTree } from './platform.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const freePort = () => new Promise((ok, bad) => {
  const s = net.createServer();
  s.on('error', bad);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

export function tail(file, n = 30) {
  try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Any HTTP answer counts: many apps answer / with a redirect or a 404.
export const answers = (port, ms = 1500) => new Promise(resolve => {
  const req = http.get({ host: 'localhost', port, path: '/', timeout: ms }, res => { res.resume(); resolve(true); });
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.on('error', () => resolve(false));
});

// Process groups left behind by an editor that was killed.
export function killStale(home) {
  const dir = join(home, 'pids');
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const pid = Number(readFileSync(join(dir, f), 'utf8'));
    if (pid && alive(pid)) killTree(pid, true);
    rmSync(join(dir, f), { force: true });
  }
}

// The message carries the app's last log line, the most likely explanation.
const startError = (message, logFile) => {
  const log = tail(logFile, 30);
  const last = log.split('\n').filter(l => l.trim()).pop();
  return Object.assign(new Error(last ? `${message} Last output: ${last.trim().slice(0, 300)}` : message), { log, logFile });
};

// Run `command` ({port} replaced, PORT set) in `cwd`; resolves once it answers HTTP on localhost.
export async function startApp({ name, cwd, command, home, env = {}, readyMs = 120_000 }) {
  const port = await freePort();
  for (const d of ['logs', 'pids']) mkdirSync(join(home, d), { recursive: true });
  const logFile = join(home, 'logs', `app-${name}.log`);
  const pidFile = join(home, 'pids', `${name}.pid`);
  const fd = openSync(logFile, 'w');
  const child = spawnCommand(command.replaceAll('{port}', String(port)), {
    cwd, stdio: ['ignore', fd, fd], env: { ...cleanEnv(process.env), PORT: String(port), BROWSER: 'none', ...env },
  });
  closeSync(fd);
  writeFileSync(pidFile, String(child.pid));
  let exitCode = null;
  const exited = new Promise(resolve => child.on('exit', (code, signal) => {
    exitCode = code ?? signal ?? 'stopped';
    rmSync(pidFile, { force: true });
    resolve(exitCode);
  }));
  const app = {
    name, port, url: `http://localhost:${port}`, pid: child.pid, logFile, exited,
    get running() { return exitCode === null; },
    async stop() {
      killTree(child.pid);                             // the shell may be gone while its children still run
      const force = setTimeout(() => killTree(child.pid, true), 5000);
      await exited;
      clearTimeout(force);
    },
  };
  for (const deadline = Date.now() + readyMs; ;) {
    if (exitCode !== null) throw startError(`The app stopped while starting (exit ${exitCode}).`, logFile);
    if (await answers(port)) return app;
    if (Date.now() > deadline) {
      await app.stop();
      throw startError(`The app did not answer within ${Math.round(readyMs / 1000)} s.`, logFile);
    }
    await sleep(500);
  }
}

// Root lockfiles: when one changes, dependency folders are copied again.
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'requirements.txt',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'Cargo.lock'];
const mtime = f => { try { return statSync(f).mtimeMs; } catch { return null; } };

// A runnable copy of the project at HEAD: <home>/<name> (detached worktree) plus the git-ignored things
// the app needs to run (node_modules, .venv, vendor, .env, local databases…). Spec §10.3.
export async function ensureCopy({ siteDir, home, name }) {
  const dir = join(home, name);
  const stateFile = join(home, `${name}.json`);
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    await git(siteDir, 'worktree', 'prune');
    await git(siteDir, 'worktree', 'add', '-q', '--detach', '-f', dir, 'HEAD');
  }
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* first use */ }
  const locks = Object.fromEntries(LOCKFILES.map(f => [f, mtime(join(siteDir, f))]));
  const refreshDirs = JSON.stringify(locks) !== JSON.stringify(state.locks);
  const ignored = (await git(siteDir, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'))
    .split('\0').filter(Boolean).map(p => p.replace(/\/$/, ''))
    .filter(p => ![BATCH_FILE, RESULT_FILE].includes(p) && !p.endsWith('.DS_Store'));
  for (const rel of ignored) {
    const src = join(siteDir, rel), dst = join(dir, rel);
    let isDir;
    try { isDir = lstatSync(src).isDirectory(); } catch { continue; }
    if (isDir && existsSync(dst) && !refreshDirs) continue;
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(dirname(dst), { recursive: true });
    await cloneTree(src, dst);
  }
  writeFileSync(stateFile, JSON.stringify({ locks }));
  return dir;
}
