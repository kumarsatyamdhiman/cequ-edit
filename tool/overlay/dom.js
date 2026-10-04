// h('button', { class: 'x', onclick }, 'text', child) → element
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter(x => x != null && x !== false));
  return el;
}

export const escapeHTML = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toast(root, message, kind = 'info', ms = 4200) {
  const t = h('div', { class: `cequ-toast cequ-toast--${kind}`, role: 'status' }, message);
  root.append(t);
  setTimeout(() => t.classList.add('cequ-out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}
