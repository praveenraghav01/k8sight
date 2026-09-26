const hasMetricUsage = (data) => data && (data.cpuMilli != null || data.memBytes != null);

const wouldDiscardLastGoodMetrics = (previous, next) => (
  (previous?.available === true && next?.available !== true)
  || (hasMetricUsage(previous) && !hasMetricUsage(next))
);

export function createMetricResponseCache({
  refreshAfterMs = 2_000,
  staleAfterMs = 8_000,
  retryBaseMs = 1_500,
  retryMaxMs = 6_000,
  maxEntries = 300,
  now = Date.now
} = {}) {
  const entries = new Map();
  const inFlight = new Map();

  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };

  const markRefreshFailed = (key, entry) => {
    if (!entry) return;
    const failedAttempts = (entry.failedAttempts || 0) + 1;
    const retryDelay = Math.min(
      retryBaseMs * (2 ** Math.min(failedAttempts - 1, 4)),
      retryMaxMs
    );
    touch(key, { ...entry, failedAttempts, retryAfter: now() + retryDelay });
  };

  const refresh = (key, loader) => {
    const pending = inFlight.get(key);
    if (pending) return pending;

    const promise = Promise.resolve().then(async () => {
      const latest = entries.get(key);
      const startedAt = now();
      if (latest && startedAt - latest.updatedAt < refreshAfterMs) return latest.data;
      if (latest?.retryAfter > startedAt) return latest.data;

      try {
        const data = await loader();
        if (latest && wouldDiscardLastGoodMetrics(latest.data, data)) {
          markRefreshFailed(key, latest);
          return latest.data;
        }
        touch(key, { data, updatedAt: now(), failedAttempts: 0, retryAfter: 0 });
        return data;
      } catch (error) {
        markRefreshFailed(key, latest);
        throw error;
      }
    }).finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };

  const get = async (key, loader) => {
    const entry = entries.get(key);
    if (!entry) {
      const data = await refresh(key, loader);
      return { data: { ...data, stale: false, refreshing: false, cacheAgeMs: 0 }, state: 'miss' };
    }

    const age = Math.max(0, now() - entry.updatedAt);
    if (age >= refreshAfterMs && !(entry.retryAfter > now())) refresh(key, loader).catch(() => {});

    const stale = age >= staleAfterMs || Boolean(entry.failedAttempts);
    const refreshing = inFlight.has(key);
    touch(key, entry);
    return {
      data: { ...entry.data, stale, refreshing, cacheAgeMs: age },
      state: stale ? 'stale' : refreshing ? 'refreshing' : 'hit'
    };
  };

  return { get };
}
