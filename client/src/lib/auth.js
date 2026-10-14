// API token for the local backend. Every /api, /mcp and /ws request must
// carry it (see lib/local-auth.mjs on the server).
//
//   - Desktop app: the Electron main process hands it over via the preload
//     bridge (window.k8sight.apiToken).
//   - Browser / Docker: the server prints `http://…/?token=…` at startup. We
//     read it from the URL once, keep it in sessionStorage for reloads, and
//     strip it from the address bar so it doesn't linger in history.
import axios from 'axios';

export const TOKEN_HEADER = 'X-K8sight-Token';
const STORE_KEY = 'k8sight.apiToken';

function readToken() {
  const fromElectron = typeof window !== 'undefined' && window.k8sight?.apiToken;
  if (fromElectron) return fromElectron;
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      try { sessionStorage.setItem(STORE_KEY, fromUrl); } catch { /* ignore */ }
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      return fromUrl;
    }
  } catch { /* ignore */ }
  try { return sessionStorage.getItem(STORE_KEY); } catch { return null; }
}

export const apiToken = readToken();

const sameOrigin = (input) => {
  try {
    const raw = typeof input === 'string' ? input : input?.url;
    return new URL(raw, window.location.href).origin === window.location.origin;
  } catch { return false; }
};

// Listeners told when the backend rejects our token (missing, or stale after
// a server restart in browser mode).
const failureListeners = new Set();
export const onAuthFailure = (fn) => { failureListeners.add(fn); return () => failureListeners.delete(fn); };
const authFailed = () => failureListeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

axios.interceptors.response.use(undefined, (err) => {
  if (err?.response?.status === 401 && err.response.headers?.['x-k8sight-auth'] === 'token-required') authFailed();
  return Promise.reject(err);
});

if (apiToken) {
  axios.defaults.headers.common[TOKEN_HEADER] = apiToken;
  // Same-origin fetch() calls (assistant streaming, MCP test, etc.).
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    if (!sameOrigin(input)) return nativeFetch(input, init);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has(TOKEN_HEADER)) headers.set(TOKEN_HEADER, apiToken);
    return nativeFetch(input, { ...init, headers }).then((r) => { if (r.status === 401 && r.headers.get('x-k8sight-auth') === 'token-required') authFailed(); return r; });
  };
}

// WebSocket URL for a backend path, with the token as a query parameter
// (browsers can't set headers on WebSocket handshakes).
export function wsUrl(path, params = new URLSearchParams()) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const p = new URLSearchParams(params);
  if (apiToken) p.set('token', apiToken);
  return `${proto}://${window.location.host}${path}?${p.toString()}`;
}

export const hasApiToken = !!apiToken;
