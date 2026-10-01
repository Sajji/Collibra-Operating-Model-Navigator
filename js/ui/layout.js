// Pure geometry for the visualization. Coordinates are SVG user units with the hub centred at (0,0).
import { itemKey } from '../model/assignment.js';
import { KIND_GROUP_ORDER } from '../model/normalize.js';
import { truncate } from '../util/format.js';

export const MAX_ITEMS_PER_RING = 18;
export const MAX_REL_ROWS = 18;
const PILL_H = 28;
const ATTR_ROW = 36;
const HEADER_ROW = 28;
const REL_ROW = 44;
const RING_GAP = 48;
const GAP_ATTR = 80;
const GAP_REL = 90;
const SAT_GAP = 56;
const MID_GAP = 36;
const NAME_MAX = 34;

export const estimateWidth = (text, size = 13) => String(text ?? '').length * size * 0.56;

function curveFn(mode, maxAbsY) {
  if (mode === 'columns') return () => 0;
  const R = Math.max(420, maxAbsY * 1.25);
  return (y) => R - Math.sqrt(Math.max(0, R * R - y * y));
}

function attrRows(attrs, groupByKind) {
  if (!groupByKind) return attrs.map((item) => ({ type: 'item', item }));
  const groups = new Map();
  for (const a of attrs) {
    const g = a.kind?.group ?? 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(a);
  }
  const order = [...groups.keys()].sort((x, y) => KIND_GROUP_ORDER.indexOf(x) - KIND_GROUP_ORDER.indexOf(y));
  const rows = [];
  for (const g of order) {
    rows.push({ type: 'header', group: g, count: groups.get(g).length });
    for (const item of groups.get(g)) rows.push({ type: 'item', item, group: g });
  }
  return rows;
}

function splitRings(rows) {
  const items = rows.filter((r) => r.type === 'item').length;
  const ringCount = Math.max(1, Math.ceil(items / MAX_ITEMS_PER_RING));
  const perRing = Math.ceil(items / ringCount);
  const rings = [[]];
  let count = 0;
  const newRing = () => {
    rings.push([]);
    count = 0;
  };
  for (const row of rows) {
    if (count >= perRing) {
      newRing();
      if (row.type === 'item' && row.group) rings[rings.length - 1].push({ type: 'header', group: row.group, cont: true });
    }
    rings[rings.length - 1].push(row);
    if (row.type === 'item') count++;
  }
  return rings.filter((r) => r.some((x) => x.type === 'item'));
}

const rowHeight = (r) => (r.type === 'header' ? HEADER_ROW : ATTR_ROW);

function attrPillWidth(item, measure) {
  const badges = (item.required ? 64 : 0) + (item.multi ? 44 : 0);
  return Math.min(300, Math.max(120, measure(truncate(item.name, NAME_MAX)) + 44 + badges));
}

export function computeLayout(scope, {
  mode = 'orbital',
  showInherited = true,
  groupByKind = true,
  expanded = {},
  hubTitle = '',
  hubSubtitle = '',
  measure = (t, size) => estimateWidth(t, size),
} = {}) {
  const keep = (x) => showInherited || !x.inheritedFrom;
  const attrs = (scope?.attributes ?? []).filter(keep);
  const rels = (scope?.relations ?? []).filter(keep);
  const complex = (scope?.complexRelations ?? []).filter(keep);

  const hubW = Math.min(420, Math.max(260, measure(hubTitle, 18) + 110, measure(hubSubtitle, 12) + 96));
  const hubH = 116;
  const hub = { x: -hubW / 2, y: -hubH / 2, w: hubW, h: hubH };
  const nodes = [];
  const edges = [];
  const anchorY = (y) => Math.max(-hubH / 2 + 14, Math.min(hubH / 2 - 14, y * 0.3));
  const isColumns = mode === 'columns';

  // Attributes: left side, one or more concentric rings.
  const rings = splitRings(attrRows(attrs, groupByKind));
  const ringHeights = rings.map((r) => r.reduce((s, x) => s + rowHeight(x), 0));
  const attrCurve = curveFn(mode, Math.max(0, ...ringHeights) / 2);
  let ringRight = -hubW / 2 - GAP_ATTR;
  rings.forEach((ring, ri) => {
    const widths = ring.map((r) => (r.type === 'item' ? attrPillWidth(r.item, measure) : measure(r.group, 11) + 60));
    const ringWidth = Math.max(...widths);
    let y = -ringHeights[ri] / 2;
    ring.forEach((row, i) => {
      const h = rowHeight(row);
      const cy = y + h / 2;
      const right = ringRight - attrCurve(cy);
      if (row.type === 'header') {
        nodes.push({ key: `hdr:${row.group}:${ri}`, type: 'header', x: right - widths[i], y: cy - 10, w: widths[i], h: 20, text: `${row.group}${row.cont ? ' (cont.)' : ''}`, count: row.count ?? null, anchor: 'end' });
      } else {
        const w = widths[i];
        const node = { key: itemKey(row.item), type: 'attr', x: right - w, y: cy - PILL_H / 2, w, h: PILL_H, item: row.item, ring: ri };
        nodes.push(node);
        if (ri === 0) {
          const sx = -hubW / 2;
          const sy = anchorY(cy);
          const d = isColumns
            ? `M${sx} ${sy} H${(sx + right) / 2} V${cy} H${right}`
            : `M${sx} ${sy} C${sx - 40} ${sy} ${right + 40} ${cy} ${right} ${cy}`;
          edges.push({ key: `e:${node.key}`, nodeKey: node.key, kind: 'attr', d, inherited: !!row.item.inheritedFrom });
        }
      }
      y += h;
    });
    ringRight -= ringWidth + RING_GAP;
  });

  // Relations: right side. Outgoing above the centre line, incoming below, complex relations last.
  const sections = [];
  for (const dir of ['out', 'in']) {
    const list = rels.filter((r) => r.direction === dir);
    if (!list.length) continue;
    const limit = expanded[dir] ? list.length : MAX_REL_ROWS;
    sections.push({ dir, rows: list.slice(0, limit), hidden: Math.max(0, list.length - limit) });
  }

  const labelWidth = (text) => Math.min(250, Math.max(90, measure(truncate(text, NAME_MAX), 12) + 40));
  const allLabels = [
    ...sections.flatMap((s) => s.rows.map((r) => labelWidth(r.label))),
    ...complex.map((c) => labelWidth(c.name) + 30),
  ];
  const labelCol = allLabels.length ? Math.max(...allLabels) : 0;
  const rowsOf = (s) => s.rows.length + (s.hidden ? 1 : 0);
  const outSection = sections.find((s) => s.dir === 'out');
  const inSection = sections.find((s) => s.dir === 'in');
  const outHeight = outSection ? rowsOf(outSection) * REL_ROW + HEADER_ROW : 0;
  const inHeight = inSection ? rowsOf(inSection) * REL_ROW + HEADER_ROW : 0;
  const complexHeight = complex.length ? complex.length * REL_ROW + HEADER_ROW : 0;
  const relCurve = curveFn(mode, Math.max(outHeight, inHeight + complexHeight) + MID_GAP);
  const labelLeft = (y) => hubW / 2 + GAP_REL + relCurve(y);

  const placeSection = (section, startY) => {
    let y = startY;
    const dirLabel = section.dir === 'out' ? 'Outgoing' : 'Incoming';
    nodes.push({ key: `hdr:${section.dir}`, type: 'header', x: labelLeft(y + HEADER_ROW / 2), y: y + 4, w: labelCol, h: 20, text: dirLabel, count: section.rows.length + section.hidden, anchor: 'start' });
    y += HEADER_ROW;
    let i = 0;
    while (i < section.rows.length) {
      const other = section.rows[i].otherType;
      let j = i;
      while (j < section.rows.length && section.rows[j].otherType?.id === other?.id) j++;
      const group = section.rows.slice(i, j);
      const top = y;
      const rowYs = group.map((_, k) => top + k * REL_ROW + REL_ROW / 2);
      const satX = hubW / 2 + GAP_REL + labelCol + SAT_GAP + Math.max(...rowYs.map(relCurve));
      const satName = other?.name ?? '?';
      const satW = Math.min(280, Math.max(160, measure(truncate(satName, NAME_MAX), 13) + 70));
      const satKey = `sat:${section.dir}:${other?.id ?? i}`;
      nodes.push({ key: satKey, type: 'satellite', x: satX, y: top + 3, w: satW, h: group.length * REL_ROW - 6, otherType: other, items: group, dir: section.dir, inherited: group.every((g) => g.inheritedFrom) });
      group.forEach((item, k) => {
        const cy = rowYs[k];
        const lx = labelLeft(cy);
        const lw = labelWidth(item.label);
        const key = itemKey(item);
        nodes.push({ key, type: 'rel', x: lx, y: cy - 13, w: lw, h: 26, item, dir: section.dir, satKey });
        const hx = hubW / 2;
        const hy = anchorY(cy);
        const toLabel = isColumns
          ? `M${hx} ${hy} H${(hx + lx) / 2} V${cy} H${lx}`
          : `M${hx} ${hy} C${hx + 50} ${hy} ${lx - 50} ${cy} ${lx} ${cy}`;
        const fromLabel = isColumns
          ? `M${lx} ${cy} H${(hx + lx) / 2} V${hy} H${hx}`
          : `M${lx} ${cy} C${lx - 50} ${cy} ${hx + 50} ${hy} ${hx} ${hy}`;
        edges.push({ key: `e1:${key}`, nodeKey: key, kind: 'rel', dir: section.dir, d: section.dir === 'out' ? toLabel : fromLabel, arrow: section.dir === 'in', inherited: !!item.inheritedFrom });
        edges.push({ key: `e2:${key}`, nodeKey: key, kind: 'rel', dir: section.dir, d: section.dir === 'out' ? `M${lx + lw} ${cy} L${satX} ${cy}` : `M${satX} ${cy} L${lx + lw} ${cy}`, arrow: section.dir === 'out', inherited: !!item.inheritedFrom });
      });
      y += group.length * REL_ROW;
      i = j;
    }
    if (section.hidden) {
      const cy = y + REL_ROW / 2;
      nodes.push({ key: `more:${section.dir}`, type: 'more', x: labelLeft(cy), y: cy - 13, w: 140, h: 26, dir: section.dir, count: section.hidden });
      y += REL_ROW;
    }
    return y;
  };

  if (outSection) placeSection(outSection, -MID_GAP / 2 - outHeight);
  let below = MID_GAP / 2;
  if (inSection) below = placeSection(inSection, below);
  if (complex.length) {
    let y = below + (inSection ? 12 : 0);
    nodes.push({ key: 'hdr:complex', type: 'header', x: labelLeft(y + HEADER_ROW / 2), y: y + 4, w: labelCol, h: 20, text: 'Complex relations', count: complex.length, anchor: 'start' });
    y += HEADER_ROW;
    for (const item of complex) {
      const cy = y + REL_ROW / 2;
      const lx = labelLeft(cy);
      const w = labelWidth(item.name) + 30;
      const key = itemKey(item);
      nodes.push({ key, type: 'complex', x: lx, y: cy - 17, w, h: 34, item });
      const hx = hubW / 2;
      const hy = anchorY(cy);
      edges.push({ key: `e:${key}`, nodeKey: key, kind: 'complex', d: isColumns ? `M${hx} ${hy} H${(hx + lx) / 2} V${cy} H${lx}` : `M${hx} ${hy} C${hx + 50} ${hy} ${lx - 50} ${cy} ${lx} ${cy}`, inherited: !!item.inheritedFrom });
      y += REL_ROW;
    }
  }

  const pad = 48;
  let minX = hub.x, minY = hub.y, maxX = hub.x + hub.w, maxY = hub.y + hub.h;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const bounds = { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
  return { hub, nodes, edges, bounds, counts: { attributes: attrs.length, relations: rels.length, complex: complex.length } };
}

export function rectsOverlap(a, b, gap = 0) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}
