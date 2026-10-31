// Tests for tabs in windows (client/src/lib/tabWindows.js): the URL that
// carries a tab into its own window, and reading it back. Pure functions, so
// they run under node:test (no window, no localStorage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabWindowHash, parseTabWindow, portableTab, newWindowId } from '../client/src/lib/tabWindows.js';

test('a tab survives the round trip through the window URL', () => {
  const tab = { id: 't1', view: 'argocd', sub: { argocd: 'applications' }, namespaces: ['shop', 'argocd'], search: 'café ☸', selected: { x: 1 }, history: {} };
  const { hash, wid } = tabWindowHash(tab, { ctx: 'prod-eu' });
  const parsed = parseTabWindow(`#${hash}`);
  assert.equal(parsed.wid, wid);
  assert.equal(parsed.ctx, 'prod-eu');
  assert.deepEqual(parsed.tab, { view: 'argocd', sub: { argocd: 'applications' }, namespaces: ['shop', 'argocd'], search: 'café ☸' });
});

test('only the durable parts of a tab travel (no selection, history or id)', () => {
  const p = portableTab({ id: 'x', view: 'pod', namespaces: [], selected: {}, history: {} });
  assert.deepEqual(p, { view: 'pod', sub: {}, namespaces: ['all'], search: '' });
});

test('the hash is URL-safe', () => {
  const { hash } = tabWindowHash({ view: 'pod', sub: {}, namespaces: ['all'], search: '/?&#=+' });
  assert.match(hash, /^tabwin=[A-Za-z0-9_-]+&wid=[\w-]+$/);
});

test('the main window has no tab-window hash', () => {
  assert.equal(parseTabWindow(''), null);
  assert.equal(parseTabWindow('#/something'), null);
  assert.equal(parseTabWindow('#tabwin=abc'), null, 'needs a window id');
});

test('a broken or unknown payload falls back to Overview', () => {
  assert.equal(parseTabWindow('#tabwin=%%%&wid=w1').tab.view, 'overview');
  // restore with nothing stored (no localStorage here) also lands on Overview
  assert.equal(parseTabWindow('#tabwin=restore&wid=w2').tab.view, 'overview');
});

test('window ids are unique and safe for file names and storage keys', () => {
  const ids = new Set(Array.from({ length: 200 }, newWindowId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[\w-]{1,64}$/);
});
