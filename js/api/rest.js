export const MAX_PAGE_SIZE = 1000;

export function buildQuery(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.append(k, String(v));
  }
  const q = sp.toString();
  return q ? `?${q}` : '';
}

const clampLimit = (n) => Math.max(1, Math.min(Number(n) || MAX_PAGE_SIZE, MAX_PAGE_SIZE));

export async function* iterateOffset(get, path, params = {}, { pageSize = MAX_PAGE_SIZE, ...opts } = {}) {
  const limit = clampLimit(pageSize);
  for (let offset = 0; ; offset += limit) {
    const page = await get(path + buildQuery({ ...params, limit, offset }), opts);
    const results = page?.results ?? [];
    yield { results, total: page?.total ?? null, offset };
    if (results.length < limit) return;
  }
}

export async function* iterateCursor(get, path, params = {}, { pageSize = MAX_PAGE_SIZE, ...opts } = {}) {
  const limit = clampLimit(pageSize);
  let cursor = '';
  for (;;) {
    const page = await get(path + buildQuery({ ...params, limit, cursor }), opts);
    const results = page?.results ?? [];
    yield { results, nextCursor: page?.nextCursor ?? null };
    cursor = page?.nextCursor;
    if (!cursor || !results.length) return;
  }
}

const FATAL_KINDS = new Set(['unauthenticated', 'forbidden']);

// Collects every page. With {cursor:true}, falls back to offset paging if the first cursor request fails.
export async function fetchAll(get, path, params = {}, { cursor = false, onPage, ...opts } = {}) {
  const out = [];
  if (cursor) {
    try {
      for await (const p of iterateCursor(get, path, params, opts)) {
        out.push(...p.results);
        onPage?.(out.length);
      }
      return out;
    } catch (e) {
      if (out.length || e?.name === 'AbortError' || FATAL_KINDS.has(e?.kind)) throw e;
    }
  }
  for await (const p of iterateOffset(get, path, params, opts)) {
    out.push(...p.results);
    onPage?.(out.length, p.total);
  }
  return out;
}

export async function fetchPage(get, path, params = {}, { limit = 50, offset = 0, ...opts } = {}) {
  const l = clampLimit(limit);
  const page = await get(path + buildQuery({ ...params, limit: l, offset }), opts);
  const results = page?.results ?? [];
  return { results, total: page?.total ?? null, hasMore: results.length === l };
}

const id = (v) => encodeURIComponent(String(v));

export function createRestApi(http) {
  const get = (p, o) => http.get(p, o);
  const all = (path, params, o) => fetchAll(get, path, params, o);
  const total = async (path, params, o) => (await get(path + buildQuery({ ...params, limit: 1, offset: 0, countLimit: -1 }), o))?.total ?? null;

  return {
    assetTypes: (o) => all('/rest/2.0/assetTypes', { sortField: 'NAME', sortOrder: 'ASC' }, o),
    attributeTypes: (o) => all('/rest/2.0/attributeTypes', { sortField: 'NAME', sortOrder: 'ASC' }, o),
    relationTypes: (o) => all('/rest/2.0/relationTypes', { sortField: 'ROLE', sortOrder: 'ASC' }, o),
    complexRelationTypes: (o) => all('/rest/2.0/complexRelationTypes', {}, o),
    statuses: (o) => all('/rest/2.0/statuses', {}, o),
    domainTypes: (o) => all('/rest/2.0/domainTypes', {}, o),
    workflowDefinitions: (o) => all('/rest/2.0/workflowDefinitions', { sortField: 'NAME', sortOrder: 'ASC' }, o),
    assignmentsForType: (typeId, o) => get(`/rest/2.0/assignments/assetType/${id(typeId)}`, o),
    assignmentsForResource: (resourceId, resourceDiscriminator, o) =>
      get('/rest/2.0/assignments/forResource' + buildQuery({ resourceId, resourceDiscriminator }), o),
    attributeType: (attrId, o) => get(`/rest/2.0/attributeTypes/${id(attrId)}`, o),
    assetType: (typeId, o) => get(`/rest/2.0/assetTypes/${id(typeId)}`, o),
    user: (userId, o) => get(`/rest/2.0/users/${id(userId)}`, o),
    countAssets: (typeIds, { inheritance = false, ...o } = {}) =>
      total('/rest/2.0/assets', { typeIds, typeInheritance: inheritance, sortField: 'NAME' }, o),
    countAttributes: (attrTypeId, o) => total('/rest/2.0/attributes', { typeIds: [attrTypeId] }, o),
    countRelations: (relationTypeId, o) => total('/rest/2.0/relations', { relationTypeId }, o),
  };
}
