// Talks to the local editor server. Every call carries the per-start token.
export const CFG = window.__CEQU_EDIT || {};

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const isJSON = body !== undefined && !(body instanceof Blob);
  const res = await fetch('/__cequ/api/' + path, {
    method,
    headers: { 'X-CEQU-Token': CFG.token, ...(isJSON ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: isJSON ? JSON.stringify(body) : body,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (res.status === 401) dispatchEvent(new CustomEvent('cequ-stale'));
  if (!res.ok) throw Object.assign(new Error(data?.error || String(data) || res.statusText), { status: res.status, fix: data?.fix, data });
  return data;
}

export const fetchJSON = path => api(path);

export const uploadImage = file => api('upload', {
  method: 'POST', body: file, headers: { 'X-Filename': encodeURIComponent(file.name || 'photo') },
});

// Server-sent events; the browser reconnects on its own if the server restarts.
export function listen(onEvent) {
  const es = new EventSource(`/__cequ/api/events?token=${CFG.token}`);
  es.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch { /* ignore malformed */ } };
  return es;
}

// The page's own route (app projects), without the editor's cequ-* parameters.
export function here() {
  const p = new URLSearchParams(location.search);
  for (const k of [...p.keys()]) if (k.startsWith('cequ-')) p.delete(k);
  return location.pathname + (p.size ? `?${p}` : '') + location.hash;
}
// Links that switch Before / After / Built carry the token (they are page navigations, not API calls).
export const viewUrl = (what, extra = {}) => `/__cequ/view/${what}?${new URLSearchParams({ to: here(), ...extra, token: CFG.token })}`;
export const withToken = url => (/^\/__cequ\/(view|build)\//.test(url || '') ? `${url}${url.includes('?') ? '&' : '?'}token=${CFG.token}` : url);
