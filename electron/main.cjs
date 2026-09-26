// Electron main process for k8sight.
//
// Responsibilities:
//   1. Repair PATH — a Finder-launched .app inherits only a minimal PATH, so
//      kubectl (in /opt/homebrew/bin, /usr/local/bin, …) would be invisible to
//      the server's child_process calls. We reconstruct the user's real PATH.
//   2. Start server.js as a child process using Electron's bundled Node
//      (ELECTRON_RUN_AS_NODE), on the fixed backend port 3001.
//   3. Wait for the server to accept connections, then load it in a window.
//   4. Tear the server down on quit (which triggers its port-forward cleanup).
'use strict';

const { app, BrowserWindow, shell, dialog, Menu, utilityProcess, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

// electron-updater is optional at runtime (only wired for packaged Win/Linux).
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* not available */ }

const BACKEND_PORT = 3001;
const SERVER_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const RELEASES_URL = 'https://github.com/praveenraghav01/k8sight/releases/latest';

let serverProcess = null;
let mainWindow = null;

// --- 1. PATH repair -------------------------------------------------------
// Ask the user's login shell for its PATH, then union with the usual GUI-app
// blind spots. Falls back gracefully if the shell can't be queried.
function resolveUserPath() {
  const common = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'bin'),
  ];

  let shellPath = '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    // -l (login) + -i (interactive) so ~/.zprofile / ~/.zshrc PATH edits apply.
    shellPath = execFileSync(shell, ['-lic', 'echo -n "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch {
    // Non-fatal — we still have `common` and the inherited PATH.
  }

  const parts = [
    ...(shellPath ? shellPath.split(':') : []),
    ...(process.env.PATH ? process.env.PATH.split(':') : []),
    ...common,
  ].filter(Boolean);

  return [...new Set(parts)].join(':');
}

// --- 2. Start the backend -------------------------------------------------
// The backend is ESM (`"type": "module"`). Node's native ESM loader does NOT
// read from inside an asar archive (Electron's asar shim only patches CommonJS
// require/fs), so `import './lib/pty-helper.mjs'` from a packed server.js fails
// at launch. We therefore ship the app unpacked (`asar: false`); server.js and
// node_modules live on the real filesystem, where the ESM loader can read them.
// It's launched with utilityProcess.fork() (not `node server.js`) so it runs on
// Electron's bundled Node; server.js resolves client/dist, VERSION and
// node_modules via import.meta.url.
function serverRoot() {
  return app.getAppPath(); // .../Contents/Resources/app (packaged) or project root (dev)
}

function startServer(fixedPath) {
  const root = serverRoot();
  const serverEntry = path.join(root, 'server.js');

  let stderrTail = '';
  try {
    serverProcess = utilityProcess.fork(serverEntry, [], {
      // Don't set cwd to an asar path (it isn't a real dir) — server.js uses
      // import.meta.url, not cwd, so the default working directory is fine.
      env: {
        ...process.env,
        PATH: fixedPath,
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    dialog.showErrorBox('k8sight', `Failed to start the backend:\n${err.message}`);
    app.quit();
    return;
  }

  serverProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-2000);
    process.stderr.write(`[server] ${d}`);
  });

  // utilityProcess 'exit' reports the exit code only (no signal argument).
  serverProcess.on('exit', (code) => {
    serverProcess = null;
    // If the server dies unexpectedly while the app is up, surface it.
    if (!app.isQuitting && code !== 0 && code !== null) {
      const portTaken = /EADDRINUSE|already in use/i.test(stderrTail);
      const detail = portTaken
        ? `Port ${BACKEND_PORT} is already in use — another copy of the app or a process on that port is running. Quit it and relaunch.`
        : `The backend exited unexpectedly (code ${code}).` +
          (stderrTail.trim() ? `\n\n${stderrTail.trim().split('\n').slice(-4).join('\n')}` : '');
      dialog.showErrorBox('k8sight', detail);
      app.quit();
    }
  });
}

function stopServer() {
  if (serverProcess) {
    // utilityProcess.kill() sends SIGTERM, letting server.js run its
    // killAllForwards() cleanup handler.
    serverProcess.kill();
    serverProcess = null;
  }
}

// --- 3. Wait for readiness, then show the window --------------------------
function pingServer() {
  return new Promise((resolve) => {
    const req = http.get(SERVER_URL, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingServer()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'k8sight',
    // Match the app's dark surface — no separate gray macOS title bar. On
    // macOS `hiddenInset` floats the traffic lights over the (black) content;
    // the frontend adds a draggable top strip via the `is-electron` class.
    backgroundColor: '#000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 15 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Tag the document so the frontend can offset content below the traffic
  // lights and expose a draggable region (CSS `.is-electron` rules).
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents
      .executeJavaScript("document.documentElement.classList.add('is-electron')")
      .catch(() => {});
  });

  // Show a lightweight loading page immediately.
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open target=_blank / external links in the default browser, not a new window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function boot() {
  createWindow();

  // If a backend is already serving on the port (e.g. `npm run dev`, or a
  // second launch), reuse it instead of spawning a duplicate that would fail
  // to bind the port and exit.
  if (await pingServer()) {
    if (mainWindow) mainWindow.loadURL(SERVER_URL);
    return;
  }

  startServer(resolveUserPath());

  const ready = await waitForServer();
  if (!mainWindow) return; // window closed while we waited

  if (ready) {
    mainWindow.loadURL(SERVER_URL);
  } else {
    dialog.showErrorBox(
      'k8sight',
      `The backend did not become ready on port ${BACKEND_PORT} within 30s.\n` +
        `Something else may be using the port. Free it and relaunch.`
    );
    app.quit();
  }
}

// --- App lifecycle --------------------------------------------------------
// Single-instance: the fixed port means two copies can't both bind it.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    boot();

    // Background update check shortly after launch (packaged Win/Linux only).
    if (canAutoUpdate() && autoCheckEnabled()) {
      setTimeout(() => checkForUpdates(false), 5000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) boot();
    });
  });
}

app.on('window-all-closed', () => {
  // Server-backed app: closing the window quits everything (incl. the backend).
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopServer();
});

// --- Auto-update (electron-updater) ---------------------------------------
// Works for packaged Windows (NSIS), Linux (AppImage) and macOS builds. macOS
// OTA is enabled now that release builds are Developer ID-signed & notarized —
// Squirrel.Mac verifies the signature (it rejects ad-hoc builds) and updates
// from the published .zip + latest-mac.yml. If macOS can't self-update (e.g. the
// app is still running from the read-only DMG mount, not /Applications), the
// error handler surfaces it and a manual check falls back to the Releases page.
function updaterPrefsPath() { return path.join(app.getPath('userData'), 'updater-prefs.json'); }
function autoCheckEnabled() {
  try { return JSON.parse(fs.readFileSync(updaterPrefsPath(), 'utf8')).autoCheck !== false; }
  catch { return true; } // default on
}
function setAutoCheck(on) {
  try { fs.writeFileSync(updaterPrefsPath(), JSON.stringify({ autoCheck: !!on })); } catch { /* ignore */ }
}
function canAutoUpdate() {
  return !!autoUpdater && app.isPackaged;
}

// IPC bridge for the Preferences UI (see electron/preload.cjs). Lets the renderer
// read and change the auto-update preference the menu checkbox also drives.
ipcMain.handle('updater:get', () => ({ autoCheck: autoCheckEnabled(), supported: canAutoUpdate() }));
ipcMain.handle('updater:set', (_e, on) => {
  setAutoCheck(on);
  try { Menu.setApplicationMenu(buildMenu()); } catch { /* menu keeps its old checked state */ }
  if (on) checkForUpdates(false); // start checking immediately when re-enabled
  return { autoCheck: autoCheckEnabled(), supported: canAutoUpdate() };
});
ipcMain.handle('updater:check', () => { checkForUpdates(true); return true; });

let updaterWired = false;
let manualCheck = false;
function wireUpdater() {
  if (!autoUpdater || updaterWired) return;
  updaterWired = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox({ type: 'info', title: 'k8sight', message: "You're up to date", detail: `k8sight ${app.getVersion()} is the latest version.` });
  });
  autoUpdater.on('error', (err) => {
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showErrorBox('Update check failed', String(err && err.message ? err.message : err));
  });
  autoUpdater.on('update-downloaded', async (info) => {
    manualCheck = false;
    const { response } = await dialog.showMessageBox({
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      title: 'k8sight', message: `k8sight ${info.version} is ready to install`,
      detail: 'Restart the app to finish updating.',
    });
    if (response === 0) { app.isQuitting = true; autoUpdater.quitAndInstall(); }
  });
}

function checkForUpdates(manual) {
  if (!canAutoUpdate()) {
    // Unsupported (macOS ad-hoc, or a dev/unpacked run): open the Releases page
    // so a manual check still does something useful.
    if (manual) shell.openExternal(RELEASES_URL);
    return;
  }
  wireUpdater();
  manualCheck = !!manual;
  autoUpdater.checkForUpdates().catch((err) => {
    if (!manual) return;
    manualCheck = false;
    dialog.showErrorBox('Update check failed', String(err && err.message ? err.message : err));
  });
}

function updateMenuItems() {
  return [
    { label: 'Check for Updates…', click: () => checkForUpdates(true) },
    {
      label: 'Automatically check for updates',
      type: 'checkbox',
      checked: autoCheckEnabled(),
      enabled: canAutoUpdate(),
      click: (item) => setAutoCheck(item.checked),
    },
  ];
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            ...updateMenuItems(),
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        ...(isMac ? [] : updateMenuItems()),
        ...(isMac ? [] : [{ type: 'separator' }]),
        { label: 'k8sight on GitHub', click: () => shell.openExternal('https://github.com/praveenraghav01/k8sight') },
        { label: 'Releases', click: () => shell.openExternal(RELEASES_URL) },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
