import { h, clear, copyText, toast, highlight } from '../util/dom.js';
import { sanitizeToFragment, toPlainText } from '../util/sanitize.js';
import { acronymFor, contrastText, typeColor, formatNumber, formatDateTime, truncate } from '../util/format.js';
import { summarize, formatOccurrence, itemKey } from '../model/assignment.js';
import { attributeKind, attributeDiscriminator } from '../model/normalize.js';
import { isAbort } from '../api/queue.js';

const DRILL_PREVIEW = 12;

function typeBadge(type, size = 'md') {
  const color = typeColor(type);
  return h('span', { class: `type-badge badge-${size}`, style: { background: color, color: contrastText(color) }, 'aria-hidden': 'true' }, acronymFor(type));
}

function card(title, body, { open = true, id } = {}) {
  return h('details', { class: 'card', open, dataset: id ? { section: id } : undefined },
    h('summary', null, h('span', { class: 'card-title' }, title)),
    h('div', { class: 'card-body' }, body));
}

function kv(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));
}

function chip(text, cls = '') {
  return h('span', { class: `chip ${cls}` }, text);
}

function errorNote(e) {
  if (isAbort(e)) return null;
  return h('p', { class: e?.kind === 'forbidden' ? 'note note-warn' : 'note note-error' }, e?.kind === 'forbidden' ? "You don't have permission to view this." : `Couldn't load: ${e?.message ?? e}`);
}

// Fills `slot` asynchronously; report entry is updated with the same result so exports match the screen.
async function fill(slot, promise, render, rep, toLines, signal) {
  slot.replaceChildren(h('span', { class: 'loading-dots', 'aria-label': 'Loading' }, '…'));
  try {
    const value = await promise;
    if (signal?.aborted) return;
    slot.replaceChildren(...[].concat(render(value)).filter(Boolean));
    if (rep && toLines) rep.lines = toLines(value);
  } catch (e) {
    if (signal?.aborted || isAbort(e)) return;
    const n = errorNote(e);
    slot.replaceChildren(...(n ? [n] : []));
    if (rep) rep.lines = [`Unavailable: ${e?.message ?? e}`];
  }
}

export function createDetails(root, ctx) {
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Details navigation' });
  const body = h('div', { class: 'details-body' });
  const footer = h('div', { class: 'details-footer', 'aria-live': 'polite' });
  clear(root).append(crumbs, body, footer);

  const st = { controller: null, report: null, view: null, usage: null, searchWidget: null, unsubscribe: null };

  ctx.indexer.subscribe((s) => {
    footer.textContent = s.mode === 'crawl' && !s.complete ? `Indexing operating model… ${formatNumber(s.done)} / ${formatNumber(s.total)}` : s.mode === 'crawl' ? 'Operating model index complete' : '';
    if (s.mode === 'crawl') st.view?.onIndexProgress?.();
  });

  const typeOf = (id) => ctx.state.meta.assetTypesById.get(id);
  const typeLink = (ref, extra = {}) => {
    const t = typeOf(ref?.id) ?? ref ?? {};
    return h('button', { class: 'type-link', type: 'button', onclick: () => ctx.navigate({ typeId: t.id, selection: extra.selection ?? null }), title: `Open ${t.name ?? ''}` },
      typeBadge(t, 'sm'), h('span', null, t.name ?? '?'));
  };
  const collibraLink = (path, label = 'Open in Collibra') => h('a', { class: 'btn btn-small', href: ctx.baseURL + path, target: '_blank', rel: 'noopener noreferrer' }, label, ' ↗');

  function newReport(title, subtitle) {
    st.report = { title, subtitle, sections: [] };
    return (sectionTitle, lines = [], table = null) => {
      const s = { title: sectionTitle, lines, table };
      st.report.sections.push(s);
      return s;
    };
  }

  function descriptionBlock(html, rep) {
    const plain = toPlainText(html);
    rep('Description', [plain || 'No description.']);
    return card('Description', plain ? h('div', { class: 'rich' }, sanitizeToFragment(html)) : h('p', { class: 'muted' }, 'No description.'));
  }

  function metadataBlock(rec, rep, signal) {
    const created = h('span');
    const modified = h('span');
    const r = rep('Metadata', []);
    const lines = { c: '', m: '' };
    const update = () => {
      r.lines = [`Created: ${lines.c} · ${formatDateTime(rec?.createdOn)}`, `Last modified: ${lines.m} · ${formatDateTime(rec?.lastModifiedOn)}`, `UUID: ${rec?.id ?? '—'}`];
    };
    const resolve = (slot, userId, key) => {
      if (!userId) {
        slot.textContent = '—';
        return;
      }
      ctx.userName(userId, { signal }).then((name) => {
        slot.textContent = name;
        lines[key] = name;
        update();
      }, () => {
        slot.textContent = userId;
      });
    };
    resolve(created, rec?.createdBy, 'c');
    resolve(modified, rec?.lastModifiedBy, 'm');
    update();
    return card('Metadata', kv([
      ['Created by', created],
      ['Created on', formatDateTime(rec?.createdOn)],
      ['Last modified by', modified],
      ['Last modified on', formatDateTime(rec?.lastModifiedOn)],
      ['UUID', h('span', { class: 'uuid' }, h('code', null, rec?.id ?? '—'),
        rec?.id ? h('button', { class: 'icon-btn', 'aria-label': 'Copy UUID', title: 'Copy UUID', onclick: () => copyText(rec.id).then(() => toast('UUID copied')) }, '⧉') : null)],
    ]), { open: false });
  }

  function setCrumbs(parts) {
    clear(crumbs).append(...parts.flatMap((p, i) => [
      i ? h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›') : null,
      p.onclick && i < parts.length - 1 ? h('button', { class: 'crumb', type: 'button', onclick: p.onclick }, p.label) : h('span', { class: 'crumb current', 'aria-current': 'page' }, p.label),
    ]).filter(Boolean));
  }

  // --- Asset type --------------------------------------------------------------------------
  function showType(route, scope, signal) {
    const t = typeOf(route.typeId);
    const rep = newReport(t?.name ?? 'Asset type', 'Asset type');
    setCrumbs([{ label: t?.name ?? 'Asset type' }]);
    if (!t) {
      body.append(h('p', { class: 'note note-warn' }, 'This asset type was not found.'));
      return;
    }
    const hier = ctx.state.hierarchy;
    const sum = summarize(scope);
    const chips = [t.system && chip('OOTB', 'chip-ootb'), t.finalType && chip('🔒 Final', 'chip-final'), t.product && chip(t.product.replace(/_/g, ' ').toLowerCase(), 'chip-muted')];
    rep('Overview', [`Public ID: ${t.publicId ?? '—'}`, `System: ${t.system ? 'yes' : 'no'} · Final: ${t.finalType ? 'yes' : 'no'}`]);

    body.append(h('header', { class: 'detail-header' },
      typeBadge(t, 'lg'),
      h('div', { class: 'detail-heading' },
        h('h2', null, t.name),
        h('div', { class: 'detail-sub' }, h('code', null, t.publicId ?? ''), ...chips.filter(Boolean))),
      collibraLink(`/assettype/${encodeURIComponent(t.id)}`)));

    body.append(descriptionBlock(t.description, rep));

    // Hierarchy
    const ancestors = hier.ancestors(t.id).slice().reverse();
    const subtypes = hier.children(t.id);
    const descendantsSlot = h('div');
    let showingAll = false;
    const toggleAll = h('button', { class: 'btn btn-small', type: 'button', onclick: () => {
      showingAll = !showingAll;
      toggleAll.textContent = showingAll ? 'Hide descendants' : `Show all descendants (${formatNumber(hier.descendants(t.id).length)})`;
      clear(descendantsSlot);
      if (showingAll) {
        const build = (id) => h('ul', { class: 'nested' }, hier.children(id).map((c) => h('li', null, typeLink({ id: c }), hier.childCount(c) ? build(c) : null)));
        descendantsSlot.append(build(t.id));
      }
    } }, `Show all descendants (${formatNumber(hier.descendants(t.id).length)})`);
    rep('Hierarchy', [`Ancestors: ${ancestors.map((a) => typeOf(a)?.name).join(' › ') || '(root)'}`, `Direct subtypes (${subtypes.length}): ${subtypes.map((c) => typeOf(c)?.name).join(', ') || 'none'}`]);
    body.append(card('Hierarchy', [
      h('div', { class: 'label' }, 'Ancestors'),
      ancestors.length ? h('div', { class: 'chain' }, ancestors.flatMap((a, i) => [i ? h('span', { class: 'crumb-sep' }, '›') : null, typeLink({ id: a })])) : h('p', { class: 'muted' }, 'Root type'),
      h('div', { class: 'label' }, `Direct subtypes (${subtypes.length})`),
      subtypes.length ? h('div', { class: 'chips' }, subtypes.map((c) => typeLink({ id: c }))) : h('p', { class: 'muted' }, 'None'),
      subtypes.length ? h('div', { class: 'row-actions' }, toggleAll) : null,
      descendantsSlot,
    ]));

    // At a glance
    const countSlot = h('span');
    const countSubSlot = h('span');
    const glance = rep('At a glance', []);
    const glanceLines = (c, cs) => [
      `Assets: ${formatNumber(c)} (this type) · ${formatNumber(cs)} (incl. subtypes)`,
      `Attributes: ${sum.attributes} (${sum.required} required, ${sum.optional} optional)`,
      `Relations: ${sum.relations} (${sum.outgoing} outgoing, ${sum.incoming} incoming)`,
      `Complex relations: ${sum.complex}`,
    ];
    glance.lines = glanceLines(null, null);
    ctx.assetCounts(t.id, { signal }).then(({ own, withSubtypes }) => {
      countSlot.textContent = formatNumber(own);
      countSubSlot.textContent = formatNumber(withSubtypes);
      glance.lines = glanceLines(own, withSubtypes);
    }, (e) => {
      if (!isAbort(e)) countSlot.textContent = countSubSlot.textContent = 'n/a';
    });
    countSlot.textContent = countSubSlot.textContent = '…';
    body.append(card('At a glance', h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, countSlot), h('span', { class: 'stat-label' }, 'assets (this type)')),
      h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, countSubSlot), h('span', { class: 'stat-label' }, 'incl. subtypes')),
      h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, String(sum.attributes)), h('span', { class: 'stat-label' }, `attributes · ${sum.required} req / ${sum.optional} opt`)),
      h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, String(sum.relations)), h('span', { class: 'stat-label' }, `relations · ${sum.outgoing} out / ${sum.incoming} in`)),
      h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, String(sum.complex)), h('span', { class: 'stat-label' }, 'complex relations')),
    )));

    // Assignment
    if (scope) {
      const scopes = ctx.state.typeModel?.scopes ?? [];
      rep('Assignment', [
        `Scope: ${scope.name}${scopes.length > 1 ? ` (of ${scopes.map((x) => x.name).join(', ')})` : ''}`,
        `Statuses: ${scope.statuses.map((x, i) => (i === 0 ? `${x.name} (default)` : x.name)).join(', ') || '—'}`,
        `Domain types: ${scope.domainTypes.map((x) => x.name).join(', ') || '—'}`,
      ]);
      body.append(card('Assignment', [
        kv([
          ['Scope', scopes.length > 1 ? `${scope.name} (${scopes.length} scopes)` : scope.name],
          scope.scope?.domains?.length ? ['Scope domains', scope.scope.domains.map((d) => d.name).join(', ')] : null,
          scope.scope?.communities?.length ? ['Scope communities', scope.scope.communities.map((d) => d.name).join(', ')] : null,
        ]),
        h('div', { class: 'label' }, 'Eligible statuses'),
        h('div', { class: 'chips' }, scope.statuses.map((x, i) => chip(i === 0 ? `${x.name} · default` : x.name, i === 0 ? 'chip-accent' : ''))),
        h('div', { class: 'label' }, 'Eligible domain types'),
        scope.domainTypes.length ? h('div', { class: 'chips' }, scope.domainTypes.map((x) => chip(x.name))) : h('p', { class: 'muted' }, 'None'),
        scope.validationRules.length || scope.dataQualityRules.length
          ? kv([['Validation rules', String(scope.validationRules.length)], ['Data quality rules', String(scope.dataQualityRules.length)]])
          : null,
      ]));
    } else {
      body.append(card('Assignment', h('p', { class: 'muted' }, 'This asset type has no assignment.')));
    }

    // Characteristics table
    if (scope) {
      const items = [...scope.attributes, ...scope.relations, ...scope.complexRelations];
      const rowsData = items.map((it) => [
        it.itemType === 'rel' ? it.label : it.name,
        it.itemType === 'attr' ? it.kind.label : it.itemType === 'rel' ? `${it.direction === 'out' ? 'Outgoing →' : 'Incoming ←'} ${it.otherType?.name ?? ''}` : 'Complex relation',
        formatOccurrence(it),
        it.inheritedFrom?.name ?? '',
      ]);
      rep('Characteristics', [], { columns: ['Name', 'Kind / direction', 'Occurs', 'Inherited from'], rows: rowsData });
      const table = h('table', { class: 'char-table' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Kind / direction'), h('th', { scope: 'col' }, 'Occurs'), h('th', { scope: 'col' }, 'Inherited from'))),
        h('tbody', null, items.map((it, i) => h('tr', {
          class: ['clickable', it.inheritedFrom ? 'inherited' : ''],
          tabindex: 0,
          onclick: () => ctx.selectItem(it),
          onkeydown: (e) => {
            if (e.key === 'Enter') ctx.selectItem(it);
          },
        }, h('td', null, it.itemType === 'attr' ? h('span', { class: 'kind-icon' }, it.kind.icon, ' ') : null, rowsData[i][0]),
        h('td', null, rowsData[i][1]),
        h('td', null, h('span', { class: it.required ? 'occ occ-req' : 'occ' }, rowsData[i][2])),
        h('td', { class: 'muted' }, rowsData[i][3])))));
      body.append(card(`Characteristics (${items.length})`, items.length ? h('div', { class: 'table-wrap' }, table) : h('p', { class: 'muted' }, 'None')));
    }

    // Workflows
    const wfSlot = h('div');
    const wfRep = rep('Workflows', []);
    body.append(card('Workflows', wfSlot, { open: false }));
    fill(wfSlot, ctx.workflowsForType(t.id, { signal }), (list) => (list.length
      ? h('ul', { class: 'plain-list' }, list.map((w) => h('li', null, h('strong', null, w.name), w.enabled === false ? chip('disabled', 'chip-muted') : null, w.description ? h('div', { class: 'muted small' }, truncate(toPlainText(w.description), 160)) : null)))
      : h('p', { class: 'muted' }, 'No workflows apply to this asset type.')), wfRep, (list) => list.map((w) => w.name), signal);

    body.append(metadataBlock(t, rep, signal));

    // Asset search
    const searchHost = h('div', { class: 'search-host' });
    body.append(card('Find assets', searchHost, { id: 'search' }));
    st.searchWidget = ctx.mountSearch(searchHost, { typeId: t.id, scope });
  }

  // --- Drill-down list shared by attribute / relation views ---------------------------------
  function usageList(kind, item, rep, signal, { preview = true } = {}) {
    const slot = h('div', { class: 'usage' });
    const r = rep(kind === 'attr' ? 'Asset types that also use this attribute' : 'Asset types that use this relation', []);
    const draw = async () => {
      try {
        const res = await ctx.indexer.lookup(kind, item.id, { signal });
        if (signal.aborted) return;
        const entries = res.entries;
        const current = ctx.state.route.typeId;
        const shown = preview ? entries.slice(0, DRILL_PREVIEW) : entries;
        const sel = (e) => (kind === 'rel' ? { kind: 'rel', id: item.id, dir: e.usages[0]?.role === 'target' ? 'in' : 'out' } : { kind, id: item.id });
        const usageText = (u) => `${formatOccurrence(u)}${u.role ? ` · as ${u.role}` : ''}${u.scope ? ` · ${u.scope}` : ''}`;
        const rows = shown.map((e) => h('li', { class: ['usage-row', e.assetTypeId === current ? 'current' : ''] },
          typeLink({ id: e.assetTypeId, name: e.assetTypeName }, { selection: sel(e) }),
          h('span', { class: 'muted small' }, e.usages.map(usageText).join('; '))));
        const extra = [];
        if (!res.complete) extra.push(h('p', { class: 'note' }, `Indexing… showing ${entries.length} found so far.`));
        if (preview && entries.length > DRILL_PREVIEW) {
          extra.push(h('button', { class: 'btn btn-small', type: 'button', onclick: () => ctx.openUsage(kind, item) }, `Show all ${formatNumber(entries.length)}`));
        }
        let summaryText = `${formatNumber(entries.length)} asset type${entries.length === 1 ? '' : 's'}`;
        if (kind === 'rel') {
          const src = entries.filter((e) => e.usages.some((u) => u.role === 'source' || u.role === 'both')).length;
          const tgt = entries.filter((e) => e.usages.some((u) => u.role === 'target' || u.role === 'both')).length;
          summaryText += ` · ${src} as source · ${tgt} as target`;
        }
        slot.replaceChildren(h('p', { class: 'muted' }, summaryText), entries.length ? h('ul', { class: 'plain-list' }, rows) : h('p', { class: 'muted' }, 'None found.'), ...extra);
        r.lines = [summaryText, ...entries.map((e) => `${e.assetTypeName}: ${e.usages.map(usageText).join('; ')}`)];
      } catch (e) {
        if (signal.aborted || isAbort(e)) return;
        slot.replaceChildren(errorNote(e));
      }
    };
    slot.append(h('span', { class: 'loading-dots' }, '…'));
    draw();
    return { el: slot, redraw: draw };
  }

  function assignmentInfo(item, rep, extra = []) {
    if (!item) {
      rep('In this assignment', ['Not assigned to the selected asset type.']);
      return card('In this assignment', h('p', { class: 'note note-warn' }, 'Not assigned to the selected asset type in this scope.'));
    }
    const rows = [
      ...extra,
      ['Occurrence', `${formatOccurrence(item)} (min ${item.min}, max ${item.max == null ? 'unbounded' : item.max})`],
      ['Required', item.required ? 'Yes' : 'No'],
      ['Inherited from', item.inheritedFrom ? typeLink(item.inheritedFrom) : 'Defined on this type'],
      item.readOnly ? ['Read-only', 'Yes'] : null,
      item.system ? ['System assignment', 'Yes'] : null,
    ];
    rep('In this assignment', rows.filter(Boolean).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : item.inheritedFrom?.name ?? ''}`));
    return card('In this assignment', kv(rows));
  }

  // --- Attribute type ------------------------------------------------------------------------
  function showAttribute(route, scope, signal) {
    const id = route.selection.id;
    const cached = ctx.state.meta.attributeTypesById.get(id);
    const item = scope?.attributes.find((a) => a.id === id) ?? null;
    const t = typeOf(route.typeId);
    const name = item?.name ?? cached?.name ?? 'Attribute';
    const disc = attributeDiscriminator(cached) ?? item?.discriminator;
    const kind = attributeKind(disc, cached);
    const rep = newReport(name, `Attribute type on ${t?.name ?? ''}`);
    setCrumbs([{ label: t?.name ?? 'Type', onclick: () => ctx.navigate({ selection: null }) }, { label: name }]);
    rep('Overview', [`Kind: ${kind.label}`, `Public ID: ${cached?.publicId ?? item?.publicId ?? '—'}`]);
    body.append(h('header', { class: 'detail-header' },
      h('span', { class: 'kind-badge', 'aria-hidden': 'true' }, kind.icon),
      h('div', { class: 'detail-heading' },
        h('h2', null, name),
        h('div', { class: 'detail-sub' }, h('code', null, cached?.publicId ?? item?.publicId ?? ''), chip(kind.label, 'chip-accent'), cached?.system ? chip('OOTB', 'chip-ootb') : null))));

    const descSlot = h('div');
    body.append(descSlot);
    body.append(assignmentInfo(item, rep));

    const defSlot = h('div');
    const defRep = rep('Definition', []);
    body.append(card('Definition details', defSlot));

    const usageSlot = h('span', null, '…');
    const usageRep = rep('Usage', ['…']);
    body.append(card('Usage', kv([['Attribute values in catalog', usageSlot]])));
    ctx.rest.countAttributes(id, { signal }).then((n) => {
      usageSlot.textContent = formatNumber(n);
      usageRep.lines = [`Attribute values in catalog: ${formatNumber(n)}`];
    }, (e) => {
      if (!isAbort(e)) usageSlot.textContent = 'n/a';
    });

    const drill = usageList('attr', { id }, rep, signal);
    body.append(card('Asset types that also use this attribute', drill.el));
    st.view.onIndexProgress = drill.redraw;

    const metaSlot = h('div');
    body.append(metaSlot);

    ctx.attributeTypeFull(id, { signal }).then((full) => {
      if (signal.aborted) return;
      descSlot.replaceChildren(descriptionBlock(full?.description ?? cached?.description, rep));
      const k = attributeKind(attributeDiscriminator(full), full);
      const known = ['id', 'name', 'publicId', 'description', 'createdBy', 'createdOn', 'lastModifiedBy', 'lastModifiedOn', 'resourceType', 'attributeTypeDiscriminator', 'allowedValues'];
      const rows = [
        ['Kind', k.label],
        full?.stringType ? ['String type', full.stringType === 'RICH_TEXT' ? 'Rich text' : 'Plain text'] : null,
        full?.isInteger != null ? ['Integer only', full.isInteger ? 'Yes' : 'No'] : null,
        full?.statisticsEnabled != null ? ['Statistics enabled', full.statisticsEnabled ? 'Yes' : 'No'] : null,
        full?.language ? ['Language', full.language] : null,
        ['System', full?.system ? 'Yes' : 'No'],
      ].filter(Boolean);
      for (const [key, v] of Object.entries(full ?? {})) {
        if (known.includes(key) || rows.some((r) => r[0].toLowerCase().replace(/\s/g, '') === key.toLowerCase())) continue;
        if (['stringType', 'isInteger', 'statisticsEnabled', 'language', 'system'].includes(key)) continue;
        if (v == null || typeof v === 'object') continue;
        rows.push([key, String(v)]);
      }
      const allowed = Array.isArray(full?.allowedValues) ? full.allowedValues : [];
      const allowedHost = h('div');
      if (allowed.length) {
        const chipsHost = h('div', { class: 'chips' });
        const renderChips = (q = '') => {
          const ql = q.trim().toLowerCase();
          const list = ql ? allowed.filter((v) => String(v).toLowerCase().includes(ql)) : allowed;
          chipsHost.replaceChildren(...list.map((v) => h('span', { class: 'chip' }, ...highlight(String(v), q))));
        };
        renderChips();
        allowedHost.append(h('div', { class: 'label' }, `Allowed values (${allowed.length})`));
        if (allowed.length > 20) allowedHost.append(h('input', { type: 'search', class: 'input input-small', placeholder: 'Filter values', 'aria-label': 'Filter allowed values', oninput: (e) => renderChips(e.target.value) }));
        allowedHost.append(chipsHost);
      }
      defSlot.replaceChildren(kv(rows), allowedHost);
      defRep.lines = [...rows.map(([a, b]) => `${a}: ${b}`), ...(allowed.length ? [`Allowed values: ${allowed.join(', ')}`] : [])];
      metaSlot.replaceChildren(metadataBlock(full, rep, signal));
    }, (e) => {
      if (isAbort(e)) return;
      descSlot.replaceChildren(descriptionBlock(cached?.description, rep));
      defSlot.replaceChildren(errorNote(e) ?? '');
      metaSlot.replaceChildren(metadataBlock(cached, rep, signal));
    });
  }

  // --- Relation type -------------------------------------------------------------------------
  function showRelation(route, scope, signal) {
    const { id, dir } = route.selection;
    const rt = ctx.state.meta.relationTypesById.get(id);
    const candidates = scope?.relations.filter((r) => r.id === id) ?? [];
    const item = candidates.find((r) => r.direction === dir) ?? candidates[0] ?? null;
    const t = typeOf(route.typeId);
    const label = item?.label ?? rt?.role ?? 'Relation';
    const rep = newReport(`${rt?.sourceType?.name ?? '?'} ${rt?.role ?? ''} ${rt?.targetType?.name ?? '?'}`, `Relation type on ${t?.name ?? ''}`);
    setCrumbs([{ label: t?.name ?? 'Type', onclick: () => ctx.navigate({ selection: null }) }, { label }]);
    const other = item?.otherType ?? (dir === 'in' ? rt?.sourceType : rt?.targetType);

    rep('Overview', [`${rt?.sourceType?.name} —${rt?.role}→ ${rt?.targetType?.name}`, `${rt?.targetType?.name} —${rt?.coRole}→ ${rt?.sourceType?.name}`, `Public ID: ${rt?.publicId ?? '—'}`]);
    body.append(h('header', { class: 'detail-header rel-header' },
      h('div', { class: 'detail-heading' },
        h('div', { class: 'rel-line' }, typeLink(rt?.sourceType), h('span', { class: 'rel-role out' }, `—${rt?.role ?? '?'}→`), typeLink(rt?.targetType)),
        h('div', { class: 'rel-line muted' }, typeLink(rt?.targetType), h('span', { class: 'rel-role in' }, `—${rt?.coRole ?? '?'}→`), typeLink(rt?.sourceType)),
        h('div', { class: 'detail-sub' }, h('code', null, rt?.publicId ?? ''), rt?.system ? chip('OOTB', 'chip-ootb') : null))));

    if (other?.id) {
      body.append(h('div', { class: 'action-row' },
        h('button', { class: 'btn btn-primary', type: 'button', 'aria-pressed': 'true' }, 'View this relation'),
        h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate({ typeId: other.id, selection: null }) }, `Open ${other.name ?? 'type'}`)));
    }

    body.append(descriptionBlock(rt?.description, rep));
    body.append(assignmentInfo(item, rep, item ? [['Direction', item.direction === 'out' ? `Outgoing — ${t?.name} is the source (role “${item.role}”)` : `Incoming — ${t?.name} is the target (co-role “${item.coRole}”)`], ['Other side', typeLink(item.otherType)]] : []));

    const hier = ctx.state.hierarchy;
    const endpoint = (ref, role) => {
      if (!ref?.id) return h('p', { class: 'muted' }, '—');
      const desc = hier.descendants(ref.id);
      return h('div', { class: 'endpoint' },
        h('div', { class: 'label' }, role), typeLink(ref),
        desc.length ? h('details', { class: 'sub-details' }, h('summary', null, `${desc.length} subtype${desc.length === 1 ? '' : 's'} also qualify`),
          h('div', { class: 'chips' }, desc.map((d) => typeLink({ id: d })))) : null);
    };
    rep('Endpoints', [`Source: ${rt?.sourceType?.name} (+${hier.descendants(rt?.sourceType?.id).length} subtypes)`, `Target: ${rt?.targetType?.name} (+${hier.descendants(rt?.targetType?.id).length} subtypes)`]);
    body.append(card('Endpoints', h('div', { class: 'endpoints' }, endpoint(rt?.sourceType, 'Source'), endpoint(rt?.targetType, 'Target'))));

    const usageSlot = h('span', null, '…');
    const usageRep = rep('Usage', ['…']);
    body.append(card('Usage', kv([['Relations in catalog', usageSlot]])));
    ctx.rest.countRelations(id, { signal }).then((n) => {
      usageSlot.textContent = formatNumber(n);
      usageRep.lines = [`Relations in catalog: ${formatNumber(n)}`];
    }, (e) => {
      if (!isAbort(e)) usageSlot.textContent = 'n/a';
    });

    const drill = usageList('rel', { id }, rep, signal);
    body.append(card('Asset types that use this relation', drill.el));
    st.view.onIndexProgress = drill.redraw;

    const pair = new Set([rt?.sourceType?.id, rt?.targetType?.id]);
    const others = [...ctx.state.meta.relationTypesById.values()].filter((x) => x.id !== id && pair.has(x.sourceType?.id) && pair.has(x.targetType?.id)
      && (x.sourceType?.id !== x.targetType?.id || rt?.sourceType?.id === rt?.targetType?.id));
    rep('Other relation types between these asset types', others.map((x) => `${x.sourceType?.name} —${x.role}→ ${x.targetType?.name}`));
    body.append(card(`Other relation types between these types (${others.length})`, others.length
      ? h('ul', { class: 'plain-list' }, others.map((x) => {
        const inScope = scope?.relations.find((r) => r.id === x.id);
        return h('li', null, h('button', {
          class: 'link-btn', type: 'button',
          onclick: () => (inScope ? ctx.selectItem(inScope) : ctx.navigate({ typeId: x.sourceType?.id, selection: { kind: 'rel', id: x.id, dir: 'out' } })),
        }, `${x.sourceType?.name} —${x.role}→ ${x.targetType?.name}`), inScope ? null : h('span', { class: 'muted small' }, ' (not on this type)'));
      }))
      : h('p', { class: 'muted' }, 'None'), { open: others.length > 0 && others.length <= 10 }));

    body.append(metadataBlock(rt, rep, signal));
  }

  // --- Complex relation type -----------------------------------------------------------------
  function showComplex(route, scope, signal) {
    const id = route.selection.id;
    const crt = ctx.state.meta.complexRelationTypesById.get(id);
    const item = scope?.complexRelations.find((c) => c.id === id) ?? null;
    const t = typeOf(route.typeId);
    const name = crt?.name ?? item?.name ?? 'Complex relation';
    const rep = newReport(name, `Complex relation type on ${t?.name ?? ''}`);
    setCrumbs([{ label: t?.name ?? 'Type', onclick: () => ctx.navigate({ selection: null }) }, { label: name }]);
    body.append(h('header', { class: 'detail-header' },
      h('span', { class: 'kind-badge hex', 'aria-hidden': 'true' }, '⬡'),
      h('div', { class: 'detail-heading' }, h('h2', null, name), h('div', { class: 'detail-sub' }, h('code', null, crt?.publicId ?? '')))));
    body.append(descriptionBlock(crt?.description, rep));
    body.append(assignmentInfo(item, rep));
    const legs = crt?.legTypes ?? [];
    rep('Legs', legs.map((l) => `${l.role ?? ''} / ${l.coRole ?? ''}: ${l.assetType?.name ?? '?'} (${formatOccurrence({ min: l.min, max: l.max })})`));
    body.append(card(`Legs (${legs.length})`, legs.length
      ? h('table', { class: 'char-table' }, h('thead', null, h('tr', null, h('th', null, 'Role'), h('th', null, 'Co-role'), h('th', null, 'Asset type'), h('th', null, 'Occurs'))),
        h('tbody', null, legs.map((l) => h('tr', null, h('td', null, l.role ?? ''), h('td', null, l.coRole ?? ''), h('td', null, l.assetType ? typeLink(l.assetType) : '—'), h('td', null, formatOccurrence({ min: l.min, max: l.max }))))))
      : h('p', { class: 'muted' }, 'None')));
    const attrs = crt?.attributeTypes ?? [];
    rep('Attributes', attrs.map((a) => a.attributeType?.name ?? a.name ?? ''));
    body.append(card(`Attributes (${attrs.length})`, attrs.length
      ? h('ul', { class: 'plain-list' }, attrs.map((a) => h('li', null, a.attributeType?.name ?? a.name ?? '?', ' ', h('span', { class: 'muted small' }, formatOccurrence({ min: a.min, max: a.max })))))
      : h('p', { class: 'muted' }, 'None')));
    const drill = usageList('complex', { id }, rep, signal);
    body.append(card('Asset types that use this complex relation', drill.el));
    st.view.onIndexProgress = drill.redraw;
    body.append(metadataBlock(crt, rep, signal));
  }

  // --- Full usage list (third drill level) ---------------------------------------------------
  function showUsage(route, scope, signal) {
    const { kind, item } = st.usage;
    const t = typeOf(route.typeId);
    const itemName = kind === 'attr' ? ctx.state.meta.attributeTypesById.get(item.id)?.name : kind === 'rel' ? ctx.state.meta.relationTypesById.get(item.id)?.role : ctx.state.meta.complexRelationTypesById.get(item.id)?.name;
    const title = kind === 'attr' ? 'Asset types using it' : 'Asset types using it';
    const rep = newReport(`${itemName ?? ''}: ${title}`, t?.name ?? '');
    setCrumbs([
      { label: t?.name ?? 'Type', onclick: () => ctx.navigate({ selection: null }) },
      { label: itemName ?? 'Item', onclick: () => { st.usage = null; render(); } },
      { label: title },
    ]);
    const drill = usageList(kind, item, rep, signal, { preview: false });
    body.append(card(title, drill.el));
    st.view.onIndexProgress = drill.redraw;
  }

  let last = { route: null, scope: null };
  function render() {
    const { route, scope } = last;
    st.controller?.abort();
    st.controller = new AbortController();
    const { signal } = st.controller;
    st.view = {};
    st.searchWidget?.destroy?.();
    st.searchWidget = null;
    clear(body);
    body.scrollTop = 0;
    if (!route?.typeId) {
      setCrumbs([{ label: 'Details' }]);
      st.report = null;
      body.append(h('div', { class: 'empty-state' }, h('p', null, 'Select an asset type in the tree to explore its operating model.')));
      return;
    }
    try {
      if (st.usage) showUsage(route, scope, signal);
      else if (!route.selection) showType(route, scope, signal);
      else if (route.selection.kind === 'attr') showAttribute(route, scope, signal);
      else if (route.selection.kind === 'rel') showRelation(route, scope, signal);
      else if (route.selection.kind === 'complex') showComplex(route, scope, signal);
    } catch (e) {
      console.error('[om-explorer] details render failed', e);
      body.append(h('p', { class: 'note note-error' }, `Something went wrong rendering this panel: ${e.message}`));
    }
  }

  return {
    show(route, scope) {
      const sameSel = last.route && last.route.typeId === route.typeId && JSON.stringify(last.route.selection) === JSON.stringify(route.selection);
      if (!sameSel) st.usage = null;
      last = { route, scope };
      render();
    },
    openUsage(kind, item) {
      st.usage = { kind, item };
      render();
    },
    getReport: () => st.report,
    itemKey,
  };
}
