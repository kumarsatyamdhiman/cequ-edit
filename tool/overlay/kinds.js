// Which changes CEQU-Edit applies itself (instantly, no Claude) and which go to Claude.
// Shared by the browser dialog and the server, so both always agree.

export const INSTANT_PAYLOADS = ['text', 'image', 'color', 'remove', 'layout'];

// Text with no markup or template characters: safe to swap literally in any source language.
export const plainText = s => Boolean(String(s ?? '').trim()) && !/[{}<>&%@$\\`]/.test(String(s));

// The markup of an HTML fragment with every text run removed: equal skeletons mean only the words changed.
export const skeleton = html => String(html ?? '').replace(/(^|>)[^<]*(?=<|$)/g, '$1');

// Static sites: only control values (no free-text instruction) on an element that exists in the source.
// App projects (target.located): the exact source position must be known and every value must be a
// literal there (spec §11); layout, remove, element colours and anything else go to Claude.
export function isDirect(item) {
  const keys = Object.keys(item?.payload || {}), t = item?.target || {}, p = item?.payload || {};
  if (String(item?.instruction || '').trim() || !keys.length) return false;
  if (!t.located) return !t.generatedBy && keys.every(k => INSTANT_PAYLOADS.includes(k));
  if (!t.src) return false;
  return keys.every(k =>
    (k === 'text' && Boolean(t.located.literal?.text) && plainText(p.text?.fromPlain) && plainText(p.text?.plain) && skeleton(p.text?.from) === skeleton(p.text?.to)) ||
    (k === 'image' && Boolean(t.located.literal?.src) && p.image?.scope !== 'everywhere') ||
    (k === 'color' && [].concat(p.color || []).length > 0 && [].concat(p.color).every(c => c.scope === 'token')));
}
