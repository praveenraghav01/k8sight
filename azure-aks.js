// ============================================================
// CLI-free Azure AKS integration — Azure AD auth-code (PKCE) + ARM REST.
//
// No `az` binary. Sign-in uses the OAuth 2.0 authorization-code flow with PKCE
// and a loopback (http://localhost:<port>) redirect, opened in the user's
// SYSTEM browser. Unlike device-code, this carries the browser's device state
// (Company Portal / Microsoft Enterprise SSO on a managed Mac), so it satisfies
// device-compliance Conditional Access policies — the same reason `az login`'s
// browser flow works. Cluster discovery + kubeconfig retrieval go straight to
// the Azure Resource Manager REST API. Node 18+ global fetch.
// ============================================================
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Where the CLI-free AKS token helper (azure-token.js) reads the refresh token.
// Persisted so kubelogin/az are never needed for app-imported AAD clusters.
export const AZURE_AUTH_FILE = path.join(os.homedir(), '.config', 'k8s-manager', 'azure-auth.json');

const AAD = 'https://login.microsoftonline.com';
const ARM = 'https://management.azure.com';
// Azure CLI's well-known public client id — a first-party public client that
// permits loopback redirects and ARM tokens (the same one `az` itself uses).
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const SCOPE = 'https://management.azure.com/.default offline_access openid profile';
const API_AKS = '2024-05-01';

const form = (obj) => new URLSearchParams(obj);
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let session = null;     // { accessToken, refreshToken, expiresAt, tenant, account }
let flow = null;        // active browser flow: { server, verifier, state, redirectUri, status, error, tenant, authUrl }

function setSession(tok, tenant) {
  let account;
  try {
    const idt = tok.id_token && JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64').toString('utf-8'));
    account = idt?.preferred_username || idt?.upn || idt?.email || idt?.name;
  } catch { /* no id_token */ }
  session = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + ((tok.expires_in || 3600) - 60) * 1000,
    tenant,
    account,
  };
  persistAuth();
}

// Keep the on-disk refresh token (read by azure-token.js) in sync with the
// in-memory session, so CLI-free AKS clusters can mint their own tokens.
function persistAuth() {
  try {
    if (!session?.refreshToken) return;
    fs.mkdirSync(path.dirname(AZURE_AUTH_FILE), { recursive: true });
    const tmp = `${AZURE_AUTH_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ refreshToken: session.refreshToken, tenant: session.tenant, account: session.account }), { mode: 0o600 });
    fs.renameSync(tmp, AZURE_AUTH_FILE);
  } catch { /* non-fatal */ }
}
export function getTenant() { return session?.tenant; }

function closeFlowServer() { try { flow?.server?.close(); } catch { /* ignore */ } }

// `msg` can carry an IDP-supplied error_description reflected from the OAuth
// callback query string, so HTML-escape it before it enters the page (XSS).
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const successPage = (ok, msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;font:15px -apple-system,system-ui,sans-serif;background:#0b0b0d;color:#ededed;display:grid;place-items:center;height:100vh">
<div style="text-align:center;max-width:360px;padding:24px">
<div style="font-size:34px;margin-bottom:8px">${ok ? '&#10003;' : '&#9888;'}</div>
<h2 style="margin:0 0 8px">${ok ? 'Signed in to Azure' : 'Sign-in failed'}</h2>
<p style="color:#9aa1ad;margin:0 0 6px">${escapeHtml(msg)}</p>
<p style="color:#6b7280;font-size:13px">You can close this tab and return to k8sight.</p>
</div></body>`;

// Begin the browser auth-code flow. Returns { authUrl } for the client to open
// in the system browser; a loopback server captures the redirect. The client
// polls loginStatus() until status === 'done'.
// A tenant id flows into the AAD token/authorize URL path. Constrain it to the
// shapes Azure actually uses — a GUID, a verified domain, or common/organizations/
// consumers — so it can't inject a path segment or host and redirect the request
// (SSRF). Anything else falls back to the safe default.
const safeTenant = (t) => {
  const v = String(t || '').trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(v) ? v : 'organizations';
};

export async function startBrowserLogin(rawTenant = 'organizations') {
  const tenant = safeTenant(rawTenant);
  cancelLogin();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}`;
  flow = { server, verifier, state, redirectUri, status: 'pending', error: null, tenant, authUrl: null };

  server.on('request', async (req, res) => {
    if (!flow) { res.end(); return; }
    const send = (ok, msg) => { res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html' }); res.end(successPage(ok, msg)); };
    try {
      const u = new URL(req.url, redirectUri);
      if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const code = u.searchParams.get('code');
      const st = u.searchParams.get('state');
      const err = u.searchParams.get('error_description') || u.searchParams.get('error');
      if (err) { flow.status = 'error'; flow.error = String(err).split('\n')[0]; send(false, flow.error); closeFlowServer(); return; }
      if (!code || st !== flow.state) { send(false, 'Invalid or mismatched response.'); return; }
      const r = await fetch(`${AAD}/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, redirect_uri: redirectUri, code_verifier: flow.verifier, scope: SCOPE }),
      });
      const t = await r.json().catch(() => ({}));
      if (r.ok && t.access_token) { setSession(t, tenant); flow.status = 'done'; send(true, 'Authentication complete.'); }
      else { flow.status = 'error'; flow.error = (t.error_description || t.error || 'Token exchange failed').split('\n')[0]; send(false, flow.error); }
      closeFlowServer();
    } catch (e) {
      if (flow) { flow.status = 'error'; flow.error = e.message; }
      try { send(false, e.message); } catch { /* ignore */ }
      closeFlowServer();
    }
  });

  flow.authUrl = `${AAD}/${tenant}/oauth2/v2.0/authorize?` + form({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
    scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account',
  }).toString();
  return { authUrl: flow.authUrl };
}

export function loginStatus() {
  return {
    loggedIn: !!session,
    account: session?.account,
    status: session ? 'done' : (flow?.status || 'idle'),
    authUrl: flow?.authUrl,
    error: flow?.error,
  };
}

export function cancelLogin() {
  closeFlowServer();
  if (flow && flow.status === 'pending') flow.status = 'cancelled';
  flow = null;
}
export function signOut() { cancelLogin(); session = null; try { fs.unlinkSync(AZURE_AUTH_FILE); } catch { /* ignore */ } }
export function isLoggedIn() { return !!session; }

async function accessToken() {
  if (!session) throw new Error('Not signed in to Azure');
  if (Date.now() < session.expiresAt) return session.accessToken;
  if (session.refreshToken) {
    const r = await fetch(`${AAD}/${session.tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: session.refreshToken, scope: SCOPE }),
    });
    const t = await r.json().catch(() => ({}));
    if (r.ok && t.access_token) { setSession(t, session.tenant); return session.accessToken; }
  }
  session = null;
  throw new Error('Azure session expired. Sign in again.');
}

async function arm(url, { method = 'GET', body } = {}) {
  // Only ever call the Azure Resource Manager host. Paginated list calls follow a
  // `nextLink` taken from ARM responses; pinning the origin stops a malformed or
  // hostile response from redirecting this bearer-token request to another host
  // (SSRF / access-token exfiltration).
  if (new URL(url).origin !== ARM) throw new Error(`Refusing non-ARM request to ${url}`);
  const tk = await accessToken();
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${tk}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(json.error?.message || json.error?.code || `Azure API error (${r.status})`);
  return json;
}

async function armList(pathWithQuery) {
  let url = `${ARM}${pathWithQuery}`;
  const out = [];
  while (url) { const j = await arm(url); if (Array.isArray(j.value)) out.push(...j.value); url = j.nextLink || null; }
  return out;
}

export async function listSubscriptions() {
  const subs = await armList(`/subscriptions?api-version=2020-01-01`);
  return subs.filter((s) => s.state === 'Enabled').map((s) => ({ id: s.subscriptionId, name: s.displayName }));
}

export async function listAllClusters() {
  const subs = await listSubscriptions();
  const perSub = await Promise.all(subs.map(async (s) => {
    try {
      const list = await armList(`/subscriptions/${s.id}/providers/Microsoft.ContainerService/managedClusters?api-version=${API_AKS}`);
      return list.map((a) => ({
        name: a.name,
        resourceGroup: (a.id.match(/\/resourceGroups\/([^/]+)/i) || [])[1],
        subscriptionId: s.id,
        subscriptionName: s.name,
        location: a.location,
        kubernetesVersion: a.properties?.currentKubernetesVersion || a.properties?.kubernetesVersion,
        powerState: a.properties?.powerState?.code || a.properties?.provisioningState,
        aadEnabled: !!a.properties?.aadProfile,
        localAccountsDisabled: !!a.properties?.disableLocalAccounts,
      }));
    } catch { return []; }
  }));
  return { clusters: perSub.flat().sort((a, b) => a.name.localeCompare(b.name)), subscriptions: subs.length };
}

export async function getClusterKubeconfig(subscriptionId, resourceGroup, name, admin = false) {
  const action = admin ? 'listClusterAdminCredential' : 'listClusterUserCredential';
  const j = await arm(
    `${ARM}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerService/managedClusters/${name}/${action}?api-version=${API_AKS}`,
    { method: 'POST' },
  );
  const b64 = (j.kubeconfigs || [])[0]?.value;
  if (!b64) throw new Error('Azure returned no kubeconfig');
  return Buffer.from(b64, 'base64').toString('utf-8');
}
