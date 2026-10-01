export function isAbort(e) {
  return e?.name === 'AbortError';
}

export function abortError(signal) {
  if (signal?.reason?.name === 'AbortError') return signal.reason;
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

// Bounded-concurrency queue where interactive jobs always start before background jobs.
export function createQueue({ concurrency = 6 } = {}) {
  const pending = { interactive: [], background: [] };
  let active = 0;

  function pump() {
    while (active < concurrency) {
      const job = pending.interactive.shift() ?? pending.background.shift();
      if (!job) return;
      job.signal?.removeEventListener('abort', job.onAbort);
      if (job.signal?.aborted) {
        job.reject(abortError(job.signal));
        continue;
      }
      active++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function run(fn, { priority = 'interactive', signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const list = priority === 'background' ? pending.background : pending.interactive;
      const job = { fn, resolve, reject, signal };
      if (signal) {
        job.onAbort = () => {
          const i = list.indexOf(job);
          if (i >= 0) {
            list.splice(i, 1);
            reject(abortError(signal));
          }
        };
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      list.push(job);
      pump();
    });
  }

  return {
    run,
    stats: () => ({ active, queued: pending.interactive.length + pending.background.length }),
  };
}
