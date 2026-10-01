import { h, clear, downloadBlob } from '../util/dom.js';
import { debounce } from '../util/debounce.js';
import { toPlainText } from '../util/sanitize.js';
import { toCsv } from '../util/csv.js';
import { formatNumber, truncate, slugify, isoDate } from '../util/format.js';
import { isAbort } from '../api/queue.js';

const PAGE = 50;
const EXPORT_PAGE = 500;
export const EXPORT_CAP = 50000;

const describe = (a) => toPlainText(a.stringAttributes?.[0]?.stringValue ?? '');

export function createSearch(host, { graphql, hierarchy, typeId, typeName, statuses = [], baseURL, assetCounts, scrollRoot }) {
  const st = { name: '', includeSubtypes: true, statusIds: new Set(), results: [], offset: 0, hasMore: false, loading: false, controller: null, total: null, exportController: null };

  const input = h('input', { type: 'search', class: 'input', placeholder: 'Asset name contains…', 'aria-label': 'Search assets by name' });
  const subtypes = h('input', { type: 'checkbox', checked: true });
  const statusBox = h('details', { class: 'dropdown' },
    h('summary', { class: 'btn btn-small' }, 'Status'),
    h('div', { class: 'dropdown-menu', role: 'group', 'aria-label': 'Filter by status' },
      statuses.length ? statuses.map((s) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', value: s.id, onchange: (e) => {
          if (e.target.checked) st.statusIds.add(s.id);
          else st.statusIds.delete(s.id);
          statusBox.querySelector('summary').textContent = st.statusIds.size ? `Status (${st.statusIds.size})` : 'Status';
          reset();
        } }), s.name)) : h('p', { class: 'muted small' }, 'No statuses')));
  const info = h('div', { class: 'search-info muted small', 'aria-live': 'polite' });
  const list = h('ul', { class: 'result-list' });
  const more = h('button', { class: 'btn btn-small', type: 'button', hidden: true, onclick: () => load() }, 'Load more');
  const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });
  const exportBtn = h('button', { class: 'btn btn-small', type: 'button', onclick: () => exportCsv() }, 'Export results (CSV)');
  const exportStatus = h('div', { class: 'export-status small', 'aria-live': 'polite' });

  clear(host).append(
    h('div', { class: 'search-controls' }, input,
      h('div', { class: 'search-filters' }, h('label', { class: 'check' }, subtypes, 'Include subtypes'), statusBox, exportBtn)),
    exportStatus, info, list, more, sentinel);

  const typeIds = () => (st.includeSubtypes ? [typeId, ...hierarchy.descendants(typeId)] : [typeId]);

  function updateInfo() {
    const shown = formatNumber(st.results.length);
    const known = st.total != null && !st.name && !st.statusIds.size;
    info.textContent = st.loading && !st.results.length ? 'Searching…' : known ? `Showing ${shown} of ${formatNumber(st.total)}` : `Showing ${shown}${st.hasMore ? '+' : ''}`;
  }

  function row(a) {
    const community = a.domain?.parent?.name;
    const desc = describe(a);
    return h('li', { class: 'result' },
      h('a', { href: `${baseURL}/asset/${encodeURIComponent(a.id)}`, target: '_blank', rel: 'noopener noreferrer', class: 'result-name' }, a.displayName || a.fullName || a.id),
      h('div', { class: 'result-meta' },
        st.includeSubtypes ? h('span', { class: 'chip chip-muted' }, a.type?.name ?? '') : null,
        a.status?.name ? h('span', { class: 'chip' }, a.status.name) : null,
        h('span', { class: 'muted small' }, [a.domain?.name, community].filter(Boolean).join(' › '))),
      desc ? h('div', { class: 'result-desc muted small' }, truncate(desc.split(/(?<=[.!?])\s/)[0], 160)) : null);
  }

  async function load() {
    if (st.loading) return;
    st.loading = true;
    more.disabled = true;
    updateInfo();
    const { signal } = st.controller;
    try {
      const res = await graphql.findAssets({ typeIds: typeIds(), name: st.name, statusIds: [...st.statusIds], limit: PAGE, offset: st.offset }, { signal });
      if (signal.aborted) return;
      st.results.push(...res.results);
      st.offset += res.results.length;
      st.hasMore = res.hasMore;
      list.append(...res.results.map(row));
      if (!st.results.length) list.append(h('li', { class: 'muted' }, 'No assets found.'));
    } catch (e) {
      if (signal.aborted || isAbort(e)) return;
      list.append(h('li', { class: 'note note-error' }, e.kind === 'forbidden' ? "You don't have permission to search these assets." : `Search failed: ${e.message}`,
        ' ', h('button', { class: 'btn btn-small', onclick: (ev) => { ev.target.closest('li').remove(); load(); } }, 'Retry')));
    } finally {
      if (!signal.aborted) {
        st.loading = false;
        more.disabled = false;
        more.hidden = !st.hasMore;
        updateInfo();
      }
    }
  }

  function reset() {
    st.controller?.abort();
    st.controller = new AbortController();
    st.results = [];
    st.offset = 0;
    st.hasMore = false;
    st.loading = false;
    clear(list);
    more.hidden = true;
    load();
  }

  input.addEventListener('input', debounce(() => {
    st.name = input.value.trim();
    reset();
  }, 300));
  subtypes.addEventListener('change', () => {
    st.includeSubtypes = subtypes.checked;
    refreshTotal();
    reset();
  });

  let observer = null;
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && st.hasMore && !st.loading) load();
    }, { root: scrollRoot ?? null, rootMargin: '200px' });
    observer.observe(sentinel);
  }

  let counts = null;
  function refreshTotal() {
    st.total = counts ? (st.includeSubtypes ? counts.withSubtypes : counts.own) : null;
    updateInfo();
  }
  assetCounts?.(typeId).then((c) => {
    counts = c;
    refreshTotal();
  }, () => {});

  async function exportCsv() {
    if (st.exportController) return;
    st.exportController = new AbortController();
    const { signal } = st.exportController;
    const rows = [];
    const cancel = h('button', { class: 'btn btn-small', type: 'button', onclick: () => st.exportController?.abort() }, 'Cancel');
    const progress = h('progress', { max: st.total && !st.name && !st.statusIds.size ? Math.min(st.total, EXPORT_CAP) : 0 });
    const label = h('span', null, 'Exporting… 0');
    clear(exportStatus).append(label, ' ', progress, ' ', cancel);
    exportBtn.disabled = true;
    try {
      for (let offset = 0; offset < EXPORT_CAP; offset += EXPORT_PAGE) {
        const res = await graphql.findAssets({ typeIds: typeIds(), name: st.name, statusIds: [...st.statusIds], limit: EXPORT_PAGE, offset }, { signal, priority: 'background' });
        rows.push(...res.results);
        label.textContent = `Exporting… ${formatNumber(rows.length)}`;
        if (progress.max) progress.value = rows.length;
        if (!res.hasMore) break;
      }
      const capped = rows.length >= EXPORT_CAP;
      const csv = toCsv([
        { label: 'Name', value: (a) => a.displayName || a.fullName },
        { label: 'Full name', key: 'fullName' },
        { label: 'Asset type', value: (a) => a.type?.name },
        { label: 'Status', value: (a) => a.status?.name },
        { label: 'Domain', value: (a) => a.domain?.name },
        { label: 'Community', value: (a) => a.domain?.parent?.name },
        { label: 'Last modified', key: 'modifiedOn' },
        { label: 'Description', value: describe },
        { label: 'ID', key: 'id' },
        { label: 'URL', value: (a) => `${baseURL}/asset/${a.id}` },
      ], rows);
      downloadBlob(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }), `${slugify(typeName)}_assets_${isoDate()}.csv`);
      exportStatus.textContent = capped
        ? `Exported the first ${formatNumber(EXPORT_CAP)} assets (limit reached — narrow the filters to export the rest).`
        : `Exported ${formatNumber(rows.length)} assets.`;
    } catch (e) {
      exportStatus.textContent = signal.aborted || isAbort(e) ? 'Export cancelled.' : `Export failed: ${e.message}`;
    } finally {
      st.exportController = null;
      exportBtn.disabled = false;
    }
  }

  st.controller = new AbortController();
  load();

  return {
    destroy() {
      st.controller?.abort();
      st.exportController?.abort();
      observer?.disconnect();
    },
  };
}
