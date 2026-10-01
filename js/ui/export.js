import { s, downloadBlob, toast } from '../util/dom.js';
import { wrapText } from '../util/wrap.js';
import { buildJpegPdf } from '../util/pdf.js';
import { exportFileName, truncate } from '../util/format.js';
import { measureText } from './viz.js';

const STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'opacity', 'fill-opacity', 'stroke-opacity',
  'font-size', 'font-weight', 'font-family', 'font-style', 'text-anchor', 'dominant-baseline', 'visibility', 'display'];
const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const DETAILS_W = 540;
const HEADER_H = 96;
const MARGIN = 32;
const MAX_CANVAS_SIDE = 16000;
const MAX_CANVAS_AREA = 120e6;

// Clone `src` and copy computed presentation styles as attributes (CSS variables don't survive serialization).
function cloneWithStyles(src) {
  const clone = src.cloneNode(true);
  const a = [src, ...src.querySelectorAll('*')];
  const b = [clone, ...clone.querySelectorAll('*')];
  a.forEach((el, i) => {
    const target = b[i];
    const cs = getComputedStyle(el);
    for (const p of STYLE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && v !== 'auto' && v !== 'normal') target.setAttribute(p, v);
    }
    target.removeAttribute('class');
    target.removeAttribute('tabindex');
    target.removeAttribute('role');
    target.removeAttribute('style');
    for (const k of Object.keys(target.dataset ?? {})) delete target.dataset[k];
  });
  return clone;
}

function withLightTheme(fn) {
  const html = document.documentElement;
  const prev = html.getAttribute('data-theme');
  html.setAttribute('data-theme', 'light');
  html.classList.add('exporting');
  try {
    return fn();
  } finally {
    html.classList.remove('exporting');
    if (prev == null) html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', prev);
  }
}

function detailsColumn(report, x, y0) {
  const g = s('g', { 'font-family': FONT });
  let y = y0;
  const width = DETAILS_W - 24;
  const text = (content, { size = 12, weight = 400, fill = '#1f2937', dx = 0 } = {}) => {
    g.append(s('text', { x: x + dx, y, 'font-size': size, 'font-weight': weight, fill }, content));
  };
  if (!report) {
    text('No details available.', { fill: '#6b7280' });
    return { g, height: 24 };
  }
  text(report.title ?? '', { size: 18, weight: 700, fill: '#111827' });
  y += 20;
  if (report.subtitle) {
    text(report.subtitle, { size: 12, fill: '#6b7280' });
    y += 18;
  }
  for (const sec of report.sections ?? []) {
    y += 14;
    g.append(s('line', { x1: x, x2: x + width, y1: y - 12, y2: y - 12, stroke: '#e5e7eb', 'stroke-width': 1 }));
    text(sec.title, { size: 13, weight: 700, fill: '#111827' });
    y += 18;
    for (const line of sec.lines ?? []) {
      for (const wrapped of wrapText(line, width, (t) => measureText(t, 12))) {
        text(wrapped);
        y += 16;
      }
    }
    if (sec.table) {
      const cols = sec.table.columns;
      const widths = [0.36, 0.34, 0.1, 0.2].map((f) => f * width);
      let cx = 0;
      cols.forEach((c, i) => {
        text(c, { size: 11, weight: 700, fill: '#374151', dx: cx });
        cx += widths[i];
      });
      y += 16;
      for (const row of sec.table.rows) {
        cx = 0;
        row.forEach((cell, i) => {
          let v = String(cell ?? '');
          while (v.length > 1 && measureText(v, 11) > widths[i] - 8) v = truncate(v, v.length - 1);
          text(v, { size: 11, fill: '#1f2937', dx: cx });
          cx += widths[i];
        });
        y += 15;
      }
    }
  }
  return { g, height: y - y0 };
}

export function createExporter({ viz, details, getContext }) {
  function buildExportSvg() {
    const ctx = getContext();
    const layout = viz.getLayout();
    const live = viz.getSvg();
    if (!layout || !live) throw new Error('Nothing to export yet');
    viz.clearHover();
    const b = layout.bounds;
    const { vizGroup, defsClone } = withLightTheme(() => ({
      vizGroup: cloneWithStyles(live.querySelector('.viz-root')),
      defsClone: cloneWithStyles(live.querySelector('defs')),
    }));
    defsClone.querySelector('pattern')?.remove();

    const detailsX = MARGIN + b.w + MARGIN;
    const col = detailsColumn(details.getReport(), detailsX, HEADER_H + MARGIN + 12);
    const width = detailsX + DETAILS_W + MARGIN;
    const height = HEADER_H + MARGIN + Math.max(b.h, col.height + 24) + MARGIN;

    const svg = s('svg', { xmlns: 'http://www.w3.org/2000/svg', width, height, viewBox: `0 0 ${width} ${height}`, 'font-family': FONT });
    const when = new Date().toLocaleString();
    svg.append(
      defsClone,
      s('rect', { x: 0, y: 0, width, height, fill: '#ffffff' }),
      s('rect', { x: 0, y: 0, width, height: HEADER_H, fill: '#f3f4f6' }),
      s('text', { x: MARGIN, y: 30, 'font-size': 13, fill: '#6b7280', 'font-weight': 600 }, 'OPERATING MODEL EXPLORER'),
      s('text', { x: MARGIN, y: 62, 'font-size': 26, 'font-weight': 700, fill: '#111827' }, ctx.typeName ?? ''),
      s('text', { x: width - MARGIN, y: 30, 'font-size': 12, fill: '#374151', 'text-anchor': 'end' }, ctx.host ?? ''),
      s('text', { x: width - MARGIN, y: 50, 'font-size': 12, fill: '#374151', 'text-anchor': 'end' }, `Exported by ${ctx.userName ?? ''}`),
      s('text', { x: width - MARGIN, y: 70, 'font-size': 12, fill: '#374151', 'text-anchor': 'end' }, when),
      s('line', { x1: detailsX - MARGIN / 2, x2: detailsX - MARGIN / 2, y1: HEADER_H + 16, y2: height - 16, stroke: '#e5e7eb' }),
    );
    vizGroup.setAttribute('transform', `translate(${MARGIN - b.x} ${HEADER_H + MARGIN - b.y})`);
    svg.append(vizGroup, col.g);
    return svg;
  }

  const serialize = (svg) => `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`;

  async function rasterize(svg) {
    const w = Number(svg.getAttribute('width'));
    const hgt = Number(svg.getAttribute('height'));
    let scale = Math.min(2, (window.devicePixelRatio || 1) * 2);
    scale = Math.min(scale, MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / hgt, Math.sqrt(MAX_CANVAS_AREA / (w * hgt)));
    const url = URL.createObjectURL(new Blob([serialize(svg)], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = new Image();
      img.decoding = 'sync';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Could not render the export image'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(hgt * scale);
      const c2d = canvas.getContext('2d');
      c2d.fillStyle = '#ffffff';
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      c2d.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const toBlob = (canvas, type, q) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), type, q));

  async function run(label, fn) {
    try {
      await fn();
    } catch (e) {
      console.error(`[om-explorer] ${label} export failed`, e);
      toast(`${label} export failed: ${e.message}`, { kind: 'error' });
    }
  }

  const name = (ext) => exportFileName(getContext().typeName ?? 'operating-model', ext);

  return {
    buildExportSvg,
    serialize,
    rasterize,
    toBlob,
    svg: () => run('SVG', async () => downloadBlob(new Blob([serialize(buildExportSvg())], { type: 'image/svg+xml' }), name('svg'))),
    png: () => run('PNG', async () => downloadBlob(await toBlob(await rasterize(buildExportSvg()), 'image/png'), name('png'))),
    pdf: () => run('PDF', async () => {
      const canvas = await rasterize(buildExportSvg());
      const jpeg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
      downloadBlob(new Blob([buildJpegPdf(jpeg, canvas.width, canvas.height)], { type: 'application/pdf' }), name('pdf'));
    }),
    json: () => run('JSON', async () => {
      const data = await getContext().jsonPayload();
      downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name('json'));
    }),
    print() {
      viz.clearHover();
      viz.fit();
      window.print();
    },
  };
}
