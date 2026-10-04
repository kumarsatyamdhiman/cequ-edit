// "Build final site" (spec §13): the production build runs in a clean build copy, its output folder is
// copied into the project, and the result can be previewed, zipped or opened in Finder. Static sites
// skip the build and get a zip of the approved site.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, openSync, closeSync, createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep, basename, extname, isAbsolute, normalize, relative } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { cleanEnv, git } from './runner.mjs';
import { ensureCopy, startApp, tail } from './apps.mjs';
import { spawnCommand, killTree, cloneTree, revealPath } from './platform.mjs';

const LIMIT_MS = 15 * 60_000;
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const WAITING = new Set(['STAGING', 'RUNNING', 'NEEDS_INPUT', 'READY', 'FAILED']);
const STATIC_EXCLUDE = ['.cequ-edit.json', '.gitignore', 'PRODUCT.md', 'DESIGN.md', 'CLAUDE.md', 'AGENTS.md'];

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.map': 'application/json',
};

// `out` must be a plain folder inside the project that holds no tracked files: only then may a build replace it.
export async function outGuard(siteDir, out) {
  const bad = !out || isAbsolute(out) || normalize(out).split(sep).includes('..') || ['.', ''].includes(normalize(out).replace(/\/$/, ''));
  if (bad || (await git(siteDir, 'ls-files', '--', out)).trim()) {
    throw fail(400, 'app.out points at a folder with files under version control; fix .cequ-edit.json.');
  }
}

const isFile = f => { try { return statSync(f).isFile(); } catch { return false; } };

// A tiny static server over a built folder, for the Built view (single-page apps fall back to index.html).
export function serveFolder(dir) {
  const root = resolve(dir);
  const inside = p => { const f = resolve(root, '.' + sep + p); return f === root || f.startsWith(root + sep) ? f : null; };
  const send = (res, f, status) => {
    res.writeHead(status, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(f).pipe(res);
  };
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    for (const c of [p, `${p}.html`, `${p.replace(/\/$/, '')}/index.html`]) {
      const f = inside(c);
      if (f && isFile(f)) return send(res, f, 200);
    }
    if (!basename(p).includes('.') && isFile(join(root, 'index.html'))) return send(res, join(root, 'index.html'), 200);
    if (isFile(join(root, '404.html'))) return send(res, join(root, '404.html'), 404);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ port: server.address().port, close: () => new Promise(r => server.close(r)) })));
}

// ---------- zip (no zip tool needed on any system) ----------
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function listFilesDeep(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? listFilesDeep(p, base) : e.isFile() ? [relative(base, p).split(sep).join('/')] : [];
  });
}
// Stream every file under `dir` into `out` as a zip archive (deflate, UTF-8 names, files at the zip root).
export async function zipFolder(dir, out) {
  const central = [];
  let offset = 0;
  const write = buf => new Promise(ok => { offset += buf.length; out.write(buf) ? ok() : out.once('drain', ok); });
  for (const name of listFilesDeep(dir)) {
    const data = await readFile(join(dir, name));
    const packed = deflateRawSync(data);
    const { time, date } = dosTime(statSync(join(dir, name)).mtime);
    const nameBuf = Buffer.from(name, 'utf8');
    const fields = { crc: crc32(data), csize: packed.length, usize: data.length, time, date, at: offset, nameBuf };
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(fields.crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    await write(Buffer.concat([head, nameBuf, packed]));
    central.push(fields);
  }
  const cdStart = offset;
  for (const f of central) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(f.time, 12); c.writeUInt16LE(f.date, 14); c.writeUInt32LE(f.crc, 16); c.writeUInt32LE(f.csize, 20);
    c.writeUInt32LE(f.usize, 24); c.writeUInt16LE(f.nameBuf.length, 28); c.writeUInt32LE(f.at, 42);
    await write(Buffer.concat([c, f.nameBuf]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
  await write(end);
  out.end();
}

function countFiles(dir) {
  let files = 0, bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const c = countFiles(p); files += c.files; bytes += c.bytes; }
    else if (e.isFile()) { files++; bytes += statSync(p).size; }
  }
  return { files, bytes };
}

export function createBuilder({ siteDir, home, config, runner, emit = () => {}, limitMs = LIMIT_MS, readyMs = 120_000 }) {
  const stateFile = join(home, 'build-state.json');
  const logFile = join(home, 'logs', 'build.log');
  const app = config.app || {};
  let state = { status: 'IDLE' };
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* first build */ }
  if (state.status === 'BUILDING') state = { ...state, status: 'FAILED', error: 'The editor was restarted during the build.' };
  let server = null, prodApp = null, child = null;

  const set = patch => {
    state = { ...state, ...patch };
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    emit({ batchId: null, type: 'build', build: view() });
  };
  const view = () => ({ ...state, appMode: Boolean(config.appMode), hasPreview: Boolean(config.appMode && (app.out || app.start)), canReveal: Boolean(app.out), os: process.platform });
  const zipUrl = '/__cequ/build/site.zip';

  async function stopBuilt() { const a = prodApp; prodApp = null; await a?.stop(); }
  async function stopAll() { await stopBuilt(); const s = server; server = null; await s?.close(); }

  async function start({ force = false } = {}) {
    if (state.status === 'BUILDING') throw fail(409, 'A build is already running.');
    const waiting = runner.list().filter(b => WAITING.has(b.status)).length;
    if (waiting && !force) throw fail(409, `${waiting} change${waiting > 1 ? 's' : ''} aren't approved yet and won't be in the build.`, { waiting });
    if (config.appMode && !app.build) throw fail(400, 'Ask Claude: set up building for this project.');
    if (config.appMode && app.out) await outGuard(siteDir, app.out);
    await runner.commitLive('Manual edits before build');
    const commit = (await git(siteDir, 'rev-parse', 'HEAD')).trim();
    if (!config.appMode) {
      set({ status: 'BUILT', commit, startedAt: new Date().toISOString(), durationMs: 0, out: null, files: null, bytes: null, logTail: '', error: null, zipUrl });
      return view();
    }
    await stopAll();
    set({ status: 'BUILDING', commit, startedAt: new Date().toISOString(), durationMs: null, out: app.out, files: null, bytes: null, logTail: '', error: null, zipUrl: null });
    run(commit).catch(e => set({ status: 'FAILED', error: e.message, logTail: tail(logFile, 30) }));
    return view();
  }

  async function run(commit) {
    const t0 = Date.now();
    const dir = await ensureCopy({ siteDir, home, name: 'build' });
    await git(dir, 'checkout', '-q', '--detach', '--force', commit);
    if (app.out) rmSync(join(dir, app.out), { recursive: true, force: true });
    const fd = openSync(logFile, 'w');
    child = spawnCommand(app.build, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv(process.env) });
    let pending = [], partial = '';
    const onData = d => {
      writeFileSync(fd, d);
      const lines = (partial + d).split('\n');
      partial = lines.pop();
      pending.push(...lines.filter(l => l.trim()));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const flushLines = () => { if (pending.length) { emit({ batchId: null, type: 'build-log', lines: pending.slice(-10) }); pending = []; } };
    const flush = setInterval(flushLines, 100);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid, true); }, limitMs);
    const code = await new Promise(r => child.on('close', c => r(c)));
    clearTimeout(timer); clearInterval(flush); closeSync(fd); child = null;
    if (partial.trim()) pending.push(partial);
    flushLines();
    const durationMs = Date.now() - t0;
    if (timedOut) return set({ status: 'FAILED', durationMs, error: `The build took longer than ${Math.round(limitMs / 60000)} minutes.`, logTail: tail(logFile, 30) });
    if (code !== 0) return set({ status: 'FAILED', durationMs, error: `The build failed (exit code ${code}).`, logTail: tail(logFile, 30) });
    if (!app.out) return set({ status: 'BUILT', durationMs, zipUrl, logTail: tail(logFile, 30) });
    const built = join(dir, app.out);
    if (!existsSync(built)) return set({ status: 'FAILED', durationMs, error: `The build finished but did not create ${app.out}/. Check app.out in .cequ-edit.json.`, logTail: tail(logFile, 30) });
    await outGuard(siteDir, app.out);
    const dest = join(siteDir, app.out);
    rmSync(dest, { recursive: true, force: true });
    await cloneTree(built, dest);
    set({ status: 'BUILT', durationMs, zipUrl, logTail: tail(logFile, 30), ...countFiles(dest) });
  }

  // "Fix with Claude": a normal batch whose one item carries the build log.
  async function fix() {
    if (state.status !== 'FAILED') throw fail(409, 'There is no failed build to fix.');
    return runner.submit([{ kind: 'build-fix', screens: 'all', instruction: 'The production build fails. Make it pass without changing how the site looks.',
      target: { log: tail(logFile, 200) }, payload: {} }], 'auto', config.page);
  }

  async function reveal() {
    if (!app.out || state.status !== 'BUILT') throw fail(409, 'There is no built folder to show.');
    await revealPath(join(siteDir, app.out));
  }

  function zip(res) {
    if (state.status !== 'BUILT') throw fail(409, 'Build the final site first.');
    const name = `${basename(siteDir).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'site'}-${new Date().toISOString().slice(0, 10)}.zip`;
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    if (config.appMode && app.out) return zipFolder(join(siteDir, app.out), res);
    const args = ['archive', '--format=zip', state.commit, ...(config.appMode ? [] : ['--', '.', ...STATIC_EXCLUDE.map(f => `:(exclude)${f}`)])];
    spawn('git', args, { cwd: siteDir, stdio: ['ignore', 'pipe', 'ignore'] }).stdout.pipe(res);
  }

  // The Built view's upstream: a static server over the output, or the production server (app.start).
  async function showBuilt() {
    if (!config.appMode || state.status !== 'BUILT') throw fail(409, 'Build the final site first.');
    const dir = join(home, 'build');
    if (app.out) { server ||= await serveFolder(join(dir, app.out)); return server.port; }
    if (app.start) { if (!prodApp?.running) prodApp = await startApp({ name: 'built', cwd: dir, command: app.start, home, readyMs }); return prodApp.port; }
    throw fail(409, 'This project has no app.out or app.start, so there is nothing to preview.');
  }
  const builtPort = () => server?.port ?? (prodApp?.running ? prodApp.port : null);

  return { state: view, start, fix, reveal, zip, showBuilt, builtPort, stopBuilt, close: async () => { if (child) killTree(child.pid, true); await stopAll(); } };
}
