// End-to-end check of the local API's access control: starts the real
// server.js on a spare port with a throwaway HOME, switches it to the demo
// cluster, and tries what an unauthorised local process, a DNS-rebinding page
// and an MCP client could do.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = 'a'.repeat(64);
let proc; let port; let home; let mcpToken;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const call = async (method, p, { token, host, body, origin } = {}) => {
  const headers = { ...(token ? { 'X-K8sight-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}) };
  // fetch() won't let us forge Host, so use a raw request for that case.
  if (host) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(`${method} ${p} HTTP/1.1\r\nHost: ${host}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}Connection: close\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('end', () => resolve({ status: Number(buf.split(' ')[1]), text: buf }));
      sock.on('error', reject);
    });
  }
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, text: await r.text() };
};

before(async () => {
  port = await freePort();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'k8sight-auth-test-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, HOME: home, KUBECONFIG: path.join(home, 'missing-kubeconfig'), K8SIGHT_PORT: String(port), K8SIGHT_API_TOKEN: UI, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await call('GET', '/api/version', { token: UI })).status === 200) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await call('POST', '/api/config/context', { token: UI, body: { contextName: 'demo-cluster' } })).status, 200);
  mcpToken = JSON.parse((await call('GET', '/api/mcp/info', { token: UI })).text).token;
});

after(() => { proc?.kill(); fs.rmSync(home, { recursive: true, force: true }); });

test('no token: API, MCP and cluster writes are refused', async () => {
  assert.equal((await call('GET', '/api/version')).status, 401);
  const r = await fetch(`http://127.0.0.1:${port}/api/version`);
  assert.equal(r.headers.get('x-k8sight-auth'), 'token-required', 'token failures are marked for the UI');
  assert.equal((await call('GET', '/api/resources/shop')).status, 401);
  assert.equal((await call('POST', '/api/scale/shop/deployment/frontend', { body: { replicas: 0 } })).status, 401);
  assert.equal((await call('POST', '/api/ai-agents/launch-external', { body: { agentId: 'x', command: 'id' } })).status, 401);
  assert.equal((await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })).status, 401);
});

test('DNS rebinding: a foreign Host is refused even with a matching Origin', async () => {
  const r = await call('GET', '/api/version', { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, token: UI });
  assert.equal(r.status, 421);
});

test('the UI token works; the static UI loads without one', async () => {
  assert.equal((await call('GET', '/api/version', { token: UI })).status, 200);
  assert.notEqual((await call('GET', '/')).status, 401);
});

test('MCP token: reads work, but no shells, local exec, writes or self-granted write access', async () => {
  assert.ok(mcpToken && mcpToken.length >= 32);
  assert.equal((await call('GET', '/api/resources/shop', { token: mcpToken })).status, 200);
  assert.equal((await call('POST', '/api/scale/shop/deployment/frontend', { token: mcpToken, body: { replicas: 0 } })).status, 403);
  assert.equal((await call('POST', '/api/exec/shop/frontend-7f9c6d5b4-fe001', { token: mcpToken, body: { command: 'id' } })).status, 403);
  assert.equal((await call('POST', '/api/ai-agents/launch-external', { token: mcpToken, body: { agentId: 'claude' } })).status, 403);
  assert.equal((await call('POST', '/api/mcp/config', { token: mcpToken, body: { allowWrite: true } })).status, 403);
  assert.equal((await call('POST', '/api/config/context', { token: mcpToken, body: { contextName: 'demo-cluster' } })).status, 403);
});

test('Secret values are redacted for the MCP token, not for the UI', async () => {
  const mcp = await call('GET', '/api/yaml/shop/secret/stripe-api-key', { token: mcpToken });
  assert.equal(mcp.status, 200);
  assert.ok(mcp.text.includes('redacted'), 'MCP sees <redacted>');
  const ui = await call('GET', '/api/yaml/shop/secret/stripe-api-key', { token: UI });
  assert.ok(!ui.text.includes('redacted'), 'UI sees the real (base64) values');
  const obj = JSON.parse((await call('GET', '/api/resource/shop/Secret/stripe-api-key', { token: mcpToken })).text);
  assert.ok(Object.values(obj.data || {}).every((v) => v === '<redacted>'));
});

test('enabling raw secret access (UI only) lifts the redaction', async () => {
  assert.equal((await call('POST', '/api/mcp/config', { token: UI, body: { allowSecrets: true } })).status, 200);
  const r = await call('GET', '/api/yaml/shop/secret/stripe-api-key', { token: mcpToken });
  assert.ok(!r.text.includes('redacted'));
  await call('POST', '/api/mcp/config', { token: UI, body: { allowSecrets: false } });
});

test('MCP over HTTP needs the MCP (or UI) token', async () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${mcpToken}` },
    body: JSON.stringify(init),
  });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('mcp-session-id'));
});

test('the exec WebSocket requires the UI token (MCP token refused)', async () => {
  const tryWs = (token) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/exec?namespace=shop&pod=x${token ? `&token=${token}` : ''}`);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
  assert.notEqual(await tryWs(null), 'open');
  assert.notEqual(await tryWs(mcpToken), 'open');
  assert.equal(await tryWs(UI), 'open');
});

test('the MCP token is persisted with owner-only permissions', () => {
  const file = path.join(home, '.config', 'k8s-manager', 'settings.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpToken, mcpToken);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
