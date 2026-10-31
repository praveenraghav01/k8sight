// Tabs in windows: any tab can be shown in a window of its own, then put back
// ("Demote as Tab") into the main window.
//
// A tab window loads the same app with `#tabwin=…` in the URL and renders just
// that one tab. Windows talk over a BroadcastChannel (same origin), so this
// works the same in the desktop app and in a browser:
//   tab window → main   { type: 'ping' }            "is the main window open?"
//   main → tab windows  { type: 'pong' }
//   tab window → main   { type: 'demote', tab }     put this tab back
//   main → tab windows  { type: 'context', ctx }    the cluster was switched

const CHANNEL = 'k8sight-tab-windows';
const STORE_PREFIX = 'k8sight.tabwin.';

// Only the durable parts of a tab travel to a window (like the saved layout).
export const portableTab = (tab) => ({
  view: tab.view,
  sub: tab.sub || {},
  namespaces: tab.namespaces?.length ? tab.namespaces : ['all'],
  search: tab.search || '',
});

const b64encode = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64decode = (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));

export const newWindowId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function tabWindowHash(tab, { wid = newWindowId(), ctx = '' } = {}) {
  const p = new URLSearchParams({ tabwin: b64encode(portableTab(tab)), wid });
  if (ctx) p.set('ctx', ctx);
  return { hash: p.toString(), wid };
}

// What this window is, from its URL. Null for the main window. A restored
// window (`tabwin=restore`) reads its last tab from localStorage.
export function parseTabWindow(hash = typeof location !== 'undefined' ? location.hash : '') {
  const p = new URLSearchParams(String(hash).replace(/^#/, ''));
  const raw = p.get('tabwin');
  const wid = p.get('wid');
  if (!raw || !wid) return null;
  let tab = null;
  try {
    tab = raw === 'restore' ? loadWindowTab(wid) : b64decode(raw);
  } catch { tab = null; }
  if (!tab || typeof tab.view !== 'string') tab = { view: 'overview', sub: {}, namespaces: ['all'], search: '' };
  return { wid, tab: portableTab(tab), ctx: p.get('ctx') || '' };
}

export function saveWindowTab(wid, tab) {
  try { localStorage.setItem(STORE_PREFIX + wid, JSON.stringify(portableTab(tab))); } catch { /* storage blocked */ }
}
export function loadWindowTab(wid) {
  try { return JSON.parse(localStorage.getItem(STORE_PREFIX + wid)); } catch { return null; }
}
export function forgetWindowTab(wid) {
  try { localStorage.removeItem(STORE_PREFIX + wid); } catch { /* storage blocked */ }
}

// Open a tab in a new window. The desktop app makes a real app window (and
// remembers it across restarts); a browser opens a popup on the same origin,
// which inherits the session's API token.
export function openTabWindow(tab, { ctx = '', at = null } = {}) {
  const { hash, wid } = tabWindowHash(tab, { ctx });
  saveWindowTab(wid, tab);
  if (typeof window !== 'undefined' && window.k8sight?.openTabWindow) {
    window.k8sight.openTabWindow({ wid, hash, at });
    return true;
  }
  const w = 1100;
  const h = 760;
  const left = at ? Math.max(0, Math.round(at.x - 120)) : Math.round(window.screenX + 60);
  const top = at ? Math.max(0, Math.round(at.y - 20)) : Math.round(window.screenY + 60);
  const win = window.open(`${location.origin}${location.pathname}#${hash}`, wid, `popup,width=${w},height=${h},left=${left},top=${top}`);
  return !!win;
}

export function channel() {
  return typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
}
