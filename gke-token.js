#!/usr/bin/env node
// Native GKE auth-token generator — a drop-in replacement for the
// gke-gcloud-auth-plugin that needs NO gcloud, only Node. Mints a Google OAuth
// access token and prints an ExecCredential, so both @kubernetes/client-node and
// kubectl can authenticate to GKE. Credentials come from --credentials <path>:
// a service-account key JSON, or an authorized_user JSON with a refresh token.
//
// Usage: node gke-token.js --credentials /path/to/credentials.json
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const b64url = (b) => Buffer.from(b).toString('base64url');

const ADC = path.join(process.env.HOME || os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');

// Signing out of the app deletes the credentials file this entry points at but
// leaves the kubeconfig entry behind, which would break kubectl for every
// cluster the app ever imported. Fall back to gcloud's Application Default
// Credentials when they exist: losing the app's session must not cost the user
// access they still legitimately have.
function loadCredentials(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    if (file !== ADC) {
      try { return JSON.parse(fs.readFileSync(ADC, 'utf8')); } catch { /* no ADC either */ }
    }
    throw new Error(`no usable credentials at ${file}${file === ADC ? '' : ', and no gcloud ADC to fall back on'}`);
  }
}

async function serviceAccountToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: key.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: key.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), key.private_key);
  const assertion = `${input}.${b64url(sig)}`;
  const r = await fetch(key.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'token exchange failed');
  return d.access_token;
}

async function refreshTokenGrant(c) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client_id, client_secret: c.client_secret }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'refresh failed');
  return d.access_token;
}

async function main() {
  const p = arg('credentials');
  if (!p) throw new Error('--credentials <path> is required');
  const creds = loadCredentials(p);
  const token = creds.type === 'service_account' ? await serviceAccountToken(creds) : await refreshTokenGrant(creds);
  // Google access tokens last ~1h; report a slightly shorter expiry so clients refresh in time.
  const expirationTimestamp = new Date(Date.now() + 55 * 60 * 1000).toISOString();
  process.stdout.write(JSON.stringify({
    kind: 'ExecCredential',
    apiVersion: 'client.authentication.k8s.io/v1beta1',
    spec: {},
    status: { expirationTimestamp, token },
  }));
}

main().catch((e) => { process.stderr.write(`gke-token: ${e.message}\n`); process.exit(1); });
