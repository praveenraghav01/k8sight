#!/usr/bin/env node
// Native AKS (Azure AD) authentication-token generator — a self-contained
// replacement for `kubelogin get-token --login azurecli` that needs NO `az` and
// NO `kubelogin`, only Node.
//
// AKS kubeconfig entries written by the app's CLI-free Azure import exec this
// file, so both @kubernetes/client-node and kubectl can authenticate to an
// AAD-enabled AKS cluster without any Azure CLI. It works like kubelogin's
// azurecli mode — take the signed-in user's refresh token and exchange it for an
// access token scoped to the cluster's AAD server app — except the refresh token
// comes from the app's own browser sign-in, persisted at ~/.config/k8s-manager/
// azure-auth.json, instead of az's MSAL cache.
//
// Usage: node azure-token.js --server-id <aad-server-app-id> [--tenant <tenant>]
import fs from 'fs';
import os from 'os';
import path from 'path';

const AAD = 'https://login.microsoftonline.com';
// Azure CLI's well-known first-party public client — the same one the app's
// browser sign-in uses; it permits cross-resource refresh-token redemption.
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const AUTH_FILE = path.join(os.homedir(), '.config', 'k8s-manager', 'azure-auth.json');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

// Persist the rotated refresh token atomically (AAD returns a fresh one on each
// redemption; keeping the store current avoids premature re-sign-in).
function saveRefreshToken(store, refreshToken) {
  try {
    const next = { ...store, refreshToken };
    const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, AUTH_FILE);
  } catch { /* non-fatal: the current token still authenticated this call */ }
}

async function main() {
  const serverId = arg('server-id');
  if (!serverId) throw new Error('--server-id is required');

  let store;
  try { store = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); }
  catch { throw new Error('Not signed in to Azure. Open k8sight and sign in to Azure.'); }
  if (!store.refreshToken) throw new Error('No Azure session. Sign in to Azure in k8sight.');

  const tenant = arg('tenant') || store.tenant || 'organizations';
  const r = await fetch(`${AAD}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: store.refreshToken,
      scope: `${serverId}/.default openid profile offline_access`,
    }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) {
    throw new Error((t.error_description || t.error || `token request failed (${r.status})`).split('\n')[0]);
  }
  if (t.refresh_token && t.refresh_token !== store.refreshToken) saveRefreshToken(store, t.refresh_token);

  // Report the token's real lifetime so clients refresh in time (60s margin).
  const expirationTimestamp = new Date(Date.now() + ((t.expires_in || 3600) - 60) * 1000).toISOString();
  process.stdout.write(JSON.stringify({
    kind: 'ExecCredential',
    apiVersion: 'client.authentication.k8s.io/v1beta1',
    spec: {},
    status: { expirationTimestamp, token: t.access_token },
  }));
}

main().catch((e) => { process.stderr.write(`azure-token: ${e.message}\n`); process.exit(1); });
