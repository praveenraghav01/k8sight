// Preload bridge: exposes a tiny, safe API to the renderer (the served web UI)
// so Preferences can read/change the auto-update setting, which lives in the
// Electron main process. Only present in the desktop app — in the browser /
// Docker build `window.k8sight` is undefined, so the UI hides those controls.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('k8sight', {
  isElectron: true,
  // Per-launch API token from the main process (null for any page that isn't
  // served by this app's own backend).
  apiToken: ipcRenderer.sendSync('api:token'),
  // { autoCheck: boolean, supported: boolean }
  getAutoUpdate: () => ipcRenderer.invoke('updater:get'),
  setAutoUpdate: (on) => ipcRenderer.invoke('updater:set', !!on),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  // Tabs in windows: open `#tabwin=…` (one tab of the app) in a window of its
  // own, near `at` ({ x, y } screen point) when the tab was dragged out.
  openTabWindow: ({ wid, hash, at }) => ipcRenderer.send('tabwin:open', { wid, hash, at }),
  // Window → Close (⌘W / Ctrl+W) asks the page first: `handler()` returns true
  // when it closed a tab or an empty split-screen group itself. Otherwise the
  // window closes as before. Returns an unsubscribe function.
  onCloseRequest: (handler) => {
    closeHandler = handler;
    return () => { if (closeHandler === handler) closeHandler = null; };
  },
});

// Listen from the start, so ⌘W still closes the window while the page is
// loading or showing the sign-in screen (no handler registered yet).
let closeHandler = null;
ipcRenderer.on('app:close-request', () => {
  let handled = false;
  try { handled = !!(closeHandler && closeHandler()); } catch { handled = false; }
  if (!handled) ipcRenderer.send('window:close');
});
