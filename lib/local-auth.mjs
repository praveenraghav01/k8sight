// Access control for the local backend (REST, /ws/exec, /mcp).
//
// The backend listens on loopback, but loopback is not a security boundary:
// any local process (or another OS user, or a DNS-rebinding web page) can
// connect. So every API, WebSocket and MCP request must carry a token:
//
//   - the UI token: random per launch. The desktop app gets it from the
//     Electron main process over IPC; browser/Docker users get it from the
//     startup URL the server prints (`/?token=…`), like Jupyter.
//   - the MCP token: persisted in ~/.config/k8s-manager/settings.json (0600) so
//     agent configs survive restarts. Shown in Preferences → MCP Server.
//
// The MCP token is a *restricted* scope: read endpoints only, cluster writes
// only when "Read & write" is enabled, and never local command execution,
// interactive shells, kubeconfig loading or the app's own settings.
import { timingSafeEqual, randomBytes } from 'crypto';

export const TOKEN_HEADER = 'x-k8sight-token';

export const newToken = () => randomBytes(32).toString('hex');

const sameToken = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Pull a presented token from a header, an `Authorization: Bearer` header, or
// (for WebSockets and the first page load, which can't set headers) `?token=`.
export function presentedToken(headers = {}, url = '') {
  const h = headers[TOKEN_HEADER];
  if (typeof h === 'string' && h) return h;
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  try {
    const q = new URL(url, 'http://local').searchParams.get('token');
    if (q) return q;
  } catch { /* ignore */ }
  return null;
}

// 'ui' | 'mcp' | null
export function scopeFor(token, { uiToken, mcpToken }) {
  if (sameToken(token, uiToken)) return 'ui';
  if (sameToken(token, mcpToken)) return 'mcp';
  return null;
}

// DNS rebinding defence: only accept requests addressed to a loopback name,
// plus any hosts the operator lists in ALLOWED_HOSTS (e.g. behind a proxy).
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export function hostAllowed(hostHeader, extraHosts = []) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  let name;
  try { name = new URL(`http://${hostHeader}`).hostname.toLowerCase(); } catch { return false; }
  if (LOOPBACK_NAMES.has(name)) return true;
  return extraHosts.some((h) => h.toLowerCase() === name || h.toLowerCase() === hostHeader.toLowerCase());
}

// Endpoints the MCP scope may never use, regardless of write access: local
// command execution, kubeconfig loading from arbitrary paths, the assistant and
// agent launchers, and the app's own MCP/assistant configuration (so an agent
// can't grant itself write access or read the LLM key).
const MCP_DENY = [
  /^\/api\/exec\b/,
  /^\/api\/portforward\b/,
  /^\/api\/ai-agents\b/,
  /^\/api\/assistant\b/,
  /^\/api\/mcp\b/,
  /^\/api\/config\/(load|reload|auth)\b/,
  /^\/api\/(aws|azure|gke)\b/,
];

// Non-GET endpoints the MCP scope may call even when write access is off:
// they don't change the cluster.
const MCP_SAFE_POSTS = [
  /^\/api\/security\/scan$/,
];

// Decide whether a request in the given scope may proceed.
// Returns { ok: true } or { ok: false, status, error }.
export function authorize({ scope, method, path, mcpAllowWrite }) {
  if (scope === 'ui') return { ok: true };
  if (scope !== 'mcp') return { ok: false, status: 401, error: 'Missing or invalid k8sight token' };
  if (path === '/mcp' || path.startsWith('/mcp/')) return { ok: true };
  if (path.startsWith('/ws/')) return { ok: false, status: 403, error: 'Interactive shells are not available to MCP clients' };
  if (MCP_DENY.some((re) => re.test(path))) return { ok: false, status: 403, error: 'This endpoint is not available to MCP clients' };
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return { ok: true };
  if (MCP_SAFE_POSTS.some((re) => re.test(path))) return { ok: true };
  if (!mcpAllowWrite) return { ok: false, status: 403, error: 'MCP write access is off. Enable "Read & write" in Preferences → MCP Server.' };
  return { ok: true };
}
