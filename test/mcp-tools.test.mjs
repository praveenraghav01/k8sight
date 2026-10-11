// End-to-end tests for the MCP tools: a real MCP client talks to
// createMcpServer() in memory, and the tools call a throwaway HTTP server that
// answers /api/* from the demo cluster (demo.js), the same data the app's demo
// mode uses. No kubeconfig or running app needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp.js';
import { handle } from '../demo.js';

let httpServer;
let baseURL;

// Minimal Express-style adapter so demo.handle() can answer real HTTP requests.
const demoApi = (req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const shim = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : {} };
    let status = 200;
    const out = {
      status(c) { status = c; return this; },
      json(o) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); return this; },
    };
    if (!handle(shim, out)) { res.writeHead(404); res.end('{"error":"not handled by demo"}'); }
  });
};

const connect = async (allowWrite) => {
  const server = createMcpServer({ baseURL, allowWrite });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return client;
};

const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || '';
  assert.ok(!r.isError, `${name} failed: ${text}`);
  return JSON.parse(text.startsWith('{') || text.startsWith('[') ? text : JSON.stringify(text));
};

before(async () => {
  httpServer = http.createServer(demoApi);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => new Promise((r) => httpServer.close(r)));

test('read-only server exposes the new read tools and no write tools', async () => {
  const client = await connect(false);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['get_security_status', 'list_vulnerable_images', 'get_image_vulnerabilities', 'list_security_checks',
    'start_security_scan', 'get_flux_overview', 'list_flux_resources', 'get_flux_resource',
    'list_flagger_canaries', 'get_flagger_canary', 'get_cost_timeseries', 'list_argocd_apps']) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
  for (const t of ['reconcile_flux_resource', 'suspend_flux_resource', 'restart_canary', 'suspend_canary', 'set_canary_skip_analysis', 'sync_argocd_app']) {
    assert.ok(!names.includes(t), `${t} must be gated behind write access`);
  }
});

test('security tools summarise images and drill into one', async () => {
  const client = await connect(false);
  const list = await call(client, 'list_vulnerable_images', { minSeverity: 'CRITICAL', limit: 5 });
  assert.ok(list.images.length > 0 && list.images.length <= 5);
  assert.ok(list.images.every((im) => im.summary.CRITICAL > 0));
  assert.ok(!('vulnerabilities' in list.images[0]), 'the list must not include full CVE lists');
  const detail = await call(client, 'get_image_vulnerabilities', { image: list.images[0].image, minSeverity: 'HIGH', limit: 10 });
  assert.ok(detail.vulnerabilities.length > 0 && detail.vulnerabilities.length <= 10);
  assert.ok(detail.vulnerabilities.every((v) => ['CRITICAL', 'HIGH'].includes(v.severity)));
  const checks = await call(client, 'list_security_checks', { kind: 'rbac' });
  assert.ok(checks.resourceCount > 0 && checks.resources[0].checks.length > 0);
});

test('Flux and Flagger read tools return demo resources', async () => {
  const client = await connect(false);
  const overview = await call(client, 'get_flux_overview');
  assert.equal(overview.installed, true);
  assert.ok(overview.attention.some((r) => r.name === 'dummy-app-1'));
  const ks = await call(client, 'list_flux_resources', { kind: 'kustomization' });
  assert.ok(ks.some((r) => r.name === 'podinfo'));
  const ksDetail = await call(client, 'get_flux_resource', { kind: 'kustomization', namespace: 'flux-system', name: 'dummy-app-1' });
  assert.ok(ksDetail.events.length > 0);
  const canaries = await call(client, 'list_flagger_canaries');
  assert.ok(canaries.find((c) => c.name === 'frontend' && c.phase === 'Progressing'));
  const canary = await call(client, 'get_flagger_canary', { namespace: 'shop', name: 'frontend' });
  assert.ok(canary.analysis.metrics.length > 0 && canary.generated.length > 0);
});

test('cost timeseries returns a series', async () => {
  const client = await connect(false);
  const ts = await call(client, 'get_cost_timeseries', { window: '7d' });
  assert.ok(Array.isArray(ts.series) && ts.series.length > 0);
});

test('write tools act on Flux and Flagger when write access is on', async () => {
  const client = await connect(true);
  await call(client, 'suspend_flux_resource', { kind: 'kustomization', namespace: 'flux-system', name: 'dummy-app-2', suspend: true });
  let ks = await call(client, 'list_flux_resources', { kind: 'kustomization' });
  assert.equal(ks.find((r) => r.name === 'dummy-app-2').state, 'Suspended');
  await call(client, 'suspend_flux_resource', { kind: 'kustomization', namespace: 'flux-system', name: 'dummy-app-2', suspend: false });
  await call(client, 'reconcile_flux_resource', { kind: 'kustomization', namespace: 'flux-system', name: 'dummy-app-2' });
  ks = await call(client, 'list_flux_resources', { kind: 'kustomization' });
  assert.equal(ks.find((r) => r.name === 'dummy-app-2').state, 'Ready');

  await call(client, 'set_canary_skip_analysis', { namespace: 'shop', name: 'checkout', skip: true });
  await call(client, 'restart_canary', { namespace: 'shop', name: 'checkout' });
  const c = await call(client, 'get_flagger_canary', { namespace: 'shop', name: 'checkout' });
  assert.equal(c.summary.phase, 'Succeeded', 'skipAnalysis + restart promotes straight away');
});
