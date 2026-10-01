function defaultStorage(kind) {
  try {
    return globalThis[kind] ?? null;
  } catch {
    return null;
  }
}

// TTL cache over Web Storage; every access is guarded (quota, private mode, disabled storage).
export function createStore({ storage = defaultStorage('sessionStorage'), now = () => Date.now(), ttlMs = 60 * 60 * 1000, namespace = 'omx' } = {}) {
  const root = `${namespace}:`;
  let prefix = root;

  function clear() {
    try {
      for (let i = storage.length - 1; i >= 0; i--) {
        const k = storage.key(i);
        if (k?.startsWith(root)) storage.removeItem(k);
      }
    } catch { /* storage unavailable */ }
  }

  return {
    setScope(origin, userId) {
      const owner = `${origin}:${userId}`;
      try {
        if (storage.getItem(`${root}owner`) !== owner) {
          clear();
          storage.setItem(`${root}owner`, owner);
        }
      } catch { /* storage unavailable */ }
      prefix = `${root}${owner}:`;
    },
    get(key) {
      try {
        const raw = storage.getItem(prefix + key);
        if (!raw) return null;
        const { t, v } = JSON.parse(raw);
        if (!(now() - t <= ttlMs)) {
          storage.removeItem(prefix + key);
          return null;
        }
        return v;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        storage.setItem(prefix + key, JSON.stringify({ t: now(), v: value }));
        return true;
      } catch {
        return false;
      }
    },
    clear,
  };
}

export function createPrefs({ storage = defaultStorage('localStorage'), key = 'omx-prefs' } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(storage.getItem(key) || '{}') || {};
  } catch {
    cache = {};
  }
  return {
    get: (k, fallback) => (k in cache ? cache[k] : fallback),
    set(k, v) {
      cache[k] = v;
      try {
        storage.setItem(key, JSON.stringify(cache));
      } catch { /* storage unavailable */ }
    },
  };
}

// In-flight de-duplicating memo for promises; failed entries are evicted so they can be retried.
export function createMemo() {
  const map = new Map();
  return {
    get(key, fn) {
      if (!map.has(key)) {
        const p = Promise.resolve().then(fn);
        map.set(key, p);
        p.catch(() => map.delete(key));
      }
      return map.get(key);
    },
    peek: (key) => map.get(key),
    clear: () => map.clear(),
  };
}
