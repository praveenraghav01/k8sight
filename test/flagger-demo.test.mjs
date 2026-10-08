// Regression tests for the Flagger demo API (demo.js), which mirrors the
// shape of the real /api/flagger/* endpoints in server.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../demo.js';

const call = (method, path, query = {}) => {
  let status = 200, body;
  const res = { status(c) { status = c; return this; }, json(o) { body = o; return this; } };
  const handled = handle({ method, path, query }, res);
  return { handled, status, body };
};

test('Flagger is reported as installed in the demo cluster', () => {
  const { handled, body } = call('GET', '/api/flagger/status');
  assert.equal(handled, true);
  assert.equal(body.installed, true);
});

test('demo canaries cover every strategy and the key phases', () => {
  const { body } = call('GET', '/api/flagger/resources', { kind: 'canary' });
  const byName = Object.fromEntries(body.resources.map((r) => [r.name, r]));
  assert.equal(byName.frontend.strategy, 'Canary');
  assert.equal(byName.frontend.phase, 'Progressing');
  assert.equal(byName.frontend.weight, 30);
  assert.equal(byName.frontend.maxWeight, 50);
  assert.equal(byName.checkout.strategy, 'Blue/Green');
  assert.equal(byName.checkout.phase, 'WaitingPromotion');
  assert.equal(byName.checkout.maxWeight, null, 'iteration strategies have no weight ceiling');
  assert.equal(byName.payments.strategy, 'A/B testing');
  assert.equal(byName.payments.phase, 'Failed');
  assert.equal(byName.cart.suspended, true);
  for (const r of body.resources) {
    assert.ok(!Object.keys(r).some((k) => k.startsWith('_')), `${r.name} leaks internal fields`);
    assert.ok(Date.now() - new Date(r.lastTransition).getTime() >= 0, `${r.name} has a future transition time`);
  }
});

test('canary detail lists analysis config and generated objects', () => {
  const { body } = call('GET', '/api/flagger/resource/canary/shop/frontend');
  assert.ok(body.analysis.metrics.some((m) => m.templateRef?.name === 'not-found-percentage'));
  assert.ok(body.analysis.webhooks.some((w) => w.type === 'pre-rollout'));
  const names = body.generated.map((g) => `${g.kind}/${g.name}`);
  for (const n of ['Deployment/frontend-primary', 'Service/frontend-canary', 'Service/frontend-primary', 'HorizontalPodAutoscaler/frontend-primary']) {
    assert.ok(names.includes(n), `missing generated ${n}`);
  }
  // events newest first
  const times = body.events.map((e) => new Date(e.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('a suspended canary cannot be restarted until resumed', () => {
  assert.equal(call('POST', '/api/flagger/canary/shop/cart/restart').status, 409);
  assert.equal(call('POST', '/api/flagger/canary/shop/cart/resume').status, 200);
  const r = call('POST', '/api/flagger/canary/shop/cart/restart');
  assert.equal(r.status, 200);
  const { body } = call('GET', '/api/flagger/resource/canary/shop/cart');
  assert.equal(body.summary.phase, 'Progressing');
  assert.equal(body.summary.weight, 0);
});

test('restart with skip analysis promotes straight away', () => {
  call('POST', '/api/flagger/canary/shop/catalog/skip-analysis');
  call('POST', '/api/flagger/canary/shop/catalog/restart');
  const { body } = call('GET', '/api/flagger/resource/canary/shop/catalog');
  assert.equal(body.summary.phase, 'Succeeded');
  assert.equal(body.summary.skipAnalysis, true);
});

test('unknown Flagger kinds are rejected', () => {
  assert.equal(call('GET', '/api/flagger/resources', { kind: 'nope' }).status, 400);
  assert.equal(call('GET', '/api/flagger/resource/nope/shop/x').status, 400);
});
