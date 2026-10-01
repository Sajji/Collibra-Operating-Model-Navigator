import { s, h, clear, prefersReducedMotion } from '../util/dom.js';
import { toPlainText } from '../util/sanitize.js';
import { computeLayout, estimateWidth } from './layout.js';
import { itemKey, formatOccurrence } from '../model/assignment.js';
import { acronymFor, contrastText, typeColor, truncate, formatNumber } from '../util/format.js';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

let measureCtx = null;
export function measureText(text, size = 13, weight = 400) {
  try {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    measureCtx.font = `${weight} ${size}px ${FONT}`;
    return measureCtx.measureText(String(text ?? '')).width;
  } catch {
    return estimateWidth(text, size);
  }
}

function defs() {
  const arrow = (id, cls) => s('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' },
    s('path', { d: 'M0 0 L10 5 L0 10 z', class: cls }));
  return s('defs', null,
    arrow('omx-arrow-out', 'arrow arrow-out'),
    arrow('omx-arrow-in', 'arrow arrow-in'),
    s('pattern', { id: 'omx-dots', width: 24, height: 24, patternUnits: 'userSpaceOnUse' }, s('circle', { cx: 2, cy: 2, r: 1.1, class: 'grid-dot' })),
    s('filter', { id: 'omx-shadow', x: '-20%', y: '-20%', width: '140%', height: '160%' },
      s('feDropShadow', { dx: 0, dy: 2, stdDeviation: 3, 'flood-color': '#0f172a', 'flood-opacity': 0.14 })));
}

function badge(x, y, size, type) {
  const color = typeColor(type);
  return [
    s('rect', { x, y, width: size, height: size, rx: size * 0.28, fill: color, stroke: 'rgba(0,0,0,0.14)', 'stroke-width': 1, class: 'svg-badge' }),
    s('text', { x: x + size / 2, y: y + size / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: contrastText(color), class: 'svg-badge-text', 'font-size': Math.round(size * 0.4) }, acronymFor(type)),
  ];
}

function hexagon(x, y, w, hgt) {
  const i = hgt / 2;
  return `${x + i},${y} ${x + w - i},${y} ${x + w},${y + hgt / 2} ${x + w - i},${y + hgt} ${x + i},${y + hgt} ${x},${y + hgt / 2}`;
}

export function createViz(container, callbacks) {
  const { onSelect, onOpenType, onPrefChange, onScopeChange } = callbacks;
  const svg = s('svg', { class: 'viz-svg', role: 'group', 'aria-label': 'Operating model visualization', 'font-family': FONT });
  const bg = s('rect', { class: 'viz-bg', x: -50000, y: -50000, width: 100000, height: 100000, fill: 'url(#omx-dots)' });
  const root = s('g', { class: 'viz-root' });
  svg.append(defs(), bg, root);

  const tooltip = h('div', { class: 'viz-tooltip', role: 'tooltip', hidden: true });
  const toolbar = h('div', { class: 'viz-toolbar', role: 'toolbar', 'aria-label': 'Visualization controls' });
  const legend = h('div', { class: 'viz-legend' });
  container.append(svg, toolbar, legend, tooltip);

  const st = {
    layout: null,
    scope: null,
    info: null,
    prefs: { mode: 'orbital', showInherited: true, groupByKind: true, legend: true },
    expanded: {},
    selectedKey: null,
    vb: { x: -500, y: -300, w: 1000, h: 600 },
    userZoomed: false,
    fitZoom: 1,
    nodeEls: new Map(),
    edgeEls: new Map(),
    token: 0,
  };

  const size = () => ({ w: container.clientWidth || 800, h: container.clientHeight || 600 });
  const zoom = () => size().w / st.vb.w;

  function applyViewBox() {
    const { x, y, w, h: hh } = st.vb;
    svg.setAttribute('viewBox', `${x} ${y} ${w} ${hh}`);
    const z = toolbar.querySelector('.zoom-level');
    if (z) z.textContent = `${Math.round(zoom() * 100)}%`;
  }

  function fit() {
    if (!st.layout) return;
    const { w: cw, h: ch } = size();
    const top = Math.min(toolbar.offsetHeight + 12, ch / 3);
    const b = st.layout.bounds;
    const z = Math.min(cw / b.w, (ch - top) / b.h, 1.25);
    st.fitZoom = z;
    const vw = cw / z;
    const vh = ch / z;
    st.vb = { x: b.x + b.w / 2 - vw / 2, y: b.y + b.h / 2 - vh / 2 - top / z / 2, w: vw, h: vh };
    st.userZoomed = false;
    applyViewBox();
  }

  function setZoom(z, cx, cy) {
    const { w: cw, h: ch } = size();
    const minZ = Math.min(MIN_ZOOM, st.fitZoom);
    const nz = Math.max(minZ, Math.min(MAX_ZOOM, z));
    const px = cx ?? st.vb.x + st.vb.w / 2;
    const py = cy ?? st.vb.y + st.vb.h / 2;
    const rx = (px - st.vb.x) / st.vb.w;
    const ry = (py - st.vb.y) / st.vb.h;
    const vw = cw / nz;
    const vh = ch / nz;
    st.vb = { x: px - rx * vw, y: py - ry * vh, w: vw, h: vh };
    st.userZoomed = true;
    applyViewBox();
  }

  function clientToUser(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return { x: st.vb.x + ((clientX - r.left) / r.width) * st.vb.w, y: st.vb.y + ((clientY - r.top) / r.height) * st.vb.h };
  }

  // Pan / pinch / wheel.
  const pointers = new Map();
  let spaceDown = false;
  let pinchStart = null;
  let panMoved = false;
  const isBackground = (t) => t === svg || t === bg;

  svg.addEventListener('pointerdown', (e) => {
    if (!isBackground(e.target) && !spaceDown && pointers.size === 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    svg.setPointerCapture(e.pointerId);
    panMoved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoom() };
    }
    svg.classList.add('panning');
  });
  svg.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const mid = clientToUser((a.x + b.x) / 2, (a.y + b.y) / 2);
      setZoom(pinchStart.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist), mid.x, mid.y);
      return;
    }
    const r = svg.getBoundingClientRect();
    const dx = ((cur.x - prev.x) / r.width) * st.vb.w;
    const dy = ((cur.y - prev.y) / r.height) * st.vb.h;
    if (Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y) > 1) panMoved = true;
    st.vb.x -= dx;
    st.vb.y -= dy;
    st.userZoomed = true;
    applyViewBox();
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (!pointers.size) svg.classList.remove('panning');
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = clientToUser(e.clientX, e.clientY);
    setZoom(zoom() * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
  }, { passive: false });
  svg.addEventListener('dblclick', (e) => {
    if (isBackground(e.target)) fit();
  });
  svg.addEventListener('click', (e) => {
    if (isBackground(e.target) && !panMoved) clearHover();
  });
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest?.('.viz-toolbar')) {
      onSelect({ kind: 'type' });
      root.querySelector('.hub')?.focus();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/input|textarea|select/i.test(e.target.tagName) && container.contains(document.activeElement ?? null)) {
      spaceDown = true;
      svg.classList.add('pan-ready');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      svg.classList.remove('pan-ready');
    }
  });

  new ResizeObserver(() => {
    if (!st.layout) return;
    if (!st.userZoomed) {
      fit();
      return;
    }
    const z = st.vb.w ? size().w / st.vb.w : 1;
    const cx = st.vb.x + st.vb.w / 2;
    const cy = st.vb.y + st.vb.h / 2;
    const { w: cw, h: ch } = size();
    st.vb = { x: cx - cw / z / 2, y: cy - ch / z / 2, w: cw / z, h: ch / z };
    applyViewBox();
  }).observe(container);

  // Hover highlighting.
  function related(node) {
    const keys = new Set([node.key]);
    if (node.type === 'satellite') node.items.forEach((i) => keys.add(itemKey(i)));
    if (node.type === 'rel') keys.add(node.satKey);
    return keys;
  }

  function setHover(node, anchorEl) {
    const keys = related(node);
    svg.classList.add('has-hover');
    for (const [k, el] of st.nodeEls) el.classList.toggle('hl', keys.has(k));
    for (const [, el] of st.edgeEls) el.classList.toggle('hl', keys.has(el.dataset.node));
    showTooltip(node, anchorEl);
  }

  function clearHover() {
    svg.classList.remove('has-hover');
    for (const el of st.nodeEls.values()) el.classList.remove('hl');
    for (const el of st.edgeEls.values()) el.classList.remove('hl');
    tooltip.hidden = true;
  }

  function tooltipText(node) {
    if (node.type === 'attr') return [`${node.item.name} — ${node.item.kind.label}`, toPlainText(node.item.description)];
    if (node.type === 'rel') {
      const i = node.item;
      return [`${i.sourceType?.name ?? '?'} —${i.role}→ ${i.targetType?.name ?? '?'}`, toPlainText(i.description)];
    }
    if (node.type === 'satellite') return [node.otherType?.name ?? '', `${node.items.length} relation${node.items.length === 1 ? '' : 's'} · click to view, or open this type from the details pane`];
    if (node.type === 'complex') return [node.item.name, toPlainText(node.item.description)];
    if (node.type === 'more') return [`${node.count} more relations`, 'Click to show all'];
    return null;
  }

  function showTooltip(node, el) {
    const t = tooltipText(node);
    if (!t) {
      tooltip.hidden = true;
      return;
    }
    const [title, body] = t;
    clear(tooltip).append(h('strong', null, title), body ? h('p', null, truncate(body, 200)) : null);
    tooltip.hidden = false;
    const r = el.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left - c.left), c.width - 300);
    const top = r.bottom - c.top + 8 + 120 > c.height ? r.top - c.top - 8 - tooltip.offsetHeight : r.bottom - c.top + 8;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  // Selection.
  function select(key) {
    st.selectedKey = key;
    for (const [k, el] of st.nodeEls) el.classList.toggle('selected', k === key);
    root.querySelector('.hub')?.classList.toggle('selected', key === 'hub');
  }

  function activate(node) {
    if (node.type === 'attr') onSelect({ kind: 'attr', id: node.item.id });
    else if (node.type === 'rel') onSelect({ kind: 'rel', id: node.item.id, dir: node.item.direction });
    else if (node.type === 'satellite') onSelect({ kind: 'rel', id: node.items[0].id, dir: node.items[0].direction, via: 'satellite' });
    else if (node.type === 'complex') onSelect({ kind: 'complex', id: node.item.id });
    else if (node.type === 'more') {
      st.expanded[node.dir] = true;
      draw(false);
    }
  }

  function nodeLabel(node) {
    if (node.type === 'attr') return `Attribute ${node.item.name}, ${node.item.kind.label}, ${formatOccurrence(node.item)}${node.item.inheritedFrom ? `, inherited from ${node.item.inheritedFrom.name}` : ''}`;
    if (node.type === 'rel') return `${node.dir === 'out' ? 'Outgoing' : 'Incoming'} relation ${node.item.label} ${node.item.otherType?.name ?? ''}`;
    if (node.type === 'satellite') return `Related asset type ${node.otherType?.name ?? ''}`;
    if (node.type === 'complex') return `Complex relation ${node.item.name}`;
    if (node.type === 'more') return `Show ${node.count} more relations`;
    return '';
  }

  function renderNode(node) {
    const { x, y, w, h: hh } = node;
    if (node.type === 'header') {
      const tx = node.anchor === 'end' ? x + w : x;
      return s('g', { class: 'node-header' },
        s('text', { x: tx, y: y + hh / 2, 'text-anchor': node.anchor, 'dominant-baseline': 'central', class: 'group-label' },
          node.text.toUpperCase(), node.count != null ? s('tspan', { class: 'group-count' }, ` · ${node.count}`) : null));
    }
    const inherited = node.item?.inheritedFrom || (node.type === 'satellite' && node.inherited);
    const g = s('g', {
      class: ['node', `node-${node.type}`, node.dir ? `dir-${node.dir}` : '', inherited ? 'inherited' : '', node.item?.kind ? `kind-${node.item.kind.key}` : ''],
      tabindex: 0,
      role: 'button',
      'aria-label': nodeLabel(node),
      dataset: { key: node.key },
    });
    if (node.type === 'attr') {
      const it = node.item;
      g.append(
        s('rect', { x, y, width: w, height: hh, rx: hh / 2, class: 'pill' }),
        s('text', { x: x + 16, y: y + hh / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'kind-icon' }, it.kind.icon),
        s('text', { x: x + 32, y: y + hh / 2, 'dominant-baseline': 'central', class: 'pill-text' }, truncate(it.name, 34)),
      );
      let bx = x + w - 8;
      if (it.multi) {
        bx -= 38;
        g.append(s('rect', { x: bx, y: y + 6, width: 38, height: hh - 12, rx: 8, class: 'occ-badge occ-multi' }),
          s('text', { x: bx + 19, y: y + hh / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'occ-text' }, 'multi'));
        bx -= 4;
      }
      if (it.required) {
        bx -= 58;
        g.append(s('rect', { x: bx, y: y + 6, width: 58, height: hh - 12, rx: 8, class: 'occ-badge occ-required' }),
          s('text', { x: bx + 29, y: y + hh / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'occ-text' }, 'required'));
      }
    } else if (node.type === 'rel') {
      const glyph = node.dir === 'out' ? '→' : '←';
      g.append(
        s('rect', { x, y, width: w, height: hh, rx: hh / 2, class: 'rel-pill' }),
        s('text', { x: x + w / 2, y: y + hh / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'rel-text' }, `${node.dir === 'in' ? `${glyph} ` : ''}${truncate(node.item.label, 34)}${node.dir === 'out' ? ` ${glyph}` : ''}`),
      );
    } else if (node.type === 'satellite') {
      const t = node.otherType ?? {};
      const full = callbacks.typeById?.(t.id) ?? t;
      const bs = Math.min(30, hh - 10);
      const cy = y + hh / 2;
      g.append(
        s('rect', { x, y, width: w, height: hh, rx: 14, class: 'satellite', filter: 'url(#omx-shadow)' }),
        s('rect', { x, y, width: 5, height: hh, rx: 2.5, fill: typeColor(full), class: 'satellite-stripe' }),
        ...badge(x + 14, cy - bs / 2, bs, full),
        s('text', { x: x + 22 + bs, y: cy - (node.items.length > 1 ? 7 : 0), 'dominant-baseline': 'central', class: 'sat-text' }, truncate(t.name ?? '?', 30)),
        node.items.length > 1 ? s('text', { x: x + 22 + bs, y: cy + 10, 'dominant-baseline': 'central', class: 'sat-sub' }, `${node.items.length} relations`) : null,
      );
    } else if (node.type === 'complex') {
      g.append(
        s('polygon', { points: hexagon(x, y, w, hh), class: 'complex-shape' }),
        s('text', { x: x + w / 2, y: y + hh / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'complex-text' }, truncate(node.item.name, 34)),
      );
    } else if (node.type === 'more') {
      g.append(
        s('rect', { x, y, width: w, height: hh, rx: hh / 2, class: 'more-pill' }),
        s('text', { x: x + w / 2, y: y + hh / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'more-text' }, `+${node.count} more`),
      );
    }
    g.addEventListener('pointerenter', () => setHover(node, g));
    g.addEventListener('pointerleave', clearHover);
    g.addEventListener('focus', () => setHover(node, g));
    g.addEventListener('blur', clearHover);
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      activate(node);
    });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate(node);
      }
    });
    return g;
  }

  function renderHub(layout) {
    const { x, y, w, h: hh } = layout.hub;
    const info = st.info ?? {};
    const type = info.type ?? {};
    const g = s('g', { class: ['hub', st.selectedKey === 'hub' ? 'selected' : ''], tabindex: 0, role: 'button', 'aria-label': `Asset type ${type.name ?? ''}` });
    const counts = info.countsText ?? '';
    g.append(
      s('rect', { x, y, width: w, height: hh, rx: 16, class: 'hub-card', filter: 'url(#omx-shadow)' }),
      ...badge(x + 18, y + 38, 44, type),
      s('text', { x: x + 74, y: y + 26, class: 'hub-path', 'dominant-baseline': 'central' }, truncate(info.pathText ?? '', 44)),
      s('text', { x: x + 74, y: y + 56, class: 'hub-title', 'dominant-baseline': 'central' }, truncate(type.name ?? '', 28)),
      s('text', { x: x + 74, y: y + 86, class: 'hub-counts', 'dominant-baseline': 'central' }, counts),
    );
    const act = () => onSelect({ kind: 'type' });
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      act();
    });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        act();
      }
    });
    return g;
  }

  function emptyMessage() {
    if (!st.scope) return st.info?.emptyText ?? null;
    const n = st.layout;
    if (!n.counts.attributes && !n.counts.relations && !n.counts.complex) {
      return st.scope.raw?.length ? (st.prefs.showInherited ? 'No attributes or relations assigned' : 'No own attributes or relations (inherited items hidden)') : 'This asset type has no assignment';
    }
    return null;
  }

  function draw(animate) {
    const token = ++st.token;
    st.layout = computeLayout(st.scope, {
      mode: st.prefs.mode,
      showInherited: st.prefs.showInherited,
      groupByKind: st.prefs.groupByKind,
      expanded: st.expanded,
      hubTitle: st.info?.type?.name ?? '',
      hubSubtitle: `${st.info?.countsText ?? ''} 00,000`,
      measure: (t, size) => measureText(t, size),
    });
    const layout = st.layout;
    const edgesG = s('g', { class: 'edges' });
    const nodesG = s('g', { class: 'nodes' });
    st.nodeEls = new Map();
    st.edgeEls = new Map();
    for (const e of layout.edges) {
      const markers = e.arrow ? { 'marker-end': `url(#omx-arrow-${e.dir})` } : {};
      const el = s('path', { d: e.d, class: ['edge', `edge-${e.kind}`, e.dir ? `edge-${e.dir}` : '', e.inherited ? 'inherited' : ''], dataset: { node: e.nodeKey }, ...markers });
      st.edgeEls.set(e.key, el);
      edgesG.append(el);
    }
    const hubEl = renderHub(layout);
    nodesG.append(hubEl);
    for (const n of layout.nodes) {
      const el = renderNode(n);
      if (n.type !== 'header') st.nodeEls.set(n.key, el);
      nodesG.append(el);
    }
    const msg = emptyMessage();
    const extra = msg ? s('text', { x: 0, y: layout.hub.y + layout.hub.h + 48, 'text-anchor': 'middle', class: 'empty-text' }, msg) : null;
    const replace = () => {
      if (token !== st.token) return;
      clear(root).append(edgesG, nodesG, extra ?? '');
      select(st.selectedKey);
      if (!st.userZoomed || animate) fit();
      if (animate && !prefersReducedMotion()) {
        let i = 0;
        for (const n of layout.nodes) {
          const el = st.nodeEls.get(n.key);
          if (!el) continue;
          const dx = -(n.x + n.w / 2);
          const dy = -(n.y + n.h / 2);
          el.animate?.([{ transform: `translate(${dx}px, ${dy}px) scale(0.4)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
            { duration: 320, delay: Math.min(i++ * 8, 220), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
        }
        edgesG.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 120, fill: 'backwards' });
      }
    };
    if (animate && root.childNodes.length && !prefersReducedMotion() && root.animate) {
      const fade = root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
      setTimeout(() => {
        fade.cancel();
        replace();
      }, 120);
    } else {
      replace();
    }
  }

  // Toolbar & legend.
  function renderToolbar() {
    const seg = (value, label) => h('button', {
      class: ['seg', st.prefs.mode === value ? 'active' : ''], 'aria-pressed': String(st.prefs.mode === value),
      onclick: () => setPref('mode', value),
    }, label);
    const check = (key, label) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: !!st.prefs[key], onchange: (e) => setPref(key, e.target.checked) }), label);
    const scopes = st.info?.scopes ?? [];
    clear(toolbar).append(
      h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Layout' }, seg('orbital', 'Orbital'), seg('columns', 'Columns')),
      check('showInherited', 'Show inherited'),
      check('groupByKind', 'Group by kind'),
      h('div', { class: 'zoom-group', role: 'group', 'aria-label': 'Zoom' },
        h('button', { class: 'icon-btn', 'aria-label': 'Zoom out', onclick: () => setZoom(zoom() / 1.25) }, '−'),
        h('span', { class: 'zoom-level', 'aria-live': 'polite' }, `${Math.round(zoom() * 100)}%`),
        h('button', { class: 'icon-btn', 'aria-label': 'Zoom in', onclick: () => setZoom(zoom() * 1.25) }, '+'),
        h('button', { class: 'btn btn-small', onclick: fit }, 'Fit')),
      h('button', { class: ['btn btn-small', st.prefs.legend ? 'active' : ''], 'aria-pressed': String(!!st.prefs.legend), onclick: () => setPref('legend', !st.prefs.legend) }, 'Legend'),
      scopes.length > 1
        ? h('label', { class: 'scope-switch' }, 'Scope ',
          h('select', { onchange: (e) => onScopeChange?.(e.target.value) },
            scopes.map((sc) => h('option', { value: sc.id, selected: sc.id === st.scope?.id }, sc.name))))
        : null,
    );
    legend.hidden = !st.prefs.legend;
  }

  function renderLegend() {
    const row = (icon, text, cls = '') => h('li', null, h('span', { class: `legend-icon ${cls}` }, icon), text);
    clear(legend).append(
      h('h3', null, 'Legend'),
      h('ul', null,
        row('Aa', 'Text'), row('◉', 'Single list'), row('☰', 'Multi list'),
        row('#', 'Number'), row('📅', 'Date'), row('◐', 'Boolean'), row('</>', 'Script'),
        row('→', 'Outgoing (role)', 'legend-out'), row('←', 'Incoming (co-role)', 'legend-in'),
        row('⬡', 'Complex relation'),
        row('req', 'Required', 'legend-req'), row('multi', 'Multi-value', 'legend-multi'),
        row('- -', 'Inherited', 'legend-inh')),
    );
  }

  function setPref(key, value) {
    st.prefs[key] = value;
    onPrefChange?.(key, value);
    renderToolbar();
    if (key !== 'legend') draw(false);
    if (key === 'mode') fit();
  }

  renderLegend();

  return {
    // info: { type, pathText, countsText, scopes, emptyText }
    render(scope, info, { prefs, animate = false, resetExpanded = false } = {}) {
      if (prefs) st.prefs = { ...st.prefs, ...prefs };
      if (resetExpanded) st.expanded = {};
      st.scope = scope;
      st.info = info;
      renderToolbar();
      draw(animate);
    },
    updateInfo(info) {
      st.info = { ...st.info, ...info };
      if (!st.layout) return;
      const hubEl = root.querySelector('.hub');
      if (hubEl) {
        const fresh = renderHub(st.layout);
        hubEl.replaceWith(fresh);
        select(st.selectedKey);
      }
    },
    select,
    fit,
    clearHover,
    reveal(key) {
      const n = st.layout?.nodes.find((x) => x.key === key);
      if (!n) return;
      const inView = n.x >= st.vb.x && n.y >= st.vb.y && n.x + n.w <= st.vb.x + st.vb.w && n.y + n.h <= st.vb.y + st.vb.h;
      if (!inView) {
        st.vb.x = n.x + n.w / 2 - st.vb.w / 2;
        st.vb.y = n.y + n.h / 2 - st.vb.h / 2;
        applyViewBox();
      }
    },
    focusHub: () => root.querySelector('.hub')?.focus(),
    getSvg: () => svg,
    getLayout: () => st.layout,
    getPrefs: () => ({ ...st.prefs }),
    formatCounts: (sum, assetCount) => `${formatNumber(sum.attributes)} attributes · ${formatNumber(sum.relations)} relations · ${assetCount == null ? '… assets' : `${formatNumber(assetCount)} assets`}`,
    onOpenType,
  };
}
