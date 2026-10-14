#!/usr/bin/env node
// Download the `trivy` binary into ./bin so the packaged app can ship it — the
// Security Center's built-in image scan then needs no in-cluster operator and no
// runtime download. Run automatically before electron-builder (see package.json).
//
//   node scripts/fetch-trivy.mjs           # current OS/arch → bin/trivy
//   node scripts/fetch-trivy.mjs --all     # every platform  → bin/<os>-<arch>/trivy
//   TRIVY_VERSION=x.y.z node scripts/fetch-trivy.mjs   # override the pinned version
//
// The default version and the SHA-256 of every asset are pinned in
// lib/pinned-tools.json; downloads that don't match are rejected.
//
// bin/ is gitignored — the binaries are fetched per build, not committed.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { PINNED, verifyAsset } from '../lib/verify-download.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin');

// GitHub release asset naming (see github.com/aquasecurity/trivy/releases).
const TARGETS = {
  'darwin-arm64': { asset: 'macOS-ARM64', ext: 'tar.gz', out: 'trivy' },
  'darwin-x64': { asset: 'macOS-64bit', ext: 'tar.gz', out: 'trivy' },
  'linux-x64': { asset: 'Linux-64bit', ext: 'tar.gz', out: 'trivy' },
  'linux-arm64': { asset: 'Linux-ARM64', ext: 'tar.gz', out: 'trivy' },
  'win32-x64': { asset: 'windows-64bit', ext: 'zip', out: 'trivy.exe' },
};

function resolveVersion() {
  return (process.env.TRIVY_VERSION || PINNED.trivy.version).replace(/^v/, '');
}

async function fetchOne(key, version, dir) {
  const t = TARGETS[key];
  if (!t) { console.log(`skip ${key} (unsupported)`); return; }
  const outPath = path.join(dir, t.out);
  if (fs.existsSync(outPath)) { console.log(`✓ ${key} already present`); return; }
  fs.mkdirSync(dir, { recursive: true });
  const asset = `trivy_${version}_${t.asset}.${t.ext}`;
  const url = `https://github.com/aquasecurity/trivy/releases/download/v${version}/${asset}`;
  const archive = path.join(dir, asset);
  console.log(`↓ ${key}: ${url}`);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`download failed for ${key} (${r.status})`);
  const data = Buffer.from(await r.arrayBuffer());
  const { verifiedBy } = await verifyAsset({
    tool: 'trivy', version, asset, data,
    fetchPublished: async () => (await fetch(`https://github.com/aquasecurity/trivy/releases/download/v${version}/trivy_${version}_checksums.txt`, { redirect: 'follow' })).text(),
  });
  if (verifiedBy !== 'pinned') console.warn(`! trivy ${version} is not the pinned version; verified against its published checksum only`);
  fs.writeFileSync(archive, data);
  // bsdtar/libarchive (present on macOS/Linux/Win10+) extracts both .tar.gz and .zip.
  execFileSync('tar', t.ext === 'zip' ? ['-xf', archive, '-C', dir, t.out] : ['-xzf', archive, '-C', dir, 'trivy']);
  fs.chmodSync(outPath, 0o755);
  fs.unlinkSync(archive);
  console.log(`✓ ${key} → ${path.relative(ROOT, outPath)} (sha256 verified)`);
}

async function main() {
  const all = process.argv.includes('--all');
  const version = resolveVersion();
  console.log(`trivy v${version}`);
  if (all) {
    for (const key of Object.keys(TARGETS)) await fetchOne(key, version, path.join(BIN, key));
  } else {
    const key = `${process.platform}-${process.arch}`;
    await fetchOne(key, version, BIN); // current platform → bin/trivy
  }
}

main().catch((e) => { console.error(`fetch-trivy: ${e.message}`); process.exit(1); });
