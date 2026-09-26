import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { execFileSync, spawnSync, spawn, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import http from 'http';
import zlib from 'zlib';
import { PassThrough, Writable } from 'stream';
import { WebSocketServer } from 'ws';
import * as k8s from '@kubernetes/client-node';
import yaml from 'js-yaml';
import * as azure from './azure-aks.js';
import compression from 'compression';
import { registerAssistant } from './assistant.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { createMcpServer } from './mcp.js';
import * as awsEks from './aws-eks.js';
import * as gke from './gke.js';
import * as trivyScan from './trivy-scan.js';
import * as demo from './demo.js';
import { ensurePtyHelperExecutable } from './lib/pty-helper.mjs';
import { searchCharts, chartVersions } from './lib/artifacthub.mjs';
import { detectForeignTrivy } from './lib/trivy-detect.mjs';
import { tokenHelperPath } from './lib/resource-path.mjs';

// node-pty powers the pod terminal (a real PTY bridged to `kubectl exec`). Load
// it defensively so a missing/unbuildable native module never crashes the whole
// server — only the terminal feature is disabled in that (rare) case.
let pty = null;
try {
  // Restore node-pty's spawn-helper execute bit BEFORE first use, so pod
  // terminals don't fail with "posix_spawnp failed". See lib/pty-helper.mjs.
  ensurePtyHelperExecutable({ currentOnly: true });
  pty = (await import('node-pty')).default;
} catch (e) {
  console.warn('[terminal] node-pty is unavailable; pod shells are disabled:', e.message);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Fixed backend port. In dev, Vite (3000) proxies /api and /ws here; in the
// Docker image this same server also serves the built UI. Map it at runtime
// with `docker run -p <host>:3001`.
const PORT = 3001;
const CLIENT_DIST = path.join(__dirname, 'client', 'dist');
// CLI-free AKS token helper — app-imported AAD clusters exec this instead of
// kubelogin, so neither `az` nor `kubelogin` is needed at runtime. Bundled and
// resolved to its unpacked location so it stays spawnable under asar.
const AZURE_TOKEN_HELPER = tokenHelperPath(import.meta.url, 'azure-token');

// Response caching with TTL
const cache = new Map();
const CACHE_TTL = {
  resources: 30000, // 30 seconds
  events: 15000,    // 15 seconds
  namespaces: 60000, // 60 seconds
  yaml: 60000        // 60 seconds
};

const getCacheKey = (prefix, params) => `${prefix}:${JSON.stringify(params)}`;
const setCache = (key, value, ttl) => {
  cache.set(key, { value, expiry: Date.now() + ttl });
};
const getCache = (key) => {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.value;
};

app.use(compression());

// ------------------------------------------------------------------
// Origin guard (replaces the old wildcard CORS). The backend exposes a
// read/write cluster API and an exec WebSocket with no per-request auth, so a
// browser page on another origin must not be able to drive it with the user's
// ambient credentials. Paired with the loopback bind below (LAN protection),
// this closes the drive-by / cross-site vector without any frontend change.
//
//   • No Origin header  → allowed. Non-browser clients (curl, MCP over stdio,
//     the server's own self-HTTP MCP calls) never send one; same-origin GET
//     navigations may omit it too.
//   • Origin host == Host header → allowed. Covers same-origin production,
//     packaged Electron (127.0.0.1:PORT) and any Docker/reverse-proxy host,
//     with no host list to maintain.
//   • Dev origins (Vite proxy forwards the browser's localhost:3000 Origin
//     while the Host becomes localhost:PORT) and any ALLOWED_ORIGINS entries
//     → allowed.
//   • Anything else with an Origin → 403.
const DEV_ORIGINS = new Set([
  'http://localhost:3000', 'http://127.0.0.1:3000',
  `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
]);
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const o of EXTRA_ORIGINS) DEV_ORIGINS.add(o);

const isAllowedOrigin = (origin, host) => {
  if (!origin) return true; // non-browser client, or same-origin request with no Origin
  if (DEV_ORIGINS.has(origin)) return true;
  try { return new URL(origin).host === host; } catch { return false; }
};

// Guard the API and MCP surface. Static assets (the built UI) are intentionally
// not guarded — they carry no cluster capability.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/mcp')) return next();
  if (isAllowedOrigin(req.headers.origin, req.headers.host)) return next();
  return res.status(403).json({ error: 'Cross-origin request rejected' });
});

// Rate-limit the API/MCP surface. The server binds to loopback and enforces
// same-origin, so this is defense-in-depth (a runaway client or same-origin
// script hammering the API) rather than a perimeter control — hence a generous
// fixed-window cap.
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_MAX) || 1000, // requests/min/IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});
app.use('/api', apiLimiter);
app.use('/mcp', apiLimiter);

app.use(express.json());

// ------------------------------------------------------------------
// Demo mode — when the active context is the synthetic 'demo-cluster',
// serve an in-memory cluster (demo.js) so every feature is explorable with
// no real cluster. This single interception covers all data + mutation
// endpoints; config/cloud/MCP/static fall through, and the assistant is
// handled explicitly (canned, no LLM needed).
// ------------------------------------------------------------------
app.use((req, res, next) => {
  if (!demo.isDemo(currentContext)) return next();
  const p = req.path;
  // Real config handlers stay in charge (they are demo-aware).
  if (p === '/api/config/status' || p === '/api/config/context' ||
      p === '/api/config/load' || p === '/api/config/reload') return next();
  // Auth always "passes" in demo.
  if (p === '/api/config/auth') return res.json({ ok: true, currentContext: demo.DEMO_CONTEXT });
  // Assistant: report enabled + stream canned answers (no LLM required).
  if (p === '/api/assistant/status') {
    return res.json({ enabled: true, source: 'demo', editable: false, baseUrl: '', model: 'k8sight-demo (canned)' });
  }
  if (p === '/api/assistant/chat' && req.method === 'POST') return demoAssistantChat(req, res);
  // Cloud sign-in, agent detection, MCP, version and non-API paths are unchanged.
  if (p.startsWith('/api/azure') || p.startsWith('/api/aws') ||
      p.startsWith('/api/ai-agents') || p === '/mcp' || p === '/api/version' ||
      !p.startsWith('/api/')) return next();
  // Everything else under /api is cluster data → the synthetic cluster.
  if (demo.handle(req, res)) return;
  return next();
});

// Canned, streamed assistant reply for demo mode — matches the SSE event
// shape of /api/assistant/chat (token / tool / done).
function demoAssistantChat(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (type, data) => { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); res.flush?.(); };
  const history = (req.body && req.body.messages) || [];
  const last = [...history].reverse().find((m) => m && m.role === 'user');
  const { text, toolCalls } = demo.aiReply(last?.text || '');
  (toolCalls || []).forEach((name) => send('tool', { name, input: {} }));
  const words = String(text).split(/(\s+)/);
  let i = 0;
  const tick = () => {
    if (res.writableEnded) return;
    if (i >= words.length) { send('done', {}); return res.end(); }
    send('token', { text: words[i++] });
    setTimeout(tick, 18);
  };
  // Stop streaming if the client actually disconnects (res 'close', not req —
  // req 'close' fires as soon as the small POST body is read).
  res.on('close', () => { i = words.length; });
  setTimeout(tick, (toolCalls && toolCalls.length) ? 250 : 0);
}

// Serve the built frontend in production (when client/dist exists)
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
}

let currentContext = null;
let kubeConfig = null;

// The app switches context in-memory (kubeConfig.setCurrentContext); the on-disk
// kubeconfig that `kubectl` reads does NOT reflect that. So every kubectl
// shell-out must be told which context to use, or it silently targets a
// different cluster after the user switches. kctl() builds the argv form — the
// only form used now, so the context name is never interpolated into a shell
// string (which would allow injection from a hostile kubeconfig's context name).
const kctl = (...args) => (currentContext ? ['--context', currentContext, ...args] : args);

const getKubeConfigPath = () => {
  const envPath = process.env.KUBECONFIG;
  if (envPath) return envPath;
  // HOME may be unset for a non-root container user; fall back to os.homedir().
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.kube', 'config');
};

const loadKubeConfig = (configPath) => {
  try {
    kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromFile(configPath);
    currentContext = kubeConfig.getCurrentContext();
    return true;
  } catch (error) {
    console.error('Failed to load kubeconfig:', error.message);
    return false;
  }
};

// Initialize with default kubeconfig
const defaultPath = getKubeConfigPath();
if (fs.existsSync(defaultPath)) {
  loadKubeConfig(defaultPath);
}

// API Endpoints

// App version — single source of truth is the repo VERSION file; falls back to
// package.json (VERSION isn't shipped in the Docker image, but package.json is
// and is kept in sync by scripts/sync-version.mjs).
let APP_VERSION = null;
const getAppVersion = () => {
  if (APP_VERSION) return APP_VERSION;
  try {
    APP_VERSION = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
  } catch {
    try {
      APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    } catch {
      APP_VERSION = 'unknown';
    }
  }
  return APP_VERSION;
};

app.get('/api/version', (req, res) => {
  res.json({ version: getAppVersion() });
});

// Persisted app settings (small JSON in the user config dir). Used so the
// desktop app can toggle MCP write tools from the UI instead of an env var.
const SETTINGS_DIR = path.join(os.homedir(), '.config', 'k8s-manager');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (e) { /* best-effort */ }
  return next;
}
// MCP write tools: the persisted UI toggle wins; MCP_ALLOW_WRITE is the initial
// default when nothing has been set yet.
let mcpAllowWrite = (() => {
  const s = readSettings();
  if (typeof s.mcpAllowWrite === 'boolean') return s.mcpAllowWrite;
  return ['1', 'true', 'yes'].includes(String(process.env.MCP_ALLOW_WRITE || '').toLowerCase());
})();

// MCP connection info for the Preferences → MCP section. The HTTP endpoint is
// this same server at /mcp; write tools are gated by `mcpAllowWrite`.
app.get('/api/mcp/info', (req, res) => {
  res.json({
    allowWrite: mcpAllowWrite,
    readTools: [
      'list_contexts', 'switch_context', 'list_namespaces', 'list_resources',
      'get_resource', 'get_resource_yaml', 'get_pod_logs', 'get_events', 'get_topology',
      'get_cluster_summary', 'list_nodes', 'get_node_pods', 'get_node_metrics',
      'get_pod_metrics', 'list_pod_metrics', 'list_storage', 'get_rbac',
      'list_helm_releases', 'get_helm_values', 'get_helm_manifest',
      'list_crds', 'list_custom_resources', 'get_custom_resource',
      'get_argocd_status', 'list_argocd_apps', 'get_argocd_app',
      'list_argocd_projects', 'list_argocd_appsets', 'list_argocd_repositories', 'list_argocd_clusters',
    ],
    writeTools: [
      'apply_yaml', 'delete_resource', 'scale_workload', 'rollout_restart',
      'sync_argocd_app', 'refresh_argocd_app',
    ],
  });
});

// Toggle MCP write tools from the UI (persisted). Takes effect for new MCP
// sessions — a connected agent must reconnect to pick up the new tool set.
app.post('/api/mcp/config', (req, res) => {
  const remoteAddr = req.socket.remoteAddress || '';
  const isLocalRequest = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddr);
  if (!isLocalRequest) {
    return res.status(403).json({ error: 'This endpoint is only accessible from localhost' });
  }
  const { allowWrite } = req.body || {};
  if (typeof allowWrite !== 'boolean') {
    return res.status(400).json({ error: 'allowWrite (boolean) is required' });
  }
  mcpAllowWrite = allowWrite;
  writeSettings({ mcpAllowWrite: allowWrite });
  res.json({ allowWrite: mcpAllowWrite });
});

// ---- Google GKE (CLI-free) ------------------------------------------------
app.get('/api/gke/status', (req, res) => res.json(gke.getStatus()));

// Service-account key sign-in: validate the key, persist it, return clusters.
app.post('/api/gke/service-account', async (req, res) => {
  try {
    const clusters = await gke.loginWithServiceAccount(req.body?.key);
    res.json({ clusters });
  } catch (e) { res.status(400).json({ error: firstLine(e.message) }); }
});

// Browser (OAuth) sign-in.
app.post('/api/gke/browser/login', async (req, res) => {
  try { res.json(await gke.startBrowserLogin()); }
  catch (e) { res.status(400).json({ error: firstLine(e.message) }); }
});
app.get('/api/gke/browser/status', (req, res) => res.json(gke.loginStatus()));
app.post('/api/gke/browser/cancel', (req, res) => { gke.cancelLogin(); res.json({ ok: true }); });
app.post('/api/gke/signout', (req, res) => { gke.signOut(); res.json({ ok: true }); });

// List clusters using the current (browser or key) sign-in.
app.get('/api/gke/clusters', async (req, res) => {
  try {
    if (!gke.readCreds()) return res.status(401).json({ error: 'Not signed in to Google' });
    res.json({ clusters: await gke.discoverClusters() });
  } catch (e) { res.status(400).json({ error: firstLine(e.message) }); }
});

// Import selected clusters into the kubeconfig.
app.post('/api/gke/import', async (req, res) => {
  const { clusters = [] } = req.body || {};
  if (!Array.isArray(clusters) || clusters.length === 0) return res.status(400).json({ error: 'No clusters selected' });
  const imported = [], failed = [], replaced = [];
  for (const c of clusters) {
    try {
      const { context, replacedExternalAuth } = gke.writeCluster(c);
      imported.push(c.name);
      if (replacedExternalAuth) replaced.push(context);
    }
    catch (e) { failed.push({ name: c?.name || '?', error: firstLine(e.message) }); }
  }
  const prev = currentContext;
  const p = getKubeConfigPath();
  if (fs.existsSync(p)) loadKubeConfig(p);
  if (prev && kubeConfig?.contexts.some((c) => c.name === prev)) { kubeConfig.setCurrentContext(prev); currentContext = prev; }
  cache.clear();
  res.json({ imported, failed, replaced, contexts: kubeConfig?.contexts.map((c) => c.name) || [], currentContext });
});

app.get('/api/config/status', (req, res) => {
  const demoInfo = demo.demoContextInfo(); // { name, cluster, provider: 'demo' }

  // Tag each context with its cloud provider (derived from the cluster's server
  // URL) so the UI can group and icon them.
  const providerOf = (server = '', name = '') => {
    const s = server.toLowerCase();
    // Match on the parsed hostname (not a substring of the whole URL) so a URL
    // like https://evil.com/.eks.amazonaws.com can't be misclassified.
    let host = '';
    try { host = new URL(server).hostname.toLowerCase(); } catch { /* not a URL */ }
    const hostEndsWith = (suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix);
    if (hostEndsWith('.azmk8s.io')) return 'azure';
    if (hostEndsWith('.eks.amazonaws.com')) return 'aws';
    // GKE is reached on a bare public IP, so the server URL rarely helps. Both
    // gcloud and this app name their contexts gke_<project>_<location>_<cluster>,
    // which is the most reliable signal.
    if (hostEndsWith('.googleapis.com') || hostEndsWith('.gke.goog') || name.toLowerCase().startsWith('gke_')) return 'gcp';
    if (/(127\.0\.0\.1|localhost|:6443|:8443|host\.docker|kubernetes\.docker|minikube|kind|orbstack|rancher)/.test(s)) return 'local';
    return 'other';
  };

  let contexts = [], contextsInfo = [], clusters = [];
  if (kubeConfig) {
    const clusterByName = new Map(kubeConfig.clusters.map((c) => [c.name, c]));
    contextsInfo = kubeConfig.contexts.map((c) => {
      const cl = clusterByName.get(c.cluster);
      return { name: c.name, cluster: c.cluster, provider: providerOf(cl?.server, c.name) };
    });
    contexts = kubeConfig.contexts.map((c) => c.name);
    clusters = kubeConfig.clusters.map((c) => c.name);
  }

  // The synthetic demo cluster is always offered, listed first.
  contexts = [demoInfo.name, ...contexts];
  contextsInfo = [demoInfo, ...contextsInfo];
  clusters = [demoInfo.cluster, ...clusters];

  const inDemo = demo.isDemo(currentContext);
  if (!kubeConfig && !inDemo) {
    const attemptedPath = getKubeConfigPath();
    return res.json({
      loaded: false,
      contexts,
      contextsInfo,
      defaultPath: attemptedPath,
      exists: fs.existsSync(attemptedPath),
    });
  }

  res.json({
    loaded: true,
    currentContext: inDemo ? demoInfo.name : currentContext,
    path: inDemo ? 'demo (synthetic cluster)' : getKubeConfigPath(),
    contexts,
    contextsInfo,
    clusters,
  });
});

app.post('/api/config/load', (req, res) => {
  const { filePath } = req.body;

  if (!fs.existsSync(filePath)) {
    return res.status(400).json({ error: 'File not found' });
  }

  if (loadKubeConfig(filePath)) {
    res.json({
      success: true,
      currentContext,
      contexts: kubeConfig.contexts.map(c => c.name)
    });
  } else {
    res.status(400).json({ error: 'Invalid kubeconfig format' });
  }
});

app.post('/api/config/context', (req, res) => {
  const { contextName } = req.body;

  // Enter the synthetic demo cluster (works with no kubeconfig at all).
  if (demo.isDemo(contextName)) {
    currentContext = demo.DEMO_CONTEXT;
    cache.clear();
    return res.json({ success: true, currentContext });
  }

  if (!kubeConfig) {
    return res.status(400).json({ error: 'No kubeconfig loaded' });
  }

  const context = kubeConfig.contexts.find(c => c.name === contextName);
  if (!context) {
    return res.status(400).json({ error: 'Context not found' });
  }

  try {
    // Switch the active context in-memory. This avoids shelling out to kubectl
    // (which may be absent in a packaged app and permanently rewrites the user's
    // kubeconfig on disk). Every handler builds its API client fresh via
    // kubeConfig.makeApiClient(), so subsequent requests use the new context.
    kubeConfig.setCurrentContext(contextName);
    currentContext = kubeConfig.getCurrentContext();

    // Drop everything cached against the previous cluster so the UI doesn't show
    // stale data (namespaces, resources, storage, rbac, …) after the switch.
    cache.clear();

    res.json({ success: true, currentContext });
  } catch (error) {
    res.status(500).json({ error: `Failed to set context: ${error.message}` });
  }
});

// Reload the kubeconfig from disk, preserving the in-memory selected context.
// Building a fresh KubeConfig drops any cached exec-credential token, so after
// an external re-login (`az login`, `aws sso login`, or the in-app sign-in flow)
// the next auth check picks up the new token instead of reusing the stale one.
app.post('/api/config/reload', (req, res) => {
  const p = getKubeConfigPath();
  if (!fs.existsSync(p)) return res.status(400).json({ error: 'No kubeconfig found' });
  const prev = currentContext;
  if (!loadKubeConfig(p)) return res.status(500).json({ error: 'Failed to reload kubeconfig' });
  if (prev && kubeConfig?.contexts.some((c) => c.name === prev)) {
    kubeConfig.setCurrentContext(prev);
    currentContext = prev;
  }
  cache.clear();
  res.json({ success: true, currentContext });
});

// ------------------------------------------------------------------
// Azure AKS integration — two sign-in methods.
//
//  1) 'browser' (default, CLI-free): OAuth auth-code + PKCE in the system
//     browser (see azure-aks.js) + the ARM REST API. The browser carries the
//     device's compliance state, so it satisfies managed-device Conditional
//     Access policies (device-code cannot).
//  2) 'az': the classic Azure CLI flow (`az login` / `az aks …`), used when the
//     user prefers it or the browser flow is blocked. Only offered if `az` is
//     on PATH.
// ------------------------------------------------------------------
const firstLine = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';

// az CLI helpers (method 'az').
const runAz = (args, timeout = 60000) => new Promise((resolve, reject) => {
  execFile('az', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
    if (err) return reject(new Error((stderr || err.message || '').trim()));
    resolve(stdout);
  });
});
const azJson = async (args, timeout) => JSON.parse(await runAz([...args, '-o', 'json'], timeout));

let azureMethod = 'browser';  // active sign-in method
let azLogin = null;           // az login session: { proc, status, method, userCode, verificationUrl, error, buffer }

app.get('/api/azure/status', async (req, res) => {
  const azInstalled = await commandExists('az');
  const loggedIn = azure.isLoggedIn() || (azureMethod === 'az' && azLogin?.status === 'done');
  const account = azure.isLoggedIn() ? azure.loginStatus().account : undefined;
  res.json({ installed: true, azInstalled, loggedIn, method: azureMethod, account: account ? { name: account } : undefined });
});

app.post('/api/azure/login', async (req, res) => {
  const method = req.body?.method === 'az' ? 'az' : 'browser';
  const tenant = (req.body?.tenant || 'organizations').toString();
  azureMethod = method;

  if (method === 'browser') {
    try {
      const { authUrl } = await azure.startBrowserLogin(tenant);
      res.json({ method: 'browser', status: 'pending', authUrl });
    } catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
    return;
  }

  // az method — spawn `az login` (browser by default; device-code on request).
  if (!(await commandExists('az'))) return res.status(400).json({ error: 'Azure CLI (az) is not installed or not on PATH.' });
  const useDeviceCode = req.body?.deviceCode === true;
  let proc;
  try { proc = spawn('az', ['login', '--only-show-errors', ...(useDeviceCode ? ['--use-device-code'] : [])], { env: process.env }); }
  catch (e) { return res.status(500).json({ error: `Failed to launch az login: ${e.message}` }); }
  const session = { proc, status: 'pending', method: useDeviceCode ? 'device' : 'browser', userCode: null, verificationUrl: 'https://microsoft.com/devicelogin', error: null, buffer: '' };
  azLogin = session;
  let replied = false;
  const reply = () => { if (replied || res.headersSent) return; replied = true; res.json({ method: 'az', submethod: session.method, status: session.status, userCode: session.userCode, verificationUrl: session.verificationUrl, error: session.error }); };
  const onData = (buf) => {
    session.buffer += buf.toString();
    const code = session.buffer.match(/enter the code\s+([A-Z0-9]{6,})/i);
    const url = session.buffer.match(/(https?:\/\/\S*devicelogin\S*)/i);
    if (code) { session.userCode = code[1]; session.method = 'device'; }
    if (url) session.verificationUrl = url[1].replace(/[.,)]+$/, '');
    if (session.userCode) reply();
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (codeNum) => { session.status = codeNum === 0 ? 'done' : 'error'; if (codeNum !== 0 && !session.error) session.error = firstLine(session.buffer) || `az login exited (${codeNum})`; reply(); });
  proc.on('error', (e) => { session.status = 'error'; session.error = e.message; reply(); });
  setTimeout(reply, 1500);
});

app.get('/api/azure/login/status', (req, res) => {
  if (azureMethod === 'az') {
    if (!azLogin) return res.json({ status: 'idle' });
    return res.json({ status: azLogin.status, method: 'az', submethod: azLogin.method, userCode: azLogin.userCode, verificationUrl: azLogin.verificationUrl, error: azLogin.error });
  }
  res.json(azure.loginStatus());
});

app.post('/api/azure/login/cancel', (req, res) => {
  try { azLogin?.proc?.kill(); } catch { /* ignore */ }
  azLogin = null;
  azure.cancelLogin();
  res.json({ ok: true });
});

app.get('/api/azure/clusters', async (req, res) => {
  try {
    let clusters, subscriptions;
    if (azureMethod === 'az') {
      const subs = await azJson(['account', 'list', '--all'], 30000);
      const enabled = subs.filter((s) => s.state === 'Enabled');
      const perSub = await Promise.all(enabled.map(async (s) => {
        try {
          const list = await azJson(['aks', 'list', '--subscription', s.id, '--only-show-errors'], 90000);
          return list.map((a) => ({
            name: a.name,
            resourceGroup: a.resourceGroup || a.nodeResourceGroup?.replace(/^MC_/, '').split('_')[0],
            subscriptionId: s.id, subscriptionName: s.name, location: a.location,
            kubernetesVersion: a.currentKubernetesVersion || a.kubernetesVersion,
            powerState: a.powerState?.code || a.provisioningState,
          }));
        } catch { return []; }
      }));
      clusters = perSub.flat().sort((a, b) => a.name.localeCompare(b.name));
      subscriptions = enabled.length;
    } else {
      if (!azure.isLoggedIn()) return res.status(401).json({ error: 'Not signed in to Azure' });
      ({ clusters, subscriptions } = await azure.listAllClusters());
    }
    const existing = new Set((kubeConfig?.contexts || []).map((c) => c.name));
    const existingClusters = new Set((kubeConfig?.clusters || []).map((c) => c.name));
    for (const c of clusters) c.imported = existing.has(c.name) || existingClusters.has(c.name);
    res.json({ clusters, subscriptions });
  } catch (e) {
    res.status(500).json({ error: firstLine(e.message) });
  }
});

// Merge a fetched kubeconfig (YAML string) into an on-disk kubeconfig object,
// de-duplicating clusters/users/contexts by name.
// Rewrite an AAD cluster's kubeconfig user so it authenticates via our bundled
// azure-token.js (CLI-free) instead of the kubelogin exec that ARM/az returns.
// Cert-based users (non-AAD / --admin) have no exec and pass through untouched.
// The well-known AKS AAD server app id is used when the source omits --server-id.
const AKS_AAD_SERVER_ID = '6dae42f8-4368-4678-94ff-3960e28e3630';
function nativizeAksExec(kcYaml) {
  const kc = yaml.load(kcYaml) || {};
  for (const u of (kc.users || [])) {
    const exec = u?.user?.exec;
    if (!exec) continue; // cert-based user — already CLI-free
    const args = Array.isArray(exec.args) ? exec.args : [];
    const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const serverId = getArg('--server-id') || AKS_AAD_SERVER_ID;
    const tenant = getArg('--tenant-id') || getArg('--tenant') || azure.getTenant() || 'organizations';
    u.user.exec = {
      apiVersion: 'client.authentication.k8s.io/v1beta1',
      command: process.execPath, // node
      args: [AZURE_TOKEN_HELPER, '--server-id', serverId, '--tenant', tenant],
      interactiveMode: 'Never',
      provideClusterInfo: false,
    };
  }
  return yaml.dump(kc);
}

function mergeKubeconfigYaml(existingPath, incomingYaml) {
  let base = { apiVersion: 'v1', kind: 'Config', clusters: [], users: [], contexts: [], 'current-context': '' };
  try { if (fs.existsSync(existingPath)) base = { ...base, ...(yaml.load(fs.readFileSync(existingPath, 'utf-8')) || {}) }; } catch { /* start fresh */ }
  for (const k of ['clusters', 'users', 'contexts']) if (!Array.isArray(base[k])) base[k] = [];
  const incoming = yaml.load(incomingYaml) || {};
  const mergeBy = (list, add) => {
    for (const item of (add || [])) {
      const i = list.findIndex((x) => x.name === item.name);
      if (i >= 0) list[i] = item; else list.push(item);
    }
  };
  mergeBy(base.clusters, incoming.clusters);
  mergeBy(base.users, incoming.users);
  mergeBy(base.contexts, incoming.contexts);
  return base;
}

app.post('/api/azure/import', async (req, res) => {
  const { clusters = [], admin = false } = req.body || {};
  if (!Array.isArray(clusters) || clusters.length === 0) return res.status(400).json({ error: 'No clusters selected' });
  if (azureMethod === 'browser' && !azure.isLoggedIn()) return res.status(401).json({ error: 'Not signed in to Azure' });

  const p = getKubeConfigPath();
  const imported = [], failed = [];
  for (const c of clusters) {
    if (!c?.name || !c?.resourceGroup || !c?.subscriptionId) { failed.push({ name: c?.name || '?', error: 'Missing cluster identifiers' }); continue; }
    try {
      if (azureMethod === 'az') {
        // `az aks get-credentials` writes/merges into the kubeconfig itself.
        const args = ['aks', 'get-credentials', '-g', c.resourceGroup, '-n', c.name, '--subscription', c.subscriptionId, '--overwrite-existing', '--only-show-errors'];
        if (admin) args.push('--admin');
        await runAz(args, 90000);
      } else {
        // Browser/REST: fetch the kubeconfig and merge it in ourselves. For AAD
        // clusters (non-admin), rewrite the kubelogin exec to our bundled
        // azure-token.js so the cluster needs neither `az` nor `kubelogin`.
        const raw = await azure.getClusterKubeconfig(c.subscriptionId, c.resourceGroup, c.name, admin);
        const kc = admin ? raw : nativizeAksExec(raw);
        const merged = mergeKubeconfigYaml(p, kc);
        fs.mkdirSync(path.dirname(p), { recursive: true }); // persist incrementally
        fs.writeFileSync(p, yaml.dump(merged), { mode: 0o600 });
      }
      imported.push(c.name);
    } catch (e) {
      failed.push({ name: c.name, error: firstLine(e.message) });
    }
  }

  // Reload the kubeconfig so the new contexts appear immediately; keep the user
  // on the context they were already using instead of switching them away.
  const prev = currentContext;
  if (fs.existsSync(p)) loadKubeConfig(p);
  if (prev && kubeConfig?.contexts.some((c) => c.name === prev)) { kubeConfig.setCurrentContext(prev); currentContext = prev; }
  cache.clear();
  res.json({ imported, failed, contexts: kubeConfig?.contexts.map((c) => c.name) || [], currentContext });
});

// ------------------------------------------------------------------
// AWS EKS one-click integration — CLI-FREE (AWS SDK for JavaScript v3).
//
// No `aws` binary: sign in (SSO device flow / access keys / assume-role),
// discover every EKS cluster across accounts and regions, and write kubeconfig
// entries whose auth execs our native eks-token.js helper. See aws-eks.js.
// ------------------------------------------------------------------
let awsSession = null; // { sso: { accessToken, ssoRegion, startUrl }, ssoClusters: Map, poll }

app.get('/api/aws/status', async (req, res) => {
  // The SDK is bundled, so the integration is always available — no CLI needed.
  try {
    const profiles = (await awsEks.listProfiles()).map((p) => p.name);
    res.json({ installed: true, profiles });
  } catch (e) { res.json({ installed: true, profiles: [] }); }
});

app.post('/api/aws/sso-login', async (req, res) => {
  try {
    const { profile, startUrl: bodyUrl, ssoRegion: bodyRegion } = req.body || {};
    // Accept pasted URLs with a "#/..." fragment or trailing slashes. Trim the
    // fragment and trailing slashes without a backtracking regex (ReDoS-safe).
    const clean = (u) => {
      let s = String(u || '').trim();
      const hash = s.indexOf('#');
      if (hash !== -1) s = s.slice(0, hash);
      let i = s.length;
      while (i > 0 && s[i - 1] === '/') i--;
      return s.slice(0, i);
    };
    let startUrl = clean(bodyUrl), ssoRegion = bodyRegion;
    if (!startUrl || !ssoRegion) {
      // Fall back to an existing SSO profile's start URL / region.
      const all = await awsEks.listProfiles();
      const p = all.find((x) => x.name === profile) || all.find((x) => x.type === 'sso');
      startUrl = startUrl || clean(p?.ssoStartUrl);
      ssoRegion = ssoRegion || p?.ssoRegion;
    }
    // Leave ssoRegion undefined so the SDK layer auto-detects the Identity Center
    // region from the start URL (cluster discovery still scans every region).
    if (!startUrl) return res.status(400).json({ error: 'Enter your AWS SSO start URL.' });
    const session = await awsEks.ssoStartDeviceFlow({ startUrl, ssoRegion: ssoRegion || undefined });
    awsSession = { sso: null, ssoClusters: new Map(), device: session, status: 'pending', error: null };
    res.json({ status: 'pending', userCode: session.userCode, verificationUrl: session.verificationUri });
  } catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
});

app.get('/api/aws/sso-login/status', async (req, res) => {
  if (!awsSession?.device) return res.json({ status: awsSession?.status || 'idle' });
  if (awsSession.status !== 'pending') return res.json({ status: awsSession.status, error: awsSession.error, userCode: awsSession.device.userCode, verificationUrl: awsSession.device.verificationUri });
  try {
    const out = await awsEks.ssoPollToken(awsSession.device);
    if (out.pending) return res.json({ status: 'pending', userCode: awsSession.device.userCode, verificationUrl: awsSession.device.verificationUri });
    awsSession.sso = { accessToken: out.accessToken, ssoRegion: awsSession.device.ssoRegion, startUrl: awsSession.device.startUrl };
    awsSession.status = 'done';
    res.json({ status: 'done' });
  } catch (e) { awsSession.status = 'error'; awsSession.error = firstLine(e.message); res.json({ status: 'error', error: awsSession.error }); }
});

app.post('/api/aws/sso-login/cancel', (req, res) => { awsSession = null; res.json({ ok: true }); });

// After SSO auth: choose an AWS account, then a role for it.
app.get('/api/aws/sso-accounts', async (req, res) => {
  if (!awsSession?.sso?.accessToken) return res.status(400).json({ error: 'Not signed in to AWS SSO' });
  try { res.json({ accounts: await awsEks.ssoListAccounts(awsSession.sso) }); }
  catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
});

app.get('/api/aws/sso-roles', async (req, res) => {
  if (!awsSession?.sso?.accessToken) return res.status(400).json({ error: 'Not signed in to AWS SSO' });
  const account = req.query.account;
  if (!account) return res.status(400).json({ error: 'account is required' });
  try { res.json({ roles: await awsEks.ssoListRoles(awsSession.sso, account) }); }
  catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
});

// Validate access-key / assume-role credentials and persist them as an ~/.aws
// profile so eks-token.js can read them at runtime.
app.post('/api/aws/configure', async (req, res) => {
  const { method, name, accessKeyId, secretAccessKey, sessionToken, region, roleArn, sourceProfile, sessionName } = req.body || {};
  const profile = (name || '').trim();
  if (!profile) return res.status(400).json({ error: 'A profile name is required' });
  try {
    const { credentials } = await awsEks.resolveCredentials(method, { accessKeyId, secretAccessKey, sessionToken, region, roleArn, sourceProfile, sessionName });
    await awsEks.validateCredentials(credentials, region); // fail fast on bad creds
    awsEks.saveProfile(profile, { accessKeyId, secretAccessKey, sessionToken, roleArn, sourceProfile, sessionName, region });
    res.json({ profile });
  } catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
});

app.post('/api/aws/clusters', async (req, res) => {
  const { profile, account, role } = req.body || {};
  try {
    const existing = new Set((kubeConfig?.contexts || []).map((c) => c.name));
    // Active SSO session with a chosen account + role → list that account's clusters.
    if (awsSession?.sso?.accessToken && account && role) {
      const credentials = await awsEks.ssoRoleCredentials(awsSession.sso, account, role);
      awsSession.ssoSelected = { account, role, credentials };
      const { clusters, regions } = await awsEks.discoverClusters({ credentials, account });
      awsSession.ssoClusters = new Map(clusters.map((c) => [`${c.region}/${c.name}`, { ...c, account, role }]));
      return res.json({ clusters: clusters.map((c) => ({ name: c.name, region: c.region, account, imported: existing.has(c.name) })), regions });
    }
    // Otherwise use a profile's credentials (access-key / role / existing).
    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
    const credentials = await fromNodeProviderChain(profile ? { profile } : {})();
    const { clusters, regions } = await awsEks.discoverClusters({ credentials });
    res.json({ clusters: clusters.map((c) => ({ name: c.name, region: c.region, imported: existing.has(c.name) })), regions });
  } catch (e) { res.status(500).json({ error: firstLine(e.message) }); }
});

app.post('/api/aws/import', async (req, res) => {
  const { clusters = [], profile } = req.body || {};
  if (!Array.isArray(clusters) || clusters.length === 0) return res.status(400).json({ error: 'No clusters selected' });
  const imported = [], failed = [];
  const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
  const { SSOClient, GetRoleCredentialsCommand } = await import('@aws-sdk/client-sso');

  for (const c of clusters) {
    if (!c?.name || !c?.region) { failed.push({ name: c?.name || '?', error: 'Missing cluster name or region' }); continue; }
    try {
      let credentials, credProfile = profile || undefined;
      const ssoInfo = awsSession?.ssoClusters?.get(`${c.region}/${c.name}`);
      if (awsSession?.sso?.accessToken && ssoInfo) {
        // Per-account SSO role credentials (short-lived). Save them as a profile
        // so the token helper can use them at runtime.
        const sso = new SSOClient({ region: awsSession.sso.ssoRegion });
        const rc = await sso.send(new GetRoleCredentialsCommand({ accessToken: awsSession.sso.accessToken, accountId: ssoInfo.account, roleName: ssoInfo.role }));
        credentials = { accessKeyId: rc.roleCredentials.accessKeyId, secretAccessKey: rc.roleCredentials.secretAccessKey, sessionToken: rc.roleCredentials.sessionToken };
        credProfile = `sso-${ssoInfo.account}`;
        awsEks.saveProfile(credProfile, { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, region: c.region });
      } else {
        credentials = await fromNodeProviderChain(profile ? { profile } : {})();
      }
      await awsEks.writeCluster({ credentials, region: c.region, name: c.name, alias: c.name, profile: credProfile });
      imported.push(c.name);
    } catch (e) { failed.push({ name: c.name, error: firstLine(e.message) }); }
  }
  // Keep the user on the cluster they were already using.
  const prev = currentContext;
  const p = getKubeConfigPath();
  if (fs.existsSync(p)) loadKubeConfig(p);
  if (prev && kubeConfig?.contexts.some((c) => c.name === prev)) { kubeConfig.setCurrentContext(prev); currentContext = prev; }
  cache.clear();
  res.json({ imported, failed, contexts: kubeConfig?.contexts.map((c) => c.name) || [], currentContext });
});

// ------------------------------------------------------------------
// Bring-your-own AI agent — detect installed CLI agents and run them in a
// terminal with the cluster context loaded. No API key.
// ------------------------------------------------------------------
const AI_AGENTS = [
  { id: 'claude', name: 'Claude Code', command: 'claude', desc: 'The coding assistant by Anthropic', install: 'https://docs.anthropic.com/en/docs/claude-code' },
  { id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot', desc: 'AI pair programmer by GitHub', install: 'https://github.com/github/gh-copilot' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', desc: 'Google Gemini in your terminal', install: 'https://github.com/google-gemini/gemini-cli' },
  { id: 'codex', name: 'Codex CLI', command: 'codex', desc: 'OpenAI Codex coding agent', install: 'https://github.com/openai/codex' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', desc: 'Open-source terminal AI agent', install: 'https://opencode.ai' },
];
// Detect a CLI regardless of how the app was launched. A GUI-launched app
// inherits a minimal PATH, and a login shell (`-lc`) sources ~/.zprofile but
// NOT ~/.zshrc — where installers like Claude Code's add ~/.local/bin. Relying
// on any single shell invocation therefore misses tools. Instead we search the
// process PATH, the login-shell PATH, and a set of well-known bin directories.
let loginPathCache;
const loginShellPath = () => new Promise((resolve) => {
  if (loginPathCache !== undefined) return resolve(loginPathCache);
  execFile(process.env.SHELL || '/bin/sh', ['-lc', 'printf %s "$PATH"'], { timeout: 8000 }, (err, stdout) => {
    resolve((loginPathCache = (!err && stdout ? String(stdout).trim() : '')));
  });
});
// Well-known bin directories a GUI-launched app's minimal PATH usually omits.
const knownBinDirs = () => {
  const home = process.env.HOME || os.homedir();
  return [
    `${home}/.local/bin`, `${home}/bin`, `${home}/.npm-global/bin`,
    `${home}/.yarn/bin`, `${home}/.bun/bin`, `${home}/.deno/bin`, `${home}/.cargo/bin`,
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ];
};
const commandExists = async (cmd) => {
  const safe = String(cmd).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return false;
  const dirs = new Set([
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
    ...(await loginShellPath()).split(path.delimiter),
    ...knownBinDirs(),
  ].filter(Boolean));
  for (const dir of dirs) {
    try { fs.accessSync(path.join(dir, safe), fs.constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
};

// Resolve an executable to an ABSOLUTE path. node-pty spawns via posix_spawnp,
// whose PATH lookup ignores the well-known dirs a GUI-launched macOS app is
// missing — so `pty.spawn('kubectl', …)` fails with "posix_spawnp failed" even
// though Node's execFile/spawn (used by the REST calls) resolve it fine. Search
// the process PATH, the cached login-shell PATH, and the known dirs; fall back
// to the bare name so PATH lookup can still try.
const resolveBinSync = (cmd) => {
  const safe = String(cmd).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return cmd;
  const dirs = [
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
    ...(loginPathCache ? loginPathCache.split(path.delimiter) : []),
    ...knownBinDirs(),
  ].filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, safe);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return cmd;
};
// Warm the login-shell PATH cache early so the first pod terminal can resolve
// kubectl from a shell-configured location too (knownBinDirs already covers the
// common Homebrew/local installs even before this resolves).
loginShellPath();
app.get('/api/ai-agents', async (req, res) => {
  const agents = await Promise.all(AI_AGENTS.map(async (a) => ({ id: a.id, name: a.name, command: a.command, desc: a.desc, install: a.install, installed: await commandExists(a.command) })));
  res.json({ agents });
});

// Launch the chosen agent in a *native* OS terminal window (rather than the
// in-app terminal panel) — the "Open AI tools in an external terminal" option.
// Writes a temp kubeconfig pinned to the app's current context, then opens the
// platform terminal running the agent CLI. macOS/Linux; best-effort.
app.post('/api/ai-agents/launch-external', (req, res) => {
  try {
    const { agentId, command: customCommand, prompt } = req.body || {};
    const info = AI_AGENTS.find((a) => a.id === agentId);
    const command = info ? info.command : String(customCommand || '').replace(/[^a-zA-Z0-9_./\s-]/g, '').trim();
    if (!command) return res.status(400).json({ error: 'Unknown AI agent' });

    // Temp kubeconfig with the app's in-memory current context.
    const kubeconfigPath = path.join(os.tmpdir(), `km-agent-${randomUUID()}.yaml`);
    fs.writeFileSync(kubeconfigPath, kubeConfig.exportConfig(), { mode: 0o600 });

    const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const launch = prompt ? `${command} ${shq(prompt)}` : command;
    // A small launcher script: pin the kubeconfig, print a banner, run the agent,
    // then keep the shell open so its output stays visible.
    const script = path.join(os.tmpdir(), `km-agent-${randomUUID()}.sh`);
    const body = [
      '#!/bin/bash',
      `export KUBECONFIG=${shq(kubeconfigPath)}`,
      `export KUBE_CONTEXT=${shq(currentContext || '')}`,
      `echo ${shq(`Cluster context: ${currentContext || '(default)'}`)}`,
      launch,
      `rm -f ${shq(kubeconfigPath)} ${shq(script)}`,
      'exec $SHELL -l',
    ].join('\n');
    fs.writeFileSync(script, body, { mode: 0o700 });

    if (process.platform === 'darwin') {
      execFile('open', ['-a', 'Terminal', script], (err) => { /* fire and forget */ });
    } else if (process.platform === 'linux') {
      // Try a few common terminal emulators.
      const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'];
      const tryNext = (i) => {
        if (i >= term.length) return;
        execFile(term[i], ['-e', 'bash', script], (err) => { if (err) tryNext(i + 1); });
      };
      tryNext(0);
    } else {
      return res.status(400).json({ error: 'External terminal is only supported on macOS and Linux' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to launch external terminal' });
  }
});

// ------------------------------------------------------------------
// Authentication / connectivity check
//
// /api/config/status only tells us the kubeconfig file *parsed*. It does not
// tell us whether the credentials actually work — a token can be expired, the
// API server unreachable, TLS untrusted, or an exec auth plugin (aws-iam-
// authenticator, gke-gcloud-auth-plugin, …) missing. This endpoint makes one
// lightweight authenticated call and classifies the outcome so the UI can show
// an actionable popup before loading the app.
// ------------------------------------------------------------------
const currentServerUrl = () => {
  try { return kubeConfig?.getCurrentCluster()?.server || null; } catch { return null; }
};

const classifyClusterError = (error) => {
  // client-node 2.0 throws ApiException with a numeric `.code` (HTTP status)
  // and a parsed `.body`; fetch network failures carry a string `.cause.code`.
  const num = (v) => (typeof v === 'number' ? v : undefined);
  const httpStatus = num(error?.code) ?? error?.statusCode ?? error?.response?.statusCode ?? num(error?.body?.code);
  const code = error?.cause?.code || (typeof error?.code === 'string' ? error.code : undefined);
  const msg = error?.body?.message || error?.body?.reason || error?.message || String(error);

  if (httpStatus === 401) {
    return {
      ok: false, reason: 'unauthorized',
      message: 'Authentication failed (HTTP 401). Your credentials were rejected — the token or client certificate may be expired or invalid.'
    };
  }
  if (httpStatus === 403) {
    // Credentials are valid; the user simply can't list namespaces. Still authenticated.
    return {
      ok: true, authenticated: true, reachable: true, limited: true,
      message: 'Authenticated, but this user has limited RBAC permissions.'
    };
  }
  const tlsCodes = ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'];
  if (code && tlsCodes.includes(code)) {
    return { ok: false, reason: 'tls', message: `TLS certificate error (${code}) contacting the cluster API server.` };
  }
  if (code && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET'].includes(code)) {
    return { ok: false, reason: 'unreachable', message: `Cannot reach the cluster API server (${code}). Check the server URL, your VPN/network, or that the cluster is running.` };
  }
  if (code === 'ENOENT' || /exec plugin|no such file|ENOENT|not found|credential plugin/i.test(msg)) {
    return {
      ok: false, reason: 'exec-plugin',
      message: `Failed to run the kubeconfig auth plugin: ${msg}. Ensure the required CLI (e.g. aws-iam-authenticator, gke-gcloud-auth-plugin) is installed and on PATH.`
    };
  }
  return { ok: false, reason: 'error', message: msg };
};

const checkClusterAuth = async () => {
  if (!kubeConfig) return { ok: false, reason: 'no-config', message: 'No kubeconfig is loaded.' };
  const server = currentServerUrl();
  try {
    const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
    // Lightweight authenticated request (limit=1). 200 ⇒ authenticated + reachable.
    await core.listNamespace({ limit: 1 });
    return { ok: true, authenticated: true, reachable: true, currentContext, server };
  } catch (error) {
    return { ...classifyClusterError(error), currentContext, server };
  }
};

// Always responds 200 with an `ok` flag so the client can render details
// (rather than having to catch an HTTP error).
app.get('/api/config/auth', async (req, res) => {
  try {
    res.json(await checkClusterAuth());
  } catch (error) {
    res.json({ ok: false, reason: 'error', message: error.message });
  }
});

app.get('/api/namespaces', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = 'namespaces';
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const api = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const response = await api.listNamespace();
    const items = response.items;
    const namespaces = items.map(ns => ns.metadata.name);
    const details = items.map(ns => ({
      name: ns.metadata.name,
      status: ns.status?.phase || 'Active',
      createdAt: ns.metadata.creationTimestamp,
      labels: ns.metadata.labels || {}
    }));
    const result = { namespaces, details };

    setCache(cacheKey, result, CACHE_TTL.namespaces);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/resources/:namespace', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const namespace = req.params.namespace;
    const cacheKey = getCacheKey('resources', { namespace });

    // Check cache first
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const appsApi = kubeConfig.makeApiClient(k8s.AppsV1Api);
    const netApi = kubeConfig.makeApiClient(k8s.NetworkingV1Api);

    const empty = () => ({ items: [] });

    // All in-process API calls (no kubectl process spawn), fetched in parallel
    const [pods, services, deployments, statefulSets, daemonSets, configMaps, secrets, serviceAccounts, ingresses, networkPolicies, pvcs] = await Promise.all([
      coreApi.listNamespacedPod({ namespace }).catch(empty),
      coreApi.listNamespacedService({ namespace }).catch(empty),
      appsApi.listNamespacedDeployment({ namespace }).catch(empty),
      appsApi.listNamespacedStatefulSet({ namespace }).catch(empty),
      appsApi.listNamespacedDaemonSet({ namespace }).catch(empty),
      coreApi.listNamespacedConfigMap({ namespace }).catch(empty),
      coreApi.listNamespacedSecret({ namespace }).catch(empty),
      coreApi.listNamespacedServiceAccount({ namespace }).catch(empty),
      netApi.listNamespacedIngress({ namespace }).catch(empty),
      netApi.listNamespacedNetworkPolicy({ namespace }).catch(empty),
      coreApi.listNamespacedPersistentVolumeClaim({ namespace }).catch(empty)
    ]);

    const resources = {
      pods: pods.items.map(item => formatResource(item, 'Pod')),
      services: services.items.map(item => formatResource(item, 'Service')),
      deployments: deployments.items.map(item => formatResource(item, 'Deployment')),
      statefulSets: statefulSets.items.map(item => formatResource(item, 'StatefulSet')),
      daemonSets: daemonSets.items.map(item => formatResource(item, 'DaemonSet')),
      configMaps: configMaps.items.map(item => formatResource(item, 'ConfigMap')),
      secrets: secrets.items.map(item => formatResource(item, 'Secret')),
      serviceAccounts: serviceAccounts.items.map(item => formatResource(item, 'ServiceAccount')),
      ingresses: ingresses.items.map(item => formatResource(item, 'Ingress')),
      networkPolicies: networkPolicies.items.map(item => formatResource(item, 'NetworkPolicy')),
      persistentVolumeClaims: pvcs.items.map(item => formatResource(item, 'PersistentVolumeClaim'))
    };

    // Cache the response
    setCache(cacheKey, resources, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(resources);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cluster-scoped storage: PersistentVolumes + StorageClasses (not per-namespace)
app.get('/api/storage', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = 'storage';
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const storageApi = kubeConfig.makeApiClient(k8s.StorageV1Api);
    const empty = () => ({ items: [] });

    const [pvs, scs] = await Promise.all([
      coreApi.listPersistentVolume().catch(empty),
      storageApi.listStorageClass().catch(empty)
    ]);

    const result = {
      persistentVolumes: pvs.items.map(item => formatResource(item, 'PersistentVolume')),
      storageClasses: scs.items.map(item => formatResource(item, 'StorageClass'))
    };

    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Access Control (RBAC): roles, bindings, cluster roles/bindings, service accounts
app.get('/api/rbac', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = 'rbac';
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const rbac = kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api);
    const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const empty = () => ({ items: [] });

    const [roles, roleBindings, clusterRoles, clusterRoleBindings, sas] = await Promise.all([
      rbac.listRoleForAllNamespaces().catch(empty),
      rbac.listRoleBindingForAllNamespaces().catch(empty),
      rbac.listClusterRole().catch(empty),
      rbac.listClusterRoleBinding().catch(empty),
      core.listServiceAccountForAllNamespaces().catch(empty)
    ]);

    const base = (i) => ({
      name: i.metadata.name,
      namespace: i.metadata.namespace || '-',
      createdAt: i.metadata.creationTimestamp
    });
    const binding = (i) => ({
      ...base(i),
      roleRef: i.roleRef ? `${i.roleRef.kind}/${i.roleRef.name}` : '-',
      subjects: (i.subjects || []).length
    });

    const result = {
      serviceAccounts: sas.items.map(i => ({ ...base(i), secrets: (i.secrets || []).length })),
      roles: roles.items.map(i => ({ ...base(i), rules: (i.rules || []).length })),
      roleBindings: roleBindings.items.map(binding),
      clusterRoles: clusterRoles.items.map(i => ({ ...base(i), rules: (i.rules || []).length })),
      clusterRoleBindings: clusterRoleBindings.items.map(binding)
    };

    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/resource/:namespace/:kind/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, kind, name } = req.params;

    let resource;
    try {
      switch(kind) {
        case 'Pod':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedPod({ name, namespace });
          break;
        case 'Service':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedService({ name, namespace });
          break;
        case 'Deployment':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedDeployment({ name, namespace });
          break;
        case 'StatefulSet':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedStatefulSet({ name, namespace });
          break;
        case 'DaemonSet':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedDaemonSet({ name, namespace });
          break;
        case 'ConfigMap':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedConfigMap({ name, namespace });
          break;
        case 'Secret':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedSecret({ name, namespace });
          break;
        case 'ServiceAccount':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedServiceAccount({ name, namespace });
          break;
        case 'Role':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readNamespacedRole({ name, namespace });
          break;
        case 'RoleBinding':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readNamespacedRoleBinding({ name, namespace });
          break;
        case 'ClusterRole':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readClusterRole({ name });
          break;
        case 'ClusterRoleBinding':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readClusterRoleBinding({ name });
          break;
        case 'Ingress':
          resource = await kubeConfig.makeApiClient(k8s.NetworkingV1Api).readNamespacedIngress({ name, namespace });
          break;
        case 'NetworkPolicy':
          resource = await kubeConfig.makeApiClient(k8s.NetworkingV1Api).readNamespacedNetworkPolicy({ name, namespace });
          break;
        case 'PersistentVolumeClaim':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedPersistentVolumeClaim({ name, namespace });
          break;
        case 'PersistentVolume':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readPersistentVolume({ name });
          break;
        case 'StorageClass':
          resource = await kubeConfig.makeApiClient(k8s.StorageV1Api).readStorageClass({ name });
          break;
        default:
          return res.status(400).json({ error: 'Unsupported resource kind' });
      }
    } catch (apiError) {
      return res.status(404).json({ error: `Resource not found: ${apiError.message}` });
    }

    res.json(resource);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/logs/:namespace/:pod', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, pod } = req.params;
    const container = req.query.container || undefined;
    const tail = parseInt(req.query.tail) || undefined; // Get last N lines
    const timestamps = req.query.timestamps === 'true'; // prefix each line with an RFC3339 timestamp
    const cacheKey = getCacheKey('logs', { namespace, pod, container, tail, timestamps });

    // Check cache
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const api = kubeConfig.makeApiClient(k8s.CoreV1Api);
    // client-node 2.0 returns the log body as a string directly.
    let logs = await api.readNamespacedPodLog({ name: pod, namespace, container, tailLines: tail, timestamps });

    if (Buffer.isBuffer(logs)) {
      logs = logs.toString('utf8');
    }

    logs = logs || 'No logs available';
    const result = { logs };

    setCache(cacheKey, result, CACHE_TTL.yaml);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    console.error(`Failed to get logs for ${pod}/${namespace}:`, error.message);
    res.status(500).json({ error: `Failed to get logs: ${error.message}` });
  }
});

app.post('/api/exec', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, pod, command, container } = req.body;

    if (!namespace || !pod || !command) {
      return res.status(400).json({ error: 'Missing namespace, pod, or command' });
    }

    // Pass the command as a single argument to `sh -c` (no shell interpolation),
    // so quotes, pipes, redirects and special chars are handled safely.
    const args = kctl('exec', '-n', namespace, pod);
    if (container) args.push('-c', container);
    args.push('--', 'sh', '-c', command);

    const result = spawnSync('kubectl', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000
    });

    if (result.error) {
      return res.json({ output: result.error.message, code: -1 });
    }
    const output = (result.stdout || '') + (result.stderr || '');
    res.json({ output, code: result.status == null ? 0 : result.status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Port forwarding to local (kubectl port-forward svc/<name>)
// ============================================================
const portForwards = new Map(); // id -> { id, namespace, name, remotePort, localPort, proc, status, startedAt, error }
let pfCounter = 0;

app.post('/api/portforward', (req, res) => {
  if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
  const { namespace, name, remotePort } = req.body;
  const localPort = req.body.localPort ? parseInt(req.body.localPort, 10) : null;

  if (!namespace || !name || !remotePort) {
    return res.status(400).json({ error: 'Missing namespace, name, or remotePort' });
  }

  // No local port -> ":remote" lets kubectl pick a random free local port
  const portArg = localPort ? `${localPort}:${remotePort}` : `:${remotePort}`;
  const proc = spawn('kubectl', kctl('port-forward', '-n', namespace, `svc/${name}`, portArg));

  const id = `pf-${++pfCounter}`;
  const entry = { id, namespace, name, remotePort, localPort, proc, status: 'starting', startedAt: Date.now(), error: '' };
  portForwards.set(id, entry);

  let responded = false;
  const respond = (fn) => { if (!responded) { responded = true; fn(); } };

  const timer = setTimeout(() => {
    respond(() => res.status(504).json({ error: 'Timed out starting port-forward' }));
    try { proc.kill(); } catch (e) {}
    portForwards.delete(id);
  }, 10000);

  proc.stdout.on('data', (data) => {
    const m = data.toString().match(/Forwarding from 127\.0\.0\.1:(\d+)/);
    if (m) {
      entry.localPort = parseInt(m[1], 10);
      entry.status = 'active';
      clearTimeout(timer);
      respond(() => res.json({ id, namespace, name, remotePort, localPort: entry.localPort, status: 'active', startedAt: entry.startedAt }));
    }
  });
  proc.stderr.on('data', (data) => { entry.error += data.toString(); });
  proc.on('exit', (code) => {
    entry.status = 'stopped';
    clearTimeout(timer);
    respond(() => res.status(500).json({ error: (entry.error || `port-forward exited (code ${code})`).trim() }));
  });
  proc.on('error', (err) => {
    entry.status = 'error';
    clearTimeout(timer);
    respond(() => res.status(500).json({ error: err.message }));
  });
});

app.get('/api/portforward', (req, res) => {
  const forwards = Array.from(portForwards.values())
    .filter(f => f.status === 'active')
    .map(({ id, namespace, name, remotePort, localPort, status, startedAt }) =>
      ({ id, namespace, name, remotePort, localPort, status, startedAt }));
  res.json({ forwards });
});

app.delete('/api/portforward/:id', (req, res) => {
  const entry = portForwards.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Port-forward not found' });
  try { entry.proc.kill(); } catch (e) {}
  portForwards.delete(req.params.id);
  res.json({ success: true });
});

// Kill all forwards when the server shuts down
const killAllForwards = () => {
  for (const entry of portForwards.values()) {
    try { entry.proc.kill(); } catch (e) {}
  }
};
process.on('exit', killAllForwards);
process.on('SIGINT', () => { killAllForwards(); process.exit(0); });
process.on('SIGTERM', () => { killAllForwards(); process.exit(0); });

app.get('/api/yaml/:namespace/:kind/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, kind, name } = req.params;

    let resource;
    try {
      switch(kind) {
        case 'pod':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedPod({ name, namespace });
          break;
        case 'service':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedService({ name, namespace });
          break;
        case 'deployment':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedDeployment({ name, namespace });
          break;
        case 'statefulSet':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedStatefulSet({ name, namespace });
          break;
        case 'daemonSet':
          resource = await kubeConfig.makeApiClient(k8s.AppsV1Api).readNamespacedDaemonSet({ name, namespace });
          break;
        case 'configMap':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedConfigMap({ name, namespace });
          break;
        case 'secret':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedSecret({ name, namespace });
          break;
        case 'serviceAccount':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedServiceAccount({ name, namespace });
          break;
        case 'role':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readNamespacedRole({ name, namespace });
          break;
        case 'roleBinding':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readNamespacedRoleBinding({ name, namespace });
          break;
        case 'clusterRole':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readClusterRole({ name });
          break;
        case 'clusterRoleBinding':
          resource = await kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api).readClusterRoleBinding({ name });
          break;
        case 'ingress':
          resource = await kubeConfig.makeApiClient(k8s.NetworkingV1Api).readNamespacedIngress({ name, namespace });
          break;
        case 'networkPolicy':
          resource = await kubeConfig.makeApiClient(k8s.NetworkingV1Api).readNamespacedNetworkPolicy({ name, namespace });
          break;
        case 'persistentVolumeClaim':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readNamespacedPersistentVolumeClaim({ name, namespace });
          break;
        case 'persistentVolume':
          resource = await kubeConfig.makeApiClient(k8s.CoreV1Api).readPersistentVolume({ name });
          break;
        case 'storageClass':
          resource = await kubeConfig.makeApiClient(k8s.StorageV1Api).readStorageClass({ name });
          break;
        default:
          return res.status(400).json({ error: 'Unsupported resource kind' });
      }
    } catch (apiError) {
      return res.status(404).json({ error: `Resource not found: ${apiError.message}` });
    }

    const yamlString = yaml.dump(resource, { indent: 2 });
    res.json({ yaml: yamlString });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ------------------------------------------------------------------
// Resource write operations (edit/apply, delete, scale, rollout restart).
// These shell out to kubectl so a single code path works for every kind.
// The camelCase resourceType lowercases to a valid kubectl resource name
// (statefulSet → statefulset, configMap → configmap, …).
// ------------------------------------------------------------------
const CLUSTER_SCOPED_KINDS = new Set([
  'persistentvolume', 'storageclass', 'clusterrole', 'clusterrolebinding',
  'node', 'namespace', 'customresourcedefinition',
]);

// Run kubectl, optionally piping `input` to stdin (for `apply -f -`).
// Always target the app's *selected* context — the app switches context
// in-memory (kubeConfig.setCurrentContext), which the on-disk kubeconfig
// kubectl reads by default does NOT reflect. Without --context, kubectl would
// operate on whatever context is current on disk (a different cluster).
const runKubectl = (args, input) => new Promise((resolve, reject) => {
  const ctxArgs = currentContext ? ['--context', currentContext] : [];
  const child = spawn('kubectl', [...ctxArgs, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('kubectl timed out')); }, 25000);
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('error', reject);
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve(out.trim());
    else reject(new Error((err || out || `kubectl exited ${code}`).trim()));
  });
  if (input != null) { child.stdin.write(input); child.stdin.end(); }
});

const nsArgs = (kind, namespace) =>
  (!namespace || namespace === '-' || CLUSTER_SCOPED_KINDS.has(kind)) ? [] : ['-n', namespace];

// Apply edited YAML (create-or-update). Body: { yaml }
app.put('/api/yaml/:namespace/:kind/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { yaml: yamlText } = req.body || {};
    if (!yamlText || !yamlText.trim()) return res.status(400).json({ error: 'Empty YAML' });
    // validate it parses before sending to the cluster
    try { yaml.load(yamlText); } catch (e) { return res.status(400).json({ error: `Invalid YAML: ${e.message}` }); }
    const out = await runKubectl(['apply', '-f', '-'], yamlText);
    cache.clear();
    res.json({ success: true, message: out || 'Applied' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Apply arbitrary YAML by content (no resource in the path). Used by the MCP
// apply_yaml tool. Body: { yaml }
app.post('/api/apply', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { yaml: yamlText } = req.body || {};
    if (!yamlText || !yamlText.trim()) return res.status(400).json({ error: 'Empty YAML' });
    try { yaml.load(yamlText); } catch (e) { return res.status(400).json({ error: `Invalid YAML: ${e.message}` }); }
    const out = await runKubectl(['apply', '-f', '-'], yamlText);
    cache.clear();
    res.json({ success: true, message: out || 'Applied' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a resource
app.delete('/api/resource/:namespace/:kind/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, kind, name } = req.params;
    const k = kind.toLowerCase();
    const out = await runKubectl(['delete', k, name, ...nsArgs(k, namespace)]);
    cache.clear();
    res.json({ success: true, message: out || `${name} deleted` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Scale a workload. Body: { replicas }
app.post('/api/scale/:namespace/:kind/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, kind, name } = req.params;
    const replicas = parseInt(req.body?.replicas, 10);
    if (Number.isNaN(replicas) || replicas < 0) return res.status(400).json({ error: 'Invalid replicas' });
    const k = kind.toLowerCase();
    const out = await runKubectl(['scale', k, name, `--replicas=${replicas}`, ...nsArgs(k, namespace)]);
    cache.clear();
    res.json({ success: true, message: out || `Scaled to ${replicas}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rollout-restart a workload
app.post('/api/restart/:namespace/:kind/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, kind, name } = req.params;
    const k = kind.toLowerCase();
    const out = await runKubectl(['rollout', 'restart', k, name, ...nsArgs(k, namespace)]);
    cache.clear();
    res.json({ success: true, message: out || 'Restart triggered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/events/:namespace?', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100 per page
    const cacheKey = getCacheKey('events', { namespace, page, limit });

    // Check cache
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);

    try {
      let response;
      if (namespace && namespace !== 'all') {
        response = await coreApi.listNamespacedEvent({ namespace });
      } else {
        response = await coreApi.listEventForAllNamespaces();
      }

      const events = response.items.map(event => ({
        message: event.message,
        namespace: event.metadata.namespace,
        type: event.type,
        reason: event.reason,
        involvedObject: event.involvedObject.kind + '/' + event.involvedObject.name,
        source: event.source.component || event.source.host,
        count: event.count,
        firstTimestamp: event.firstTimestamp,
        lastTimestamp: event.lastTimestamp,
        age: Math.floor((new Date() - new Date(event.lastTimestamp)) / 1000)
      }));

      // Sort by lastTimestamp descending (newest first)
      events.sort((a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp));

      // Pagination
      const total = events.length;
      const start = (page - 1) * limit;
      const paginatedEvents = events.slice(start, start + limit);

      const result = {
        events: paginatedEvents,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };

      setCache(cacheKey, result, CACHE_TTL.events);
      res.set('X-Cache', 'MISS');
      res.json(result);
    } catch (error) {
      res.json({ events: [], pagination: { page, limit, total: 0, pages: 0 } });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const fetchNodesWithKubectl = () => {
  try {
    const output = execFileSync('kubectl', kctl('get', 'nodes', '-o', 'json'), {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000
    });
    const data = JSON.parse(output);
    return data.items || [];
  } catch (error) {
    console.error(`Error fetching nodes with kubectl: ${error.message}`);
    return [];
  }
};

function formatNode(item) {
  const conditions = item.status?.conditions || [];
  const readyCondition = conditions.find(c => c.type === 'Ready');
  const isReady = readyCondition?.status === 'True';

  const labels = item.metadata?.labels || {};
  const roles = Object.keys(labels)
    .filter(key => key.startsWith('node-role.kubernetes.io/'))
    .map(key => key.replace('node-role.kubernetes.io/', ''))
    .filter(Boolean);

  const addresses = item.status?.addresses || [];
  const internalIp = addresses.find(a => a.type === 'InternalIP')?.address || '-';
  const externalIp = addresses.find(a => a.type === 'ExternalIP')?.address || '-';

  const taints = item.spec?.taints || [];

  return {
    name: item.metadata.name,
    status: isReady ? 'Ready' : 'NotReady',
    roles: roles.length > 0 ? roles.join(', ') : 'worker',
    version: item.status?.nodeInfo?.kubeletVersion || '-',
    os: item.status?.nodeInfo?.osImage || '-',
    kernelVersion: item.status?.nodeInfo?.kernelVersion || '-',
    containerRuntime: item.status?.nodeInfo?.containerRuntimeVersion || '-',
    internalIp,
    externalIp,
    cpuCapacity: item.status?.capacity?.cpu || '-',
    memoryCapacity: item.status?.capacity?.memory || '-',
    cpuAllocatable: item.status?.allocatable?.cpu || '-',
    memoryAllocatable: item.status?.allocatable?.memory || '-',
    createdAt: item.metadata.creationTimestamp,
    unschedulable: !!item.spec?.unschedulable,
    taints: taints.length
  };
}

app.get('/api/nodes', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = 'nodes';
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const kubectlNodes = fetchNodesWithKubectl();
    const nodes = kubectlNodes.map(formatNode);
    const result = { nodes };

    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const fetchPodsForNodeWithKubectl = (nodeName) => {
  try {
    const output = execFileSync(
      'kubectl',
      ['get', 'pods', '--all-namespaces', `--field-selector=spec.nodeName=${nodeName}`, '-o', 'json'],
      {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 5000
      }
    );
    const data = JSON.parse(output);
    return data.items || [];
  } catch (error) {
    console.error(`Error fetching pods for node with kubectl: ${error.message}`);
    return [];
  }
};

function formatPodForNode(item) {
  const containerStatuses = item.status?.containerStatuses || [];
  const readyCount = containerStatuses.filter(c => c.ready).length;
  const restarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);

  return {
    name: item.metadata.name,
    namespace: item.metadata.namespace,
    status: item.status?.phase || 'Unknown',
    ready: `${readyCount}/${containerStatuses.length}`,
    restarts,
    createdAt: item.metadata.creationTimestamp
  };
}

app.get('/api/nodes/:name/pods', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { name } = req.params;
    const cacheKey = getCacheKey('node-pods', { name });

    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const kubectlPods = fetchPodsForNodeWithKubectl(name);
    const pods = kubectlPods.map(formatPodForNode);
    const result = { pods };

    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ------------------------------------------------------------------
// Helm — read release storage directly via the Kubernetes API.
//
// Helm has no official JS SDK, but it persists each release revision as a
// Secret of type `helm.sh/release.v1` (labeled `owner=helm`) in the release's
// namespace. The `data.release` field is base64(gzip(json)) — and Kubernetes
// base64-encodes Secret data on top of that. Decoding it gives us everything
// `helm list` / `helm get values` / `helm get manifest` would return, with no
// CLI dependency.
// ------------------------------------------------------------------
const HELM_RELEASE_MAGIC_GZIP = [0x1f, 0x8b, 0x08];

// Decode a Helm release Secret into the stored release object.
const decodeHelmRelease = (secret) => {
  const encoded = secret?.data?.release;
  if (!encoded) return null;
  try {
    // Layer 1: Kubernetes returns Secret data base64-encoded → the Helm blob.
    let buf = Buffer.from(encoded, 'base64');
    // Layer 2: Helm itself base64-encodes gzip(json).
    buf = Buffer.from(buf.toString('utf-8'), 'base64');
    // Helm gzips by default (magic 0x1f 0x8b 0x08); older/plain blobs are raw JSON.
    if (buf.length >= 3 &&
        buf[0] === HELM_RELEASE_MAGIC_GZIP[0] &&
        buf[1] === HELM_RELEASE_MAGIC_GZIP[1] &&
        buf[2] === HELM_RELEASE_MAGIC_GZIP[2]) {
      buf = zlib.gunzipSync(buf);
    }
    return JSON.parse(buf.toString('utf-8'));
  } catch (error) {
    console.error(`Error decoding helm release ${secret?.metadata?.name}: ${error.message}`);
    return null;
  }
};

// List all Helm release Secrets, optionally scoped to a namespace.
const listHelmReleaseSecrets = async (namespace) => {
  const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
  const labelSelector = 'owner=helm';
  const resp = namespace
    ? await core.listNamespacedSecret({ namespace, labelSelector })
    : await core.listSecretForAllNamespaces({ labelSelector });
  return resp.items || [];
};

// Decode + keep only the latest revision per (namespace, name).
const latestHelmReleases = (secrets) => {
  const latest = new Map();
  for (const secret of secrets) {
    const rel = decodeHelmRelease(secret);
    if (!rel) continue;
    const key = `${rel.namespace}/${rel.name}`;
    const prev = latest.get(key);
    if (!prev || (rel.version || 0) > (prev.version || 0)) {
      latest.set(key, rel);
    }
  }
  return [...latest.values()];
};

// Find the latest revision of one named release (for values/manifest lookups).
const getLatestHelmRelease = async (namespace, name) => {
  const secrets = await listHelmReleaseSecrets(namespace);
  const releases = latestHelmReleases(secrets).filter(r => r.name === name);
  return releases[0] || null;
};

app.get('/api/helm/releases', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = 'helm-releases';
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const secrets = await listHelmReleaseSecrets();
    const releases = latestHelmReleases(secrets);

    const result = {
      releases: releases.map(r => {
        const chartMeta = r.chart?.metadata || {};
        return {
          name: r.name,
          namespace: r.namespace,
          revision: String(r.version ?? ''),
          updated: r.info?.last_deployed || r.info?.first_deployed || '',
          status: r.info?.status || '',
          chart: chartMeta.name ? `${chartMeta.name}-${chartMeta.version}` : '',
          appVersion: chartMeta.appVersion || ''
        };
      })
    };

    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: `Failed to list helm releases: ${error.message}` });
  }
});

app.get('/api/helm/releases/:namespace/:name/values', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, name } = req.params;
    const release = await getLatestHelmRelease(namespace, name);
    if (!release) return res.status(404).json({ error: `Release ${name} not found in ${namespace}` });

    // `helm get values` returns the user-supplied values (release.config).
    const values = release.config || {};
    const output = Object.keys(values).length ? yaml.dump(values) : '{}\n';
    res.json({ yaml: output });
  } catch (error) {
    res.status(500).json({ error: `Failed to get values: ${error.message}` });
  }
});

app.get('/api/helm/releases/:namespace/:name/manifest', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace, name } = req.params;
    const release = await getLatestHelmRelease(namespace, name);
    if (!release) return res.status(404).json({ error: `Release ${name} not found in ${namespace}` });

    res.json({ yaml: release.manifest || '' });
  } catch (error) {
    res.status(500).json({ error: `Failed to get manifest: ${error.message}` });
  }
});

// ---------------------------------------------------------------------------
// Helm chart search & install
//
// The reads above decode Helm's release Secrets straight from the Kubernetes
// API, with no helm binary. Installing a chart needs Helm's templating engine,
// so the install path shells out to `helm` — resolved from the app-bundled
// bin/ first (scripts/fetch-helm.mjs), then PATH. Search is pure HTTPS to
// Artifact Hub (see lib/artifacthub.mjs) and needs no binary at all.
// ---------------------------------------------------------------------------
const HELM_NAME = process.platform === 'win32' ? 'helm.exe' : 'helm';
let _helmBin = null;
const helmBin = () => {
  if (_helmBin) return _helmBin;
  const candidates = [
    process.env.HELM_BIN,
    path.join(__dirname, 'bin', HELM_NAME),
    process.resourcesPath && path.join(process.resourcesPath, 'bin', HELM_NAME),
  ].filter(Boolean);
  for (const p of candidates) { try { if (fs.existsSync(p)) { _helmBin = p; return _helmBin; } } catch { /* keep looking */ } }
  _helmBin = resolveBinSync('helm'); // fall back to PATH (absolute if found)
  return _helmBin;
};

// helm accepts --kube-context to pin the app's current context, mirroring kctl().
const helmCtx = (...args) => (currentContext ? ['--kube-context', currentContext, ...args] : args);

// DNS-1123-style validation for the release/namespace/repo names we hand to helm.
const isHelmName = (s) => typeof s === 'string' && /^[a-z0-9]([-a-z0-9]{0,251}[a-z0-9])?$/.test(s);
// A chart's own name may include dots (e.g. an OCI path segment); keep it strict but permit them.
const isChartName = (s) => typeof s === 'string' && /^[a-zA-Z0-9._-]{1,253}$/.test(s);
const isVersion = (s) => s === undefined || s === '' || (typeof s === 'string' && /^[a-zA-Z0-9._+-]{1,64}$/.test(s));

// Is helm available (bundled or on PATH)? Reports its version for the UI.
app.get('/api/helm/available', async (req, res) => {
  try {
    const { stdout } = await execFileAsync(helmBin(), ['version', '--short'], { encoding: 'utf-8', timeout: 8000 });
    res.json({ installed: true, version: stdout.trim() });
  } catch {
    res.json({ installed: false, version: null });
  }
});

// Search Artifact Hub for Helm charts.
app.get('/api/helm/charts/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ charts: [] });
  try {
    const charts = await searchCharts(q, { limit: Number(req.query.limit) || 24 });
    res.json({ charts });
  } catch (error) {
    res.status(502).json({ error: `Chart search failed: ${error.message}` });
  }
});

// List available versions for a chart (repo name + chart name from a result).
app.get('/api/helm/charts/versions', async (req, res) => {
  const repo = String(req.query.repo || '').trim();
  const chart = String(req.query.chart || '').trim();
  if (!repo || !chart) return res.status(400).json({ error: 'repo and chart are required' });
  try {
    res.json({ versions: await chartVersions(repo, chart) });
  } catch (error) {
    res.status(502).json({ error: `Version lookup failed: ${error.message}` });
  }
});

// Shared driver for `helm upgrade [--install]`. Installing a fresh release and
// upgrading/downgrading an existing one differ only in a couple of flags:
//   install → `upgrade --install … --create-namespace`
//   upgrade → `upgrade …` (optionally `--reuse-values` to keep current values)
// `verb` is used only in error text ("Install failed" / "Upgrade failed").
async function runHelmDeploy(req, res, { install, verb }) {
  if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
  const { repoName, repoUrl, chart, version, releaseName, namespace = 'default', values, reuseValues } = req.body || {};

  // Validate everything we splice into the helm argv (execFile → no shell, but
  // we still reject malformed names so helm gets clean input).
  if (!isHelmName(repoName)) return res.status(400).json({ error: 'Invalid repository name' });
  if (!isChartName(chart)) return res.status(400).json({ error: 'Invalid chart name' });
  if (!isHelmName(releaseName)) return res.status(400).json({ error: 'Invalid release name (use lowercase letters, digits and dashes)' });
  if (!isHelmName(namespace)) return res.status(400).json({ error: 'Invalid namespace' });
  if (!isVersion(version)) return res.status(400).json({ error: 'Invalid version' });
  try { new URL(repoUrl); } catch { return res.status(400).json({ error: 'Invalid repository URL' }); }
  if (!/^https?:\/\//i.test(repoUrl)) return res.status(400).json({ error: 'Repository URL must be http(s)' });

  const bin = helmBin();
  // Confirm helm is actually runnable before we start mutating repo config.
  try {
    await execFileAsync(bin, ['version', '--short'], { timeout: 8000 });
  } catch {
    return res.status(501).json({ error: 'Helm is not available on the server. Install Helm to enable chart installs.' });
  }

  let valuesFile = null;
  try {
    // 1. Register the repo (idempotent; --force-update refreshes a changed URL).
    await execFileAsync(bin, ['repo', 'add', repoName, repoUrl, '--force-update'], { encoding: 'utf-8', timeout: 60000 });
    // 2. Refresh the repo index so the requested version resolves.
    await execFileAsync(bin, ['repo', 'update', repoName], { encoding: 'utf-8', timeout: 60000 });

    const args = helmCtx('upgrade', ...(install ? ['--install'] : []), releaseName, `${repoName}/${chart}`,
      '--namespace', namespace, ...(install ? ['--create-namespace'] : []));
    if (version) args.push('--version', version);

    // 3. Values handling. If the caller supplied values, validate + pass with -f.
    // Otherwise, a plain `helm upgrade` resets values to chart defaults — so for
    // an upgrade with no new values we reuse the release's current values.
    if (typeof values === 'string' && values.trim() && values.trim() !== '{}') {
      try { yaml.load(values); } catch (e) { return res.status(400).json({ error: `Values are not valid YAML: ${e.message}` }); }
      valuesFile = path.join(os.tmpdir(), `km-helm-values-${randomUUID()}.yaml`);
      fs.writeFileSync(valuesFile, values, { mode: 0o600 });
      args.push('-f', valuesFile);
    } else if (!install && reuseValues) {
      args.push('--reuse-values');
    }

    const { stdout } = await execFileAsync(bin, args, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, timeout: 300000 });
    cache.delete('helm-releases'); // surface the change on the next list.
    res.json({ ok: true, output: stdout, release: releaseName, namespace });
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim();
    res.status(500).json({ error: `${verb} failed: ${detail}` });
  } finally {
    if (valuesFile) { try { fs.unlinkSync(valuesFile); } catch { /* best effort */ } }
  }
}

// Install a chart into the current cluster (creates the namespace if missing).
app.post('/api/helm/install', (req, res) => runHelmDeploy(req, res, { install: true, verb: 'Install' }));

// Upgrade or downgrade an existing release to a different chart version and/or
// values. Same chart/repo, new --version; values are reused unless overridden.
app.post('/api/helm/upgrade', (req, res) => runHelmDeploy(req, res, { install: false, verb: 'Upgrade' }));

const CRD_JSONPATH = '{range .items[*]}{.metadata.name}{"\\t"}{.spec.group}{"\\t"}{.spec.names.kind}{"\\t"}{.spec.names.plural}{"\\t"}{.spec.names.singular}{"\\t"}{.spec.scope}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.spec.versions[?(@.storage==true)].name}{"\\n"}{end}';

const fetchCrdsWithKubectl = async () => {
  try {
    // execFile (no shell) + async so we never block the event loop
    const { stdout: output } = await execFileAsync(
      'kubectl',
      kctl('get', 'crds', '-o', `jsonpath=${CRD_JSONPATH}`),
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 15000 }
    );
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, group, kind, plural, singular, scope, createdAt, version] = line.split('\t');
        return { name, group, kind, plural, singular, scope, createdAt, version: version || '-' };
      });
  } catch (error) {
    console.error(`Error fetching CRDs: ${error.message}`);
    return [];
  }
};

app.get('/api/customresources', async (req, res) => {
  try {
    const cacheKey = 'crds';
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const crds = await fetchCrdsWithKubectl();
    const result = { crds };

    setCache(cacheKey, result, CACHE_TTL.namespaces);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/customresources/:group/:version/:plural', async (req, res) => {
  try {
    const { group, version, plural } = req.params;
    const cacheKey = getCacheKey('cr-instances', { group, version, plural });

    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    // execFile (no shell) + async so a slow/large CR list never blocks the event loop
    const { stdout: output } = await execFileAsync(
      'kubectl',
      kctl('get', `${plural}.${version}.${group}`, '-A', '-o', 'json'),
      { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024, timeout: 20000 }
    );
    const data = JSON.parse(output);
    const items = (data.items || []).map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || '-',
      createdAt: item.metadata.creationTimestamp
    }));

    const result = { items };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, items: [] });
  }
});

// Full YAML for a single custom-resource instance
app.get('/api/customresource/:group/:version/:plural/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { group, version, plural, name } = req.params;
    const namespace = req.query.namespace;

    const args = kctl('get', `${plural}.${version}.${group}`, name);
    if (namespace && namespace !== '-') args.push('-n', namespace);
    args.push('-o', 'yaml');

    // async execFile (no shell) so a single-resource fetch never blocks the event loop
    const { stdout } = await execFileAsync('kubectl', args, {
      encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 15000
    });
    res.json({ yaml: stdout || '' });
  } catch (error) {
    const msg = (error.stderr || error.message || 'Failed to get resource').trim();
    res.status(500).json({ error: msg });
  }
});

// ------------------------------------------------------------------
// ArgoCD (GitOps). Detected via the applications.argoproj.io CRD; if present the
// UI shows an ArgoCD view. Applications are plain CRs, so we read them with
// kubectl (context-aware) and parse the sync/health/source/destination fields.
// ------------------------------------------------------------------
const argoSource = (spec) => spec.source || (Array.isArray(spec.sources) ? spec.sources[0] : {}) || {};
const parseArgoApp = (a) => {
  const spec = a.spec || {}, st = a.status || {};
  const src = argoSource(spec);
  return {
    name: a.metadata?.name,
    namespace: a.metadata?.namespace,
    project: spec.project || 'default',
    syncStatus: st.sync?.status || 'Unknown',
    healthStatus: st.health?.status || 'Unknown',
    healthMessage: st.health?.message || '',
    repoURL: src.repoURL || '',
    path: src.path || src.chart || '',
    targetRevision: src.targetRevision || '',
    revision: (st.sync?.revision || '').slice(0, 7),
    multiSource: Array.isArray(spec.sources) && spec.sources.length > 1,
    destName: spec.destination?.name || '',
    destServer: spec.destination?.server || '',
    destNamespace: spec.destination?.namespace || '',
    resourceCount: (st.resources || []).length,
    operationPhase: st.operationState?.phase || '',
    autoSync: !!spec.syncPolicy?.automated,
    createdAt: a.metadata?.creationTimestamp,
    // extras for the properties panel + dashboard "recent activity"
    reconciledAt: st.reconciledAt || '',
    images: st.summary?.images || [],
    finalizers: a.metadata?.finalizers || [],
    controlledBy: (a.metadata?.ownerReferences || []).find(o => o.kind === 'ApplicationSet')?.name || '',
    lastOperation: st.operationState
      ? { phase: st.operationState.phase || '', message: st.operationState.message || '', finishedAt: st.operationState.finishedAt || st.operationState.startedAt || '' }
      : null,
  };
};

// ------------------------------------------------------------------
// Security Center — surfaces the Trivy Operator's report CRDs (image CVEs,
// config-audit / best-practice checks, and RBAC risk assessment). The operator
// (github.com/aquasecurity/trivy-operator) does the scanning in-cluster; we just
// read and aggregate its reports, so there's nothing extra to install app-side.
// ------------------------------------------------------------------
const TRIVY_GROUP = 'aquasecurity.github.io';
const TRIVY_VER = 'v1alpha1';
const co = () => kubeConfig.makeApiClient(k8s.CustomObjectsApi);

const listTrivy = async (plural, { cluster = false } = {}) => {
  try {
    // client-node 2.0 names the param `plural` on the cluster call but
    // `resourcePlural` on the all-namespaces one.
    const res = cluster
      ? await co().listClusterCustomObject({ group: TRIVY_GROUP, version: TRIVY_VER, plural })
      : await co().listCustomObjectForAllNamespaces({ group: TRIVY_GROUP, version: TRIVY_VER, resourcePlural: plural });
    return res.items || [];
  } catch (e) {
    if (e?.code === 404 || e?.statusCode === 404) return null; // CRD not installed
    throw e;
  }
};

// Trivy labels the report with the scanned resource it belongs to.
const trivyOwner = (r) => {
  const l = r.metadata?.labels || {};
  return {
    kind: l['trivy-operator.resource.kind'] || r.metadata?.ownerReferences?.[0]?.kind || '',
    name: l['trivy-operator.resource.name'] || r.metadata?.ownerReferences?.[0]?.name || r.metadata?.name || '',
    namespace: r.metadata?.namespace || '',
    container: l['trivy-operator.container.name'] || '',
  };
};
const sev = (s) => (s || 'UNKNOWN').toUpperCase();
const emptySummary = () => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
const sevTotalOf = (s = {}) => (s.CRITICAL || 0) + (s.HIGH || 0) + (s.MEDIUM || 0) + (s.LOW || 0) + (s.UNKNOWN || 0);
const addSummary = (into, s = {}) => {
  into.CRITICAL += s.criticalCount || 0; into.HIGH += s.highCount || 0;
  into.MEDIUM += s.mediumCount || 0; into.LOW += s.lowCount || 0; into.UNKNOWN += s.unknownCount || s.noneCount || 0;
  return into;
};

app.get('/api/security/status', async (req, res) => {
  if (!kubeConfig) return res.json({ installed: false });
  try {
    const api = kubeConfig.makeApiClient(k8s.ApiextensionsV1Api);
    const { items } = await api.listCustomResourceDefinition();
    const names = new Set(items.map((c) => c.metadata?.name));
    const has = (n) => names.has(`${n}.${TRIVY_GROUP}`);
    const installed = [...names].some((n) => n?.endsWith(`.${TRIVY_GROUP}`));
    res.json({
      installed,
      reports: {
        vulnerability: has('vulnerabilityreports'),
        configAudit: has('configauditreports'),
        rbac: has('rbacassessmentreports') || has('clusterrbacassessmentreports'),
        exposedSecret: has('exposedsecretreports'),
      },
      // When the official operator is absent, look for a *different* Trivy
      // operator (e.g. devopstales/trivy-operator, group trivy-operator.
      // devopstales.io) so the UI can explain the mismatch instead of just
      // saying "not installed" when the user clearly did install one.
      foreignOperator: installed ? null : detectForeignTrivy(names, TRIVY_GROUP),
    });
  } catch (e) {
    res.json({ installed: false, error: firstLine(e.message) });
  }
});

// Image vulnerability reports → grouped by image, with severity + CVE detail.
app.get('/api/security/vulnerabilities', async (req, res) => {
  try {
    const items = await listTrivy('vulnerabilityreports');
    if (items === null) return res.json({ installed: false, images: [], summary: emptySummary() });
    const ns = req.query.namespace && req.query.namespace !== 'all' ? req.query.namespace : null;
    const total = emptySummary();
    const byImage = new Map();
    for (const r of items) {
      const owner = trivyOwner(r);
      if (ns && owner.namespace !== ns) continue;
      const rep = r.report || {};
      const art = rep.artifact || {};
      const reg = rep.registry?.server || '';
      const image = `${reg ? reg + '/' : ''}${art.repository || '?'}${art.tag ? ':' + art.tag : (art.digest ? '@' + String(art.digest).slice(0, 19) : '')}`;
      addSummary(total, rep.summary);
      const scannedAt = rep.updateTimestamp || r.metadata?.creationTimestamp || '';
      if (!byImage.has(image)) byImage.set(image, {
        image, repository: art.repository || '', tag: art.tag || '',
        digest: art.digest || '', registry: reg,
        os: `${rep.os?.family || ''} ${rep.os?.name || ''}`.trim(),
        namespace: owner.namespace, status: 'Scanned',
        scanner: [rep.scanner?.name, rep.scanner?.version].filter(Boolean).join(' '),
        scannedAt, summary: emptySummary(), workloads: [], vulnerabilities: [], secrets: 0, _seen: new Set(),
      });
      const g = byImage.get(image);
      if (scannedAt > g.scannedAt) g.scannedAt = scannedAt;
      addSummary(g.summary, rep.summary);
      g.workloads.push({ kind: owner.kind, name: owner.name, namespace: owner.namespace, container: owner.container });
      for (const v of (rep.vulnerabilities || [])) {
        const key = v.vulnerabilityID + '|' + v.resource + '|' + v.installedVersion;
        if (g._seen.has(key)) continue; g._seen.add(key);
        g.vulnerabilities.push({
          id: v.vulnerabilityID, severity: sev(v.severity), pkg: v.resource || '',
          installedVersion: v.installedVersion || '', fixedVersion: v.fixedVersion || '',
          title: v.title || '', link: v.primaryLink || (v.links || [])[0] || '', score: v.score,
        });
      }
    }
    // Merge exposed-secret counts (a separate Trivy Operator report) by image.
    const secretItems = await listTrivy('exposedsecretreports');
    for (const r of (secretItems || [])) {
      const owner = trivyOwner(r);
      if (ns && owner.namespace !== ns) continue;
      const rep = r.report || {};
      const art = rep.artifact || {};
      const reg = rep.registry?.server || '';
      const image = `${reg ? reg + '/' : ''}${art.repository || '?'}${art.tag ? ':' + art.tag : (art.digest ? '@' + String(art.digest).slice(0, 19) : '')}`;
      const g = byImage.get(image);
      if (g) g.secrets = (g.secrets || 0) + (rep.summary ? sevTotalOf({ CRITICAL: rep.summary.criticalCount, HIGH: rep.summary.highCount, MEDIUM: rep.summary.mediumCount, LOW: rep.summary.lowCount }) : (rep.secrets || []).length);
    }

    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };
    const images = [...byImage.values()].map((g) => {
      delete g._seen;
      g.platform = g.platform || g.os;
      g.criticalCount = g.summary.CRITICAL;
      g.vulnerabilities.sort((a, b) => order[a.severity] - order[b.severity] || (b.score || 0) - (a.score || 0));
      return g;
    }).sort((a, b) => (b.summary.CRITICAL - a.summary.CRITICAL) || (b.summary.HIGH - a.summary.HIGH));
    // Results donut: images with any finding vs clean.
    const vulnerable = images.filter((g) => sevTotalOf(g.summary) > 0).length;
    const results = { vulnerable, ok: images.length - vulnerable };
    // Status donut: scanned vs not-scanned (best-effort pod count for the total).
    const scanned = images.length;
    let podCount = null;
    try {
      const pods = await kubeConfig.makeApiClient(k8s.CoreV1Api).listPodForAllNamespaces({ limit: 5000 });
      podCount = (pods.items || []).length;
    } catch { /* best-effort */ }
    res.json({
      installed: true, images, summary: total, reportCount: items.length,
      results, scanned, notScanned: podCount != null ? Math.max(0, podCount - scanned) : null,
    });
  } catch (e) {
    res.status(500).json({ error: firstLine(e.message) });
  }
});

// Config-audit (resource best-practice) + RBAC assessment reports. `kind` picks
// which: 'config' (configauditreports) or 'rbac' (rbac + cluster rbac).
app.get('/api/security/checks', async (req, res) => {
  try {
    const which = req.query.kind === 'rbac' ? 'rbac' : 'config';
    let items;
    if (which === 'config') {
      items = await listTrivy('configauditreports');
      if (items === null) return res.json({ installed: false, resources: [], summary: emptySummary() });
    } else {
      const nsR = await listTrivy('rbacassessmentreports');
      const clR = await listTrivy('clusterrbacassessmentreports', { cluster: true });
      if (nsR === null && clR === null) return res.json({ installed: false, resources: [], summary: emptySummary() });
      items = [...(nsR || []), ...(clR || [])];
    }
    const ns = req.query.namespace && req.query.namespace !== 'all' ? req.query.namespace : null;
    const total = emptySummary();
    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };
    const resources = [];
    for (const r of items) {
      const owner = trivyOwner(r);
      if (ns && owner.namespace && owner.namespace !== ns) continue;
      const rep = r.report || {};
      addSummary(total, rep.summary);
      const failed = (rep.checks || []).filter((c) => c.success === false).map((c) => ({
        id: c.checkID || c.id || '', title: c.title || '', severity: sev(c.severity),
        category: c.category || '', message: (c.messages || [])[0] || c.description || '', remediation: c.remediation || '',
      })).sort((a, b) => order[a.severity] - order[b.severity]);
      if (!failed.length) continue;
      resources.push({
        kind: owner.kind || 'Cluster', name: owner.name, namespace: owner.namespace,
        createdAt: r.metadata?.creationTimestamp || '',
        scannedAt: rep.updateTimestamp || r.metadata?.creationTimestamp || '',
        scanner: [rep.scanner?.name, rep.scanner?.version].filter(Boolean).join(' '),
        labels: Object.keys(r.metadata?.labels || {}).length,
        summary: rep.summary && {
          CRITICAL: rep.summary.criticalCount || 0, HIGH: rep.summary.highCount || 0, MEDIUM: rep.summary.mediumCount || 0, LOW: rep.summary.lowCount || 0, UNKNOWN: 0,
        } || emptySummary(),
        checks: failed,
      });
    }
    resources.sort((a, b) => (b.summary.CRITICAL - a.summary.CRITICAL) || (b.summary.HIGH - a.summary.HIGH));
    res.json({ installed: true, resources, summary: total, reportCount: items.length });
  } catch (e) {
    res.status(500).json({ error: firstLine(e.message) });
  }
});

// ---- Built-in image scanning (bundled Trivy, no in-cluster operator) ----
const scanResultShape = () => {
  const s = trivyScan.scanState;
  return {
    running: s.running, done: s.done, phase: s.phase, total: s.total, scanned: s.scanned,
    startedAt: s.startedAt, finishedAt: s.finishedAt, error: s.error,
    installed: !!s.images, images: s.images || [], summary: s.summary,
    results: s.results, scanned: s.scanned,
    notScanned: s.total ? Math.max(0, s.total - s.scanned) : null,
    source: 'trivy-builtin',
  };
};

app.get('/api/security/scan/status', async (req, res) => {
  const t = await trivyScan.trivyAvailable();
  const s = trivyScan.scanState;
  const hasResult = (s.context === currentContext && !!s.images) || !!trivyScan.loadScan(currentContext);
  res.json({ ...t, running: s.running, done: s.done, hasResult });
});

app.post('/api/security/scan', async (req, res) => {
  if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
  const t = await trivyScan.trivyAvailable();
  if (!t.available && !t.installable) return res.status(400).json({ error: 'trivy is not available and cannot be auto-installed on this platform.' });
  if (trivyScan.scanState.running) return res.json({ started: false, ...scanResultShape() });
  try {
    const pods = await kubeConfig.makeApiClient(k8s.CoreV1Api).listPodForAllNamespaces({ limit: 5000 });
    const byImage = trivyScan.listClusterImages(pods.items || [], req.body?.namespace);
    await trivyScan.startScan(byImage, currentContext);
    res.json({ started: true, ...scanResultShape() });
  } catch (e) {
    res.status(500).json({ error: firstLine(e.message) });
  }
});

app.get('/api/security/scan', (req, res) => {
  const s = trivyScan.scanState;
  // Live/in-memory scan for the current context wins; otherwise fall back to the
  // persisted result for this cluster (survives an app restart / context switch).
  if (s.context === currentContext && (s.images || s.running)) return res.json(scanResultShape());
  const cached = trivyScan.loadScan(currentContext);
  if (cached && cached.images?.length) {
    return res.json({
      installed: true, running: false, done: true, phase: 'done', cached: true, source: 'trivy-builtin',
      images: cached.images, summary: cached.summary, results: cached.results,
      scanned: cached.scanned, total: cached.total, notScanned: null, finishedAt: cached.finishedAt,
    });
  }
  res.json(scanResultShape());
});

// Applications that aren't fully Synced+Healthy — the "Needs attention" panel.
const needsAttention = (a) => a.syncStatus !== 'Synced' || (a.healthStatus !== 'Healthy' && a.healthStatus !== 'Unknown');

// Is ArgoCD installed on the current cluster? (cached briefly)
app.get('/api/argocd/status', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-status', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    let installed = false;
    try {
      const { stdout } = await execFileAsync('kubectl', kctl('get', 'crd', 'applications.argoproj.io', '-o', 'name'),
        { encoding: 'utf-8', timeout: 12000 });
      installed = stdout.trim().length > 0;
    } catch { installed = false; }
    // Best-effort: the external Argo CD UI URL (from the argocd-cm configmap).
    let url = '';
    if (installed) {
      try {
        const { stdout } = await execFileAsync('kubectl', kctl('get', 'configmap', 'argocd-cm', '-n', 'argocd', '-o', 'jsonpath={.data.url}'),
          { encoding: 'utf-8', timeout: 8000 });
        url = (stdout || '').trim();
      } catch { /* no argocd-cm / different namespace — button just hidden */ }
    }
    const result = { installed, url };
    setCache(cacheKey, result, CACHE_TTL.namespaces);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all ArgoCD Applications (parsed summary)
app.get('/api/argocd/applications', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-apps', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    const { stdout } = await execFileAsync('kubectl', kctl('get', 'applications.argoproj.io', '-A', '-o', 'json'),
      { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: 25000 });
    const items = (JSON.parse(stdout).items || []).map(parseArgoApp);
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const result = { applications: items };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error.stderr || error.message || 'Failed to list applications').trim(), applications: [] });
  }
});

// Best-effort health for a live child resource (Argo CD computes these too).
function liveChildHealth(kind, item) {
  if (kind === 'Pod') {
    const phase = item.status?.phase;
    if (phase === 'Succeeded') return { status: 'Healthy' };
    if (phase === 'Failed') return { status: 'Degraded', message: item.status?.reason || '' };
    const cs = item.status?.containerStatuses || [];
    const bad = cs.map(c => c.state?.waiting?.reason).find(r => /CrashLoopBackOff|Error|ImagePullBackOff|ErrImagePull|CreateContainerError|RunContainerError/.test(r || ''));
    if (bad) return { status: 'Degraded', message: bad };
    const ready = (item.status?.conditions || []).find(c => c.type === 'Ready')?.status === 'True';
    if (phase === 'Running' && ready) return { status: 'Healthy' };
    return { status: 'Progressing' };
  }
  if (kind === 'ReplicaSet') {
    const desired = item.spec?.replicas || 0, ready = item.status?.readyReplicas || 0;
    return { status: ready >= desired ? 'Healthy' : 'Progressing' };
  }
  if (kind === 'Job') {
    if (item.status?.succeeded) return { status: 'Healthy' };
    if (item.status?.failed) return { status: 'Degraded' };
    return { status: 'Progressing' };
  }
  return { status: 'Healthy' };
}

// One Application in full (summary + managed resources + conditions + last op)
app.get('/api/argocd/application/:namespace/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, name } = req.params;
    const { stdout } = await execFileAsync('kubectl',
      kctl('get', 'applications.argoproj.io', name, '-n', namespace, '-o', 'json'),
      { encoding: 'utf-8', maxBuffer: 40 * 1024 * 1024, timeout: 15000 });
    const a = JSON.parse(stdout);
    const spec = a.spec || {}, st = a.status || {};
    const keyOf = (kind, ns, nm) => `${kind}|${ns || ''}|${nm}`;
    const resources = (st.resources || []).map(r => ({
      group: r.group || '', version: r.version || '', kind: r.kind,
      namespace: r.namespace || '', name: r.name,
      syncStatus: r.status || 'Unknown',
      healthStatus: r.health?.status || '',
      healthMessage: r.health?.message || '',
      parentKey: null, managed: true, createdAt: '',
    }));

    // ---- augment with live descendants (Deployment→RS→Pod, Service→EndpointSlice,
    // CronJob→Job→Pod) by walking ownerReferences, so the tree matches Argo CD ----
    try {
      const nsSet = new Set(resources.map(r => r.namespace).filter(Boolean));
      if (spec.destination?.namespace) nsSet.add(spec.destination.namespace);
      const namespaces = [...nsSet].slice(0, 12);
      const kindMap = { pods: 'Pod', replicasets: 'ReplicaSet', endpointslices: 'EndpointSlice', jobs: 'Job' };
      const live = [];
      await Promise.all(namespaces.flatMap(ns => Object.keys(kindMap).map(async plural => {
        try {
          const { stdout: out } = await execFileAsync('kubectl',
            kctl('get', plural, '-n', ns, '-o', 'json'),
            { encoding: 'utf-8', maxBuffer: 80 * 1024 * 1024, timeout: 15000 });
          for (const it of (JSON.parse(out).items || [])) live.push({ item: it, kind: kindMap[plural], ns });
        } catch { /* best-effort per kind/namespace (RBAC etc.) */ }
      })));

      const nodeByKey = new Map();
      resources.forEach(r => nodeByKey.set(keyOf(r.kind, r.namespace, r.name), r));
      const remaining = live.slice();
      let added = true, pass = 0;
      while (added && pass < 5) {
        added = false; pass++;
        for (let i = remaining.length - 1; i >= 0; i--) {
          const { item, kind, ns } = remaining[i];
          const nm = item.metadata?.name;
          if (!nm) { remaining.splice(i, 1); continue; }
          const key = keyOf(kind, ns, nm);
          if (nodeByKey.has(key)) { remaining.splice(i, 1); continue; }
          if (kind === 'ReplicaSet' && !(item.spec?.replicas || item.status?.replicas)) { remaining.splice(i, 1); continue; } // drop scaled-down history
          let parentKey = null;
          for (const o of (item.metadata?.ownerReferences || [])) {
            const k = keyOf(o.kind, ns, o.name);
            if (nodeByKey.has(k)) { parentKey = k; break; }
          }
          if (!parentKey && kind === 'EndpointSlice') {
            const svc = item.metadata?.labels?.['kubernetes.io/service-name'];
            if (svc && nodeByKey.has(keyOf('Service', ns, svc))) parentKey = keyOf('Service', ns, svc);
          }
          if (!parentKey) continue;
          const h = liveChildHealth(kind, item);
          const node = {
            group: (item.apiVersion || '').includes('/') ? item.apiVersion.split('/')[0] : '',
            version: '', kind, namespace: ns, name: nm,
            syncStatus: '', healthStatus: h.status, healthMessage: h.message || '',
            parentKey, managed: false, createdAt: item.metadata?.creationTimestamp || '',
          };
          nodeByKey.set(key, node); resources.push(node); remaining.splice(i, 1); added = true;
        }
      }
    } catch { /* live-tree augmentation is best-effort */ }
    // events on the Application object (sync started/completed, health changes, …)
    let events = [];
    try {
      const { stdout: ev } = await execFileAsync('kubectl',
        kctl('get', 'events', '-n', namespace, '--field-selector', `involvedObject.name=${name},involvedObject.kind=Application`, '-o', 'json'),
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 10000 });
      events = (JSON.parse(ev).items || [])
        .map(e => ({ type: e.type, reason: e.reason, message: e.message, count: e.count, lastTimestamp: e.lastTimestamp || e.eventTime }))
        .sort((x, y) => new Date(y.lastTimestamp) - new Date(x.lastTimestamp))
        .slice(0, 20);
    } catch { /* events are best-effort */ }
    res.json({
      app: parseArgoApp(a),
      sources: spec.sources || (spec.source ? [spec.source] : []),
      destination: spec.destination || {},
      syncPolicy: spec.syncPolicy || {},
      resources,
      conditions: st.conditions || [],
      operationState: st.operationState
        ? { phase: st.operationState.phase, message: st.operationState.message, startedAt: st.operationState.startedAt, finishedAt: st.operationState.finishedAt, revision: (st.operationState.syncResult?.revision || '').slice(0, 7) }
        : null,
      history: (st.history || []).map(h => ({ id: h.id, revision: h.revision, deployedAt: h.deployedAt })).reverse(),
      events,
    });
  } catch (error) {
    res.status(500).json({ error: (error.stderr || error.message || 'Failed to get application').trim() });
  }
});

// Trigger a sync of an Application. Body accepts options:
// { prune, dryRun, applyOnly, force, replace, revision }
app.post('/api/argocd/application/:namespace/:name/sync', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, name } = req.params;
    const o = req.body || {};
    const sync = {};
    if (o.prune) sync.prune = true;
    if (o.dryRun) sync.dryRun = true;
    if (o.revision) sync.revision = String(o.revision);
    const syncOptions = [];
    if (o.applyOnly) syncOptions.push('ApplyOutOfSyncOnly=true');
    if (o.replace) syncOptions.push('Replace=true');
    if (o.force) syncOptions.push('Force=true');
    if (syncOptions.length) sync.syncOptions = syncOptions;
    const patch = JSON.stringify({ operation: { initiatedBy: { username: 'k8sight' }, sync } });
    const out = await runKubectl(['patch', 'applications.argoproj.io', name, '-n', namespace, '--type', 'merge', '-p', patch]);
    cache.clear();
    res.json({ success: true, message: out || 'Sync triggered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an Application. ?cascade=false removes the argocd finalizer first so
// the managed resources are left in place (orphan); default cascades.
app.delete('/api/argocd/application/:namespace/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, name } = req.params;
    const cascade = req.query.cascade !== 'false';
    if (!cascade) {
      // drop the finalizer so deletion doesn't cascade to the managed resources
      await runKubectl(['patch', 'applications.argoproj.io', name, '-n', namespace, '--type', 'merge', '-p', JSON.stringify({ metadata: { finalizers: null } })]);
    }
    const out = await runKubectl(['delete', 'applications.argoproj.io', name, '-n', namespace]);
    cache.clear();
    res.json({ success: true, message: out || `${name} deleted` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List AppProjects
app.get('/api/argocd/projects', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-projects', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    const { stdout } = await execFileAsync('kubectl', kctl('get', 'appprojects.argoproj.io', '-A', '-o', 'json'),
      { encoding: 'utf-8', maxBuffer: 40 * 1024 * 1024, timeout: 20000 });
    const projects = (JSON.parse(stdout).items || []).map(p => {
      const s = p.spec || {};
      return {
        name: p.metadata?.name, namespace: p.metadata?.namespace,
        description: s.description || '',
        sourceRepos: s.sourceRepos || [],
        destinations: (s.destinations || []).map(d => `${d.server || d.name || '*'}/${d.namespace || '*'}`),
        clusterResourceWhitelist: (s.clusterResourceWhitelist || []).length,
        roles: (s.roles || []).map(r => r.name),
        createdAt: p.metadata?.creationTimestamp,
      };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const result = { projects };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error.stderr || error.message || 'Failed to list projects').trim(), projects: [] });
  }
});

// List ApplicationSets (may be absent — controller not installed)
app.get('/api/argocd/applicationsets', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-appsets', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    let available = true, appSets = [];
    try {
      const { stdout } = await execFileAsync('kubectl', kctl('get', 'applicationsets.argoproj.io', '-A', '-o', 'json'),
        { encoding: 'utf-8', maxBuffer: 40 * 1024 * 1024, timeout: 20000 });
      appSets = (JSON.parse(stdout).items || []).map(as => {
        const s = as.spec || {}, st = as.status || {};
        return {
          name: as.metadata?.name, namespace: as.metadata?.namespace,
          generators: (s.generators || []).map(g => Object.keys(g)[0]).filter(Boolean),
          destinationNamespace: s.template?.spec?.destination?.namespace || '',
          project: s.template?.spec?.project || '',
          conditions: (st.conditions || []).map(c => ({ type: c.type, status: c.status, message: c.message })),
          createdAt: as.metadata?.creationTimestamp,
        };
      }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch (e) {
      if (/NotFound|doesn't have a resource type|the server doesn't have/i.test(e.stderr || e.message || '')) available = false;
      else throw e;
    }
    const result = { available, applicationSets: appSets };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error.stderr || error.message || 'Failed to list application sets').trim(), applicationSets: [] });
  }
});

const b64 = (v) => { try { return Buffer.from(v || '', 'base64').toString('utf-8'); } catch { return ''; } };

// Repositories ArgoCD is wired to. Repos may be stored as secrets, or configured
// inline in Applications — so we merge repo secrets with the distinct repoURLs
// actually referenced by Applications.
app.get('/api/argocd/repositories', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-repos', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    const byUrl = new Map();
    try {
      const { stdout } = await execFileAsync('kubectl', kctl('get', 'secrets', '-A', '-l', 'argocd.argoproj.io/secret-type=repository', '-o', 'json'),
        { encoding: 'utf-8', maxBuffer: 40 * 1024 * 1024, timeout: 15000 });
      for (const s of JSON.parse(stdout).items || []) {
        const d = s.data || {};
        const url = b64(d.url);
        if (url) byUrl.set(url, { url, name: b64(d.name), type: b64(d.type) || 'git', project: b64(d.project) || '', source: 'secret' });
      }
    } catch { /* fall through to app-derived */ }
    // derive from applications
    try {
      const { stdout } = await execFileAsync('kubectl', kctl('get', 'applications.argoproj.io', '-A', '-o', 'json'),
        { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: 25000 });
      for (const a of JSON.parse(stdout).items || []) {
        const spec = a.spec || {};
        const srcs = spec.sources || (spec.source ? [spec.source] : []);
        for (const s of srcs) {
          const url = s.repoURL;
          if (!url) continue;
          if (!byUrl.has(url)) byUrl.set(url, { url, name: '', type: s.chart ? 'helm' : 'git', project: '', source: 'application', appCount: 0 });
          const r = byUrl.get(url); r.appCount = (r.appCount || 0) + 1;
        }
      }
    } catch { /* best-effort */ }
    const repositories = [...byUrl.values()].sort((a, b) => (a.url || '').localeCompare(b.url || ''));
    const result = { repositories };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error.stderr || error.message || 'Failed to list repositories').trim(), repositories: [] });
  }
});

// Clusters ArgoCD manages (stored as secrets; plus the implicit in-cluster).
app.get('/api/argocd/clusters', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const cacheKey = getCacheKey('argocd-clusters', { ctx: currentContext });
    const cached = getCache(cacheKey);
    if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
    const clusters = [];
    try {
      const { stdout } = await execFileAsync('kubectl', kctl('get', 'secrets', '-A', '-l', 'argocd.argoproj.io/secret-type=cluster', '-o', 'json'),
        { encoding: 'utf-8', maxBuffer: 40 * 1024 * 1024, timeout: 15000 });
      for (const s of JSON.parse(stdout).items || []) {
        const d = s.data || {};
        clusters.push({ name: b64(d.name), server: b64(d.server) });
      }
    } catch { /* best-effort */ }
    clusters.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const result = { clusters };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error.stderr || error.message || 'Failed to list clusters').trim(), clusters: [] });
  }
});

// Refresh an Application (re-compares against git without syncing)
app.post('/api/argocd/application/:namespace/:name/refresh', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, name } = req.params;
    const hard = req.body?.hard ? 'hard' : 'normal';
    const out = await runKubectl(['annotate', 'applications.argoproj.io', name, '-n', namespace,
      `argocd.argoproj.io/refresh=${hard}`, '--overwrite']);
    cache.clear();
    res.json({ success: true, message: out || 'Refresh requested' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const parseCpuCores = (s) => {
  if (!s || s === '-') return 0;
  if (String(s).endsWith('m')) return parseInt(s) / 1000;
  return parseFloat(s) || 0;
};

// returns bytes
const parseMemBytes = (s) => {
  if (!s || s === '-') return 0;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([KMGTP]i)?$/);
  if (!m) return parseFloat(s) || 0;
  const val = parseFloat(m[1]);
  const unit = m[2];
  const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5 };
  return val * (mult[unit] || 1);
};

app.get('/api/cluster/summary', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const cacheKey = 'cluster-summary';
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    // Kubernetes version — read it in-process via the API server's /version
    // endpoint instead of shelling out to `kubectl version`, which prints a
    // "client/server version skew" warning when the local kubectl binary is more
    // than one minor off the cluster, and needs a matching kubectl at all.
    let serverVersion = 'unknown';
    let platform = '';
    try {
      const info = await kubeConfig.makeApiClient(k8s.VersionApi).getCode();
      serverVersion = info.gitVersion || 'unknown';
      platform = info.platform || '';
    } catch (e) { /* version is best-effort */ }

    // Nodes (reuse existing helpers)
    const nodes = fetchNodesWithKubectl().map(formatNode);
    const nodeSummary = {
      total: nodes.length,
      ready: nodes.filter(n => n.status === 'Ready').length,
      notReady: nodes.filter(n => n.status !== 'Ready').length
    };

    const roles = {};
    let cpuCapacity = 0, cpuAllocatable = 0, memCapacity = 0, memAllocatable = 0;
    const versions = new Set();
    const osImages = new Set();
    for (const n of nodes) {
      String(n.roles || 'worker').split(',').map(r => r.trim()).filter(Boolean).forEach(r => {
        roles[r] = (roles[r] || 0) + 1;
      });
      cpuCapacity += parseCpuCores(n.cpuCapacity);
      cpuAllocatable += parseCpuCores(n.cpuAllocatable);
      memCapacity += parseMemBytes(n.memoryCapacity);
      memAllocatable += parseMemBytes(n.memoryAllocatable);
      if (n.version) versions.add(n.version);
      if (n.os) osImages.add(n.os);
    }

    // Pod phases
    const podPhases = { Running: 0, Pending: 0, Succeeded: 0, Failed: 0, Unknown: 0 };
    let podTotal = 0;
    try {
      const out = execFileSync(
        'kubectl',
        kctl('get', 'pods', '-A', '-o', 'jsonpath={range .items[*]}{.status.phase}{"\\n"}{end}'),
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 12000 }
      );
      out.split('\n').filter(Boolean).forEach(p => {
        podPhases[p] = (podPhases[p] || 0) + 1;
        podTotal++;
      });
    } catch (e) { /* ignore */ }

    // Namespace count
    let namespaceCount = 0;
    try {
      const out = execFileSync(
        'kubectl',
        kctl('get', 'ns', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}'),
        { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024, timeout: 8000 }
      );
      namespaceCount = out.split('\n').filter(Boolean).length;
    } catch (e) { /* ignore */ }

    const result = {
      currentContext: currentContext,
      serverVersion,
      platform,
      contexts: kubeConfig.contexts.map(c => c.name),
      clusters: kubeConfig.clusters.map(c => c.name),
      nodes: nodeSummary,
      roles,
      capacity: {
        cpuCapacity: +cpuCapacity.toFixed(1),
        cpuAllocatable: +cpuAllocatable.toFixed(1),
        memCapacityBytes: memCapacity,
        memAllocatableBytes: memAllocatable
      },
      versions: Array.from(versions),
      osImages: Array.from(osImages),
      pods: { total: podTotal, phases: podPhases },
      namespaceCount
    };

    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const parseCpuMilli = (s) => {
  if (!s) return 0;
  s = String(s);
  if (s.endsWith('n')) return parseFloat(s) / 1e6;   // nanocores
  if (s.endsWith('u')) return parseFloat(s) / 1e3;   // microcores
  if (s.endsWith('m')) return parseFloat(s);         // millicores
  return parseFloat(s) * 1000;                        // cores
};

const fetchMetricsRaw = (path) => {
  const out = execFileSync('kubectl', kctl('get', '--raw', path), {
    encoding: 'utf-8',
    maxBuffer: 30 * 1024 * 1024,
    timeout: 10000
  });
  return JSON.parse(out);
};

const summarizePodMetrics = (item) => {
  let cpuMilli = 0;
  let memBytes = 0;
  const containers = (item.containers || []).map(c => {
    const cm = parseCpuMilli(c.usage?.cpu);
    const mb = parseMemBytes(c.usage?.memory);
    cpuMilli += cm;
    memBytes += mb;
    return { name: c.name, cpuMilli: +cm.toFixed(1), memBytes: mb };
  });
  return {
    cpuMilli: +cpuMilli.toFixed(1),
    memBytes,
    containers,
    timestamp: item.timestamp,
    window: item.window
  };
};

// Metrics for all pods (optionally scoped to a namespace) — keyed by "namespace/name"
app.get('/api/metrics/pods/:namespace?', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace } = req.params;
    const cacheKey = getCacheKey('metrics-pods', { namespace: namespace || 'all' });

    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const path = namespace && namespace !== 'all'
      ? `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`
      : `/apis/metrics.k8s.io/v1beta1/pods`;

    let data;
    try {
      data = fetchMetricsRaw(path);
    } catch (err) {
      return res.json({ metrics: {}, available: false });
    }

    const metrics = {};
    (data.items || []).forEach(item => {
      const key = `${item.metadata.namespace}/${item.metadata.name}`;
      metrics[key] = summarizePodMetrics(item);
    });

    const result = { metrics, available: true };
    setCache(cacheKey, result, 8000);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, metrics: {} });
  }
});

// Metrics for a single pod (used for live polling in the detail drawer)
app.get('/api/metrics/pod/:namespace/:pod', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { namespace, pod } = req.params;

    let item;
    try {
      item = fetchMetricsRaw(`/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${pod}`);
    } catch (err) {
      return res.json({ available: false });
    }

    res.json({ available: true, ...summarizePodMetrics(item) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Live metrics + capacity for a single node (for node detail graphs)
app.get('/api/metrics/node/:name', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });
    const { name } = req.params;

    let usage;
    try {
      const m = fetchMetricsRaw(`/apis/metrics.k8s.io/v1beta1/nodes/${name}`);
      usage = m.usage || {};
    } catch (err) {
      return res.json({ available: false });
    }

    let cpuCap = '0', memCap = '0', cpuAlloc = '0', memAlloc = '0';
    try {
      const out = execFileSync(
        'kubectl',
        ['get', 'node', name, '-o', 'jsonpath={.status.capacity.cpu}|{.status.capacity.memory}|{.status.allocatable.cpu}|{.status.allocatable.memory}'],
        { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024, timeout: 8000 }
      );
      [cpuCap, memCap, cpuAlloc, memAlloc] = out.split('|');
    } catch (e) { /* ignore */ }

    res.json({
      available: true,
      cpuMilli: +parseCpuMilli(usage.cpu).toFixed(1),
      memBytes: parseMemBytes(usage.memory),
      cpuCapacityMilli: parseCpuMilli(cpuCap),
      memCapacityBytes: parseMemBytes(memCap),
      cpuAllocatableMilli: parseCpuMilli(cpuAlloc),
      memAllocatableBytes: parseMemBytes(memAlloc)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/topology/:namespace', async (req, res) => {
  try {
    if (!kubeConfig) return res.status(400).json({ error: 'No kubeconfig loaded' });

    const { namespace } = req.params;
    const cacheKey = getCacheKey('topology', { namespace });

    const cachedData = getCache(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    // Namespaced resources across workloads / network / storage / config / rbac.
    // async execFile (no shell) so a big fetch never blocks the event loop.
    let data;
    try {
      const { stdout } = await execFileAsync('kubectl', kctl(
        'get',
        'deployments,replicasets,statefulsets,daemonsets,jobs,cronjobs,pods,' +
        'services,ingresses,networkpolicies,configmaps,secrets,serviceaccounts,' +
        'persistentvolumeclaims,roles,rolebindings',
        '-n', namespace, '-o', 'json'
      ), { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: 25000 });
      data = JSON.parse(stdout);
    } catch (err) {
      return res.status(500).json({ error: `Failed to build topology: ${(err.stderr || err.message).trim()}`, nodes: [], edges: [] });
    }

    const items = data.items || [];
    const byKind = {};
    for (const it of items) {
      if (it.kind) (byKind[it.kind] = byKind[it.kind] || []).push(it);
    }
    const get = (k) => byKind[k] || [];

    const CATEGORY = {
      Deployment: 'workload', ReplicaSet: 'workload', StatefulSet: 'workload',
      DaemonSet: 'workload', Job: 'workload', CronJob: 'workload', Pod: 'workload',
      Service: 'network', Ingress: 'network', NetworkPolicy: 'network',
      PersistentVolumeClaim: 'storage', PersistentVolume: 'storage', StorageClass: 'storage',
      ConfigMap: 'config', Secret: 'config',
      ServiceAccount: 'rbac', Role: 'rbac', ClusterRole: 'rbac', RoleBinding: 'rbac'
    };

    const workloadStatus = (item) => {
      const s = item.status || {};
      const spec = item.spec || {};
      const kind = item.kind;
      if (kind === 'Pod') return s.phase || 'Unknown';
      if (kind === 'PersistentVolumeClaim' || kind === 'PersistentVolume') return s.phase || 'Unknown';
      if (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'].includes(kind)) {
        const desired = spec.replicas != null ? spec.replicas
          : (s.desiredNumberScheduled != null ? s.desiredNumberScheduled : null);
        const ready = s.readyReplicas != null ? s.readyReplicas
          : (s.numberReady != null ? s.numberReady : (s.succeeded != null ? s.succeeded : 0));
        if (desired == null) return 'Ready';
        return ready >= desired && desired > 0 ? 'Ready' : (ready === 0 && desired === 0 ? 'Ready' : 'Pending');
      }
      return 'Active';
    };

    const idFor = (kind, name) => `${kind}/${name}`;
    const nodes = [];
    const nodeIndex = new Map();
    const edges = [];
    const rawByKind = new Map(items.map(it => [idFor(it.kind, it.metadata?.name), it]));

    const addNode = (kind, name, extra = {}) => {
      if (!kind || !name) return null;
      const id = idFor(kind, name);
      if (!nodeIndex.has(id)) {
        const item = rawByKind.get(id);
        const node = {
          id, kind, name,
          category: CATEGORY[kind] || 'workload',
          ...extra,
          status: item ? workloadStatus(item) : (extra.status || 'Active')
        };
        nodeIndex.set(id, node);
        nodes.push(node);
      }
      return id;
    };
    const addEdge = (source, target, type) => {
      if (source && target) edges.push({ source, target, type });
    };

    // ---- workloads + pods (always shown) ----
    const WORKLOAD_KINDS = ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod'];
    for (const kind of WORKLOAD_KINDS) {
      for (const item of get(kind)) {
        const id = addNode(kind, item.metadata.name);
        for (const owner of item.metadata?.ownerReferences || []) {
          addEdge(idFor(owner.kind, owner.name), id, 'owns');
        }
      }
    }

    const pods = get('Pod');

    // ---- network: services, ingresses, network policies ----
    for (const svc of get('Service')) {
      const svcId = addNode('Service', svc.metadata.name);
      const selector = svc.spec?.selector;
      if (selector && Object.keys(selector).length) {
        for (const pod of pods) {
          const labels = pod.metadata?.labels || {};
          if (Object.entries(selector).every(([k, v]) => labels[k] === v)) {
            addEdge(idFor('Pod', pod.metadata.name), svcId, 'service');
          }
        }
      }
    }
    for (const ing of get('Ingress')) {
      const ingId = addNode('Ingress', ing.metadata.name);
      const spec = ing.spec || {};
      const svcNames = new Set();
      if (spec.defaultBackend?.service?.name) svcNames.add(spec.defaultBackend.service.name);
      (spec.rules || []).forEach(r => (r.http?.paths || []).forEach(p => {
        if (p.backend?.service?.name) svcNames.add(p.backend.service.name);
      }));
      svcNames.forEach(n => addEdge(idFor('Service', n), ingId, 'network'));
    }
    for (const np of get('NetworkPolicy')) {
      const npId = addNode('NetworkPolicy', np.metadata.name);
      const sel = np.spec?.podSelector?.matchLabels || {};
      for (const pod of pods) {
        const labels = pod.metadata?.labels || {};
        if (Object.entries(sel).every(([k, v]) => labels[k] === v)) {
          addEdge(idFor('Pod', pod.metadata.name), npId, 'network');
        }
      }
    }

    // ---- storage: pvc -> pv / storageclass, pod -> pvc ----
    const pvcNames = new Set();
    const scNames = new Set();
    const pvNames = new Set();
    for (const pvc of get('PersistentVolumeClaim')) {
      const pvcId = addNode('PersistentVolumeClaim', pvc.metadata.name);
      pvcNames.add(pvc.metadata.name);
      if (pvc.spec?.volumeName) { pvNames.add(pvc.spec.volumeName); }
      if (pvc.spec?.storageClassName) {
        scNames.add(pvc.spec.storageClassName);
        addEdge(pvcId, addNode('StorageClass', pvc.spec.storageClassName), 'storage');
      }
    }

    // ---- config + rbac + storage refs discovered from pod specs ----
    const cmSet = new Set(), secretSet = new Set(), saSet = new Set();
    const podRefs = (pod) => {
      const spec = pod.spec || {};
      const containers = [...(spec.containers || []), ...(spec.initContainers || [])];
      (spec.volumes || []).forEach(v => {
        if (v.configMap?.name) cmSet.add(v.configMap.name);
        if (v.secret?.secretName) secretSet.add(v.secret.secretName);
        if (v.persistentVolumeClaim?.claimName) pvcNames.add(v.persistentVolumeClaim.claimName);
        (v.projected?.sources || []).forEach(s => {
          if (s.configMap?.name) cmSet.add(s.configMap.name);
          if (s.secret?.name) secretSet.add(s.secret.name);
        });
      });
      containers.forEach(c => {
        (c.envFrom || []).forEach(ef => {
          if (ef.configMapRef?.name) cmSet.add(ef.configMapRef.name);
          if (ef.secretRef?.name) secretSet.add(ef.secretRef.name);
        });
        (c.env || []).forEach(e => {
          if (e.valueFrom?.configMapKeyRef?.name) cmSet.add(e.valueFrom.configMapKeyRef.name);
          if (e.valueFrom?.secretKeyRef?.name) secretSet.add(e.valueFrom.secretKeyRef.name);
        });
      });
      (spec.imagePullSecrets || []).forEach(s => { if (s.name) secretSet.add(s.name); });
      return spec.serviceAccountName || spec.serviceAccount || null;
    };

    for (const pod of pods) {
      const podId = idFor('Pod', pod.metadata.name);
      const beforeCm = new Set(cmSet), beforeSec = new Set(secretSet);
      const sa = podRefs(pod);
      // edges: pod -> each newly-referenced cm/secret it introduced
      for (const name of pod.spec?.volumes?.map(v => v.persistentVolumeClaim?.claimName).filter(Boolean) || []) {
        addEdge(podId, idFor('PersistentVolumeClaim', name), 'storage');
      }
      // re-derive this pod's own references for precise edges
      const spec = pod.spec || {};
      const containers = [...(spec.containers || []), ...(spec.initContainers || [])];
      const myCm = new Set(), mySec = new Set();
      (spec.volumes || []).forEach(v => {
        if (v.configMap?.name) myCm.add(v.configMap.name);
        if (v.secret?.secretName) mySec.add(v.secret.secretName);
        (v.projected?.sources || []).forEach(s => {
          if (s.configMap?.name) myCm.add(s.configMap.name);
          if (s.secret?.name) mySec.add(s.secret.name);
        });
      });
      containers.forEach(c => {
        (c.envFrom || []).forEach(ef => {
          if (ef.configMapRef?.name) myCm.add(ef.configMapRef.name);
          if (ef.secretRef?.name) mySec.add(ef.secretRef.name);
        });
        (c.env || []).forEach(e => {
          if (e.valueFrom?.configMapKeyRef?.name) myCm.add(e.valueFrom.configMapKeyRef.name);
          if (e.valueFrom?.secretKeyRef?.name) mySec.add(e.valueFrom.secretKeyRef.name);
        });
      });
      (spec.imagePullSecrets || []).forEach(s => { if (s.name) mySec.add(s.name); });
      myCm.forEach(n => addEdge(podId, addNode('ConfigMap', n), 'config'));
      mySec.forEach(n => addEdge(podId, addNode('Secret', n), 'config'));
      if (sa) { saSet.add(sa); addEdge(podId, addNode('ServiceAccount', sa), 'rbac'); }
    }

    // rbac chain: serviceaccount -> rolebinding -> role
    for (const rb of get('RoleBinding')) {
      const subjects = rb.subjects || [];
      const linkedSAs = subjects.filter(s => s.kind === 'ServiceAccount' && saSet.has(s.name));
      if (!linkedSAs.length) continue;
      const rbId = addNode('RoleBinding', rb.metadata.name);
      linkedSAs.forEach(s => addEdge(idFor('ServiceAccount', s.name), rbId, 'rbac'));
      const ref = rb.roleRef;
      if (ref?.name) addEdge(rbId, addNode(ref.kind || 'Role', ref.name), 'rbac');
    }

    // ---- cluster-scoped storage (PVs + StorageClasses) bound to this namespace ----
    if (pvNames.size || scNames.size) {
      try {
        const { stdout } = await execFileAsync('kubectl', kctl('get', 'pv,storageclass', '-o', 'json'),
          { encoding: 'utf-8', maxBuffer: 40 * 1024 * 1024, timeout: 15000 });
        const cluster = JSON.parse(stdout).items || [];
        for (const it of cluster) {
          if (it.kind === 'PersistentVolume' && pvNames.has(it.metadata.name)) {
            rawByKind.set(idFor('PersistentVolume', it.metadata.name), it);
            const pvId = addNode('PersistentVolume', it.metadata.name);
            // pvc -> pv
            const claim = it.spec?.claimRef;
            if (claim && claim.namespace === namespace) {
              addEdge(idFor('PersistentVolumeClaim', claim.name), pvId, 'storage');
            }
            if (it.spec?.storageClassName) {
              addEdge(pvId, addNode('StorageClass', it.spec.storageClassName), 'storage');
            }
          }
          if (it.kind === 'StorageClass' && scNames.has(it.metadata.name)) {
            rawByKind.set(idFor('StorageClass', it.metadata.name), it);
            // ensure node exists (status Active) if referenced
            addNode('StorageClass', it.metadata.name);
          }
        }
      } catch { /* cluster-scoped fetch optional; skip on RBAC failure */ }
    }

    // keep only edges whose endpoints exist as nodes; dedupe
    const seen = new Set();
    const validEdges = edges.filter(e => {
      if (!nodeIndex.has(e.source) || !nodeIndex.has(e.target)) return false;
      const key = `${e.source}|${e.target}|${e.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const result = { nodes, edges: validEdges };
    setCache(cacheKey, result, CACHE_TTL.resources);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, nodes: [], edges: [] });
  }
});

// Derive a simple status for a single container from its containerStatus.
// running -> 'running', waiting(bad reason)/terminated(non-zero) -> 'failed',
// waiting(other) -> 'pending', missing status -> 'unknown'
function containerState(cs) {
  if (!cs || !cs.state) return 'unknown';
  if (cs.state.running) return 'running';
  if (cs.state.terminated) {
    return cs.state.terminated.exitCode === 0 ? 'running' : 'failed';
  }
  if (cs.state.waiting) {
    const reason = cs.state.waiting.reason || '';
    const bad = /CrashLoopBackOff|Error|ImagePull|InvalidImageName|CreateContainer|RunContainer|CreateContainerConfigError/i.test(reason);
    return bad ? 'failed' : 'pending';
  }
  return 'unknown';
}

function formatResource(item, kind) {
  const resolvedKind = kind || item.kind;
  const out = {
    name: item.metadata.name,
    namespace: item.metadata.namespace,
    kind: resolvedKind,
    createdAt: item.metadata.creationTimestamp,
    status: getResourceStatus(item, resolvedKind)
  };
  if (resolvedKind === 'Pod') {
    out.node = item.spec?.nodeName || null;
    out.containerNames = (item.spec?.containers || []).map(c => c.name);
    const cs = item.status?.containerStatuses || [];
    const byName = {};
    cs.forEach(c => { byName[c.name] = c; });
    out.containerStates = (item.spec?.containers || []).map(c => ({
      name: c.name,
      status: containerState(byName[c.name])
    }));
    out.containers = out.containerNames.length || cs.length;
    out.restarts = cs.reduce((s, c) => s + (c.restartCount || 0), 0);
  }
  if (resolvedKind === 'ConfigMap') {
    out.dataKeys = Object.keys(item.data || {}).length + Object.keys(item.binaryData || {}).length;
  }
  if (resolvedKind === 'Secret') {
    out.secretType = item.type || 'Opaque';
    out.dataKeys = Object.keys(item.data || {}).length;
  }
  if (resolvedKind === 'ServiceAccount') {
    out.saSecrets = (item.secrets || []).length;
  }
  if (resolvedKind === 'NetworkPolicy') {
    out.policyTypes = (item.spec?.policyTypes || []).join(', ') || '-';
  }
  if (resolvedKind === 'Ingress') {
    out.ingressClass = item.spec?.ingressClassName || '-';
    out.hosts = (item.spec?.rules || []).map(r => r.host).filter(Boolean).join(', ') || '-';
  }
  if (resolvedKind === 'PersistentVolumeClaim') {
    out.capacity = item.status?.capacity?.storage || item.spec?.resources?.requests?.storage || '-';
    out.storageClass = item.spec?.storageClassName || '-';
    out.volume = item.spec?.volumeName || '-';
    out.accessModes = (item.spec?.accessModes || []).join(',') || '-';
  }
  if (resolvedKind === 'PersistentVolume') {
    out.capacity = item.spec?.capacity?.storage || '-';
    out.storageClass = item.spec?.storageClassName || '-';
    out.reclaimPolicy = item.spec?.persistentVolumeReclaimPolicy || '-';
    out.claim = item.spec?.claimRef ? `${item.spec.claimRef.namespace}/${item.spec.claimRef.name}` : '-';
    out.accessModes = (item.spec?.accessModes || []).join(',') || '-';
  }
  if (resolvedKind === 'StorageClass') {
    out.provisioner = item.provisioner || '-';
    out.reclaimPolicy = item.reclaimPolicy || 'Delete';
    out.bindingMode = item.volumeBindingMode || 'Immediate';
  }
  return out;
}

// `kind` is passed explicitly because list items from the client library
// don't carry a per-item `kind` field.
function getResourceStatus(item, kind) {
  const status = item.status || {};
  if (kind === 'Pod') {
    return status.phase || 'Unknown';
  }
  if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
    const ready = status.readyReplicas != null ? status.readyReplicas
      : (status.numberReady != null ? status.numberReady : 0);
    const desired = status.replicas != null ? status.replicas
      : (status.desiredNumberScheduled != null ? status.desiredNumberScheduled : 0);
    return `${ready}/${desired}`;
  }
  if (kind === 'Service') {
    return item.spec?.type || 'Unknown';
  }
  if (kind === 'PersistentVolume' || kind === 'PersistentVolumeClaim') {
    return status.phase || 'Unknown';
  }
  if (kind === 'StorageClass') {
    return '';
  }
  return 'Unknown';
}

// ------------------------------------------------------------------
// MCP endpoint (Streamable HTTP). Any MCP-compatible AI agent can connect to
// /mcp to drive the cluster this app is attached to. Stateful: an initialize
// request mints a session id; later requests reuse the same server via the
// Mcp-Session-Id header.
// ------------------------------------------------------------------
const mcpTransports = {}; // sessionId -> transport

app.post('/mcp', async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'];
    let transport;
    if (sid && mcpTransports[sid]) {
      transport = mcpTransports[sid];
    } else if (!sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { mcpTransports[id] = transport; },
      });
      transport.onclose = () => { if (transport.sessionId) delete mcpTransports[transport.sessionId]; };
      const mcp = createMcpServer({ version: getAppVersion(), allowWrite: mcpAllowWrite });
      await mcp.connect(transport);
    } else {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session id (send an initialize request first)' }, id: null });
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: null });
    }
  }
});

// GET (server→client notification stream) and DELETE (end session) reuse the session.
const mcpSession = async (req, res) => {
  const sid = req.headers['mcp-session-id'];
  if (!sid || !mcpTransports[sid]) return res.status(400).send('Invalid or missing Mcp-Session-Id');
  await mcpTransports[sid].handleRequest(req, res);
};
app.get('/mcp', mcpSession);
app.delete('/mcp', mcpSession);

// SPA fallback: serve index.html for non-API routes (production build)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  const indexFile = path.join(CLIENT_DIST, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

// ============================================================
// AI assistant (read-only, agentic, streams over SSE)
// ============================================================
registerAssistant(app, {
  k8s,
  getKubeConfig: () => kubeConfig,
  getCurrentContext: () => currentContext,
  helmReleases: async () => latestHelmReleases(await listHelmReleaseSecrets()),
});

// ============================================================
// Interactive shell over WebSocket (real TTY via k8s exec)
// ============================================================
const server = http.createServer(app);
// WebSocket handshakes are NOT subject to CORS, so a malicious page could open
// /ws/exec directly and get a shell in a pod. Reject cross-origin upgrades with
// the same rule the REST guard uses (browsers always send Origin on WS
// handshakes; non-browser clients that omit it are allowed).
const wss = new WebSocketServer({
  server,
  path: '/ws/exec',
  verifyClient: (info) => isAllowedOrigin(info.origin, info.req.headers.host),
});

wss.on('connection', async (browserWs, req) => {
  // Demo mode: a scripted pseudo-terminal instead of a real pod exec.
  if (demo.isDemo(currentContext)) {
    const durl = new URL(req.url, 'http://localhost');
    demo.shellSession(browserWs, {
      agent: durl.searchParams.get('agent'),
      namespace: durl.searchParams.get('namespace'),
      pod: durl.searchParams.get('pod'),
      container: durl.searchParams.get('container'),
    });
    return;
  }

  if (!kubeConfig) {
    browserWs.close(1011, 'No kubeconfig loaded');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const send = (data) => { if (browserWs.readyState === 1) browserWs.send(data); };
  if (!pty) {
    send('\r\n\x1b[31mTerminal is unavailable on this server (node-pty failed to load).\x1b[0m\r\n');
    browserWs.close();
    return;
  }

  const agentId = url.searchParams.get('agent');
  let term, cleanup = () => {};

  if (agentId) {
    // ---- AI agent terminal: a login shell with the app's current cluster
    // context pinned via a temp kubeconfig, then launch the chosen agent CLI. ----
    const info = AI_AGENTS.find((a) => a.id === agentId);
    const command = info ? info.command : (url.searchParams.get('command') || '').replace(/[^a-zA-Z0-9_./\s-]/g, '').trim();
    if (!command) { send('\r\n\x1b[31mUnknown AI agent.\x1b[0m\r\n'); browserWs.close(); return; }

    let kubeconfigPath = getKubeConfigPath();
    try {
      const tmp = path.join(os.tmpdir(), `km-agent-${randomUUID()}.yaml`);
      fs.writeFileSync(tmp, kubeConfig.exportConfig(), { mode: 0o600 });
      kubeconfigPath = tmp;
      cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } };
    } catch { /* fall back to the default kubeconfig path */ }

    const shell = process.env.SHELL || '/bin/bash';
    try {
      term = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.env.HOME || '/', env: { ...process.env, KUBECONFIG: kubeconfigPath, KUBE_CONTEXT: currentContext || '' } });
    } catch (err) {
      send(`\r\n\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n`);
      browserWs.close();
      return;
    }
    // Once the shell is ready, launch the agent (with an optional seed prompt).
    const prompt = url.searchParams.get('prompt');
    const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const launch = prompt ? `${command} ${shq(prompt)}\r` : `${command}\r`;
    setTimeout(() => { try { term.write(launch); } catch { /* ignore */ } }, 700);
  } else {
    // ---- pod exec: bridge to `kubectl exec -it` in a real PTY (robust against
    // exec-credential auth plugins that break client-node's WebSocket exec). ----
    const namespace = url.searchParams.get('namespace');
    const pod = url.searchParams.get('pod');
    const container = url.searchParams.get('container') || undefined;
    if (!namespace || !pod) { browserWs.close(1008, 'Missing namespace or pod'); return; }
    const args = kctl('exec', '-it', '-n', namespace, ...(container ? ['-c', container] : []), pod, '--', 'sh', '-c', 'exec $(command -v bash || command -v sh || echo /bin/sh)');
    const kubectlBin = resolveBinSync('kubectl');
    try {
      term = pty.spawn(kubectlBin, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.env.HOME || '/', env: process.env });
    } catch (err) {
      const hint = kubectlBin === 'kubectl'
        ? ' (kubectl was not found — install it or add it to PATH)'
        : '';
      send(`\r\n\x1b[31mFailed to start shell: ${err.message}${hint}\x1b[0m\r\n`);
      browserWs.close();
      return;
    }
  }

  term.onData((data) => send(data));
  term.onExit(({ exitCode }) => {
    if (browserWs.readyState === 1 && exitCode) send(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
    try { browserWs.close(); } catch (e) {}
  });

  browserWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg.type === 'data') {
      try { term.write(msg.data); } catch (e) {}
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      try { term.resize(msg.cols, msg.rows); } catch (e) {}
    }
  });

  browserWs.on('close', () => {
    try { term.kill(); } catch (e) {}
    cleanup();
  });
});

let handledFatal = false;
const handleServerError = (err) => {
  if (handledFatal) return;
  handledFatal = true;
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — another instance of the app (or a process using this port) is already running. Stop it and try again.`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
};
// The WebSocketServer (created with { server }) re-emits the HTTP server's
// listen errors on itself, so guard both to avoid an unhandled 'error' throw.
server.on('error', handleServerError);
wss.on('error', handleServerError);

// Bind to loopback by default so the API/exec surface is not reachable from
// other hosts on the LAN. Set HOST=0.0.0.0 to expose it (the Docker image does
// this so its published port works); prefer `-p 127.0.0.1:8080:3001` there.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Server running on http://${shown}:${PORT}${HOST === '0.0.0.0' ? ' (bound 0.0.0.0)' : ''}`);
});
