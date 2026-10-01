import { h, clear, highlight } from '../util/dom.js';
import { debounce } from '../util/debounce.js';
import { filterHierarchy, visibleRows } from '../model/hierarchy.js';
import { acronymFor, contrastText, typeColor, formatNumber } from '../util/format.js';

export function createTree(root, { onSelect }) {
  const input = h('input', { type: 'search', class: 'tree-filter-input', placeholder: 'Filter asset types  ( / )', 'aria-label': 'Filter asset types', autocomplete: 'off', spellcheck: 'false' });
  const matchCount = h('span', { class: 'match-count', 'aria-live': 'polite' });
  const list = h('ul', { class: 'tree', role: 'tree', 'aria-label': 'Asset type hierarchy' });
  const total = h('span', { class: 'tree-total' });
  const footer = h('div', { class: 'tree-footer' },
    h('button', { class: 'btn btn-small', onclick: () => expandAll() }, 'Expand all'),
    h('button', { class: 'btn btn-small', onclick: () => collapseAll() }, 'Collapse all'),
    total);
  clear(root).append(h('div', { class: 'tree-filter' }, input, matchCount), h('div', { class: 'tree-scroll' }, list), footer);

  const st = { hier: null, expanded: new Set(), savedExpanded: null, filter: null, selectedId: null, focusId: null, rows: [] };

  function render() {
    if (!st.hier) return;
    st.rows = visibleRows(st.hier, st.expanded, st.filter);
    if (!st.rows.some((r) => r.id === st.focusId)) st.focusId = st.rows.find((r) => r.id === st.selectedId)?.id ?? st.rows[0]?.id ?? null;
    const q = st.filter?.query ?? '';
    const frag = document.createDocumentFragment();
    for (const row of st.rows) {
      const t = st.hier.byId.get(row.id);
      const color = typeColor(t);
      const kids = st.hier.childCount(row.id);
      const matched = st.filter?.matches.has(row.id);
      const li = h('li', {
        role: 'treeitem',
        class: ['tree-row', row.id === st.selectedId ? 'selected' : '', st.filter && !matched ? 'context' : ''],
        'aria-level': row.level,
        'aria-setsize': row.setSize,
        'aria-posinset': row.posInSet,
        'aria-selected': String(row.id === st.selectedId),
        'aria-expanded': row.hasChildren ? String(row.expanded) : null,
        tabindex: row.id === st.focusId ? 0 : -1,
        dataset: { id: row.id },
        style: { '--level': row.level - 1 },
      },
      h('span', { class: ['chevron', row.hasChildren ? '' : 'leaf', row.expanded ? 'open' : ''], 'aria-hidden': 'true', dataset: { toggle: '1' } }, row.hasChildren ? '▸' : ''),
      h('span', { class: 'type-badge', style: { background: color, color: contrastText(color) }, 'aria-hidden': 'true' }, acronymFor(t)),
      h('span', { class: 'tree-name' }, ...highlight(t.name, matched ? q : '')),
      t.system ? h('span', { class: 'chip chip-ootb', title: 'Out-of-the-box type' }, 'OOTB') : null,
      t.finalType ? h('span', { class: 'lock', title: 'No subtypes allowed', 'aria-label': 'Final type' }, '🔒') : null,
      kids ? h('span', { class: 'tree-count', 'aria-label': `${kids} subtypes` }, String(kids)) : null);
      frag.append(li);
    }
    clear(list).append(frag);
    total.textContent = `${formatNumber(st.hier.size)} asset types`;
    matchCount.textContent = st.filter ? `${formatNumber(st.filter.matches.size)} match${st.filter.matches.size === 1 ? '' : 'es'}` : '';
  }

  function rowEl(id) {
    return list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  }

  function focusRow(id) {
    st.focusId = id;
    for (const li of list.children) li.tabIndex = li.dataset.id === id ? 0 : -1;
    const el = rowEl(id);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  }

  function toggle(id, open = !st.expanded.has(id)) {
    if (open) st.expanded.add(id);
    else st.expanded.delete(id);
    render();
    focusRow(id);
  }

  function expandAll() {
    if (st.filter) return;
    for (const id of st.hier.byId.keys()) if (st.hier.childCount(id)) st.expanded.add(id);
    render();
  }

  function collapseAll() {
    st.expanded.clear();
    render();
  }

  const applyFilter = debounce(() => {
    const q = input.value;
    if (q.trim() && !st.savedExpanded) st.savedExpanded = new Set(st.expanded);
    st.filter = filterHierarchy(st.hier, q);
    if (!st.filter && st.savedExpanded) {
      st.expanded = st.savedExpanded;
      st.savedExpanded = null;
    }
    render();
  }, 150);

  input.addEventListener('input', applyFilter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      applyFilter.cancel();
      st.filter = null;
      if (st.savedExpanded) {
        st.expanded = st.savedExpanded;
        st.savedExpanded = null;
      }
      render();
    } else if (e.key === 'ArrowDown' && st.rows.length) {
      e.preventDefault();
      focusRow(st.rows[0].id);
    } else if (e.key === 'Enter' && st.filter?.matches.size) {
      const first = st.rows.find((r) => st.filter.matches.has(r.id));
      if (first) onSelect(first.id);
    }
  });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('[role="treeitem"]');
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.closest('[data-toggle]') && st.hier.childCount(id)) {
      toggle(id);
      return;
    }
    st.focusId = id;
    onSelect(id);
  });
  list.addEventListener('dblclick', (e) => {
    const li = e.target.closest('[role="treeitem"]');
    if (li && st.hier.childCount(li.dataset.id)) toggle(li.dataset.id);
  });

  list.addEventListener('keydown', (e) => {
    const idx = st.rows.findIndex((r) => r.id === st.focusId);
    if (idx < 0) return;
    const row = st.rows[idx];
    const move = (i) => {
      e.preventDefault();
      const r = st.rows[Math.max(0, Math.min(st.rows.length - 1, i))];
      if (r) focusRow(r.id);
    };
    switch (e.key) {
      case 'ArrowDown': move(idx + 1); break;
      case 'ArrowUp': move(idx - 1); break;
      case 'Home': move(0); break;
      case 'End': move(st.rows.length - 1); break;
      case 'ArrowRight':
        e.preventDefault();
        if (row.hasChildren && !row.expanded && !st.filter) toggle(row.id, true);
        else if (row.expanded) move(idx + 1);
        break;
      case 'ArrowLeft': {
        e.preventDefault();
        if (row.expanded && !st.filter) {
          toggle(row.id, false);
        } else {
          const parent = st.hier.parentOf.get(row.id);
          if (parent) focusRow(parent);
        }
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect(row.id);
        break;
      default:
        break;
    }
  });

  return {
    setHierarchy(hier) {
      st.hier = hier;
      st.filter = input.value.trim() ? filterHierarchy(hier, input.value) : null;
      render();
    },
    setSelected(id, { reveal = true } = {}) {
      st.selectedId = id;
      if (!st.hier) return;
      if (reveal && id && st.hier.byId.has(id)) {
        for (const a of st.hier.ancestors(id)) st.expanded.add(a);
        if (st.filter && !st.filter.visible.has(id)) {
          input.value = '';
          st.filter = null;
          st.savedExpanded = null;
        }
      }
      st.focusId = id ?? st.focusId;
      render();
      rowEl(id)?.scrollIntoView({ block: 'nearest' });
    },
    focusFilter() {
      input.focus();
      input.select();
    },
  };
}
