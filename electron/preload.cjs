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
});
