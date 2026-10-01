export function slugify(s) {
  const out = String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'export';
}

export function isoDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function exportFileName(typeName, ext, date = new Date()) {
  return `${slugify(typeName)}_operating-model_${isoDate(date)}.${ext}`;
}

const nf = new Intl.NumberFormat('en-US');
export function formatNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) ? nf.format(n) : '—';
}

export function formatDateTime(ms) {
  if (ms == null || ms === '') return '—';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function plural(n, one, many = `${one}s`) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

export function userDisplayName(u) {
  if (!u) return '';
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.userName || u.emailAddress || u.id || '';
}

export function initials(u) {
  const name = userDisplayName(u);
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function truncate(s, max) {
  const str = String(s ?? '');
  return str.length > max ? str.slice(0, Math.max(0, max - 1)) + '…' : str;
}

export function acronymFor(type) {
  const code = type?.symbolData?.acronymCode;
  if (code) return String(code).slice(0, 3);
  const letters = String(type?.name ?? '?').replace(/[^A-Za-z0-9]/g, '');
  return (letters.slice(0, 2) || '?').toUpperCase();
}

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function relativeLuminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function contrastText(bg) {
  const rgb = parseHex(bg);
  if (!rgb) return '#ffffff';
  return contrastRatio(rgb, [0, 0, 0]) >= contrastRatio(rgb, [255, 255, 255]) ? '#000000' : '#ffffff';
}

export const DEFAULT_TYPE_COLOR = '#5b6b7f';

export function typeColor(type) {
  return parseHex(type?.symbolData?.color) ? type.symbolData.color : DEFAULT_TYPE_COLOR;
}
