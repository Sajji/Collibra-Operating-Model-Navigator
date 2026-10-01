import { HttpError } from './http.js';

export const GRAPHQL_PATH = '/graphql/knowledgeGraph/v1';

export const FIND_ASSETS = `query FindAssets($where: AssetFilter, $limit: Int!, $offset: Int!) {
  assets(where: $where, limit: $limit, offset: $offset, order: [{ displayName: asc }]) {
    id
    displayName
    fullName
    modifiedOn
    status { id name }
    type { id name }
    domain { id name parent { id name } }
    stringAttributes(where: { type: { name: { eq: "Description" } } }, limit: 1) { stringValue }
  }
}`;

// Empty filters are omitted because some operators reject null.
export function buildAssetWhere({ typeIds, name, statusIds } = {}) {
  const and = [];
  if (typeIds?.length) and.push({ type: { id: { in: [...typeIds] } } });
  const n = String(name ?? '').trim();
  if (n) and.push({ _or: [{ displayName: { contains: n } }, { fullName: { contains: n } }] });
  if (statusIds?.length) and.push({ status: { id: { in: [...statusIds] } } });
  if (!and.length) return undefined;
  return and.length === 1 ? and[0] : { _and: and };
}

export function createGraphqlApi(http) {
  async function query(q, variables = {}, opts) {
    const res = await http.post(GRAPHQL_PATH, { query: q, variables }, opts);
    if (res?.errors?.length) throw new HttpError(res.errors[0]?.message || 'GraphQL error', { kind: 'graphql', path: GRAPHQL_PATH });
    return res?.data ?? {};
  }

  async function findAssets({ typeIds, name, statusIds, limit = 50, offset = 0 } = {}, opts) {
    const where = buildAssetWhere({ typeIds, name, statusIds });
    const data = await query(FIND_ASSETS, { where, limit, offset }, opts);
    const results = data.assets ?? [];
    return { results, hasMore: results.length === limit };
  }

  return { query, findAssets };
}
