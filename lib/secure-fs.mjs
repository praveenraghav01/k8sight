// Owner-only file writes for credentials and kubeconfigs.
//
// fs.writeFileSync's `mode` only applies when a file is *created*; an existing
// ~/.aws/credentials or kubeconfig keeps whatever permissions it had (often
// 0644). These helpers always leave the file at 0600 and create missing
// parent directories as 0700. No-ops for permissions on Windows, which uses
// ACLs inherited from the user profile.
import fs from 'fs';
import os from 'os';
import path from 'path';

const posix = process.platform !== 'win32';

export function ensurePrivateDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function writePrivateFile(file, data, encoding = 'utf8') {
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, data, { encoding, mode: 0o600 });
  if (posix) fs.chmodSync(file, 0o600);
}

// Tighten permissions on files the app owns that may predate these rules.
// Best-effort: missing files and permission errors are ignored.
export function hardenAppFiles(home = os.homedir()) {
  if (!posix) return [];
  const base = path.join(home, '.config', 'k8s-manager');
  const fixed = [];
  const tighten = (p, mode) => {
    try {
      const st = fs.statSync(p);
      if ((st.mode & 0o777) !== mode) { fs.chmodSync(p, mode); fixed.push(p); }
    } catch { /* missing or not ours */ }
  };
  tighten(base, 0o700);
  for (const f of ['settings.json', 'config.json', 'azure-auth.json']) tighten(path.join(base, f), 0o600);
  tighten(path.join(base, 'gke'), 0o700);
  tighten(path.join(base, 'gke', 'credentials.json'), 0o600);
  const scans = path.join(base, 'security-scans');
  tighten(scans, 0o700);
  try { for (const f of fs.readdirSync(scans)) tighten(path.join(scans, f), 0o600); } catch { /* none */ }
  return fixed;
}
