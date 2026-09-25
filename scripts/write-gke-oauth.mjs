#!/usr/bin/env node
// Generate gke-oauth.json (gitignored) from env vars so a shipped build can
// embed the Google OAuth client for GKE browser sign-in without the id/secret
// living in git. Runs as part of `npm run build` / packaging.
//
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run dist
//
// If the env vars are not set, an existing gke-oauth.json is left untouched
// (handy for local dev, where you may have created it once by hand). If neither
// exists, GKE browser sign-in is simply disabled in that build (the
// service-account-key method still works).
import { writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(repo, 'gke-oauth.json');
const id = process.env.GOOGLE_CLIENT_ID;
const secret = process.env.GOOGLE_CLIENT_SECRET;

if (id && secret) {
  writeFileSync(file, JSON.stringify({ clientId: id, clientSecret: secret }, null, 2));
  console.log('gke-oauth.json ← GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
} else if (existsSync(file)) {
  console.log('gke-oauth.json: keeping existing file (no GOOGLE_CLIENT_* env set)');
} else {
  console.log('gke-oauth.json: not set — GKE browser sign-in disabled in this build (service-account key still works)');
}
