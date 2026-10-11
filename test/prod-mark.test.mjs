// Tests for production-cluster name detection and manual-override resolution
// (client/src/lib/prodMark.js). The pure functions take no DOM, so they run
// under node:test directly. The localStorage-backed load/save helpers are not
// exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProductionByName, resolveProd, toggleMark } from '../client/src/lib/prodMark.js';

test('detects prod / production / prd as a separate word', () => {
  for (const name of ['prod', 'production', 'prd', 'prod-eu', 'k8s_production', 'prd01', 'eks-prod', 'my.prod.cluster', 'PROD', 'Production-US']) {
    assert.equal(isProductionByName(name), true, `${name} should be production`);
  }
});

test('does not match prod embedded in a larger word', () => {
  for (const name of ['preprod', 'nonprod', 'reproduction', 'productive', 'prodigy', 'staging', 'dev', 'qa', 'prduction', 'uat']) {
    assert.equal(isProductionByName(name), false, `${name} should NOT be production`);
  }
});

test('empty / nullish names are not production', () => {
  assert.equal(isProductionByName(''), false);
  assert.equal(isProductionByName(null), false);
  assert.equal(isProductionByName(undefined), false);
});

test('resolveProd: explicit mark overrides the name rule', () => {
  assert.equal(resolveProd('staging', { staging: true }), true);   // force-on a non-prod name
  assert.equal(resolveProd('prod-eu', { 'prod-eu': false }), false); // force-off a prod name
  assert.equal(resolveProd('prod-eu', {}), true);                   // falls back to the name
  assert.equal(resolveProd('staging', {}), false);
});

test('toggleMark flips state and clears the override when it matches the name rule', () => {
  // prod name, no override → toggling off stores an explicit false
  let m = toggleMark({}, 'prod-eu');
  assert.equal(m['prod-eu'], false);
  // toggling it again returns to the name rule (true) → override removed, not stored as true
  m = toggleMark(m, 'prod-eu');
  assert.ok(!Object.prototype.hasOwnProperty.call(m, 'prod-eu'));

  // non-prod name → toggling on stores explicit true
  let s = toggleMark({}, 'staging');
  assert.equal(s.staging, true);
  // toggling off returns to the name rule (false) → override removed
  s = toggleMark(s, 'staging');
  assert.ok(!Object.prototype.hasOwnProperty.call(s, 'staging'));
});
