import { createQueue, isAbort } from './queue.js';

export class HttpError extends Error {
  constructor(message, { status = 0, kind = 'client', body = '', path = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.kind = kind;
    this.body = body;
    this.path = path;
  }
}

export function kindForStatus(status) {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'server';
  return 'client';
}

export function resolveBaseURL(doc = globalThis.document, loc = globalThis.location) {
  const override = doc?.querySelector?.('meta[name="collibra-base-url"]')?.getAttribute('content')?.trim();
  return (override || loc?.origin || '').replace(/\/+$/, '');
}

const SESSION_PATH = '/rest/2.0/auth/sessions/current?include=csrfToken&include=user';

export function createHttp({
  baseURL,
  fetchImpl = (...a) => globalThis.fetch(...a),
  queue = createQueue({ concurrency: 6 }),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  backoff = [500, 1000, 2000],
  onUnauthenticated = () => {},
} = {}) {
  let session = null;
  let sessionPromise = null;

  async function loadSession() {
    let res;
    try {
      res = await fetchImpl(baseURL + SESSION_PATH, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
    } catch {
      throw new HttpError('Could not reach Collibra.', { kind: 'network', path: SESSION_PATH });
    }
    if (!res.ok) {
      throw new HttpError(res.status === 401 ? 'You are not signed in to Collibra.' : `Session check failed (HTTP ${res.status}).`,
        { status: res.status, kind: kindForStatus(res.status), path: SESSION_PATH });
    }
    session = await res.json();
    return session;
  }

  function refreshSession() {
    sessionPromise ??= loadSession().finally(() => {
      sessionPromise = null;
    });
    return sessionPromise;
  }

  async function send(method, path, body, signal) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && session?.csrfToken) headers['X-CSRF-TOKEN'] = session.csrfToken;
    return fetchImpl(baseURL + path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  }

  async function attempt(method, path, body, signal) {
    let retries = 0;
    let reauthed = false;
    for (;;) {
      let res;
      try {
        res = await send(method, path, body, signal);
      } catch (e) {
        if (isAbort(e) || signal?.aborted) throw e;
        if (retries < backoff.length) {
          await sleep(backoff[retries++]);
          continue;
        }
        throw new HttpError('Network error — could not reach Collibra.', { kind: 'network', path });
      }
      // 401 = session expired; 403 on a write may be a rotated CSRF token. Re-check the session once.
      if (!reauthed && (res.status === 401 || (res.status === 403 && method !== 'GET'))) {
        reauthed = true;
        try {
          await refreshSession();
        } catch (e) {
          if (e.kind === 'unauthenticated') onUnauthenticated(e);
          throw e;
        }
        continue;
      }
      if (res.status >= 500 && retries < backoff.length) {
        await sleep(backoff[retries++]);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const kind = kindForStatus(res.status);
        if (kind === 'unauthenticated') onUnauthenticated();
        const msg = kind === 'forbidden' ? "You don't have permission to view this." : `HTTP ${res.status} for ${path}`;
        throw new HttpError(msg, { status: res.status, kind, body: text.slice(0, 500), path });
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
  }

  function request(path, { method = 'GET', body, signal, priority = 'interactive' } = {}) {
    return queue.run(() => attempt(method, path, body, signal), { priority, signal });
  }

  return {
    baseURL,
    queue,
    init: loadSession,
    getSession: () => session,
    get: (path, opts) => request(path, { ...opts, method: 'GET' }),
    post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  };
}
