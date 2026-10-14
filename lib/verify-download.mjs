// Integrity checks for third-party binaries k8sight downloads (Trivy, Helm).
//
// Versions are pinned in lib/pinned-tools.json together with the SHA-256 of
// every platform asset, committed to this repository. A download of the pinned
// version must match that hash, so a tampered or replaced upstream release is
// rejected. Overriding the version (e.g. TRIVY_VERSION) falls back to the
// checksum file published with that release, with a warning.
import fs from 'fs';
import { createHash } from 'crypto';

export const PINNED = JSON.parse(fs.readFileSync(new URL('./pinned-tools.json', import.meta.url), 'utf8'));

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Expected hash for an asset from a "<hash>  <file>" checksum listing.
export function hashFromListing(text, asset) {
  for (const line of String(text).split('\n')) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file && file.replace(/^\*/, '') === asset && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
}

// Verify `data` for `tool`/`asset`. `fetchPublished` returns the release's own
// checksum text, used only when the version isn't the pinned one.
export async function verifyAsset({ tool, version, asset, data, fetchPublished }) {
  const actual = sha256(data);
  const pin = PINNED[tool];
  if (pin && pin.version === version) {
    const expected = pin.sha256[asset];
    if (!expected) throw new Error(`No pinned checksum for ${asset}; add it to lib/pinned-tools.json.`);
    if (actual !== expected) throw new Error(`${asset} failed checksum verification (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…).`);
    return { verifiedBy: 'pinned' };
  }
  if (!fetchPublished) throw new Error(`${tool} ${version} is not the pinned version and no published checksum is available.`);
  const expected = hashFromListing(await fetchPublished(), asset);
  if (!expected) throw new Error(`No published checksum for ${asset}.`);
  if (actual !== expected) throw new Error(`${asset} failed checksum verification against the published checksum.`);
  return { verifiedBy: 'published' };
}
