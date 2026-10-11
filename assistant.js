// AI assistant — an agentic, READ-ONLY Kubernetes debugging helper.
//
// Provider-agnostic: it talks to any OpenAI-compatible Chat Completions API
// (TrueFoundry LLM Gateway, OpenAI, Azure OpenAI, LiteLLM, vLLM, Ollama, …).
// The user supplies a base URI, an API key, and a model name — in the chat
// panel or via env (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, which take
// precedence). Saved config is persisted locally to
// ~/.config/k8s-manager/config.json (chmod 600).
//
// The model investigates the cluster via the read-only tools below (function
// calling) and its answer is streamed back to the browser over SSE. Nothing
// here can mutate the cluster; Secret values are redacted before they leave
// the server.
import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_TOOL_ITERATIONS = 12;
const MAX_TOOL_OUTPUT = 14000; // chars — keep tool results bounded

// --- persisted config (used only when env vars are not set) ----------
const CONFIG_DIR = path.join(os.homedir(), '.config', 'k8s-manager');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const readConfig = () => {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; }
};
const writeConfig = (cfg) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
};

let stored = readConfig().llm || null; // { baseUrl, apiKey, model }

const envConfig = () => {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  return baseUrl && apiKey && model ? { baseUrl, apiKey, model } : null;
};
const config = () => envConfig() || stored;
const source = () => (envConfig() ? 'env' : stored ? 'stored' : null);
const configured = () => !!config()?.baseUrl && !!config()?.apiKey && !!config()?.model;

// Strip trailing slashes without a backtracking regex (avoids polynomial ReDoS
// on attacker-influenced input).
const stripTrailingSlashes = (s) => {
  let i = s.length;
  while (i > 0 && s[i - 1] === '/') i--;
  return s.slice(0, i);
};

// Normalize a base URL to a chat-completions endpoint.
const completionsUrl = (base) => {
  const b = stripTrailingSlashes(String(base || '').trim());
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
};

// --- helpers ---------------------------------------------------------
const truncate = (s, n = MAX_TOOL_OUTPUT) =>
  typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;

const stripHeavy = (obj) => {
  if (obj?.metadata) {
    delete obj.metadata.managedFields;
    delete obj.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration'];
  }
  return obj;
};

const redactSecret = (obj) => {
  if (obj?.kind === 'Secret' || obj?.data) {
    if (obj.data) obj.data = Object.fromEntries(Object.keys(obj.data).map((k) => [k, '<redacted>']));
    if (obj.stringData) obj.stringData = Object.fromEntries(Object.keys(obj.stringData).map((k) => [k, '<redacted>']));
  }
  return obj;
};

export function registerAssistant(app, deps) {
  const { k8s, getKubeConfig, getCurrentContext, helmReleases } = deps;

  const core = () => getKubeConfig().makeApiClient(k8s.CoreV1Api);
  const apps = () => getKubeConfig().makeApiClient(k8s.AppsV1Api);
  const batch = () => getKubeConfig().makeApiClient(k8s.BatchV1Api);
  const net = () => getKubeConfig().makeApiClient(k8s.NetworkingV1Api);

  // ---- read-only tool implementations ---------------------------------
  const impls = {
    async list_namespaces() {
      const body = await core().listNamespace();
      return body.items.map((n) => ({ name: n.metadata.name, status: n.status?.phase }));
    },

    async list_resources({ namespace, kind }) {
      const ns = namespace;
      const k = String(kind || '').toLowerCase();
      const items = async () => {
        switch (k) {
          case 'pod': case 'pods': return (await core().listNamespacedPod({ namespace: ns })).items.map((p) => ({
            name: p.metadata.name, phase: p.status?.phase,
            ready: `${(p.status?.containerStatuses || []).filter((c) => c.ready).length}/${(p.status?.containerStatuses || []).length}`,
            restarts: (p.status?.containerStatuses || []).reduce((a, c) => a + (c.restartCount || 0), 0),
            node: p.spec?.nodeName,
            reason: p.status?.reason || (p.status?.containerStatuses || []).map((c) => c.state?.waiting?.reason).find(Boolean),
          }));
          case 'deployment': case 'deployments': return (await apps().listNamespacedDeployment({ namespace: ns })).items.map((d) => ({
            name: d.metadata.name, ready: `${d.status?.readyReplicas || 0}/${d.status?.replicas || 0}`, available: d.status?.availableReplicas || 0,
          }));
          case 'statefulset': case 'statefulsets': return (await apps().listNamespacedStatefulSet({ namespace: ns })).items.map((d) => ({ name: d.metadata.name, ready: `${d.status?.readyReplicas || 0}/${d.status?.replicas || 0}` }));
          case 'daemonset': case 'daemonsets': return (await apps().listNamespacedDaemonSet({ namespace: ns })).items.map((d) => ({ name: d.metadata.name, ready: `${d.status?.numberReady || 0}/${d.status?.desiredNumberScheduled || 0}` }));
          case 'replicaset': case 'replicasets': return (await apps().listNamespacedReplicaSet({ namespace: ns })).items.map((d) => ({ name: d.metadata.name, ready: `${d.status?.readyReplicas || 0}/${d.status?.replicas || 0}` }));
          case 'service': case 'services': return (await core().listNamespacedService({ namespace: ns })).items.map((s) => ({ name: s.metadata.name, type: s.spec?.type, clusterIP: s.spec?.clusterIP, ports: (s.spec?.ports || []).map((p) => `${p.port}/${p.protocol}`) }));
          case 'job': case 'jobs': return (await batch().listNamespacedJob({ namespace: ns })).items.map((j) => ({ name: j.metadata.name, succeeded: j.status?.succeeded || 0, failed: j.status?.failed || 0, active: j.status?.active || 0 }));
          case 'cronjob': case 'cronjobs': return (await batch().listNamespacedCronJob({ namespace: ns })).items.map((j) => ({ name: j.metadata.name, schedule: j.spec?.schedule, suspend: j.spec?.suspend, lastSchedule: j.status?.lastScheduleTime }));
          case 'configmap': case 'configmaps': return (await core().listNamespacedConfigMap({ namespace: ns })).items.map((c) => ({ name: c.metadata.name, keys: Object.keys(c.data || {}) }));
          case 'secret': case 'secrets': return (await core().listNamespacedSecret({ namespace: ns })).items.map((s) => ({ name: s.metadata.name, type: s.type, keys: Object.keys(s.data || {}) })); // values never returned
          case 'ingress': case 'ingresses': return (await net().listNamespacedIngress({ namespace: ns })).items.map((i) => ({ name: i.metadata.name, hosts: (i.spec?.rules || []).map((r) => r.host) }));
          case 'pvc': case 'persistentvolumeclaim': case 'persistentvolumeclaims': return (await core().listNamespacedPersistentVolumeClaim({ namespace: ns })).items.map((p) => ({ name: p.metadata.name, status: p.status?.phase, capacity: p.status?.capacity?.storage, storageClass: p.spec?.storageClassName }));
          default: throw new Error(`Unsupported kind "${kind}". Supported: pod, deployment, statefulset, daemonset, replicaset, service, job, cronjob, configmap, secret, ingress, pvc.`);
        }
      };
      const list = await items();
      return { namespace: ns, kind, count: list.length, items: list };
    },

    async get_pod_logs({ namespace, pod, container, tailLines }) {
      const tl = Math.min(Number(tailLines) || 200, 1000);
      const body = await core().readNamespacedPodLog({ name: pod, namespace, container: container || undefined, tailLines: tl });
      return truncate(body || '(no logs)');
    },

    async get_events({ namespace }) {
      const resp = namespace ? await core().listNamespacedEvent({ namespace }) : await core().listEventForAllNamespaces();
      const events = resp.items
        .map((e) => ({
          ns: e.metadata?.namespace, type: e.type, reason: e.reason,
          object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
          message: e.message, count: e.count,
          last: e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp,
        }))
        .sort((a, b) => new Date(b.last || 0) - new Date(a.last || 0))
        .slice(0, 60);
      return { count: events.length, events };
    },

    async describe_resource({ namespace, kind, name }) {
      const ns = namespace;
      const k = String(kind || '').toLowerCase();
      const read = async () => {
        switch (k) {
          case 'pod': return (await core().readNamespacedPod({ name, namespace: ns }));
          case 'deployment': return (await apps().readNamespacedDeployment({ name, namespace: ns }));
          case 'statefulset': return (await apps().readNamespacedStatefulSet({ name, namespace: ns }));
          case 'daemonset': return (await apps().readNamespacedDaemonSet({ name, namespace: ns }));
          case 'replicaset': return (await apps().readNamespacedReplicaSet({ name, namespace: ns }));
          case 'service': return (await core().readNamespacedService({ name, namespace: ns }));
          case 'job': return (await batch().readNamespacedJob({ name, namespace: ns }));
          case 'cronjob': return (await batch().readNamespacedCronJob({ name, namespace: ns }));
          case 'configmap': return (await core().readNamespacedConfigMap({ name, namespace: ns }));
          case 'secret': return (await core().readNamespacedSecret({ name, namespace: ns }));
          case 'ingress': return (await net().readNamespacedIngress({ name, namespace: ns }));
          case 'pvc': case 'persistentvolumeclaim': return (await core().readNamespacedPersistentVolumeClaim({ name, namespace: ns }));
          case 'node': return (await core().readNode({ name }));
          case 'namespace': return (await core().readNamespace({ name }));
          default: throw new Error(`Unsupported kind "${kind}".`);
        }
      };
      const obj = redactSecret(stripHeavy(await read()));
      return truncate(JSON.stringify(obj, null, 2));
    },

    async list_nodes() {
      const body = await core().listNode();
      return body.items.map((n) => ({
        name: n.metadata.name,
        ready: (n.status?.conditions || []).find((c) => c.type === 'Ready')?.status,
        roles: Object.keys(n.metadata.labels || {}).filter((l) => l.startsWith('node-role.kubernetes.io/')).map((l) => l.split('/')[1] || 'node'),
        kubelet: n.status?.nodeInfo?.kubeletVersion,
        os: n.status?.nodeInfo?.osImage,
        capacity: { cpu: n.status?.capacity?.cpu, memory: n.status?.capacity?.memory, pods: n.status?.capacity?.pods },
        problems: (n.status?.conditions || []).filter((c) => c.type !== 'Ready' && c.status === 'True').map((c) => c.type),
      }));
    },

    async get_helm_releases() {
      const releases = await helmReleases();
      return releases.map((r) => ({
        name: r.name, namespace: r.namespace, revision: r.version, status: r.info?.status,
        chart: r.chart?.metadata ? `${r.chart.metadata.name}-${r.chart.metadata.version}` : '', appVersion: r.chart?.metadata?.appVersion,
      }));
    },
  };

  // Tool definitions in OpenAI function-calling format.
  const rawTools = [
    { name: 'list_namespaces', description: 'List all namespaces in the cluster with their status.', parameters: { type: 'object', properties: {} } },
    { name: 'list_resources', description: 'List resources of a given kind in a namespace, summarized. Supported kinds: pod, deployment, statefulset, daemonset, replicaset, service, job, cronjob, configmap, secret (names only), ingress, pvc.', parameters: { type: 'object', properties: { namespace: { type: 'string' }, kind: { type: 'string' } }, required: ['namespace', 'kind'] } },
    { name: 'get_pod_logs', description: 'Fetch recent logs for a pod (optionally a specific container). Use this to debug crashes and errors.', parameters: { type: 'object', properties: { namespace: { type: 'string' }, pod: { type: 'string' }, container: { type: 'string' }, tailLines: { type: 'integer', description: 'Number of lines from the end (default 200, max 1000)' } }, required: ['namespace', 'pod'] } },
    { name: 'get_events', description: 'List recent cluster events (warnings and normal), most recent first. Omit namespace for cluster-wide. Essential for debugging why something is failing.', parameters: { type: 'object', properties: { namespace: { type: 'string' } } } },
    { name: 'describe_resource', description: 'Get the full spec and status of a single resource (like kubectl describe/get -o yaml). Secret values are redacted. Kinds: pod, deployment, statefulset, daemonset, replicaset, service, job, cronjob, configmap, secret, ingress, pvc, node, namespace.', parameters: { type: 'object', properties: { namespace: { type: 'string' }, kind: { type: 'string' }, name: { type: 'string' } }, required: ['kind', 'name'] } },
    { name: 'list_nodes', description: 'List cluster nodes with readiness, roles, versions, capacity, and any problem conditions.', parameters: { type: 'object', properties: {} } },
    { name: 'get_helm_releases', description: 'List installed Helm releases with revision, status, chart, and app version.', parameters: { type: 'object', properties: {} } },
  ];
  const tools = rawTools.map((t) => ({ type: 'function', function: t }));

  const systemPrompt = (ctx) => `You are the built-in AI assistant for a Kubernetes management UI. You help the user understand and debug their cluster.

You have READ-ONLY tools to inspect the live cluster. Use them to ground every answer in real data — never guess or fabricate resource names, statuses, or logs. When debugging, a good sequence is: check events, then describe the failing resource, then read its pod logs.

Rules:
- Investigate with tools before answering. If the user asks about "this pod/deployment/etc.", use the current context below to resolve what they mean.
- Be concise and lead with the finding. Use short bullet points and quote the specific log line or event that explains a problem.
- You cannot make changes. If a fix requires a command, show the kubectl command for the user to run, and explain what it does.
- Secret values are redacted from tool output — never claim to know them.
- If a tool errors (e.g. RBAC forbidden), say so plainly and suggest what access is needed.

Current context:
- Cluster context: ${getCurrentContext() || 'unknown'}
- Active view: ${ctx?.view || 'overview'}
- Selected namespaces: ${(ctx?.namespaces || []).join(', ') || 'all'}
${ctx?.selected ? `- Selected resource: ${ctx.selected.type || ''} ${ctx.selected.namespace ? ctx.selected.namespace + '/' : ''}${ctx.selected.name || ''}` : ''}`.trim();

  // ---- OpenAI-compatible chat completion (one streamed turn) ----------
  // Streams text tokens to `onToken`, accumulates assistant content + any
  // tool calls, and returns { content, toolCalls, finish }.
  const streamTurn = async (cfg, messages, onToken, signal) => {
    const resp = await fetch(completionsUrl(cfg.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: 'auto', stream: true, max_tokens: 4096 }),
      signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Provider returned ${resp.status}${text ? `: ${truncate(text, 500)}` : ''}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let finish = null;
    const toolCalls = [];

    const handleData = (data) => {
      if (data === '[DONE]') return true;
      let json;
      try { json = JSON.parse(data); } catch { return false; }
      const choice = json.choices?.[0];
      if (!choice) return false;
      const delta = choice.delta || {};
      if (delta.content) { content += delta.content; onToken(delta.content); }
      for (const tcd of delta.tool_calls || []) {
        const idx = tcd.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tcd.id) toolCalls[idx].id = tcd.id;
        if (tcd.function?.name) toolCalls[idx].function.name = tcd.function.name;
        if (tcd.function?.arguments) toolCalls[idx].function.arguments += tcd.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
      return false;
    };

    let done = false;
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        if (handleData(t.slice(5).trim())) { done = true; break; }
      }
    }
    return { content, toolCalls: toolCalls.filter(Boolean), finish };
  };

  // ---- SSE streaming agentic loop -------------------------------------
  app.post('/api/assistant/chat', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (type, data) => {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      res.flush?.();
    };

    try {
      const cfg = config();
      if (!configured()) {
        send('error', { message: 'AI assistant is not configured. Add your LLM API URL, key, and model in the chat panel (or set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL).' });
        return res.end();
      }
      if (!getKubeConfig()) {
        send('error', { message: 'No kubeconfig is loaded.' });
        return res.end();
      }

      const { messages: history = [], context } = req.body || {};
      const messages = [{ role: 'system', content: systemPrompt(context) }];
      for (const m of history) {
        if (m && m.text && (m.role === 'user' || m.role === 'assistant')) messages.push({ role: m.role, content: m.text });
      }

      let iterations = 0;
      while (true) {
        if (++iterations > MAX_TOOL_ITERATIONS) {
          send('error', { message: 'Stopped after too many investigation steps.' });
          break;
        }

        const { content, toolCalls, finish } = await streamTurn(cfg, messages, (t) => send('token', { text: t }));

        // Record the assistant turn (with any tool calls) for the next round.
        messages.push({ role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

        if (finish !== 'tool_calls' || toolCalls.length === 0) break;

        for (const tc of toolCalls) {
          let input = {};
          try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* leave {} */ }
          send('tool', { name: tc.function.name, input });
          let out, isError = false;
          try {
            const fn = impls[tc.function.name];
            if (!fn) throw new Error(`Unknown tool: ${tc.function.name}`);
            const result = await fn(input);
            out = typeof result === 'string' ? result : JSON.stringify(result);
          } catch (e) {
            out = `Error: ${e?.body?.message || e?.message || String(e)}`;
            isError = true;
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: truncate(out) });
        }
      }

      send('done', {});
    } catch (err) {
      send('error', { message: err?.message || 'Assistant failed unexpectedly.' });
    } finally {
      res.end();
    }
  });

  // ---- status + config management -------------------------------------
  app.get('/api/assistant/status', (req, res) => {
    const cfg = config() || {};
    res.json({
      enabled: configured(),
      source: source(),
      editable: !envConfig(),
      baseUrl: cfg.baseUrl || '',
      model: cfg.model || '',
    });
  });

  // Save the LLM connection. Validates against the provider before persisting.
  app.post('/api/assistant/config', async (req, res) => {
    if (envConfig()) return res.status(409).json({ error: 'The LLM connection is set via environment variables; unset LLM_BASE_URL / LLM_API_KEY / LLM_MODEL to manage it here.' });
    const baseUrl = (req.body?.baseUrl || '').trim();
    const apiKey = (req.body?.apiKey || '').trim();
    const model = (req.body?.model || '').trim();
    if (!baseUrl || !apiKey || !model) return res.status(400).json({ error: 'API URL, API key, and model are all required.' });
    if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'API URL must start with http:// or https://' });

    // Validate: a minimal chat completion against the provider.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const resp = await fetch(completionsUrl(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (resp.status === 401 || resp.status === 403) return res.status(400).json({ error: 'The API key was rejected by the provider (authentication failed).' });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return res.status(400).json({ error: `Provider rejected the request (HTTP ${resp.status}). Check the URL and model name.${text ? `: ${truncate(text, 300)}` : ''}` });
      }
    } catch (err) {
      // Network/timeout — save anyway but tell the user validation didn't complete.
      console.error(`Assistant config validation could not complete: ${err?.message || err}`);
    }

    try {
      stored = { baseUrl, apiKey, model };
      const cfg = readConfig();
      cfg.llm = stored;
      writeConfig(cfg);
    } catch (err) {
      return res.status(500).json({ error: `Could not save the configuration: ${err.message}` });
    }
    res.json({ enabled: true, source: 'stored', editable: true, baseUrl, model });
  });

  // Forget the stored LLM connection.
  app.delete('/api/assistant/config', (req, res) => {
    if (envConfig()) return res.status(409).json({ error: 'The connection is set via environment variables; unset them to remove it.' });
    stored = null;
    try {
      const cfg = readConfig();
      delete cfg.llm;
      delete cfg.anthropicApiKey; // clean up any key saved by an older version
      writeConfig(cfg);
    } catch (err) {
      return res.status(500).json({ error: `Could not clear the configuration: ${err.message}` });
    }
    res.json({ enabled: false, source: null, editable: true, baseUrl: '', model: '' });
  });
}
