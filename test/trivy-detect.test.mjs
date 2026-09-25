// Unit tests for foreign Trivy-operator detection (lib/trivy-detect.mjs).
// The Security Center distinguishes the official Aqua operator from lookalike
// third-party operators so it can explain the mismatch instead of just saying
// "not installed". These cover the branches the status endpoint depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectForeignTrivy, OFFICIAL_TRIVY_GROUP } from '../lib/trivy-detect.mjs';

test('detects the devopstales operator by its known group', () => {
  const names = new Set([
    'vulnerabilityreports.trivy-operator.devopstales.io',
    'cluster-scanners.trivy-operator.devopstales.io',
    'namespace-scanners.trivy-operator.devopstales.io',
    'ingressroutes.traefik.io', // unrelated CRD, ignored
  ]);
  assert.deepEqual(detectForeignTrivy(names), {
    group: 'trivy-operator.devopstales.io',
    name: 'devopstales/trivy-operator',
  });
});

test('returns null when the official Aqua operator is present', () => {
  const names = new Set([
    'vulnerabilityreports.aquasecurity.github.io',
    'rbacassessmentreports.aquasecurity.github.io',
  ]);
  assert.equal(detectForeignTrivy(names), null);
});

test('returns null when no trivy-related CRDs exist', () => {
  assert.equal(detectForeignTrivy(new Set(['ingressroutes.traefik.io', 'certificates.cert-manager.io'])), null);
  assert.equal(detectForeignTrivy(new Set()), null);
  assert.equal(detectForeignTrivy(null), null);
});

test('falls back to the raw group for an unknown foreign operator', () => {
  const names = new Set(['vulnerabilityreports.trivy.example.com']);
  assert.deepEqual(detectForeignTrivy(names), {
    group: 'trivy.example.com',
    name: 'trivy.example.com',
  });
});

test('prefers a known operator group when several foreign groups are present', () => {
  const names = new Set([
    'vulnerabilityreports.trivy.example.com',
    'vulnerabilityreports.trivy-operator.devopstales.io',
  ]);
  assert.equal(detectForeignTrivy(names).name, 'devopstales/trivy-operator');
});

test('accepts a custom official group and treats it as recognized', () => {
  const names = new Set(['vulnerabilityreports.aquasecurity.github.io']);
  // With a different "official" group, the aqua CRD now looks foreign.
  assert.equal(detectForeignTrivy(names, 'my.custom.group')?.group, 'aquasecurity.github.io');
  // And the default official group is still exported for callers.
  assert.equal(OFFICIAL_TRIVY_GROUP, 'aquasecurity.github.io');
});
