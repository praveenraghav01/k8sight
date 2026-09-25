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

const { app, BrowserWindow, shell, dialog, Menu, utilityProcess } = require('electron');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const DEFAULT_PORT = 3001;
// The port the backend actually binds. We prefer 3001, but fall back to a free
// port if a stale/older instance (or anything else) is squatting it — so a fresh
// launch or an upgrade never dies with "port in use".
let backendPort = DEFAULT_PORT;
const serverUrl = (port = backendPort) => `http://127.0.0.1:${port}`;

// Return the first free port at/after `preferred` (scanning a small range so the
// port stays predictable), falling back to an OS-assigned one as a last resort.
function findFreePort(preferred) {
  const isFree = (port) => new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '127.0.0.1');
  });
  const anyFree = () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  return (async () => {
    for (let p = preferred; p < preferred + 20; p++) {
      if (await isFree(p)) return p;
    }
    return anyFree();
  })();
}

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
        PORT: String(backendPort),
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
        ? `Port ${backendPort} is already in use — another copy of the app or a process on that port is running. Quit it and relaunch.`
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
function pingServer(port = backendPort) {
  return new Promise((resolve) => {
    const req = http.get(serverUrl(port), (res) => {
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

  // Always start our own backend on a free port — preferring 3001, but falling
  // back if a stale/older instance (or anything else) is squatting it. This way
  // a fresh launch or an upgrade never dies with "port in use", and the app
  // always runs THIS version's backend rather than reusing a leaked old one.
  backendPort = await findFreePort(DEFAULT_PORT);
  startServer(resolveUserPath());

  const ready = await waitForServer();
  if (!mainWindow) return; // window closed while we waited

  if (ready) {
    mainWindow.loadURL(serverUrl());
  } else {
    dialog.showErrorBox(
      'k8sight',
      `The backend did not become ready on port ${backendPort} within 30s.\n` +
        `Something else may be blocking it. Free it and relaunch.`
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

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
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
  ];
  return Menu.buildFromTemplate(template);
}
