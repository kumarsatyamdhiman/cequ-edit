// App mode: every request outside /__cequ/ goes to the app's own dev server, and full page loads get the
// editor injected right after <head>. Hot-reload WebSockets pass straight through. Spec §7.
import http from 'node:http';
import net from 'node:net';

// A page load (document or iframe), not a fetch / XHR / RSC / htmx fragment.
export function wantsDocument(req) {
  const dest = req.headers['sec-fetch-dest'];
  if (dest) return dest === 'document' || dest === 'iframe';
  return req.method === 'GET' && /^text\/html/i.test(req.headers.accept || '');
}

const HEAD = /<head(?:\s[^>]*)?>/i;

// Insert `tag` after the <head …> start tag; without a <head>, after the doctype.
export function injectAfterHead(html, tag) {
  const m = HEAD.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  const d = /^\s*<!doctype[^>]*>/i.exec(html);
  return d ? d[0] + tag + html.slice(d[0].length) : tag + html;
}

export const rewriteLocation = (loc, port) =>
  String(loc).replace(new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|$)`, 'i'), '') || '/';

// pick(req) → { port } | null; injectHead(req) → html string; onDown(req, res, error) answers when no app is reachable.
export function createProxy({ pick, injectHead, onDown }) {
  function handle(req, res) {
    const up = pick(req);
    if (!up) return onDown(req, res, null);
    const headers = { ...req.headers };
    delete headers['accept-encoding'];                          // answers come uncompressed, so HTML can be edited
    if (wantsDocument(req)) {
      // The live app and a preview copy serve the same index.html (same ETag); a 304 would reuse a page
      // cached with the other view's editor settings. Page loads always fetch fresh.
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
    }
    const preq = http.request({ host: 'localhost', port: up.port, method: req.method, path: req.url, headers }, pres => {
      const h = { ...pres.headers };
      delete h['content-security-policy'];
      delete h['content-security-policy-report-only'];
      if (h.location) h.location = rewriteLocation(h.location, up.port);
      const inject = pres.statusCode === 200 && req.method === 'GET' && /text\/html/i.test(h['content-type'] || '') && wantsDocument(req);
      if (!inject) { res.writeHead(pres.statusCode, pres.statusMessage, h); return pres.pipe(res); }
      delete h['content-length'];
      delete h.etag;
      delete h['last-modified'];
      h['cache-control'] = 'no-store';
      res.writeHead(pres.statusCode, pres.statusMessage, h);
      const tag = injectHead(req);
      let buf = Buffer.alloc(0), done = false;
      // latin1 keeps every byte as-is whatever the page's encoding; the tag itself is ASCII.
      const emit = () => { res.write(Buffer.from(injectAfterHead(buf.toString('latin1'), tag), 'latin1')); done = true; buf = null; };
      pres.on('data', d => {
        if (done) return res.write(d);
        buf = Buffer.concat([buf, d]);
        const s = buf.toString('latin1');
        if (HEAD.test(s) || /<body[\s>]/i.test(s) || buf.length > 65536) emit();
      });
      pres.on('end', () => { if (!done) emit(); res.end(); });
      pres.on('error', () => res.destroy());
    });
    preq.on('error', e => { if (res.headersSent) res.destroy(); else onDown(req, res, e); });
    req.pipe(preq);
  }

  function upgrade(req, socket, head) {
    const up = pick(req);
    if (!up) return socket.destroy();
    const conn = net.connect(up.port, 'localhost', () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      conn.write(raw + '\r\n');
      if (head?.length) conn.write(head);
      conn.pipe(socket);
      socket.pipe(conn);
    });
    conn.on('error', () => socket.destroy());
    socket.on('error', () => conn.destroy());
  }

  return { handle, upgrade };
}
