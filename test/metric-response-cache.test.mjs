import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricResponseCache } from '../lib/metric-response-cache.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('serves the latest value while a background refresh updates the cache', async () => {
  let now = 0;
  const cache = createMetricResponseCache({
    refreshAfterMs: 2_000,
    staleAfterMs: 8_000,
    now: () => now
  });
  const initial = await cache.get('pod/demo/api', async () => ({ available: true, cpuMilli: 10, memBytes: 100 }));
  assert.equal(initial.state, 'miss');
  assert.equal(initial.data.cpuMilli, 10);

  now = 3_000;
  let finishRefresh;
  const duringRefresh = await cache.get('pod/demo/api', () => new Promise((resolve) => { finishRefresh = resolve; }));
  assert.equal(duringRefresh.data.cpuMilli, 10);
  assert.equal(duringRefresh.data.refreshing, true);
  assert.equal(duringRefresh.data.stale, false);
  await tick();
  finishRefresh({ available: true, cpuMilli: 20, memBytes: 200 });
  await tick();

  now = 3_100;
  const refreshed = await cache.get('pod/demo/api', async () => {
    throw new Error('Fresh data should be served from the cache');
  });
  assert.equal(refreshed.state, 'hit');
  assert.equal(refreshed.data.cpuMilli, 20);
  assert.equal(refreshed.data.refreshing, false);
});

test('keeps a stale last-good value through refresh failures and retries promptly', async () => {
  let now = 0;
  const cache = createMetricResponseCache({
    refreshAfterMs: 1_000,
    staleAfterMs: 5_000,
    retryBaseMs: 5,
    retryMaxMs: 10,
    now: () => now
  });
  await cache.get('node/demo', async () => ({ available: true, cpuMilli: 100, memBytes: 1_000 }));

  now = 3_000;
  let failures = 0;
  const duringFailure = await cache.get('node/demo', async () => {
    failures++;
    throw new Error('temporary metrics outage');
  });
  assert.equal(duringFailure.data.cpuMilli, 100);
  assert.equal(duringFailure.data.refreshing, true);
  await tick();
  assert.equal(failures, 1);

  now = 3_004;
  const duringBackoff = await cache.get('node/demo', async () => {
    failures++;
    return { available: true, cpuMilli: 200, memBytes: 2_000 };
  });
  assert.equal(duringBackoff.data.cpuMilli, 100);
  assert.equal(duringBackoff.data.refreshing, false);
  assert.equal(duringBackoff.data.stale, true);
  assert.equal(failures, 1);

  now = 3_006;
  const retrying = await cache.get('node/demo', async () => {
    failures++;
    return { available: true, cpuMilli: 200, memBytes: 2_000 };
  });
  assert.equal(retrying.data.cpuMilli, 100);
  assert.equal(retrying.data.refreshing, true);
  await tick();

  now = 3_007;
  const recovered = await cache.get('node/demo', async () => {
    throw new Error('Recovered value should be cached');
  });
  assert.equal(recovered.data.cpuMilli, 200);
  assert.equal(recovered.data.memBytes, 2_000);
});

test('coalesces concurrent initial loads and bounds cache size with LRU eviction', async () => {
  let now = 0;
  const cache = createMetricResponseCache({ maxEntries: 1, now: () => now });
  let calls = 0;
  const firstLoader = async () => {
    calls++;
    await tick();
    return { available: true, cpuMilli: 1, memBytes: 10 };
  };
  const [first, concurrent] = await Promise.all([
    cache.get('pod/one', firstLoader),
    cache.get('pod/one', firstLoader)
  ]);
  assert.equal(calls, 1);
  assert.equal(first.data.cpuMilli, 1);
  assert.equal(concurrent.data.cpuMilli, 1);

  await cache.get('pod/two', async () => ({ available: true, cpuMilli: 2, memBytes: 20 }));
  now = 10_000;
  const reloaded = await cache.get('pod/one', async () => {
    calls++;
    return { available: true, cpuMilli: 3, memBytes: 30 };
  });
  assert.equal(calls, 2);
  assert.equal(reloaded.data.cpuMilli, 3);
});
