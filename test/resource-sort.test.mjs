// Unit tests for the resource-table sorting rules (client/src/lib/resourceSort.js).
// These cover the value-based ordering that the sortable column headers rely on:
// numeric columns sort by magnitude (not rendered text), and rows missing a
// value sort last in both directions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuantity, sortValue, sortResources } from '../client/src/lib/resourceSort.js';

test('parseQuantity: binary and decimal suffixes convert to bytes', () => {
  assert.equal(parseQuantity('10Gi'), 10 * 1024 ** 3);
  assert.equal(parseQuantity('500Mi'), 500 * 1024 ** 2);
  assert.equal(parseQuantity('1Ki'), 1024);
  assert.equal(parseQuantity('1M'), 1e6);
  assert.ok(parseQuantity('10Gi') > parseQuantity('500Mi')); // the whole point
});

test('parseQuantity: bare numbers and blanks', () => {
  assert.equal(parseQuantity('5'), 5);
  assert.equal(parseQuantity(''), null);
  assert.equal(parseQuantity(null), null);
  assert.equal(parseQuantity(undefined), null);
});

test('sortValue: CPU/Memory read raw metrics, null when absent', () => {
  const metrics = { 'default/a': { cpuMilli: 346, memBytes: 1_000_000 } };
  const a = { namespace: 'default', name: 'a' };
  const b = { namespace: 'default', name: 'b' };
  assert.equal(sortValue(a, 'CPU', metrics), 346);
  assert.equal(sortValue(a, 'Memory', metrics), 1_000_000);
  assert.equal(sortValue(b, 'CPU', metrics), null);
});

test('CPU sorts by magnitude, not by the "92m"/"346m" string', () => {
  const metrics = {
    'default/big': { cpuMilli: 346 },
    'default/small': { cpuMilli: 92 },
    'default/mid': { cpuMilli: 135 },
  };
  const rows = [
    { namespace: 'default', name: 'small' },
    { namespace: 'default', name: 'big' },
    { namespace: 'default', name: 'mid' },
  ];
  const asc = sortResources(rows, { col: 'CPU', dir: 'asc' }, metrics).map(r => r.name);
  assert.deepEqual(asc, ['small', 'mid', 'big']);
  const desc = sortResources(rows, { col: 'CPU', dir: 'desc' }, metrics).map(r => r.name);
  assert.deepEqual(desc, ['big', 'mid', 'small']);
});

test('rows missing a metric sort last in BOTH directions', () => {
  const metrics = { 'default/has': { cpuMilli: 100 } };
  const rows = [
    { namespace: 'default', name: 'none' },   // no metrics
    { namespace: 'default', name: 'has' },
  ];
  const asc = sortResources(rows, { col: 'CPU', dir: 'asc' }, metrics).map(r => r.name);
  assert.deepEqual(asc, ['has', 'none']);
  const desc = sortResources(rows, { col: 'CPU', dir: 'desc' }, metrics).map(r => r.name);
  assert.deepEqual(desc, ['has', 'none']);
});

test('Capacity sorts by size so 10Gi > 500Mi', () => {
  const rows = [
    { namespace: 'x', name: 'small', capacity: '500Mi' },
    { namespace: 'x', name: 'big', capacity: '10Gi' },
    { namespace: 'x', name: 'none' }, // no capacity
  ];
  const asc = sortResources(rows, { col: 'Capacity', dir: 'asc' }).map(r => r.name);
  assert.deepEqual(asc, ['small', 'big', 'none']);
});

test('Age ascending is youngest first; undated rows sort last', () => {
  const now = Date.now();
  const rows = [
    { namespace: 'x', name: 'old', createdAt: new Date(now - 2 * 86400_000).toISOString() },
    { namespace: 'x', name: 'young', createdAt: new Date(now - 60_000).toISOString() },
    { namespace: 'x', name: 'undated' },
  ];
  const asc = sortResources(rows, { col: 'Age', dir: 'asc' }).map(r => r.name);
  assert.deepEqual(asc, ['young', 'old', 'undated']);
});

test('text columns use natural numeric order (pod-2 before pod-10)', () => {
  const rows = [
    { namespace: 'x', name: 'pod-10' },
    { namespace: 'x', name: 'pod-2' },
    { namespace: 'x', name: 'pod-1' },
  ];
  const asc = sortResources(rows, { col: 'Name', dir: 'asc' }).map(r => r.name);
  assert.deepEqual(asc, ['pod-1', 'pod-2', 'pod-10']);
});

test('Restarts sorts numerically, descending puts the noisiest pod on top', () => {
  const rows = [
    { namespace: 'x', name: 'calm', restarts: 0 },
    { namespace: 'x', name: 'crashloop', restarts: 7 },
    { namespace: 'x', name: 'flaky', restarts: 2 },
  ];
  const desc = sortResources(rows, { col: 'Restarts', dir: 'desc' }).map(r => r.name);
  assert.deepEqual(desc, ['crashloop', 'flaky', 'calm']);
});

test('no sort returns the original array reference (server order preserved)', () => {
  const rows = [{ namespace: 'x', name: 'b' }, { namespace: 'x', name: 'a' }];
  assert.equal(sortResources(rows, null), rows);
});
