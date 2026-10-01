import { characteristicRefs } from './assignment.js';
import { isAbort } from '../api/queue.js';

const DIRECTION_ROLE = { TO_TARGET: 'source', TO_SOURCE: 'target', BOTH: 'both' };

const usageOf = (a, ref) => ({
  scope: a.scope?.name ?? null,
  min: Number.isFinite(ref.minimumOccurrences) ? ref.minimumOccurrences : 0,
  max: Number.isFinite(ref.maximumOccurrences) ? ref.maximumOccurrences : null,
  role: DIRECTION_ROLE[ref.relationTypeDirection] ?? null,
});

const sortEntries = (m) => [...m.values()].sort((x, y) => x.assetTypeName.localeCompare(y.assetTypeName));

function addUsage(byType, a, ref) {
  const typeId = a.assetType.id;
  if (!byType.has(typeId)) byType.set(typeId, { assetTypeId: typeId, assetTypeName: a.assetType.name ?? '', usages: [] });
  byType.get(typeId).usages.push(usageOf(a, ref));
}

// Reverse-lookup entries for one characteristic id across a list of assignments, grouped by asset type.
export function entriesFor(assignments, characteristicId) {
  const byType = new Map();
  for (const a of assignments ?? []) {
    if (!a?.assetType?.id) continue;
    for (const ref of characteristicRefs(a)) {
      if (ref?.assignedResourceReference?.id === characteristicId) addUsage(byType, a, ref);
    }
  }
  return sortEntries(byType);
}

// Builds id -> [{assetTypeId, assetTypeName, usages}] for every characteristic in the crawled assignments.
export function buildIndex(assignmentLists) {
  const index = new Map();
  for (const assignments of assignmentLists) {
    for (const a of assignments ?? []) {
      if (!a?.assetType?.id) continue;
      for (const ref of characteristicRefs(a)) {
        const cid = ref?.assignedResourceReference?.id;
        if (!cid) continue;
        if (!index.has(cid)) index.set(cid, new Map());
        addUsage(index.get(cid), a, ref);
      }
    }
  }
  return new Map([...index].map(([k, m]) => [k, sortEntries(m)]));
}

const DISCRIMINATOR = { attr: 'AttributeType', rel: 'RelationType', complex: 'ComplexRelationType' };

// Uses /assignments/forResource when available; otherwise crawls every asset type's assignment.
export function createIndexer({ api, getTypeIds, store, concurrency = 6 }) {
  let mode = 'direct';
  const cache = new Map();
  const listeners = new Set();
  const crawl = { started: false, done: 0, total: 0, complete: false, lists: [], index: new Map() };

  const notify = () => listeners.forEach((fn) => fn(status()));
  const status = () => ({ mode, done: crawl.done, total: crawl.total, complete: mode === 'direct' || crawl.complete });

  async function startCrawl() {
    if (crawl.started) return;
    crawl.started = true;
    const cached = store?.get('crawlIndex');
    if (cached) {
      crawl.index = new Map(cached);
      crawl.complete = true;
      crawl.done = crawl.total = cached.length;
      notify();
      return;
    }
    const ids = getTypeIds();
    crawl.total = ids.length;
    let next = 0;
    let lastRebuild = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          crawl.lists.push(await api.assignmentsForType(id, { priority: 'background' }));
        } catch (e) {
          if (e?.kind === 'unauthenticated') throw e;
        }
        crawl.done++;
        if (crawl.done - lastRebuild >= 20 || crawl.done === ids.length) {
          lastRebuild = crawl.done;
          crawl.index = buildIndex(crawl.lists);
          notify();
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker)).catch(() => {});
    crawl.complete = true;
    crawl.index = buildIndex(crawl.lists);
    store?.set('crawlIndex', [...crawl.index]);
    notify();
  }

  async function lookup(kind, id, { signal } = {}) {
    const key = `${kind}:${id}`;
    if (mode === 'direct') {
      if (cache.has(key)) return cache.get(key);
      try {
        const assignments = await api.assignmentsForResource(id, DISCRIMINATOR[kind], { signal });
        const result = { complete: true, entries: entriesFor(assignments, id) };
        cache.set(key, result);
        return result;
      } catch (e) {
        if (isAbort(e) || e?.kind === 'unauthenticated' || e?.kind === 'forbidden') throw e;
        mode = 'crawl';
        notify();
      }
    }
    startCrawl();
    return { complete: crawl.complete, entries: crawl.index.get(id) ?? [] };
  }

  return {
    lookup,
    status,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
