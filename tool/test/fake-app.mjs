// Stand-in for a project's dev server in tests. Port from --port or PORT.
// MODE=crash exits at once; MODE=slow listens after 400 ms; MODE=child also starts a grandchild (pid → CHILD_PID_FILE).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const i = process.argv.indexOf('--port');
const port = Number(i > 0 ? process.argv[i + 1] : process.env.PORT);
const mode = process.argv.includes('--crash') ? 'crash' : process.env.MODE;
console.log(`fake app starting on ${port} (${mode || 'normal'})`);
if (mode === 'crash') { console.error('boom: cannot start'); process.exit(1); }
if (mode === 'child') {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.CHILD_PID_FILE, String(c.pid));
}
const page = () => (existsSync('page.html') ? readFileSync('page.html', 'utf8')
  : '<!doctype html>\n<html><head><title>t</title></head><body><h1 class="hero">Hello app</h1></body></html>\n');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/env') return res.end(JSON.stringify({ keys: Object.keys(process.env), port: process.env.PORT, cwd: process.cwd(), browser: process.env.BROWSER }));
  if (url.pathname === '/headers') return res.end(JSON.stringify(req.headers));
  if (url.pathname === '/json') { res.setHeader('Content-Type', 'application/json'); return res.end('{"a":"<head>"}'); }
  if (url.pathname === '/redirect') { res.writeHead(302, { Location: `http://localhost:${port}/landed` }); return res.end(); }
  if (url.pathname === '/csp') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'none'" });
    return res.end('<!doctype html><html><head></head><body>csp</body></html>');
  }
  if (url.pathname === '/split') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write('<!doctype html><html><he');
    setTimeout(() => { res.write('ad lang="x"><title>s</title>'); setTimeout(() => res.end('</head><body>split</body></html>'), 20); }, 20);
    return;
  }
  if (url.pathname === '/nohead') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html>\n<p>bare</p>'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page());
});
server.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', d => socket.write(d));            // echo raw bytes
});
setTimeout(() => server.listen(port, '127.0.0.1'), mode === 'slow' ? 400 : 0);
