// Workspace layout: the main view is split into side-by-side groups, each with
// its own tab strip and one visible tab. A tab is one page (a resource list, a
// dashboard, Preferences…) with its own namespaces, search, selection and
// back/forward history.
//
// Everything here is pure (no React, no DOM) so it can be unit-tested with
// node:test. `reduce(state, action)` returns a new state; it never mutates.

export const MAX_GROUPS = 4;

let seq = 0;
const uid = (prefix) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

// Sub-views some pages carry (Argo CD dashboard vs applications, …), keyed by
// the page they belong to.
export function newTab(view = 'overview', { sub = {}, namespaces = ['all'], search = '' } = {}) {
  return {
    id: uid('t'),
    view,
    sub: { ...sub },
    namespaces: namespaces.slice(),
    search,
    selected: null, // { type, resource } — transient, never persisted
    focusResource: null, // { type, namespace, name } — cross-link target
    focusNode: null,
    history: { stack: [view], idx: 0 },
  };
}

const newGroup = (tabs = [], size = 1) => ({
  id: uid('g'),
  tabs,
  active: tabs.length ? tabs[tabs.length - 1].id : null,
  size,
});

export function initialWorkspace(tab = newTab()) {
  const g = newGroup([tab]);
  return { groups: [g], focus: g.id };
}

// ---- lookups ----
export const findGroup = (s, gid) => s.groups.find((g) => g.id === gid);
export const focusedGroup = (s) => findGroup(s, s.focus) || s.groups[0];
export const activeTab = (g) => (g ? g.tabs.find((t) => t.id === g.active) || null : null);
export const focusedTab = (s) => activeTab(focusedGroup(s));
export function groupOfTab(s, tid) {
  return s.groups.find((g) => g.tabs.some((t) => t.id === tid)) || null;
}
export function findTab(s, tid) {
  const g = groupOfTab(s, tid);
  return g ? g.tabs.find((t) => t.id === tid) : null;
}

// ---- internal helpers (return new state) ----
const mapGroup = (s, gid, fn) => ({ ...s, groups: s.groups.map((g) => (g.id === gid ? fn(g) : g)) });
const mapTab = (s, tid, fn) => ({
  ...s,
  groups: s.groups.map((g) => (g.tabs.some((t) => t.id === tid)
    ? { ...g, tabs: g.tabs.map((t) => (t.id === tid ? fn(t) : t)) }
    : g)),
});

// Remove a group, handing its width to the neighbour on its left (or on its
// right, for the leftmost group). The last remaining group never goes away.
function dropGroup(s, gid) {
  if (s.groups.length <= 1) return s;
  const i = s.groups.findIndex((g) => g.id === gid);
  if (i < 0) return s;
  const gone = s.groups[i];
  const groups = s.groups.filter((g) => g.id !== gid);
  const heir = groups[i > 0 ? i - 1 : 0];
  const next = groups.map((g) => (g.id === heir.id ? { ...g, size: g.size + gone.size } : g));
  const focus = s.focus === gid ? heir.id : s.focus;
  return { ...s, groups: next, focus };
}

// Pull a tab out of its group. A group left empty by this is closed unless
// `keepEmpty` (or it's the only group, which stays as an empty group).
function detachTab(s, tid, { keepEmpty = false } = {}) {
  const g = groupOfTab(s, tid);
  if (!g) return { state: s, tab: null };
  const idx = g.tabs.findIndex((t) => t.id === tid);
  const tab = g.tabs[idx];
  const tabs = g.tabs.filter((t) => t.id !== tid);
  const active = g.active === tid ? (tabs[Math.min(idx, tabs.length - 1)]?.id || null) : g.active;
  let state = mapGroup(s, g.id, (x) => ({ ...x, tabs, active }));
  if (!tabs.length && !keepEmpty) state = dropGroup(state, g.id);
  return { state, tab };
}

function insertTab(s, gid, tab, index = -1) {
  return mapGroup(s, gid, (g) => {
    const tabs = g.tabs.slice();
    if (index < 0 || index > tabs.length) tabs.push(tab); else tabs.splice(index, 0, tab);
    return { ...g, tabs, active: tab.id };
  });
}

// Insert a new (empty) group next to `gid`, taking half of its width.
function addGroupBeside(s, gid, side = 'right') {
  if (s.groups.length >= MAX_GROUPS) return { state: s, group: null };
  const i = s.groups.findIndex((g) => g.id === gid);
  if (i < 0) return { state: s, group: null };
  const base = s.groups[i];
  const half = base.size / 2;
  const group = newGroup([], half);
  const groups = s.groups.map((g) => (g.id === gid ? { ...g, size: half } : g));
  groups.splice(side === 'left' ? i : i + 1, 0, group);
  return { state: { ...s, groups }, group };
}

// The group beside `gid` for "open beside": the one on the right, or the
// leftmost when `gid` is the rightmost. Null when there is only one group.
export function besideGroup(s, gid) {
  if (s.groups.length < 2) return null;
  const i = s.groups.findIndex((g) => g.id === gid);
  return i < s.groups.length - 1 ? s.groups[i + 1] : s.groups[0];
}

const pushHistory = (t, view) => {
  if (t.history.stack[t.history.idx] === view) return t.history;
  const stack = t.history.stack.slice(0, t.history.idx + 1).concat(view);
  return { stack, idx: stack.length - 1 };
};

// ---- the reducer ----
export function reduce(s, a) {
  switch (a.type) {
    case 'reset':
      return a.state || initialWorkspace();

    case 'focusGroup':
      return findGroup(s, a.groupId) ? { ...s, focus: a.groupId } : s;

    case 'focusNext': {
      const i = s.groups.findIndex((g) => g.id === s.focus);
      return { ...s, focus: s.groups[(i + 1) % s.groups.length].id };
    }

    case 'activateTab': {
      const g = groupOfTab(s, a.tabId);
      if (!g) return s;
      return { ...mapGroup(s, g.id, (x) => ({ ...x, active: a.tabId })), focus: g.id };
    }

    // Change what a tab shows (sidebar click, cross-link…). An empty focused
    // group gets a new tab instead.
    case 'navigate': {
      const g = a.tabId ? groupOfTab(s, a.tabId) : focusedGroup(s);
      const tab = a.tabId ? findTab(s, a.tabId) : activeTab(g);
      if (!tab) {
        const t = newTab(a.view, { sub: a.sub, namespaces: a.namespaces });
        return insertTab(s, g.id, t);
      }
      return mapTab(s, tab.id, (t) => {
        const viewChanged = t.view !== a.view;
        return {
          ...t,
          view: a.view,
          sub: a.sub ? { ...t.sub, ...a.sub } : t.sub,
          namespaces: a.namespaces ? a.namespaces.slice() : t.namespaces,
          search: a.search != null ? a.search : t.search,
          selected: viewChanged ? null : t.selected,
          focusResource: a.focusResource !== undefined ? a.focusResource : (viewChanged ? null : t.focusResource),
          focusNode: a.focusNode !== undefined ? a.focusNode : t.focusNode,
          history: a.fromHistory ? t.history : pushHistory(t, a.view),
        };
      });
    }

    case 'patchTab':
      return mapTab(s, a.tabId, (t) => ({ ...t, ...a.patch }));

    case 'back':
    case 'forward': {
      const tab = focusedTab(s);
      if (!tab) return s;
      const step = a.type === 'back' ? -1 : 1;
      const idx = tab.history.idx + step;
      if (idx < 0 || idx >= tab.history.stack.length) return s;
      const view = tab.history.stack[idx];
      const moved = mapTab(s, tab.id, (t) => ({ ...t, history: { ...t.history, idx } }));
      return reduce(moved, { type: 'navigate', tabId: tab.id, view, fromHistory: true });
    }

    // Open a new tab: in a given group, in the focused group, or "beside" the
    // focused group (making a group on the right when there is only one).
    case 'openTab': {
      const t = newTab(a.view, { sub: a.sub, namespaces: a.namespaces, search: a.search });
      let state = s;
      let gid = a.groupId || s.focus;
      if (a.beside) {
        const b = besideGroup(s, s.focus);
        if (b) gid = b.id;
        else {
          const r = addGroupBeside(s, s.focus, 'right');
          if (r.group) { state = r.state; gid = r.group.id; }
        }
      }
      state = insertTab(state, gid, t, a.index ?? -1);
      return { ...state, focus: gid };
    }

    case 'closeTab': {
      const g = groupOfTab(s, a.tabId);
      if (!g) return s;
      const { state } = detachTab(s, a.tabId);
      // Closing the very last tab leaves one empty group behind; refill it.
      if (state.groups.length === 1 && !state.groups[0].tabs.length && a.keepOne) {
        return insertTab(state, state.groups[0].id, newTab());
      }
      return state;
    }

    // Split: the focused group's selected tab moves to a new group on the
    // right; a single-tab group gets an empty group instead.
    case 'split': {
      const gid = a.groupId || s.focus;
      const g = findGroup(s, gid);
      if (!g) return s;
      const r = addGroupBeside(s, gid, 'right');
      if (!r.group) return s;
      let state = { ...r.state, focus: r.group.id };
      if (g.tabs.length > 1 && g.active) {
        const d = detachTab(state, g.active, { keepEmpty: true });
        state = insertTab(d.state, r.group.id, d.tab);
      }
      return state;
    }

    // Move a tab into another group (drop on the middle of a group, its tab
    // strip, or "Move to the left/right").
    case 'moveTab': {
      const from = groupOfTab(s, a.tabId);
      const to = findGroup(s, a.toGroupId);
      if (!from || !to) return s;
      if (from.id === to.id) {
        if (a.index == null) return s;
        const tabs = from.tabs.slice();
        const cur = tabs.findIndex((t) => t.id === a.tabId);
        const [tab] = tabs.splice(cur, 1);
        tabs.splice(Math.min(a.index > cur ? a.index - 1 : a.index, tabs.length), 0, tab);
        return { ...mapGroup(s, from.id, (g) => ({ ...g, tabs, active: tab.id })), focus: from.id };
      }
      const d = detachTab(s, a.tabId);
      return { ...insertTab(d.state, a.toGroupId, d.tab, a.index ?? -1), focus: a.toGroupId };
    }

    // Move a tab to a new group on one side of `ofGroupId` (drop on the left or
    // right third, or "Move to a new group on the right"). A group's only tab
    // can't make a new group: it just moves into `ofGroupId`.
    case 'moveTabToNewGroup': {
      const from = groupOfTab(s, a.tabId);
      const of = findGroup(s, a.ofGroupId);
      if (!from || !of) return s;
      if (from.tabs.length === 1) {
        if (from.id === of.id) return s;
        return reduce(s, { type: 'moveTab', tabId: a.tabId, toGroupId: of.id });
      }
      if (s.groups.length >= MAX_GROUPS) return reduce(s, { type: 'moveTab', tabId: a.tabId, toGroupId: of.id });
      const r = addGroupBeside(s, of.id, a.side || 'right');
      if (!r.group) return s;
      const d = detachTab(r.state, a.tabId);
      return { ...insertTab(d.state, r.group.id, d.tab), focus: r.group.id };
    }

    case 'closeGroup':
      return dropGroup(s, a.groupId);

    // Divider drag: set the two neighbours' sizes (they always sum to the same).
    case 'resize': {
      const total = (findGroup(s, a.leftId)?.size || 0) + (findGroup(s, a.rightId)?.size || 0);
      const min = total * 0.12;
      const left = Math.min(total - min, Math.max(min, a.leftSize));
      return {
        ...s,
        groups: s.groups.map((g) => (g.id === a.leftId ? { ...g, size: left } : g.id === a.rightId ? { ...g, size: total - left } : g)),
      };
    }

    default:
      return s;
  }
}

// ---- persistence ----
// Only the durable parts: which pages are open where, their filters, the
// widths and the focused group. Selections, cross-link targets and history are
// session-only.
export function serialize(s) {
  return {
    v: 1,
    focus: s.focus,
    groups: s.groups.map((g) => ({
      id: g.id,
      size: g.size,
      active: g.active,
      tabs: g.tabs.map((t) => ({ id: t.id, view: t.view, sub: t.sub, namespaces: t.namespaces, search: t.search })),
    })),
  };
}

export function deserialize(raw) {
  if (!raw || raw.v !== 1 || !Array.isArray(raw.groups) || !raw.groups.length) return null;
  const groups = raw.groups.slice(0, MAX_GROUPS).map((g) => {
    const tabs = (Array.isArray(g.tabs) ? g.tabs : [])
      .filter((t) => t && typeof t.view === 'string')
      .map((t) => ({ ...newTab(t.view, { sub: t.sub || {}, namespaces: Array.isArray(t.namespaces) && t.namespaces.length ? t.namespaces : ['all'], search: t.search || '' }), id: t.id || uid('t') }));
    return { id: g.id || uid('g'), tabs, active: tabs.some((t) => t.id === g.active) ? g.active : (tabs[0]?.id || null), size: Number(g.size) > 0 ? Number(g.size) : 1 };
  });
  const nonEmpty = groups.filter((g) => g.tabs.length);
  const usable = nonEmpty.length ? nonEmpty : [newGroup([newTab()])];
  return { groups: usable, focus: usable.some((g) => g.id === raw.focus) ? raw.focus : usable[0].id };
}
