const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' });

export function missingParentIds(types) {
  const ids = new Set((types ?? []).map((t) => t.id));
  return [...new Set((types ?? []).map((t) => t.parent?.id).filter((p) => p && !ids.has(p)))];
}

// /assetTypes excludes meta types by default, which drops the "Asset" root; fetch such parents individually.
export async function withMissingParents(types, fetchType, maxRounds = 5) {
  let all = [...types];
  for (let round = 0; round < maxRounds; round++) {
    const missing = missingParentIds(all);
    if (!missing.length) break;
    const fetched = await Promise.all(missing.map((id) => fetchType(id).catch(() => null)));
    const found = fetched.filter((t) => t?.id);
    if (!found.length) break;
    all = all.concat(found);
  }
  return all;
}

export function buildHierarchy(types) {
  const byId = new Map();
  for (const t of types ?? []) if (t?.id) byId.set(t.id, t);
  const parentOf = new Map();
  for (const t of byId.values()) {
    const pid = t.parent?.id;
    if (pid && pid !== t.id && byId.has(pid)) parentOf.set(t.id, pid);
  }
  // Cut cycles: a node whose ancestor walk returns to itself becomes a root.
  for (const idStart of byId.keys()) {
    const seen = new Set([idStart]);
    for (let p = parentOf.get(idStart); p; p = parentOf.get(p)) {
      if (p === idStart) {
        parentOf.delete(idStart);
        break;
      }
      if (seen.has(p)) break;
      seen.add(p);
    }
  }
  const children = new Map();
  const roots = [];
  for (const t of byId.values()) {
    const pid = parentOf.get(t.id);
    if (pid) {
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(t);
    } else {
      roots.push(t);
    }
  }
  const childIds = new Map();
  for (const [pid, list] of children) childIds.set(pid, list.sort(byName).map((t) => t.id));
  const rootIds = roots.sort(byName).map((t) => t.id);

  const ancestorCache = new Map();
  const ancestors = (id) => {
    if (ancestorCache.has(id)) return ancestorCache.get(id);
    const out = [];
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) out.push(p);
    ancestorCache.set(id, out);
    return out;
  };

  const keys = new Map();
  for (const t of byId.values()) {
    keys.set(t.id, { name: String(t.name ?? '').toLowerCase(), publicId: String(t.publicId ?? '').toLowerCase() });
  }

  function descendants(id) {
    const out = [];
    const stack = [...(childIds.get(id) ?? [])];
    while (stack.length) {
      const c = stack.pop();
      out.push(c);
      stack.push(...(childIds.get(c) ?? []));
    }
    return out;
  }

  return {
    byId,
    roots: rootIds,
    parentOf,
    children: (id) => childIds.get(id) ?? [],
    childCount: (id) => childIds.get(id)?.length ?? 0,
    ancestors,
    path: (id) => [...ancestors(id)].reverse().concat(byId.has(id) ? [id] : []),
    descendants,
    keys,
    size: byId.size,
  };
}

export function filterHierarchy(hier, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return null;
  const matches = new Set();
  const visible = new Set();
  for (const [id, key] of hier.keys) {
    if (key.name.includes(q) || key.publicId.includes(q)) {
      matches.add(id);
      visible.add(id);
      for (const a of hier.ancestors(id)) visible.add(a);
    }
  }
  return { query: q, matches, visible };
}

// Flattens the tree into the rows currently shown, honouring expansion and an optional filter.
export function visibleRows(hier, expanded, filter) {
  const rows = [];
  const walk = (ids, level) => {
    const shown = filter ? ids.filter((id) => filter.visible.has(id)) : ids;
    shown.forEach((id, i) => {
      const kids = hier.children(id);
      const hasShownKids = filter ? kids.some((k) => filter.visible.has(k)) : kids.length > 0;
      const isOpen = hasShownKids && (filter ? true : expanded.has(id));
      rows.push({ id, level, hasChildren: kids.length > 0, expanded: isOpen, posInSet: i + 1, setSize: shown.length });
      if (isOpen) walk(kids, level + 1);
    });
  };
  walk(hier.roots, 1);
  return rows;
}
