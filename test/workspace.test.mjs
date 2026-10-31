// Tests for the split-screen workspace layout (client/src/lib/workspace.js):
// tabs, side-by-side groups, splitting, moving and closing. Pure functions, so
// they run under node:test directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduce, initialWorkspace, newTab, focusedGroup, focusedTab, activeTab, groupOfTab,
  besideGroup, serialize, deserialize, MAX_GROUPS,
} from '../client/src/lib/workspace.js';

const views = (g) => g.tabs.map((t) => t.view);
const sizes = (s) => s.groups.map((g) => Math.round(g.size * 100) / 100);
const twoTabs = () => reduce(initialWorkspace(newTab('pod')), { type: 'openTab', view: 'deployment' });

test('starts with one group holding one Overview tab', () => {
  const s = initialWorkspace();
  assert.equal(s.groups.length, 1);
  assert.deepEqual(views(s.groups[0]), ['overview']);
  assert.equal(focusedTab(s).view, 'overview');
});

test('split moves the selected tab to a new group on the right', () => {
  const s = reduce(twoTabs(), { type: 'split' });
  assert.equal(s.groups.length, 2);
  assert.deepEqual(views(s.groups[0]), ['pod']);
  assert.deepEqual(views(s.groups[1]), ['deployment']);
  assert.equal(s.focus, s.groups[1].id);
  assert.deepEqual(sizes(s), [0.5, 0.5]);
});

test('split on a single-tab group opens an empty group', () => {
  const s = reduce(initialWorkspace(newTab('pod')), { type: 'split' });
  assert.equal(s.groups.length, 2);
  assert.deepEqual(views(s.groups[0]), ['pod']);
  assert.deepEqual(views(s.groups[1]), []);
  assert.equal(activeTab(s.groups[1]), null);
});

test('navigating in an empty group opens a tab there', () => {
  let s = reduce(initialWorkspace(newTab('pod')), { type: 'split' });
  s = reduce(s, { type: 'navigate', view: 'service' });
  assert.deepEqual(views(s.groups[1]), ['service']);
});

test('split stops at the group limit', () => {
  let s = initialWorkspace();
  for (let i = 0; i < MAX_GROUPS + 2; i++) s = reduce(s, { type: 'split' });
  assert.equal(s.groups.length, MAX_GROUPS);
});

test('closing the last tab of a group closes it and gives its width to the neighbour', () => {
  let s = reduce(twoTabs(), { type: 'split' });
  const right = s.groups[1].tabs[0].id;
  s = reduce(s, { type: 'closeTab', tabId: right });
  assert.equal(s.groups.length, 1);
  assert.deepEqual(sizes(s), [1]);
  assert.equal(s.focus, s.groups[0].id);
});

test('the last remaining group never closes; keepOne refills it', () => {
  let s = initialWorkspace(newTab('pod'));
  const only = s.groups[0].tabs[0].id;
  const emptied = reduce(s, { type: 'closeTab', tabId: only });
  assert.equal(emptied.groups.length, 1);
  assert.deepEqual(views(emptied.groups[0]), []);
  s = reduce(s, { type: 'closeTab', tabId: only, keepOne: true });
  assert.deepEqual(views(s.groups[0]), ['overview']);
});

test('closeGroup closes an empty group but never the last one', () => {
  let s = reduce(initialWorkspace(newTab('pod')), { type: 'split' });
  s = reduce(s, { type: 'closeGroup', groupId: s.groups[1].id });
  assert.equal(s.groups.length, 1);
  assert.equal(reduce(s, { type: 'closeGroup', groupId: s.groups[0].id }).groups.length, 1);
});

test('moveTab drops a tab into another group (middle third)', () => {
  let s = reduce(twoTabs(), { type: 'split' }); // [pod] [deployment]
  s = reduce(s, { type: 'openTab', groupId: s.groups[0].id, view: 'service' }); // [pod, service] [deployment]
  const service = s.groups[0].tabs[1].id;
  s = reduce(s, { type: 'moveTab', tabId: service, toGroupId: s.groups[1].id });
  assert.deepEqual(views(s.groups[0]), ['pod']);
  assert.deepEqual(views(s.groups[1]), ['deployment', 'service']);
  assert.equal(activeTab(s.groups[1]).view, 'service');
});

test('moveTab reorders inside a group', () => {
  let s = reduce(twoTabs(), { type: 'openTab', view: 'service' }); // [pod, deployment, service]
  const service = s.groups[0].tabs[2].id;
  s = reduce(s, { type: 'moveTab', tabId: service, toGroupId: s.groups[0].id, index: 0 });
  assert.deepEqual(views(s.groups[0]), ['service', 'pod', 'deployment']);
});

test('moveTabToNewGroup makes a group on the chosen side', () => {
  let s = twoTabs(); // [pod, deployment]
  const pod = s.groups[0].tabs[0].id;
  s = reduce(s, { type: 'moveTabToNewGroup', tabId: pod, ofGroupId: s.groups[0].id, side: 'left' });
  assert.deepEqual(s.groups.map(views), [['pod'], ['deployment']]);
});

test("a group's only tab can't make a new group: it moves into the target", () => {
  let s = reduce(twoTabs(), { type: 'split' }); // [pod] [deployment]
  const pod = s.groups[0].tabs[0].id;
  s = reduce(s, { type: 'moveTabToNewGroup', tabId: pod, ofGroupId: s.groups[1].id, side: 'right' });
  assert.equal(s.groups.length, 1);
  assert.deepEqual(views(s.groups[0]), ['deployment', 'pod']);
});

test('openTab beside: the group on the right, the leftmost from the rightmost, or a new group', () => {
  let s = initialWorkspace(newTab('pod'));
  s = reduce(s, { type: 'openTab', view: 'deployment', beside: true });
  assert.equal(s.groups.length, 2);
  assert.deepEqual(views(s.groups[1]), ['deployment']);
  // focus is now the rightmost group, so "beside" wraps to the leftmost
  s = reduce(s, { type: 'openTab', view: 'service', beside: true });
  assert.deepEqual(views(s.groups[0]), ['pod', 'service']);
  assert.equal(besideGroup(s, s.groups[0].id).id, s.groups[1].id);
});

test('focusNext cycles through the groups', () => {
  let s = reduce(reduce(twoTabs(), { type: 'split' }), { type: 'focusGroup', groupId: undefined });
  const [a, b] = s.groups.map((g) => g.id);
  s = reduce(s, { type: 'focusGroup', groupId: a });
  s = reduce(s, { type: 'focusNext' });
  assert.equal(s.focus, b);
  s = reduce(s, { type: 'focusNext' });
  assert.equal(s.focus, a);
});

test('navigate keeps per-tab history; back and forward replay it', () => {
  let s = initialWorkspace(newTab('overview'));
  s = reduce(s, { type: 'navigate', view: 'pod' });
  s = reduce(s, { type: 'navigate', view: 'service' });
  s = reduce(s, { type: 'back' });
  assert.equal(focusedTab(s).view, 'pod');
  s = reduce(s, { type: 'back' });
  assert.equal(focusedTab(s).view, 'overview');
  s = reduce(s, { type: 'forward' });
  assert.equal(focusedTab(s).view, 'pod');
});

test('navigate clears the selection when the page changes', () => {
  let s = initialWorkspace(newTab('pod'));
  const id = focusedTab(s).id;
  s = reduce(s, { type: 'patchTab', tabId: id, patch: { selected: { type: 'pod', resource: { name: 'a' } } } });
  s = reduce(s, { type: 'navigate', view: 'pod', namespaces: ['shop'] });
  assert.ok(focusedTab(s).selected, 'same page keeps the selection');
  s = reduce(s, { type: 'navigate', view: 'service' });
  assert.equal(focusedTab(s).selected, null);
});

test('resize keeps the pair total and clamps each side', () => {
  let s = reduce(twoTabs(), { type: 'split' });
  const [l, r] = s.groups.map((g) => g.id);
  s = reduce(s, { type: 'resize', leftId: l, rightId: r, leftSize: 0.7 });
  assert.deepEqual(sizes(s), [0.7, 0.3]);
  s = reduce(s, { type: 'resize', leftId: l, rightId: r, leftSize: 5 });
  assert.equal(Math.round((s.groups[0].size + s.groups[1].size) * 100), 100);
  assert.ok(s.groups[1].size > 0.1);
});

test('serialize keeps layout and filters, drops selections; deserialize restores it', () => {
  let s = reduce(twoTabs(), { type: 'split' });
  const tid = s.groups[0].tabs[0].id;
  s = reduce(s, { type: 'patchTab', tabId: tid, patch: { namespaces: ['shop'], search: 'web', selected: { type: 'pod', resource: {} } } });
  const raw = JSON.parse(JSON.stringify(serialize(s)));
  assert.equal(raw.groups[0].tabs[0].selected, undefined);
  const back = deserialize(raw);
  assert.deepEqual(back.groups.map(views), [['pod'], ['deployment']]);
  assert.deepEqual(back.groups[0].tabs[0].namespaces, ['shop']);
  assert.equal(back.groups[0].tabs[0].search, 'web');
  assert.equal(groupOfTab(back, tid).id, back.groups[0].id);
  assert.equal(focusedGroup(back).id, s.focus);
});

test('deserialize rejects junk and drops empty groups', () => {
  assert.equal(deserialize(null), null);
  assert.equal(deserialize({ v: 2, groups: [] }), null);
  const s = deserialize({ v: 1, groups: [{ tabs: [] }, { tabs: [{ view: 'pod' }] }] });
  assert.deepEqual(s.groups.map(views), [['pod']]);
});
