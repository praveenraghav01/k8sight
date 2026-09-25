// Guard for the Google OAuth token exchange used by the GKE integration.
//
// A service-account key's `token_uri` is user-supplied. The token exchange POSTs
// a signed JWT assertion (a bearer credential) to that endpoint, so a tampered
// key could point it at an attacker host to capture the assertion (SSRF /
// credential exfiltration). Service-account keys always use Google's fixed token
// endpoint, so we:
//   1. POST only ever to GOOGLE_TOKEN_URI (a constant — never a value derived
//      from the key file), and
//   2. assert the key's declared token_uri is a Google endpoint, rejecting a
//      tampered key loudly instead of silently ignoring it.
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const isGoogleHost = (host) => host === 'googleapis.com' || host.endsWith('.googleapis.com');

// Throw if a key declares a non-Google (or malformed) token endpoint. A missing
// token_uri is fine — callers fall back to GOOGLE_TOKEN_URI.
export function assertGoogleTokenUri(uri) {
  if (!uri) return;
  let u;
  try { u = new URL(uri); } catch { throw new Error(`Invalid token_uri: ${uri}`); }
  if (u.protocol !== 'https:' || !isGoogleHost(u.hostname.toLowerCase())) {
    throw new Error(`Refusing non-Google token endpoint: ${u.origin}`);
  }
}
