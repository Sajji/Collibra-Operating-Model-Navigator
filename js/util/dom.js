export const SVG_NS = 'http://www.w3.org/2000/svg';

function applyAttrs(el, attrs, isSvg) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') {
      el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    } else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (val == null) continue;
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    } else if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else if (k === 'text') {
      el.textContent = String(v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (!isSvg && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected')) {
      el[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.append(c);
    else el.append(document.createTextNode(String(c)));
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs, false);
  appendChildren(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs, true);
  appendChildren(el, children);
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

// Returns nodes for `text` with case-insensitive matches of `query` wrapped in <mark>.
export function highlight(text, query) {
  const str = String(text ?? '');
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [str];
  const lower = str.toLowerCase();
  const out = [];
  let i = 0;
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, i)) {
    if (at > i) out.push(str.slice(i, at));
    out.push(h('mark', null, str.slice(at, at + q.length)));
    i = at + q.length;
  }
  if (i < str.length) out.push(str.slice(i));
  return out;
}

let toastHost = null;
export function toast(message, { kind = 'info', timeout = 5000 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast toast-${kind}` }, h('span', null, message),
    h('button', { class: 'icon-btn', 'aria-label': 'Dismiss', onclick: () => el.remove() }, '×'));
  toastHost.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: fileName, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
