// Bundle the cloud token exec-plugin helpers into self-contained CommonJS files.
//
// These helpers are written into the user's kubeconfig as `exec` credential
// plugins and spawned as separate processes (by our backend, kubectl, k9s, …)
// to mint EKS/AKS tokens. Once the app ships with `asar: true`, a plain
// `eks-token.js` could no longer resolve its @aws-sdk imports (they live inside
// app.asar). Bundling each helper into one dependency-free .cjs under
// dist-helpers/ (which packaging marks asarUnpack) keeps them runnable as
// standalone child processes with nothing to resolve at runtime.
import { build } from 'esbuild';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist-helpers');
mkdirSync(outdir, { recursive: true });

const entries = ['eks-token.js', 'azure-token.js', 'gke-token.js'];

await build({
  entryPoints: entries.map((e) => path.join(root, e)),
  outdir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  legalComments: 'none',
  // Optional AWS CRT peer dep, only used for multi-region SigV4a (signingRegion
  // '*'), which EKS token minting never hits and which isn't installed. Mark it
  // external so it's an explicit, intentional skip rather than a bundler warning.
  external: ['@aws-sdk/signature-v4-crt'],
  logLevel: 'info',
});

console.log(`[bundle] token helpers -> ${path.relative(root, outdir)}/ (${entries.join(', ')})`);
