// Redaction for data handed to MCP clients (external AI agents).
//
// Kubernetes Secret values and secret-looking Helm values are replaced with a
// placeholder unless the user explicitly allows raw secret access in
// Preferences → MCP Server. Key names are kept so an agent can still reason
// about *which* secrets exist.
import yaml from 'js-yaml';

export const REDACTED = '<redacted>';

const isSecretKind = (obj) => obj && typeof obj === 'object' && String(obj.kind || '').toLowerCase() === 'secret';

const maskValues = (map) => (map && typeof map === 'object'
  ? Object.fromEntries(Object.keys(map).map((k) => [k, REDACTED]))
  : map);

// A Kubernetes object (or a List of them). Returns a redacted copy.
export function redactSecretObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSecretObject);
  if (Array.isArray(obj.items)) return { ...obj, items: obj.items.map(redactSecretObject) };
  if (!isSecretKind(obj)) return obj;
  const out = { ...obj };
  if (out.data) out.data = maskValues(out.data);
  if (out.stringData) out.stringData = maskValues(out.stringData);
  // kubectl apply keeps a full copy of the object, values included, here.
  const ann = out.metadata?.annotations;
  if (ann && ann['kubectl.kubernetes.io/last-applied-configuration']) {
    out.metadata = { ...out.metadata, annotations: { ...ann, 'kubectl.kubernetes.io/last-applied-configuration': REDACTED } };
  }
  return out;
}

// YAML text with one or more documents (resource YAML, Helm manifests).
export function redactSecretYaml(text) {
  if (typeof text !== 'string' || !/kind:\s*["']?Secret\b/i.test(text)) return text;
  try {
    const docs = yaml.loadAll(text);
    if (!docs.some(isSecretKind) && !docs.some((d) => Array.isArray(d?.items) && d.items.some(isSecretKind))) return text;
    return docs
      .map((d) => (d == null ? '' : yaml.dump(redactSecretObject(d), { lineWidth: -1, noRefs: true })))
      .filter(Boolean)
      .join('---\n');
  } catch {
    // Unparseable but mentions a Secret: fail closed.
    return `# ${REDACTED}: this document contains a Secret and could not be parsed for safe redaction.\n`;
  }
}

// Helm values: mask scalar values under secret-looking keys, at any depth.
const SENSITIVE_KEY = /(pass(word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credential|auth[-_]?key|cert(ificate)?[-_]?key|connection[-_]?string|dsn|webhook[-_]?url)/i;

function maskSensitive(node) {
  if (Array.isArray(node)) return node.map(maskSensitive);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => {
    if (SENSITIVE_KEY.test(k) && v != null && typeof v !== 'object' && v !== '') return [k, REDACTED];
    return [k, maskSensitive(v)];
  }));
}

export function redactHelmValues(text) {
  if (typeof text !== 'string' || !text.trim()) return text;
  try {
    const parsed = yaml.load(text);
    if (!parsed || typeof parsed !== 'object') return text;
    return yaml.dump(maskSensitive(parsed), { lineWidth: -1, noRefs: true });
  } catch {
    return `# ${REDACTED}: Helm values could not be parsed for safe redaction.\n`;
  }
}

// Apply the right redaction to an API response, by route. `body` is what the
// handler passed to res.json().
export function redactApiResponse(path, body) {
  if (!body || typeof body !== 'object') return body;
  if (/^\/api\/resource\//.test(path)) return redactSecretObject(body);
  if (/^\/api\/yaml\//.test(path) && typeof body.yaml === 'string') return { ...body, yaml: redactSecretYaml(body.yaml) };
  if (/^\/api\/helm\/releases\/[^/]+\/[^/]+\/values$/.test(path) && typeof body.yaml === 'string') return { ...body, yaml: redactHelmValues(body.yaml) };
  if (/^\/api\/helm\/releases\/[^/]+\/[^/]+\/manifest$/.test(path) && typeof body.yaml === 'string') return { ...body, yaml: redactSecretYaml(body.yaml) };
  if (/^\/api\/(customresource|resources)\//.test(path)) return redactSecretObject(body);
  return body;
}
