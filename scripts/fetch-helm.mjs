#!/usr/bin/env node
// Download the `helm` binary into ./bin so the packaged app can ship it — the
// Helm chart search/install flow then works out-of-the-box with no separate
// Helm install. Run automatically before electron-builder (see package.json).
//
//   node scripts/fetch-helm.mjs           # current OS/arch → bin/helm
//   node scripts/fetch-helm.mjs --all     # every platform  → bin/<os>-<arch>/helm
//   HELM_VERSION=4.3.0 node scripts/fetch-helm.mjs    # override the pinned version
//   HELM_VERSION=latest node scripts/fetch-helm.mjs   # newest stable release
//
// bin/ is gitignored — the binaries are fetched per build, not committed.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin');
// Pinned so every build ships the same Helm (reproducible, no surprise major
// upgrades). Bump deliberately after testing chart search/install against it.
const PINNED_VERSION = '4.3.0';

// helm release archives (https://github.com/helm/helm/releases). Each archive
// nests the binary under `<os>-<arch>/helm[.exe]`; we flatten it to bin/helm.
const TARGETS = {
  'darwin-arm64': { slug: 'darwin-arm64', ext: 'tar.gz', out: 'helm' },
  'darwin-x64': { slug: 'darwin-amd64', ext: 'tar.gz', out: 'helm' },
  'linux-x64': { slug: 'linux-amd64', ext: 'tar.gz', out: 'helm' },
  'linux-arm64': { slug: 'linux-arm64', ext: 'tar.gz', out: 'helm' },
  'win32-x64': { slug: 'windows-amd64', ext: 'zip', out: 'helm.exe' },
};

async function resolveVersion() {
  const want = (process.env.HELM_VERSION || '').replace(/^v/, '');
  if (want && want !== 'latest') return want;
  if (!want) return PINNED_VERSION;
  // get.helm.sh publishes a plain-text pointer to the current stable release.
  try {
    const r = await fetch('https://get.helm.sh/helm-latest-version', { headers: { 'user-agent': 'k8sight' } });
    const v = (await r.text()).trim().replace(/^v/, '');
    if (/^\d+\.\d+\.\d+$/.test(v)) return v;
  } catch { /* fall through */ }
  try {
    const r = await fetch('https://api.github.com/repos/helm/helm/releases/latest', { headers: { 'user-agent': 'k8sight' } });
    const j = await r.json();
    return (j.tag_name || '').replace(/^v/, '') || PINNED_VERSION;
  } catch { return PINNED_VERSION; }
}

async function fetchOne(key, version, dir) {
  const t = TARGETS[key];
  if (!t) { console.log(`skip ${key} (unsupported)`); return; }
  const outPath = path.join(dir, t.out);
  if (fs.existsSync(outPath)) { console.log(`✓ ${key} already present`); return; }
  fs.mkdirSync(dir, { recursive: true });
  const asset = `helm-v${version}-${t.slug}.${t.ext}`;
  const url = `https://get.helm.sh/${asset}`;
  const archive = path.join(dir, asset);
  console.log(`↓ ${key}: ${url}`);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`download failed for ${key} (${r.status})`);
  fs.writeFileSync(archive, Buffer.from(await r.arrayBuffer()));
  // The binary lives at `<slug>/helm[.exe]` inside the archive; --strip-components
  // flattens it straight into `dir`. bsdtar/libarchive handles both .tar.gz and .zip.
  const member = `${t.slug}/${t.out}`;
  execFileSync('tar', t.ext === 'zip'
    ? ['-xf', archive, '-C', dir, '--strip-components=1', member]
    : ['-xzf', archive, '-C', dir, '--strip-components=1', member]);
  fs.chmodSync(outPath, 0o755);
  fs.unlinkSync(archive);
  console.log(`✓ ${key} → ${path.relative(ROOT, outPath)}`);
}

async function main() {
  const all = process.argv.includes('--all');
  const version = await resolveVersion();
  console.log(`helm v${version}`);
  if (all) {
    for (const key of Object.keys(TARGETS)) await fetchOne(key, version, path.join(BIN, key));
  } else {
    const key = `${process.platform}-${process.arch}`;
    await fetchOne(key, version, BIN); // current platform → bin/helm
  }
}

main().catch((e) => { console.error(`fetch-helm: ${e.message}`); process.exit(1); });
