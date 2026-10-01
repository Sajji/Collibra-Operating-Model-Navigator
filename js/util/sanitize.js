const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'head', 'title', 'link', 'meta', 'base', 'frame', 'frameset', 'textarea', 'select', 'button', 'form', 'input']);

export function safeHref(href) {
  const t = String(href ?? '').trim();
  if (!/^(https?:|mailto:)/i.test(t)) return null;
  try {
    const u = new URL(t);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function copyInto(src, dest, doc) {
  for (const node of src.childNodes) {
    if (node.nodeType === 3) {
      dest.append(doc.createTextNode(node.data));
    } else if (node.nodeType === 1) {
      const tag = node.localName;
      if (DROP.has(tag)) continue;
      if (!ALLOWED.has(tag)) {
        copyInto(node, dest, doc);
        continue;
      }
      const el = doc.createElement(tag);
      if (tag === 'a') {
        const href = safeHref(node.getAttribute('href'));
        if (href) {
          el.setAttribute('href', href);
          el.setAttribute('rel', 'noopener noreferrer');
          el.setAttribute('target', '_blank');
        }
      }
      copyInto(node, el, doc);
      dest.append(el);
    }
  }
}

// Parses untrusted rich text and rebuilds it from an allow-list; never uses innerHTML.
export function sanitizeToFragment(html, doc = document) {
  const frag = doc.createDocumentFragment();
  if (html == null || html === '') return frag;
  const parsed = new DOMParser().parseFromString(String(html), 'text/html');
  copyInto(parsed.body, frag, doc);
  return frag;
}

export function toPlainText(html) {
  if (html == null) return '';
  const parsed = new DOMParser().parseFromString(String(html).replace(/<(br|\/p|\/li|\/tr)\b[^>]*>/gi, '$& '), 'text/html');
  return (parsed.body.textContent || '').replace(/\s+/g, ' ').trim();
}
