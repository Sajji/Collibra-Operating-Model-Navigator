import { createHttp, resolveBaseURL } from './api/http.js';
import { createRestApi } from './api/rest.js';
import { createGraphqlApi } from './api/graphql.js';
import { isAbort } from './api/queue.js';
import { buildHierarchy, withMissingParents } from './model/hierarchy.js';
import { indexById } from './model/normalize.js';
import { buildTypeModel, pickScope, applyInheritance, scopeKeys, summarize } from './model/assignment.js';
import { createStore, createPrefs, createMemo } from './model/store.js';
import { createIndexer } from './model/indexer.js';
import { parseHash, formatHash } from './router.js';
import { state } from './state.js';
import { h, clear, toast } from './util/dom.js';
import { userDisplayName, initials } from './util/format.js';
import { createTree } from './ui/tree.js';
import { createViz } from './ui/viz.js';
import { createDetails } from './ui/details.js';
import { createSearch } from './ui/search.js';
import { createExporter } from './ui/export.js';

const META_CACHE_KEY = 'meta:v2';
const $ = (id) => document.getElementById(id);
const app = $('app');

window.addEventListener('error', (e) => {
  console.error('[om-explorer] uncaught error', e.error ?? e.message);
  toast(`Unexpected error: ${e.message}`, { kind: 'error' });
});
window.addEventListener('unhandledrejection', (e) => {
  if (isAbort(e.reason)) return;
  console.error('[om-explorer] unhandled rejection', e.reason);
  toast(`Unexpected error: ${e.reason?.message ?? e.reason}`, { kind: 'error' });
});

const baseURL = resolveBaseURL();
state.baseURL = baseURL;
const prefs = createPrefs();
const store = createStore();
const memo = createMemo();

let signedOut = false;
function showSignedOut() {
  if (signedOut) return;
  signedOut = true;
  app.hidden = true;
  const page = $('fullpage');
  page.hidden = false;
  clear(page).append(h('div', { class: 'fullpage-card' },
    h('h1', null, "You're not signed in to Collibra"),
    h('p', null, 'Sign in to Collibra in this browser, then come back to this page.'),
    h('a', { class: 'btn btn-primary', href: `${baseURL}/` }, 'Go to Collibra sign-in'),
    h('button', { class: 'btn', onclick: () => location.reload() }, 'I have signed in — retry')));
}

function showFatal(message, retry) {
  app.hidden = true;
  const page = $('fullpage');
  page.hidden = false;
  clear(page).append(h('div', { class: 'fullpage-card' },
    h('h1', null, 'Something went wrong'), h('p', null, message),
    h('button', { class: 'btn btn-primary', onclick: retry }, 'Retry')));
}

const http = createHttp({ baseURL, onUnauthenticated: showSignedOut });
const rest = createRestApi(http);
const graphql = createGraphqlApi(http);

// --- Cached lookups ---------------------------------------------------------------------------
const assignments = (typeId, opts = {}) => memo.get(`asg:${typeId}`, () => rest.assignmentsForType(typeId, { priority: opts.priority ?? 'interactive' }));

const indexer = createIndexer({
  api: { assignmentsForResource: rest.assignmentsForResource, assignmentsForType: (id, o) => assignments(id, o) },
  getTypeIds: () => state.meta.assetTypes.map((t) => t.id),
  store,
});

function typeName(id) {
  return state.meta.assetTypesById.get(id)?.name ?? '?';
}

function assetCounts(typeId) {
  return memo.get(`count:${typeId}`, async () => {
    const desc = state.hierarchy.descendants(typeId);
    const [own, withSubtypes] = await Promise.all([
      rest.countAssets([typeId]),
      desc.length ? rest.countAssets([typeId, ...desc]) : null,
    ]);
    return { own, withSubtypes: withSubtypes ?? own };
  });
}

function userName(id) {
  return memo.get(`user:${id}`, async () => userDisplayName(await rest.user(id)) || id);
}

function attributeTypeFull(id) {
  return memo.get(`attr:${id}`, () => rest.attributeType(id));
}

function workflowsForType(typeId) {
  return memo.get(`wf:${typeId}`, async () => {
    const all = await memo.get('workflows', () => rest.workflowDefinitions());
    const lineage = new Set([typeId, ...state.hierarchy.ancestors(typeId)]);
    return all.filter((w) => {
      const target = w.businessItemDiscriminator ?? w.businessItemResourceType;
      if (target && target !== 'ASSET') return false;
      return (w.assetAssignmentRules ?? []).some((r) => {
        const rid = r.assetType?.id;
        return rid === typeId || (!r.exactResourceTypeMatch && lineage.has(rid));
      });
    });
  });
}

function typeModel(typeId) {
  return memo.get(`model:${typeId}`, async () => {
    const hier = state.hierarchy;
    const ancestors = hier.ancestors(typeId);
    const maps = {
      relationTypesById: state.meta.relationTypesById,
      attributeTypesById: state.meta.attributeTypesById,
      complexRelationTypesById: state.meta.complexRelationTypesById,
    };
    const [own, ...ancLists] = await Promise.all([assignments(typeId), ...ancestors.map((a) => assignments(a).catch(() => null))]);
    const model = buildTypeModel({ typeId, assignments: own, ancestorIds: ancestors, ...maps });
    const ancModels = ancestors.map((a, i) => (ancLists[i] ? buildTypeModel({ typeId: a, assignments: ancLists[i], ancestorIds: hier.ancestors(a), ...maps }) : null));
    for (const scope of model.scopes) {
      applyInheritance(scope, ancestors.map((a, i) => {
        const sc = ancModels[i] ? pickScope(ancModels[i], scope.id) : null;
        return { id: a, name: typeName(a), keys: sc ? scopeKeys(sc) : new Set() };
      }));
    }
    return model;
  });
}

// --- Operating model metadata (§4.1) --------------------------------------------------------
function setProgress(done, total) {
  const bar = $('progress');
  bar.hidden = done >= total;
  $('progress-bar').style.width = `${Math.round((done / total) * 100)}%`;
}

function applyMeta(meta) {
  state.meta.assetTypes = meta.assetTypes ?? [];
  state.meta.assetTypesById = indexById(meta.assetTypes);
  state.meta.attributeTypesById = indexById(meta.attributeTypes);
  state.meta.relationTypesById = indexById(meta.relationTypes);
  state.meta.complexRelationTypesById = indexById(meta.complexRelationTypes);
  state.meta.statusesById = indexById(meta.statuses);
  state.meta.domainTypesById = indexById(meta.domainTypes);
}

async function loadMeta() {
  const cached = store.get(META_CACHE_KEY);
  if (cached?.assetTypes?.length) {
    applyMeta(cached);
    state.hierarchy = buildHierarchy(state.meta.assetTypes);
    tree.setHierarchy(state.hierarchy);
    state.meta.loaded = true;
    return;
  }
  const jobs = {
    assetTypes: rest.assetTypes().then((types) => withMissingParents(types, (id) => rest.assetType(id))),
    attributeTypes: rest.attributeTypes(),
    relationTypes: rest.relationTypes(),
    complexRelationTypes: rest.complexRelationTypes().catch(() => []),
    statuses: rest.statuses().catch(() => []),
    domainTypes: rest.domainTypes().catch(() => []),
  };
  const total = Object.keys(jobs).length;
  let done = 0;
  setProgress(0, total);
  for (const p of Object.values(jobs)) p.then(() => setProgress(++done, total), () => setProgress(++done, total));
  jobs.assetTypes.then((types) => {
    state.meta.assetTypes = types;
    state.meta.assetTypesById = indexById(types);
    state.hierarchy = buildHierarchy(types);
    tree.setHierarchy(state.hierarchy);
  }).catch(() => {});
  const keys = Object.keys(jobs);
  const values = await Promise.all(Object.values(jobs));
  const meta = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  applyMeta(meta);
  state.hierarchy ??= buildHierarchy(state.meta.assetTypes);
  state.meta.loaded = true;
  store.set(META_CACHE_KEY, meta);
}

// --- UI wiring --------------------------------------------------------------------------------
function navigate(patch, { replace = false } = {}) {
  const cur = state.route;
  const next = { ...cur, ...patch };
  if (patch.typeId && patch.typeId !== cur.typeId) {
    next.scope = patch.scope ?? null;
    if (!('selection' in patch)) next.selection = null;
  }
  const hash = formatHash(next);
  if (hash === location.hash) {
    applyRoute();
  } else if (replace) {
    history.replaceState(null, '', hash);
    applyRoute();
  } else {
    location.hash = hash;
  }
}

const tree = createTree($('tree-host'), {
  onSelect: (id) => {
    navigate({ typeId: id, selection: null, scope: null });
    closeLeftDrawer();
  },
});

const viz = createViz($('viz'), {
  onSelect: (sel) => {
    if (sel.kind === 'type') navigate({ selection: null });
    else navigate({ selection: { kind: sel.kind, id: sel.id, dir: sel.dir } });
    openRight();
  },
  onOpenType: (id) => navigate({ typeId: id }),
  onPrefChange: (key, value) => {
    if (key === 'showInherited') navigate({ inherited: value }, { replace: true });
    else prefs.set(`viz.${key}`, value);
  },
  onScopeChange: (scopeId) => navigate({ scope: scopeId }),
  typeById: (id) => state.meta.assetTypesById.get(id),
});

const details = createDetails($('details'), {
  state,
  rest,
  indexer,
  baseURL,
  navigate: (patch) => {
    navigate(patch);
    openRight();
  },
  selectItem: (item) => navigate({ selection: { kind: item.itemType, id: item.id, dir: item.direction } }),
  openUsage: (kind, item) => details.openUsage(kind, item),
  userName: (id) => userName(id),
  attributeTypeFull: (id) => attributeTypeFull(id),
  assetCounts: (id) => assetCounts(id),
  workflowsForType: (id) => workflowsForType(id),
  mountSearch: (host, { typeId, scope }) => createSearch(host, {
    graphql,
    hierarchy: state.hierarchy,
    typeId,
    typeName: typeName(typeId),
    statuses: scope?.statuses ?? [],
    baseURL,
    assetCounts,
    scrollRoot: document.querySelector('.details-body'),
  }),
});

const exporter = createExporter({
  viz,
  details,
  getContext: () => ({
    typeName: typeName(state.route.typeId),
    host: new URL(baseURL || location.origin).host,
    userName: userDisplayName(state.user),
    jsonPayload,
  }),
});

function selectionKey(route, scope) {
  const sel = route.selection;
  if (!sel) return 'hub';
  if (sel.kind === 'rel') {
    const dir = sel.dir ?? scope?.relations.find((r) => r.id === sel.id)?.direction ?? 'out';
    return `rel:${sel.id}:${dir}`;
  }
  return `${sel.kind}:${sel.id}`;
}

function renderHeaderCrumbs(typeId) {
  const host = $('header-crumbs');
  clear(host);
  if (!typeId || !state.hierarchy) return;
  const path = state.hierarchy.path(typeId);
  path.forEach((id, i) => {
    if (i) host.append(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'));
    host.append(i === path.length - 1
      ? h('span', { class: 'crumb current', 'aria-current': 'page' }, typeName(id))
      : h('button', { class: 'crumb', type: 'button', onclick: () => navigate({ typeId: id }) }, typeName(id)));
  });
}

let rendered = { typeId: null, scopeId: null, inherited: null };
let routeToken = 0;

async function applyRoute() {
  if (!state.meta.loaded || signedOut) return;
  const route = parseHash(location.hash);
  const prev = state.route;
  state.route = route;
  const token = ++routeToken;

  if (route.typeId && !state.meta.assetTypesById.has(route.typeId)) {
    toast('That asset type was not found.', { kind: 'warn' });
    history.replaceState(null, '', '#/');
    route.typeId = null;
    route.selection = null;
  }
  tree.setSelected(route.typeId, { reveal: prev.typeId !== route.typeId || rendered.typeId === null });
  renderHeaderCrumbs(route.typeId);
  document.title = route.typeId ? `${typeName(route.typeId)} · Operating Model Explorer` : 'Operating Model Explorer';

  if (!route.typeId) {
    state.typeModel = null;
    state.scope = null;
    rendered = { typeId: null, scopeId: null, inherited: null };
    viz.render(null, { type: null, pathText: '', countsText: '', emptyText: 'Select an asset type in the tree' }, { animate: false });
    details.show(route, null);
    return;
  }

  const typeChanged = rendered.typeId !== route.typeId;
  if (typeChanged) {
    viz.render(null, { type: state.meta.assetTypesById.get(route.typeId), pathText: '', countsText: 'Loading…', emptyText: 'Loading assignment…' }, { animate: false, resetExpanded: true });
  }
  let model;
  try {
    model = await typeModel(route.typeId);
  } catch (e) {
    if (token !== routeToken || isAbort(e)) return;
    const msg = e.kind === 'forbidden' ? "You don't have permission to view this asset type's assignment." : `Couldn't load the assignment: ${e.message}`;
    viz.render(null, { type: state.meta.assetTypesById.get(route.typeId), pathText: '', countsText: '', emptyText: msg }, { animate: false });
    state.typeModel = null;
    state.scope = null;
    details.show(route, null);
    rendered = { typeId: null, scopeId: null, inherited: null };
    return;
  }
  if (token !== routeToken) return;
  state.typeModel = model;
  const scope = pickScope(model, route.scope);
  state.scope = scope;

  const t = state.meta.assetTypesById.get(route.typeId);
  const sum = summarize(scope);
  const info = {
    type: t,
    pathText: state.hierarchy.ancestors(route.typeId).slice().reverse().map(typeName).join(' › '),
    countsText: viz.formatCounts(sum, null),
    scopes: model.scopes.map((s) => ({ id: s.id, name: s.name })),
  };
  if (typeChanged || rendered.scopeId !== scope?.id || rendered.inherited !== route.inherited) {
    viz.render(scope, info, { animate: typeChanged, resetExpanded: typeChanged, prefs: { showInherited: route.inherited } });
    rendered = { typeId: route.typeId, scopeId: scope?.id, inherited: route.inherited };
    assetCounts(route.typeId).then((c) => {
      if (state.route.typeId === route.typeId) viz.updateInfo({ countsText: viz.formatCounts(sum, c.own) });
    }, () => viz.updateInfo({ countsText: viz.formatCounts(sum, null).replace('… assets', 'assets n/a') }));
  }
  const key = selectionKey(route, scope);
  viz.select(key);
  if (key !== 'hub') viz.reveal(key);
  if (route.selection && !prev.typeId) openRight();
  details.show(route, scope);
}

async function jsonPayload() {
  const route = state.route;
  const t = state.meta.assetTypesById.get(route.typeId) ?? null;
  const scope = state.scope;
  const hier = state.hierarchy;
  let reverse = null;
  const sel = route.selection;
  if (sel && ['attr', 'rel', 'complex'].includes(sel.kind)) {
    reverse = await indexer.lookup(sel.kind, sel.id).catch((e) => ({ error: e.message }));
  }
  const selectionRecord = !sel ? t
    : sel.kind === 'attr' ? await attributeTypeFull(sel.id).catch(() => state.meta.attributeTypesById.get(sel.id) ?? null)
      : sel.kind === 'rel' ? state.meta.relationTypesById.get(sel.id) ?? null
        : state.meta.complexRelationTypesById.get(sel.id) ?? null;
  return {
    exportedAt: new Date().toISOString(),
    exportedBy: { id: state.user?.id ?? null, name: userDisplayName(state.user) },
    instance: baseURL || location.origin,
    assetType: t,
    hierarchy: t ? {
      ancestors: hier.ancestors(t.id).map((id) => ({ id, name: typeName(id) })),
      subtypes: hier.children(t.id).map((id) => ({ id, name: typeName(id) })),
    } : null,
    assignments: scope ? { scope: { id: scope.id, name: scope.name }, raw: scope.raw, normalized: { statuses: scope.statuses, domainTypes: scope.domainTypes, summary: summarize(scope) } } : null,
    attributes: scope?.attributes ?? [],
    relations: scope?.relations ?? [],
    complexRelations: scope?.complexRelations ?? [],
    selection: { type: sel?.kind ?? 'type', id: sel?.id ?? t?.id ?? null, record: selectionRecord, details: details.getReport() },
    reverseIndexSnapshot: reverse,
  };
}

// --- Header, panes, responsive behaviour ------------------------------------------------------
const THEMES = ['auto', 'light', 'dark'];
function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const btn = $('btn-theme');
  btn.setAttribute('aria-label', `Theme: ${theme}`);
  btn.title = `Theme: ${theme}`;
  btn.textContent = theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐';
}
applyTheme(prefs.get('theme', 'auto'));
$('btn-theme').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(prefs.get('theme', 'auto')) + 1) % THEMES.length];
  prefs.set('theme', next);
  applyTheme(next);
});

$('btn-refresh').addEventListener('click', () => {
  store.clear();
  memo.clear();
  location.reload();
});
$('btn-print').addEventListener('click', () => exporter.print());
$('export-menu').addEventListener('click', (e) => {
  const kind = e.target.closest('[data-export]')?.dataset.export;
  if (!kind) return;
  $('export-menu').open = false;
  if (!state.route.typeId) {
    toast('Select an asset type first.', { kind: 'warn' });
    return;
  }
  exporter[kind]();
});
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.dropdown[open]')) if (!d.contains(e.target)) d.open = false;
});

let printState = [];
window.addEventListener('beforeprint', () => {
  $('header-crumbs').dataset.printed = new Date().toLocaleString();
  printState = [...document.querySelectorAll('.details details:not([open])')];
  printState.forEach((d) => { d.open = true; });
  viz.fit();
});
window.addEventListener('afterprint', () => {
  printState.forEach((d) => { d.open = false; });
  printState = [];
});

const mq = {
  wide: window.matchMedia('(min-width: 1440px)'),
  medium: window.matchMedia('(min-width: 1024px) and (max-width: 1439.98px)'),
  narrow: window.matchMedia('(max-width: 1023.98px)'),
};

function setLeftDrawer(open) {
  app.classList.toggle('left-open', open);
  $('btn-left').setAttribute('aria-expanded', String(open));
  syncScrim();
}
function closeLeftDrawer() {
  if (mq.narrow.matches) setLeftDrawer(false);
}
function openRight() {
  if (!mq.wide.matches) app.classList.add('right-open');
  syncScrim();
}
function closeRight() {
  app.classList.remove('right-open', 'sheet-expanded');
  syncScrim();
}
function syncScrim() {
  const show = (mq.narrow.matches && app.classList.contains('left-open')) || (mq.medium.matches && app.classList.contains('right-open') && !app.classList.contains('right-pinned'));
  $('scrim').hidden = !show;
}
$('btn-left').addEventListener('click', () => setLeftDrawer(!app.classList.contains('left-open')));
$('scrim').addEventListener('click', () => {
  setLeftDrawer(false);
  if (mq.medium.matches) closeRight();
});
$('btn-close-right').addEventListener('click', closeRight);
$('btn-details').addEventListener('click', openRight);
$('btn-pin').addEventListener('click', () => {
  const pinned = !app.classList.contains('right-pinned');
  app.classList.toggle('right-pinned', pinned);
  $('btn-pin').setAttribute('aria-pressed', String(pinned));
  prefs.set('rightPinned', pinned);
  syncScrim();
});
$('btn-rail').addEventListener('click', () => {
  const collapsed = !app.classList.contains('left-collapsed');
  app.classList.toggle('left-collapsed', collapsed);
  $('btn-rail').textContent = collapsed ? '⟩' : '⟨';
  $('btn-rail').setAttribute('aria-label', collapsed ? 'Expand tree' : 'Collapse tree');
  prefs.set('leftCollapsed', collapsed);
});
const toggleSheet = () => {
  if (!app.classList.contains('right-open')) app.classList.add('right-open');
  else app.classList.toggle('sheet-expanded');
};
$('sheet-handle').addEventListener('click', toggleSheet);
$('sheet-handle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleSheet();
  }
});
let sheetDrag = null;
$('sheet-handle').addEventListener('pointerdown', (e) => {
  sheetDrag = { y: e.clientY };
  $('sheet-handle').setPointerCapture(e.pointerId);
});
$('sheet-handle').addEventListener('pointerup', (e) => {
  if (!sheetDrag) return;
  const dy = e.clientY - sheetDrag.y;
  sheetDrag = null;
  if (dy < -40) app.classList.add('right-open', 'sheet-expanded');
  else if (dy > 40) app.classList.contains('sheet-expanded') ? app.classList.remove('sheet-expanded') : closeRight();
});

app.classList.toggle('right-pinned', prefs.get('rightPinned', false));
$('btn-pin').setAttribute('aria-pressed', String(prefs.get('rightPinned', false)));
app.classList.toggle('left-collapsed', prefs.get('leftCollapsed', false));
for (const [side, key, min, max] of [['left', '--left-w', 220, 420], ['right', '--right-w', 300, 560]]) {
  const saved = prefs.get(key, null);
  if (saved) app.style.setProperty(key, `${saved}px`);
  const handle = $(`resize-${side}`);
  const set = (w) => {
    const v = Math.max(min, Math.min(max, Math.round(w)));
    app.style.setProperty(key, `${v}px`);
    prefs.set(key, v);
  };
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => set(side === 'left' ? ev.clientX : window.innerWidth - ev.clientX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('keydown', (e) => {
    const cur = parseInt(getComputedStyle(app).getPropertyValue(key), 10) || (side === 'left' ? 280 : 380);
    const delta = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (delta) {
      e.preventDefault();
      set(cur + (side === 'left' ? delta : -delta));
    }
  });
}
Object.values(mq).forEach((m) => m.addEventListener('change', syncScrim));

document.addEventListener('keydown', (e) => {
  const typing = /input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable;
  if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
    e.preventDefault();
    if (mq.narrow.matches) setLeftDrawer(true);
    tree.focusFilter();
  } else if (e.key === 'Escape' && !typing) {
    if (app.classList.contains('left-open')) setLeftDrawer(false);
  }
});

// --- Boot ------------------------------------------------------------------------------------
async function boot() {
  $('host').textContent = new URL(baseURL || location.origin).host;
  let session;
  try {
    session = await http.init();
  } catch (e) {
    if (e.kind === 'unauthenticated') showSignedOut();
    else showFatal(e.message, () => location.reload());
    return;
  }
  state.user = session?.user ?? null;
  const u = state.user;
  clear($('user')).append(
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(u)),
    h('span', { class: 'user-name' }, userDisplayName(u)));
  store.setScope(baseURL || location.origin, u?.id ?? 'anonymous');

  const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
  const vizPrefs = {
    mode: prefs.get('viz.mode', vw < 640 ? 'columns' : 'orbital'),
    groupByKind: prefs.get('viz.groupByKind', true),
    legend: prefs.get('viz.legend', vw >= 1024),
  };
  viz.render(null, { type: null, pathText: '', countsText: '', emptyText: 'Loading operating model…' }, { prefs: vizPrefs });

  try {
    await loadMeta();
  } catch (e) {
    if (e.kind === 'unauthenticated') return;
    showFatal(`Couldn't load the operating model: ${e.message}`, () => location.reload());
    return;
  }
  window.addEventListener('hashchange', applyRoute);
  await applyRoute();
}

boot();
