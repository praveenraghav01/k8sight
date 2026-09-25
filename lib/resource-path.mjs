import path from 'path';
import { fileURLToPath } from 'url';

// A file shipped via electron-builder's `asarUnpack` is still referenced, from
// code running inside the archive, through a virtual `.../app.asar/<file>` path
// (that's what `__dirname` / import.meta.url resolve to). A *spawned child
// process* can't read a path inside the archive, so rewrite it to the real
// on-disk `app.asar.unpacked` location. No-op for any path not in an asar.
export function unpackedPath(p) {
  return p.replace(/app\.asar(?!\.unpacked)([\\/])/, 'app.asar.unpacked$1');
}

// Resolve a cloud token exec-plugin helper (eks-token / azure-token / gke-token)
// to a real, spawnable file, correct in every build:
//   - Packaged with asar: the raw ESM source can't be spawned from inside the
//     archive, so we ship a bundled, dependency-free `.cjs` under dist-helpers/
//     (marked asarUnpack) and point at its real on-disk location.
//   - Dev (`npm run dev`) and asar:false builds: run the raw `.js` source, which
//     sits next to its node_modules and needs no bundle.
// The kubeconfig exec entries these produce are read by our backend, kubectl and
// k9s alike, so the path must be valid for whoever runs it.
export function tokenHelperPath(fromUrl, baseName) {
  const dir = path.dirname(fileURLToPath(fromUrl));
  if (dir.includes('.asar')) {
    return unpackedPath(path.join(dir, 'dist-helpers', `${baseName}.cjs`));
  }
  return path.join(dir, `${baseName}.js`);
}
