import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivePodResource, parseCpuMilli, parseMemoryBytes } from '../client/src/utils/podResources.js';

test('partial container requests sum declared values and treat missing values as zero', () => {
  const spec = {
    containers: [
      { resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '500m', memory: '1Gi' } } },
      { resources: { requests: {}, limits: {} } }
    ]
  };

  assert.equal(effectivePodResource(spec, 'requests', 'cpu', parseCpuMilli), 100);
  assert.equal(effectivePodResource(spec, 'requests', 'memory', parseMemoryBytes), 256 * 1024 ** 2);
  assert.equal(effectivePodResource(spec, 'limits', 'cpu', parseCpuMilli), 500);
  assert.equal(effectivePodResource(spec, 'limits', 'memory', parseMemoryBytes), 1024 ** 3);
});

test('returns null when no container or pod declares the resource', () => {
  assert.equal(effectivePodResource({ containers: [{ resources: {} }] }, 'requests', 'cpu', parseCpuMilli), null);
});

test('uses the max of regular-container sum and init-container peak', () => {
  const spec = {
    containers: [{ resources: { requests: { cpu: '100m' } } }],
    initContainers: [
      { resources: { requests: { cpu: '500m' } } },
      { resources: { requests: { cpu: '200m' } } }
    ]
  };

  assert.equal(effectivePodResource(spec, 'requests', 'cpu', parseCpuMilli), 500);
});

test('includes restartable init containers and pod overhead', () => {
  const spec = {
    overhead: { cpu: '10m' },
    containers: [{ resources: { requests: { cpu: '100m' } } }],
    initContainers: [
      { restartPolicy: 'Always', resources: { requests: { cpu: '50m' } } },
      { resources: { requests: { cpu: '100m' } } }
    ]
  };

  assert.equal(effectivePodResource(spec, 'requests', 'cpu', parseCpuMilli), 160);
});

test('uses pod-level resources when present', () => {
  const spec = {
    resources: { requests: { cpu: '2', memory: '1Gi' } },
    overhead: { cpu: '100m', memory: '32Mi' },
    containers: [{ resources: { requests: { cpu: '500m', memory: '256Mi' } } }]
  };

  assert.equal(effectivePodResource(spec, 'requests', 'cpu', parseCpuMilli), 2100);
  assert.equal(effectivePodResource(spec, 'requests', 'memory', parseMemoryBytes), 1024 ** 3 + 32 * 1024 ** 2);
});

test('parses Kubernetes decimal and binary memory quantities', () => {
  assert.equal(parseMemoryBytes('1000M'), 1_000_000_000);
  assert.equal(parseMemoryBytes('1Gi'), 1024 ** 3);
  assert.equal(parseMemoryBytes('2e3'), 2000);
  assert.equal(parseMemoryBytes('300m'), 0.3);
});
