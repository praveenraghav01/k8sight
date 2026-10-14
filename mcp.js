// ============================================================
// MCP server — exposes this app's Kubernetes capabilities as tools so any
// MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, …) can drive
// the cluster the app is connected to.
//
// The tools are a thin wrapper over the app's own REST API (self-HTTP), so they
// behave exactly like the UI — same kubeconfig, same selected context, same
// caching. Read tools are always available; write/destructive tools are gated
// behind MCP_ALLOW_WRITE=1 (off by default) so an agent can't mutate a cluster
// unless the operator opts in.
//
// createMcpServer() is transport-agnostic — server.js mounts it over Streamable
// HTTP at /mcp, and mcp-stdio.js serves the same tools over stdio.
// ============================================================
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function createMcpServer({ baseURL, version, allowWrite } = {}) {
  const base = baseURL || process.env.MCP_API_BASE || `http://127.0.0.1:${process.env.PORT || 3001}`;
  // Prefer an explicit flag (the app's persisted UI setting); fall back to the
  // MCP_ALLOW_WRITE env var when not supplied (e.g. `npm run mcp` standalone).
  if (typeof allowWrite !== 'boolean') {
    allowWrite = ['1', 'true', 'yes'].includes(String(process.env.MCP_ALLOW_WRITE || '').toLowerCase());
  }

  // Minimal REST client over Node's built-in fetch (no extra backend dep).
  const req = async (method, urlPath, { params, body } = {}) => {
    let url = base + urlPath;
    if (params) {
      const qs = Object.entries(params)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.response = { data }; throw e; }
    return data;
  };
  const api = {
    get: async (p, opts) => ({ data: await req('GET', p, opts) }),
    post: async (p, body) => ({ data: await req('POST', p, { body }) }),
    delete: async (p) => ({ data: await req('DELETE', p) }),
  };

  const server = new McpServer({
    name: 'k8sight',
    version: version || process.env.APP_VERSION || '1.2.0',
  });

  const ok = (data) => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  });
  const fail = (msg) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
  const wrap = (fn) => async (args) => {
    try { return await fn(args || {}); }
    catch (e) { return fail(e.response?.data?.error || e.message || 'request failed'); }
  };

  // ---------------------------------------------------------- read tools
  server.registerTool('list_contexts', {
    title: 'List kube contexts',
    description: 'List available kubeconfig contexts and the currently selected one.',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/config/status');
    return ok({ current: data.currentContext, contexts: data.contexts });
  }));

  server.registerTool('switch_context', {
    title: 'Switch cluster context',
    description: 'Switch the active cluster/context. Affects all later tool calls (and the running UI).',
    inputSchema: { context: z.string().describe('context name from list_contexts') },
  }, wrap(async ({ context }) => {
    const { data } = await api.post('/api/config/context', { contextName: context });
    return ok({ switched: true, currentContext: data.currentContext });
  }));

  server.registerTool('list_namespaces', {
    title: 'List namespaces',
    description: 'List all namespaces in the current cluster.',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/namespaces');
    return ok(data.namespaces);
  }));

  server.registerTool('list_resources', {
    title: 'List resources in a namespace',
    description: 'List workloads/services/config/etc. in a namespace (or "all"). Returns a compact per-kind summary (name, namespace, status).',
    inputSchema: { namespace: z.string().default('all').describe('namespace name, or "all"') },
  }, wrap(async ({ namespace = 'all' }) => {
    if (namespace === 'all') {
      try {
        const [resourcesResponse, podsResponse] = await Promise.all([
          api.get('/api/resources/all'),
          api.get('/api/resources/all/pods'),
        ]);
        const summary = {};
        for (const [kind, items] of Object.entries({ ...resourcesResponse.data, ...podsResponse.data })) {
          if (Array.isArray(items) && items.length) {
            summary[kind] = items.map((r) => ({ name: r.name, namespace: r.namespace, status: r.status }));
          }
        }
        return ok(summary);
      } catch {
        // Preserve namespace-scoped access when a role denies cluster-wide list.
      }
    }
    const namespaces = namespace === 'all'
      ? (await api.get('/api/namespaces')).data.namespaces
      : [namespace];
    const data = {};
    let cursor = 0;
    const loadNamespace = async () => {
      while (cursor < namespaces.length) {
        const current = namespaces[cursor++];
        const [resourcesResponse, podsResponse] = await Promise.all([
          api.get(`/api/resources/${encodeURIComponent(current)}`).catch(() => ({ data: {} })),
          api.get(`/api/resources/${encodeURIComponent(current)}/pods`).catch(() => ({ data: {} })),
        ]);
        for (const [kind, items] of Object.entries({ ...resourcesResponse.data, ...podsResponse.data })) {
          if (Array.isArray(items)) data[kind] = [...(data[kind] || []), ...items];
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(12, namespaces.length) }, loadNamespace));
    const summary = {};
    for (const [kind, list] of Object.entries(data)) {
      if (Array.isArray(list) && list.length) {
        summary[kind] = list.map((r) => ({ name: r.name, namespace: r.namespace, status: r.status }));
      }
    }
    return ok(summary);
  }));

  server.registerTool('get_resource_yaml', {
    title: 'Get resource YAML',
    description: 'Get the full YAML manifest of a single resource.',
    inputSchema: {
      namespace: z.string().describe('namespace ("-" for cluster-scoped kinds)'),
      kind: z.string().describe('resource type: pod, deployment, service, statefulSet, daemonSet, configMap, secret, ingress, persistentVolumeClaim, …'),
      name: z.string(),
    },
  }, wrap(async ({ namespace, kind, name }) => {
    const { data } = await api.get(`/api/yaml/${encodeURIComponent(namespace)}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
    return ok(data.yaml);
  }));

  server.registerTool('get_pod_logs', {
    title: 'Get pod logs',
    description: 'Fetch recent logs for a pod (optionally a specific container).',
    inputSchema: {
      namespace: z.string(),
      pod: z.string(),
      container: z.string().optional().describe('container name (for multi-container pods)'),
      tail: z.number().int().positive().max(5000).optional().describe('last N lines'),
    },
  }, wrap(async ({ namespace, pod, container, tail }) => {
    const { data } = await api.get(`/api/logs/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}`, { params: { container, tail } });
    return ok(data.logs ?? data);
  }));

  server.registerTool('get_events', {
    title: 'Get cluster events',
    description: 'List recent events for a namespace (or "all"). Useful for debugging failures.',
    inputSchema: { namespace: z.string().default('all') },
  }, wrap(async ({ namespace = 'all' }) => {
    const { data } = await api.get(`/api/events/${encodeURIComponent(namespace)}`);
    return ok(data.events ?? data);
  }));

  server.registerTool('get_topology', {
    title: 'Get namespace topology',
    description: 'Resource dependency graph for a namespace (workloads, network, storage, config, rbac) — nodes + edges.',
    inputSchema: { namespace: z.string() },
  }, wrap(async ({ namespace }) => {
    const { data } = await api.get(`/api/topology/${encodeURIComponent(namespace)}`);
    return ok({ nodeCount: data.nodes?.length || 0, edgeCount: data.edges?.length || 0, nodes: data.nodes, edges: data.edges });
  }));

  server.registerTool('list_argocd_apps', {
    title: 'List ArgoCD applications',
    description: 'List ArgoCD Applications with sync + health status (only if ArgoCD is installed on the cluster).',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/argocd/applications');
    return ok(data.applications ?? data);
  }));

  server.registerTool('get_argocd_app', {
    title: 'Get ArgoCD application',
    description: 'Full detail of one ArgoCD Application: source(s), destination, managed resources, conditions, last operation.',
    inputSchema: { namespace: z.string().describe('the Application\'s namespace (e.g. argocd)'), name: z.string() },
  }, wrap(async ({ namespace, name }) => {
    const { data } = await api.get(`/api/argocd/application/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);
    return ok(data);
  }));

  server.registerTool('get_cluster_summary', {
    title: 'Get cluster summary',
    description: 'Cluster overview: node & pod health, CPU/memory capacity and allocatable, Kubernetes version, node roles.',
    inputSchema: {},
  }, wrap(async () => {
    const [summaryResponse, podsResponse, metricsResponse] = await Promise.all([
      api.get('/api/cluster/summary'),
      api.get('/api/cluster/pods-summary').catch(() => null),
      api.get('/api/cluster/metrics').catch(() => null),
    ]);
    return ok({
      ...summaryResponse.data,
      ...(podsResponse?.data || {}),
      ...(metricsResponse?.data || {})
    });
  }));

  server.registerTool('list_nodes', {
    title: 'List nodes',
    description: 'List cluster nodes with status, roles, version and capacity.',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/nodes');
    return ok(data.nodes ?? data);
  }));

  server.registerTool('get_node_pods', {
    title: 'Get pods on a node',
    description: 'List the pods scheduled on a given node.',
    inputSchema: { name: z.string().describe('node name') },
  }, wrap(async ({ name }) => {
    const { data } = await api.get(`/api/nodes/${encodeURIComponent(name)}/pods`);
    return ok(data.pods ?? data);
  }));

  server.registerTool('get_node_metrics', {
    title: 'Get node metrics',
    description: 'Live CPU/memory usage for a node (requires metrics-server).',
    inputSchema: { name: z.string().describe('node name') },
  }, wrap(async ({ name }) => {
    const { data } = await api.get(`/api/metrics/node/${encodeURIComponent(name)}`);
    return ok(data);
  }));

  server.registerTool('get_pod_metrics', {
    title: 'Get pod metrics',
    description: 'Live CPU/memory usage for a pod (requires metrics-server).',
    inputSchema: { namespace: z.string(), pod: z.string() },
  }, wrap(async ({ namespace, pod }) => {
    const { data } = await api.get(`/api/metrics/pod/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}`);
    return ok(data);
  }));

  server.registerTool('list_pod_metrics', {
    title: 'List pod metrics',
    description: 'Live CPU/memory usage for all pods in a namespace (or "all"). Requires metrics-server.',
    inputSchema: { namespace: z.string().default('all') },
  }, wrap(async ({ namespace = 'all' }) => {
    const { data } = await api.get(`/api/metrics/pods/${encodeURIComponent(namespace)}`);
    return ok(data.pods ?? data);
  }));

  server.registerTool('get_cost_provider_status', {
    title: 'Get cost provider status',
    description: 'Detect OpenCost or Kubecost in the active cluster. Supply all four selector fields to check a non-standard Service manually.',
    inputSchema: {
      provider: z.enum(['opencost', 'kubecost']).optional(),
      namespace: z.string().optional(),
      service: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
    },
  }, wrap(async ({ provider, namespace, service, port }) => {
    const { data } = await api.get('/api/costs/status', { params: { provider, namespace, service, port } });
    return ok(data);
  }));

  server.registerTool('get_cost_allocations', {
    title: 'Get Kubernetes cost allocations',
    description: 'Read allocated USD costs from OpenCost or Kubecost for a time window, grouped by namespace, workload controller, node, or cluster. Supply all four selector fields to use a non-standard Service.',
    inputSchema: {
      window: z.enum(['24h', '7d', '30d', 'today', 'lastweek', 'month']).default('7d'),
      aggregate: z.enum(['cluster', 'namespace', 'controller', 'node']).default('namespace'),
      provider: z.enum(['opencost', 'kubecost']).optional(),
      namespace: z.string().optional(),
      service: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
    },
  }, wrap(async ({ window = '7d', aggregate = 'namespace', provider, namespace, service, port }) => {
    const { data } = await api.get('/api/costs/allocation', { params: { window, aggregate, provider, namespace, service, port } });
    return ok(data);
  }));

  server.registerTool('get_resource', {
    title: 'Get resource detail',
    description: 'Full detail for one resource (metadata, spec, status, conditions, containers) — richer than the raw YAML.',
    inputSchema: {
      namespace: z.string().describe('namespace ("-" for cluster-scoped kinds)'),
      kind: z.string().describe('resource type: pod, deployment, service, node, …'),
      name: z.string(),
    },
  }, wrap(async ({ namespace, kind, name }) => {
    const { data } = await api.get(`/api/resource/${encodeURIComponent(namespace)}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
    return ok(data);
  }));

  server.registerTool('list_storage', {
    title: 'List storage',
    description: 'PersistentVolumes, PersistentVolumeClaims and StorageClasses across the cluster.',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/storage');
    return ok(data);
  }));

  server.registerTool('get_rbac', {
    title: 'Get RBAC',
    description: 'Roles, ClusterRoles, RoleBindings, ClusterRoleBindings and ServiceAccounts (access control).',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/rbac');
    return ok(data);
  }));

  // ---- Helm ----
  server.registerTool('list_helm_releases', {
    title: 'List Helm releases',
    description: 'All Helm releases with chart, version, status and namespace (read via the API — no helm CLI).',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/helm/releases');
    return ok(data.releases ?? data);
  }));

  server.registerTool('get_helm_values', {
    title: 'Get Helm release values',
    description: 'The values a Helm release was installed with.',
    inputSchema: { namespace: z.string(), name: z.string() },
  }, wrap(async ({ namespace, name }) => {
    const { data } = await api.get(`/api/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/values`);
    return ok(data.values ?? data);
  }));

  server.registerTool('get_helm_manifest', {
    title: 'Get Helm release manifest',
    description: 'The rendered Kubernetes manifest for a Helm release.',
    inputSchema: { namespace: z.string(), name: z.string() },
  }, wrap(async ({ namespace, name }) => {
    const { data } = await api.get(`/api/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/manifest`);
    return ok(data.manifest ?? data);
  }));

  // ---- Custom Resources (CRDs) ----
  server.registerTool('list_crds', {
    title: 'List CRDs',
    description: 'The custom resource definitions available on the cluster (group → kind), for use with list_custom_resources.',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/customresources');
    return ok(data.groups ?? data);
  }));

  server.registerTool('list_custom_resources', {
    title: 'List custom resources',
    description: 'Instances of a custom resource. Get group/version/plural from list_crds.',
    inputSchema: { group: z.string(), version: z.string(), plural: z.string() },
  }, wrap(async ({ group, version, plural }) => {
    const { data } = await api.get(`/api/customresources/${encodeURIComponent(group)}/${encodeURIComponent(version)}/${encodeURIComponent(plural)}`);
    return ok(data.items ?? data);
  }));

  server.registerTool('get_custom_resource', {
    title: 'Get custom resource',
    description: 'Full detail of one custom resource instance.',
    inputSchema: { group: z.string(), version: z.string(), plural: z.string(), name: z.string() },
  }, wrap(async ({ group, version, plural, name }) => {
    const { data } = await api.get(`/api/customresource/${encodeURIComponent(group)}/${encodeURIComponent(version)}/${encodeURIComponent(plural)}/${encodeURIComponent(name)}`);
    return ok(data);
  }));

  // ---- ArgoCD (extended) ----
  server.registerTool('get_argocd_status', {
    title: 'Get ArgoCD status',
    description: 'Whether ArgoCD is installed/detected on the cluster, and fleet-level sync/health counts.',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/argocd/status');
    return ok(data);
  }));

  server.registerTool('list_argocd_projects', {
    title: 'List ArgoCD projects',
    description: 'ArgoCD AppProjects.',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/argocd/projects');
    return ok(data.projects ?? data);
  }));

  server.registerTool('list_argocd_appsets', {
    title: 'List ArgoCD ApplicationSets',
    description: 'ArgoCD ApplicationSets.',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/argocd/applicationsets');
    return ok(data.applicationSets ?? data.applicationsets ?? data);
  }));

  server.registerTool('list_argocd_repositories', {
    title: 'List ArgoCD repositories',
    description: 'Git/Helm repositories connected to ArgoCD.',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/argocd/repositories');
    return ok(data.repositories ?? data);
  }));

  server.registerTool('list_argocd_clusters', {
    title: 'List ArgoCD clusters',
    description: 'Destination clusters registered with ArgoCD.',
    inputSchema: {},
  }, wrap(async () => {
    const { data } = await api.get('/api/argocd/clusters');
    return ok(data.clusters ?? data);
  }));

  // ---- Costs (extended) ----
  server.registerTool('get_cost_timeseries', {
    title: 'Get cost over time',
    description: 'Cost per namespace over time from OpenCost or Kubecost (hourly for 24h/today, daily otherwise). Supply all four selector fields to use a non-standard Service.',
    inputSchema: {
      window: z.enum(['24h', '7d', '30d', 'today', 'lastweek', 'month']).default('7d'),
      provider: z.enum(['opencost', 'kubecost']).optional(),
      namespace: z.string().optional(),
      service: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
    },
  }, wrap(async ({ window = '7d', provider, namespace, service, port }) => {
    const { data } = await api.get('/api/costs/timeseries', { params: { window, provider, namespace, service, port } });
    return ok(data);
  }));

  // ---- Security Center ----
  // Image findings come from the Trivy Operator's reports when it's installed,
  // otherwise from the app's built-in Trivy scan. Both use the same shape.
  const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
  const atLeast = (min) => SEVERITIES.slice(0, SEVERITIES.indexOf(min) + 1);
  const securityImages = async (namespace) => {
    const { data: st } = await api.get('/api/security/status');
    if (st.installed && st.reports?.vulnerability) {
      const { data } = await api.get('/api/security/vulnerabilities', { params: { namespace } });
      return { source: 'trivy-operator', ...data };
    }
    const { data } = await api.get('/api/security/scan');
    const images = (data.images || []).filter((im) => !namespace || namespace === 'all'
      || (im.workloads || []).some((w) => w.namespace === namespace));
    return { source: 'built-in scan', ...data, images };
  };

  server.registerTool('get_security_status', {
    title: 'Get Security Center status',
    description: 'Which security data is available: Trivy Operator reports (vulnerability, config audit, RBAC, exposed secrets) and the built-in Trivy scanner (available, running, has a result).',
    inputSchema: {},
  }, wrap(async () => {
    const [{ data: operator }, { data: scan }] = await Promise.all([api.get('/api/security/status'), api.get('/api/security/scan/status')]);
    return ok({ operator, builtInScan: scan });
  }));

  server.registerTool('list_vulnerable_images', {
    title: 'List image vulnerabilities',
    description: 'Images running in the cluster with CVE counts by severity, the workloads using them, and exposed-secret counts, worst first. Use get_image_vulnerabilities for the CVE list of one image.',
    inputSchema: {
      namespace: z.string().optional().describe('limit to one namespace (default: all)'),
      minSeverity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional().describe('only images with at least one finding at this severity or worse'),
      limit: z.number().int().min(1).max(500).default(50),
    },
  }, wrap(async ({ namespace, minSeverity, limit = 50 }) => {
    const d = await securityImages(namespace);
    let images = d.images || [];
    if (minSeverity) images = images.filter((im) => atLeast(minSeverity).some((sv) => im.summary?.[sv] > 0));
    return ok({
      source: d.source,
      totals: d.summary,
      imageCount: images.length,
      images: images.slice(0, limit).map((im) => ({
        image: im.image, os: im.os || im.platform || '', status: im.status, scannedAt: im.scannedAt,
        summary: im.summary, exposedSecrets: im.secrets || 0,
        workloads: (im.workloads || []).map((w) => `${w.namespace}/${w.kind}/${w.name}${w.container ? ` (${w.container})` : ''}`),
      })),
      note: d.images?.length ? undefined : 'No image findings. Install the Trivy Operator or run start_security_scan.',
    });
  }));

  server.registerTool('get_image_vulnerabilities', {
    title: 'Get CVEs for an image',
    description: 'The CVEs found in one image (package, installed and fixed version, severity, score), worst first.',
    inputSchema: {
      image: z.string().describe('image reference as shown by list_vulnerable_images'),
      minSeverity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
      fixableOnly: z.boolean().optional().describe('only CVEs that have a fixed version'),
      limit: z.number().int().min(1).max(1000).default(100),
    },
  }, wrap(async ({ image, minSeverity, fixableOnly, limit = 100 }) => {
    const d = await securityImages();
    const im = (d.images || []).find((x) => x.image === image) || (d.images || []).find((x) => x.image.includes(image));
    if (!im) return fail(`image "${image}" has no scan result; check list_vulnerable_images`);
    let vulns = im.vulnerabilities || [];
    if (minSeverity) vulns = vulns.filter((v) => atLeast(minSeverity).includes(v.severity));
    if (fixableOnly) vulns = vulns.filter((v) => v.fixedVersion);
    return ok({
      image: im.image, source: d.source, summary: im.summary, matching: vulns.length,
      vulnerabilities: vulns.slice(0, limit).map((v) => ({
        id: v.id, severity: v.severity, score: v.score, package: v.pkg,
        installedVersion: v.installedVersion, fixedVersion: v.fixedVersion || null, title: v.title, link: v.link,
      })),
    });
  }));

  server.registerTool('list_security_checks', {
    title: 'List config and RBAC findings',
    description: 'Failed configuration-audit checks (kind=config) or RBAC risks (kind=rbac) per resource, from Trivy Operator reports, worst first. Each finding has its id, severity, message and remediation.',
    inputSchema: {
      kind: z.enum(['config', 'rbac']).default('config'),
      namespace: z.string().optional(),
      minSeverity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
  }, wrap(async ({ kind = 'config', namespace, minSeverity, limit = 50 }) => {
    const { data } = await api.get('/api/security/checks', { params: { kind, namespace } });
    if (data.installed === false) return ok({ installed: false, note: 'Config and RBAC checks need the Trivy Operator; the built-in scan only covers images.' });
    let resources = data.resources || [];
    if (minSeverity) {
      const keep = atLeast(minSeverity);
      resources = resources.map((r) => ({ ...r, checks: r.checks.filter((c) => keep.includes(c.severity)) })).filter((r) => r.checks.length);
    }
    return ok({
      totals: data.summary, resourceCount: resources.length,
      resources: resources.slice(0, limit).map((r) => ({
        resource: `${r.namespace ? r.namespace + '/' : ''}${r.kind}/${r.name}`, summary: r.summary, checks: r.checks,
      })),
    });
  }));

  server.registerTool('start_security_scan', {
    title: 'Start built-in image scan',
    description: 'Scan every running image with the app\'s built-in Trivy (runs on this machine; nothing is installed in the cluster). Returns immediately; poll get_security_status, then use list_vulnerable_images. Only works once Trivy is available locally.',
    inputSchema: { namespace: z.string().optional().describe('only scan images used in this namespace') },
  }, wrap(async ({ namespace }) => {
    const { data: st } = await api.get('/api/security/scan/status');
    if (!st.available) return fail('Trivy is not available on this machine yet. Open Security Center in k8sight and choose "Download Trivy & scan" once.');
    const { data } = await api.post('/api/security/scan', namespace ? { namespace } : {});
    return ok({ started: data.started, running: data.running, total: data.total, message: data.started ? 'Scan started.' : 'A scan is already running.' });
  }));

  // ---- Flux CD ----
  const FLUX_KINDS = ['kustomization', 'helmrelease', 'gitrepository', 'ocirepository', 'helmrepository', 'bucket', 'helmchart', 'externalartifact', 'alert', 'provider', 'receiver', 'imagerepository', 'imagepolicy', 'imageupdateautomation'];
  const fluxPath = (kind, namespace, name) => `/api/flux/resource/${encodeURIComponent(kind)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;

  server.registerTool('get_flux_overview', {
    title: 'Get Flux overview',
    description: 'Whether Flux is installed, ready/total counts per category (Kustomizations, HelmReleases, sources, notifications), every resource that is not Ready with its message, and the last hour of Flux events.',
    inputSchema: {},
  }, wrap(async () => {
    const { data: st } = await api.get('/api/flux/status');
    if (!st.installed) return ok({ installed: false });
    const { data } = await api.get('/api/flux/overview');
    return ok({ installed: true, ...data, activity: (data.activity || []).slice(0, 40) });
  }));

  server.registerTool('list_flux_resources', {
    title: 'List Flux resources',
    description: 'All Flux resources of one kind with state (Ready, Reconciling, Failed, Suspended), message, source, revision and interval.',
    inputSchema: { kind: z.enum(FLUX_KINDS) },
  }, wrap(async ({ kind }) => {
    const { data } = await api.get('/api/flux/resources', { params: { kind } });
    return ok(data.resources ?? data);
  }));

  server.registerTool('get_flux_resource', {
    title: 'Get Flux resource',
    description: 'Full detail of one Flux resource: spec, status, conditions, the resources a Kustomization manages, and recent events.',
    inputSchema: { kind: z.enum(FLUX_KINDS), namespace: z.string(), name: z.string() },
  }, wrap(async ({ kind, namespace, name }) => {
    const { data } = await api.get(fluxPath(kind, namespace, name));
    return ok(data);
  }));

  // ---- Flagger ----
  const FLAGGER_KINDS = ['canary', 'metrictemplate', 'alertprovider'];

  server.registerTool('list_flagger_canaries', {
    title: 'List Flagger canaries',
    description: 'Flagger Canaries with phase (Progressing, WaitingPromotion, Succeeded, Failed, ...), strategy (Canary, A/B testing, Blue/Green, mirroring), target, traffic weight or iterations, and failed checks against the threshold. Use kind to list MetricTemplates or AlertProviders instead.',
    inputSchema: { kind: z.enum(FLAGGER_KINDS).default('canary') },
  }, wrap(async ({ kind = 'canary' }) => {
    const { data: st } = await api.get('/api/flagger/status');
    if (!st.installed) return ok({ installed: false });
    const { data } = await api.get('/api/flagger/resources', { params: { kind } });
    return ok(data.resources ?? data);
  }));

  server.registerTool('get_flagger_canary', {
    title: 'Get Flagger canary',
    description: 'Full detail of one Canary (or MetricTemplate / AlertProvider): rollout status, analysis metrics and thresholds, webhooks, alerts, A/B match rules, the objects Flagger generated, and events.',
    inputSchema: { namespace: z.string(), name: z.string(), kind: z.enum(FLAGGER_KINDS).default('canary') },
  }, wrap(async ({ namespace, name, kind = 'canary' }) => {
    const { data } = await api.get(`/api/flagger/resource/${kind}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);
    return ok(data);
  }));

  // ---------------------------------------------------------- write tools (gated)
  if (allowWrite) {
    server.registerTool('apply_yaml', {
      title: 'Apply YAML (write)',
      description: 'Create or update a resource from YAML (kubectl apply). WRITE operation — mutates the cluster.',
      inputSchema: { yaml: z.string().describe('full resource manifest as YAML') },
    }, wrap(async ({ yaml }) => {
      const { data } = await api.post('/api/apply', { yaml });
      return ok(data.message || 'applied');
    }));

    server.registerTool('delete_resource', {
      title: 'Delete resource (destructive)',
      description: 'Delete a resource. DESTRUCTIVE — cannot be undone.',
      inputSchema: { namespace: z.string(), kind: z.string(), name: z.string() },
    }, wrap(async ({ namespace, kind, name }) => {
      const { data } = await api.delete(`/api/resource/${encodeURIComponent(namespace)}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
      return ok(data.message || 'deleted');
    }));

    server.registerTool('scale_workload', {
      title: 'Scale workload (write)',
      description: 'Set the replica count for a deployment/statefulSet/replicaSet. WRITE operation.',
      inputSchema: { namespace: z.string(), kind: z.string(), name: z.string(), replicas: z.number().int().min(0) },
    }, wrap(async ({ namespace, kind, name, replicas }) => {
      const { data } = await api.post(`/api/scale/${encodeURIComponent(namespace)}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`, { replicas });
      return ok(data.message || `scaled to ${replicas}`);
    }));

    server.registerTool('rollout_restart', {
      title: 'Rollout restart (write)',
      description: 'Trigger a rolling restart of a deployment/statefulSet/daemonSet. WRITE operation.',
      inputSchema: { namespace: z.string(), kind: z.string(), name: z.string() },
    }, wrap(async ({ namespace, kind, name }) => {
      const { data } = await api.post(`/api/restart/${encodeURIComponent(namespace)}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
      return ok(data.message || 'restart triggered');
    }));

    server.registerTool('sync_argocd_app', {
      title: 'Sync ArgoCD application (write)',
      description: 'Trigger an ArgoCD sync for an Application (deploys the target Git state). Optional: prune resources no longer in Git, a dry run, or a specific revision. WRITE operation.',
      inputSchema: {
        namespace: z.string(), name: z.string(),
        prune: z.boolean().optional().describe('delete resources that are no longer defined in Git'),
        dryRun: z.boolean().optional().describe('preview the sync without applying anything'),
        revision: z.string().optional().describe('Git revision to sync to (default: the target revision)'),
      },
    }, wrap(async ({ namespace, name, prune, dryRun, revision }) => {
      const { data } = await api.post(`/api/argocd/application/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/sync`, { prune, dryRun, revision });
      return ok(data.message || 'sync triggered');
    }));

    server.registerTool('refresh_argocd_app', {
      title: 'Refresh ArgoCD application',
      description: 'Ask ArgoCD to re-compare an Application against Git (no deploy). WRITE-ish (annotation only).',
      inputSchema: { namespace: z.string(), name: z.string() },
    }, wrap(async ({ namespace, name }) => {
      const { data } = await api.post(`/api/argocd/application/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/refresh`);
      return ok(data.message || 'refresh requested');
    }));

    server.registerTool('reconcile_flux_resource', {
      title: 'Reconcile Flux resource',
      description: 'Ask Flux to reconcile a resource now (same as `flux reconcile`; sets the reconcile.fluxcd.io/requestedAt annotation). WRITE operation.',
      inputSchema: { kind: z.enum(FLUX_KINDS), namespace: z.string(), name: z.string() },
    }, wrap(async ({ kind, namespace, name }) => {
      const { data } = await api.post(`${fluxPath(kind, namespace, name)}/reconcile`);
      return ok(data.message || 'reconciliation requested');
    }));

    server.registerTool('suspend_flux_resource', {
      title: 'Suspend or resume Flux resource',
      description: 'Suspend (suspend=true) or resume (suspend=false) reconciliation of a Flux resource via spec.suspend. WRITE operation.',
      inputSchema: { kind: z.enum(FLUX_KINDS), namespace: z.string(), name: z.string(), suspend: z.boolean() },
    }, wrap(async ({ kind, namespace, name, suspend }) => {
      const { data } = await api.post(`${fluxPath(kind, namespace, name)}/${suspend ? 'suspend' : 'resume'}`);
      return ok(data.message || (suspend ? 'suspended' : 'resumed'));
    }));

    const canaryPath = (namespace, name, action) => `/api/flagger/canary/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${action}`;

    server.registerTool('restart_canary', {
      title: 'Restart canary rollout',
      description: 'Rollout-restart the Canary\'s target workload. Flagger treats it as a new revision and starts a new analysis (or promotes straight away if skipAnalysis is on). WRITE operation.',
      inputSchema: { namespace: z.string(), name: z.string() },
    }, wrap(async ({ namespace, name }) => {
      const { data } = await api.post(canaryPath(namespace, name, 'restart'));
      return ok(data.message || 'restarted');
    }));

    server.registerTool('suspend_canary', {
      title: 'Suspend or resume canary',
      description: 'Suspend (suspend=true) or resume (suspend=false) a Flagger Canary via spec.suspend. WRITE operation.',
      inputSchema: { namespace: z.string(), name: z.string(), suspend: z.boolean() },
    }, wrap(async ({ namespace, name, suspend }) => {
      const { data } = await api.post(canaryPath(namespace, name, suspend ? 'suspend' : 'resume'));
      return ok(data.message || (suspend ? 'suspended' : 'resumed'));
    }));

    server.registerTool('set_canary_skip_analysis', {
      title: 'Set canary skipAnalysis',
      description: 'Turn spec.skipAnalysis on (new revisions are promoted without analysis) or off. WRITE operation.',
      inputSchema: { namespace: z.string(), name: z.string(), skip: z.boolean() },
    }, wrap(async ({ namespace, name, skip }) => {
      const { data } = await api.post(canaryPath(namespace, name, skip ? 'skip-analysis' : 'enable-analysis'));
      return ok(data.message || (skip ? 'analysis will be skipped' : 'analysis enabled'));
    }));
  }

  return server;
}
