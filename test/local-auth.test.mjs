// Unit tests for the local API access policy (lib/local-auth.mjs) and the
// MCP redaction rules (lib/redact.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentedToken, scopeFor, hostAllowed, authorize } from '../lib/local-auth.mjs';
import { redactSecretObject, redactSecretYaml, redactHelmValues, redactApiResponse, REDACTED } from '../lib/redact.mjs';

const tokens = { uiToken: 'u'.repeat(64), mcpToken: 'm'.repeat(64) };

test('tokens are read from the header, Bearer auth or ?token=', () => {
  assert.equal(presentedToken({ 'x-k8sight-token': 'a' }), 'a');
  assert.equal(presentedToken({ authorization: 'Bearer b' }), 'b');
  assert.equal(presentedToken({}, '/ws/exec?pod=x&token=c'), 'c');
  assert.equal(presentedToken({}, '/api/version'), null);
});

test('scope is ui, mcp or null; near-misses are rejected', () => {
  assert.equal(scopeFor(tokens.uiToken, tokens), 'ui');
  assert.equal(scopeFor(tokens.mcpToken, tokens), 'mcp');
  assert.equal(scopeFor(null, tokens), null);
  assert.equal(scopeFor('', tokens), null);
  assert.equal(scopeFor(tokens.uiToken.slice(1), tokens), null);
});

test('Host allow-list blocks DNS-rebinding hostnames', () => {
  for (const h of ['127.0.0.1:3001', 'localhost:3001', 'localhost:8080', '[::1]:3001', 'LOCALHOST:3001']) assert.ok(hostAllowed(h), h);
  for (const h of ['evil.example:3001', 'evil.example', '127.0.0.1.nip.io:3001', '', undefined]) assert.ok(!hostAllowed(h), String(h));
  assert.ok(hostAllowed('k8s.internal:443', ['k8s.internal']));
});

test('no token: everything under /api, /mcp and /ws is refused', () => {
  for (const path of ['/api/version', '/api/resources/default', '/mcp', '/ws/exec']) {
    assert.equal(authorize({ scope: null, method: 'GET', path }).status, 401, path);
  }
});

test('MCP scope: reads allowed; shells, local exec and app settings never', () => {
  const mcp = (method, path, mcpAllowWrite = true) => authorize({ scope: 'mcp', method, path, mcpAllowWrite });
  assert.ok(mcp('GET', '/api/resources/default').ok);
  assert.ok(mcp('POST', '/mcp').ok);
  for (const [m, p] of [['GET', '/ws/exec'], ['POST', '/api/exec/default/pod'], ['POST', '/api/portforward'],
    ['POST', '/api/ai-agents/launch-external'], ['GET', '/api/ai-agents'], ['POST', '/api/mcp/config'],
    ['POST', '/api/mcp/token/rotate'], ['GET', '/api/mcp/info'], ['GET', '/api/assistant/status'],
    ['POST', '/api/config/load'], ['POST', '/api/aws/configure']]) {
    assert.equal(mcp(m, p).ok, false, `${m} ${p}`);
  }
});

test('MCP scope: cluster writes and context switches need write access', () => {
  for (const [m, p] of [['POST', '/api/apply'], ['DELETE', '/api/resource/default/pod/x'], ['POST', '/api/scale/default/deployment/x'], ['POST', '/api/config/context']]) {
    assert.equal(authorize({ scope: 'mcp', method: m, path: p, mcpAllowWrite: false }).status, 403, `${m} ${p}`);
    assert.ok(authorize({ scope: 'mcp', method: m, path: p, mcpAllowWrite: true }).ok, `${m} ${p}`);
  }
  assert.ok(authorize({ scope: 'mcp', method: 'POST', path: '/api/security/scan', mcpAllowWrite: false }).ok);
});

test('UI scope can do everything', () => {
  assert.ok(authorize({ scope: 'ui', method: 'POST', path: '/api/exec/default/pod' }).ok);
});

const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"k":"c2VjcmV0"}}' } }, data: { k: 'c2VjcmV0' }, stringData: { p: 'plain' } };

test('Secret objects keep keys but lose values (including last-applied copy)', () => {
  const r = redactSecretObject(secret);
  assert.deepEqual(r.data, { k: REDACTED });
  assert.deepEqual(r.stringData, { p: REDACTED });
  assert.equal(r.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'], REDACTED);
  assert.equal(secret.data.k, 'c2VjcmV0', 'input is not mutated');
  assert.deepEqual(redactSecretObject({ kind: 'ConfigMap', data: { a: '1' } }).data, { a: '1' });
});

test('multi-document YAML: only Secret documents are redacted', () => {
  const manifest = 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\ndata: {a: "1"}\n---\napiVersion: v1\nkind: Secret\nmetadata: {name: s}\ndata: {k: c2VjcmV0}\n';
  const out = redactSecretYaml(manifest);
  assert.ok(!out.includes('c2VjcmV0'));
  assert.ok(out.includes(REDACTED));
  assert.ok(out.includes('a: \'1\'') || out.includes('a: "1"'), 'ConfigMap untouched');
  assert.match(redactSecretYaml('kind: Secret\ndata: [unclosed'), /could not be parsed/);
});

test('Helm values: secret-looking keys masked at any depth', () => {
  const out = redactHelmValues('replicas: 2\npostgresql:\n  auth:\n    password: hunter2\n    username: app\napiKey: abc\nimage: {tag: "1.0"}\n');
  assert.ok(!out.includes('hunter2') && !out.includes('abc'));
  assert.ok(out.includes('username: app') && out.includes('replicas: 2'));
});

test('redactApiResponse routes by endpoint', () => {
  assert.equal(redactApiResponse('/api/resource/ns/Secret/s', secret).data.k, REDACTED);
  assert.ok(!redactApiResponse('/api/yaml/ns/secret/s', { yaml: 'kind: Secret\ndata: {k: c2VjcmV0}\n' }).yaml.includes('c2VjcmV0'));
  assert.ok(!redactApiResponse('/api/helm/releases/ns/r/values', { yaml: 'password: x1\n' }).yaml.includes('x1'));
  assert.deepEqual(redactApiResponse('/api/events/all', { events: [1] }), { events: [1] });
});
