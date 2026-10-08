// ============================================================================
// demo.js — Synthetic Kubernetes cluster for "demo mode".
//
// When the active context is DEMO_CONTEXT, server.js routes every /api/* data
// and mutation request through handle() below instead of talking to a real
// cluster. The whole point is that k8sight is fully explorable with no
// kubeconfig, no cluster, and no kubectl.
//
// The JSON returned here is shaped to EXACTLY match what the corresponding real
// handlers in server.js emit, because the same React frontend consumes both.
// Where a view consumes a raw Kubernetes object (the resource-detail drawer and
// the YAML viewer), we store and return realistic full manifests; where a view
// consumes server.js's own transformed shape (lists, summaries, security,
// argocd, …), we replicate that transform here.
//
// One coherent in-memory cluster is built once at module load and mutated in
// place, so scale / restart / delete / apply visibly change what later reads
// return.
//
// js-yaml is an existing project dependency (used throughout server.js); it is
// reused here for YAML dump/parse so round-trips stay correct. No new/external
// dependency is added.
// ============================================================================

import yaml from 'js-yaml';

export const DEMO_CONTEXT = 'demo-cluster';
export function isDemo(context) {
  return context === DEMO_CONTEXT;
}

// Context row merged into GET /api/config/status so the switcher always shows it.
export function demoContextInfo() {
  return { name: DEMO_CONTEXT, cluster: DEMO_CONTEXT, provider: 'demo' };
}

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
const nowISO = () => new Date().toISOString();
// A timestamp `mins` minutes in the past (creationTimestamps etc).
const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString();
// Flux demo clock: seeded timestamps drift forward with uptime (see fluxEvent).
let fluxSeededAt = Date.now();
let fluxSeeding = false;
const fluxDrift = (iso) => (iso ? new Date(new Date(iso).getTime() + Date.now() - fluxSeededAt).toISOString() : iso);

// Flux CD demo constants — declared up here because build() seeds the cluster at
// module load, before declarations further down the file are initialized.
const FLUX_CATEGORY = {
  kustomization: 'kustomizations', helmrelease: 'helmreleases',
  gitrepository: 'sources', ocirepository: 'sources', helmrepository: 'sources', bucket: 'sources', helmchart: 'sources', externalartifact: 'sources',
  alert: 'notifications', provider: 'notifications', receiver: 'notifications',
};
const FLUX_KIND = {
  kustomization: 'Kustomization', helmrelease: 'HelmRelease', gitrepository: 'GitRepository', ocirepository: 'OCIRepository',
  helmrepository: 'HelmRepository', bucket: 'Bucket', helmchart: 'HelmChart', externalartifact: 'ExternalArtifact',
  alert: 'Alert', provider: 'Provider', receiver: 'Receiver',
};
const FLUX_SUSPENDABLE = new Set(['kustomization', 'helmrelease', 'gitrepository', 'ocirepository', 'helmrepository', 'bucket', 'helmchart', 'alert', 'receiver']);
const GIT_REV = 'master@sha1:a30fa3224289a3f3e413157104dee8844e329926';
const OCI_REV = '6.14.0@sha256:272e33c79aa668777ec5c79248652deee2f34e785049c19607b9f571d1608ed4';
const HELMREPO_REV = 'sha256:23d1b72c7e6b835b1eda38821cf65539042d6fa4ee2bf162e25e0474fc44b2fe';
// Slight per-call jitter so live metrics "move" between polls.
const jitter = (base, pct = 0.12) => Math.max(0, base * (1 + (Math.random() - 0.5) * pct));
const round1 = (n) => +Number(n).toFixed(1);

// ----------------------------------------------------------------------------
// Shape helpers copied from server.js so demo lists match real lists exactly.
// (Kept in sync with server.js formatResource / getResourceStatus / etc.)
// ----------------------------------------------------------------------------
function containerState(cs) {
  if (!cs || !cs.state) return 'unknown';
  if (cs.state.running) return 'running';
  if (cs.state.terminated) return cs.state.terminated.exitCode === 0 ? 'running' : 'failed';
  if (cs.state.waiting) {
    const reason = cs.state.waiting.reason || '';
    const bad = /CrashLoopBackOff|Error|ImagePull|InvalidImageName|CreateContainer|RunContainer|CreateContainerConfigError/i.test(reason);
    return bad ? 'failed' : 'pending';
  }
  return 'unknown';
}

function getResourceStatus(item, kind) {
  const status = item.status || {};
  if (kind === 'Pod') return status.phase || 'Unknown';
  if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
    const ready = status.readyReplicas != null ? status.readyReplicas
      : (status.numberReady != null ? status.numberReady : 0);
    const desired = status.replicas != null ? status.replicas
      : (status.desiredNumberScheduled != null ? status.desiredNumberScheduled : 0);
    return `${ready}/${desired}`;
  }
  if (kind === 'Service') return item.spec?.type || 'Unknown';
  if (kind === 'PersistentVolume' || kind === 'PersistentVolumeClaim') return status.phase || 'Unknown';
  if (kind === 'StorageClass') return '';
  return 'Unknown';
}

function formatResource(item, kind) {
  const resolvedKind = kind || item.kind;
  const out = {
    name: item.metadata.name,
    namespace: item.metadata.namespace,
    kind: resolvedKind,
    createdAt: item.metadata.creationTimestamp,
    status: getResourceStatus(item, resolvedKind),
  };
  if (resolvedKind === 'Pod') {
    out.node = item.spec?.nodeName || null;
    out.containerNames = (item.spec?.containers || []).map((c) => c.name);
    const cs = item.status?.containerStatuses || [];
    const byName = {};
    cs.forEach((c) => { byName[c.name] = c; });
    out.containerStates = (item.spec?.containers || []).map((c) => ({ name: c.name, status: containerState(byName[c.name]) }));
    out.containers = out.containerNames.length || cs.length;
    out.restarts = cs.reduce((s, c) => s + (c.restartCount || 0), 0);
  }
  if (resolvedKind === 'ConfigMap') {
    out.dataKeys = Object.keys(item.data || {}).length + Object.keys(item.binaryData || {}).length;
  }
  if (resolvedKind === 'Secret') {
    out.secretType = item.type || 'Opaque';
    out.dataKeys = Object.keys(item.data || {}).length;
  }
  if (resolvedKind === 'ServiceAccount') out.saSecrets = (item.secrets || []).length;
  if (resolvedKind === 'NetworkPolicy') out.policyTypes = (item.spec?.policyTypes || []).join(', ') || '-';
  if (resolvedKind === 'Ingress') {
    out.ingressClass = item.spec?.ingressClassName || '-';
    out.hosts = (item.spec?.rules || []).map((r) => r.host).filter(Boolean).join(', ') || '-';
  }
  if (resolvedKind === 'PersistentVolumeClaim') {
    out.capacity = item.status?.capacity?.storage || item.spec?.resources?.requests?.storage || '-';
    out.storageClass = item.spec?.storageClassName || '-';
    out.volume = item.spec?.volumeName || '-';
    out.accessModes = (item.spec?.accessModes || []).join(',') || '-';
  }
  if (resolvedKind === 'PersistentVolume') {
    out.capacity = item.spec?.capacity?.storage || '-';
    out.storageClass = item.spec?.storageClassName || '-';
    out.reclaimPolicy = item.spec?.persistentVolumeReclaimPolicy || '-';
    out.claim = item.spec?.claimRef ? `${item.spec.claimRef.namespace}/${item.spec.claimRef.name}` : '-';
    out.accessModes = (item.spec?.accessModes || []).join(',') || '-';
  }
  if (resolvedKind === 'StorageClass') {
    out.provisioner = item.provisioner || '-';
    out.reclaimPolicy = item.reclaimPolicy || 'Delete';
    out.bindingMode = item.volumeBindingMode || 'Immediate';
  }
  return out;
}

// ----------------------------------------------------------------------------
// Object builders (full-ish Kubernetes manifests). These back the detail drawer
// and YAML viewer, and every list/summary is derived from them.
// ----------------------------------------------------------------------------
let uidCounter = 1000;
const uid = () => `d3m0${(uidCounter++).toString(16)}-0000-4000-8000-000000000000`;

function makeContainerStatus({ name, image, ready, restarts = 0, waiting, terminated }) {
  const cs = { name, image, imageID: `docker-pullable://${image}`, restartCount: restarts, ready: !!ready, started: !!ready };
  if (waiting) cs.state = { waiting: { reason: waiting, message: `Back-off restarting failed container ${name}` } };
  else if (terminated) cs.state = { terminated: { exitCode: terminated, reason: terminated === 0 ? 'Completed' : 'Error', finishedAt: ago(3) } };
  else cs.state = { running: { startedAt: ago(120) } };
  return cs;
}

// Build a Pod manifest. `phase`: Running | Pending | Succeeded | Failed.
function makePod(ns, name, opts = {}) {
  const {
    image = 'nginx:1.25', node = 'demo-node-1', phase = 'Running', ready = true, restarts = 0,
    waiting = null, cpuReq = '100m', memReq = '128Mi', cpuLim = '500m', memLim = '256Mi',
    labels = {}, owner = null, ports = [], sa = 'default', createdMin = 180,
    configMaps = [], secrets = [], pvc = null,
  } = opts;
  const containerName = name.replace(/-[a-z0-9]{5,}$/i, '') || name;
  const container = {
    name: containerName,
    image,
    imagePullPolicy: 'IfNotPresent',
    ports: ports.map((p) => ({ containerPort: p, protocol: 'TCP' })),
    resources: { requests: { cpu: cpuReq, memory: memReq }, limits: { cpu: cpuLim, memory: memLim } },
    env: [{ name: 'POD_NAMESPACE', value: ns }],
  };
  const volumes = [];
  configMaps.forEach((cm) => volumes.push({ name: `cm-${cm}`, configMap: { name: cm } }));
  secrets.forEach((s) => volumes.push({ name: `sec-${s}`, secret: { secretName: s } }));
  if (pvc) volumes.push({ name: 'data', persistentVolumeClaim: { claimName: pvc } });

  let containerStatuses = null;
  const conditions = [];
  if (phase === 'Pending') {
    // Unschedulable — no containerStatuses, a PodScheduled=False condition.
    conditions.push({ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes are available: 3 Insufficient cpu.' });
  } else {
    const csReady = phase === 'Running' && ready && !waiting;
    containerStatuses = [makeContainerStatus({ name: containerName, image, ready: csReady, restarts, waiting })];
    conditions.push(
      { type: 'Initialized', status: 'True' },
      { type: 'Ready', status: csReady ? 'True' : 'False' },
      { type: 'ContainersReady', status: csReady ? 'True' : 'False' },
      { type: 'PodScheduled', status: 'True' },
    );
  }

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin),
      labels: { ...labels },
      ownerReferences: owner ? [{ apiVersion: owner.apiVersion || 'apps/v1', kind: owner.kind, name: owner.name, uid: uid(), controller: true }] : undefined,
    },
    spec: {
      nodeName: phase === 'Pending' ? undefined : node,
      serviceAccountName: sa, serviceAccount: sa,
      priorityClassName: undefined,
      containers: [container],
      volumes,
      restartPolicy: 'Always',
      tolerations: [{ key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 }],
    },
    status: {
      phase,
      qosClass: 'Burstable',
      podIP: phase === 'Pending' ? undefined : `10.24.${node.endsWith('1') ? 1 : node.endsWith('2') ? 2 : 3}.${20 + (uidCounter % 200)}`,
      hostIP: phase === 'Pending' ? undefined : '10.0.0.10',
      startTime: phase === 'Pending' ? undefined : ago(createdMin),
      conditions,
      containerStatuses,
      reason: phase === 'Pending' ? 'Unschedulable' : undefined,
    },
  };
}

function makeDeployment(ns, name, opts = {}) {
  const { replicas = 2, ready = replicas, image = 'nginx:1.25', labels = {}, cpuReq = '100m', memReq = '128Mi', cpuLim = '500m', memLim = '256Mi', ports = [], createdMin = 1440 } = opts;
  const sel = { app: name, ...labels };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin), labels: sel, generation: 1, annotations: { 'deployment.kubernetes.io/revision': '1' } },
    spec: {
      replicas,
      selector: { matchLabels: sel },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } },
      template: {
        metadata: { labels: sel },
        spec: { containers: [{ name, image, ports: ports.map((p) => ({ containerPort: p })), resources: { requests: { cpu: cpuReq, memory: memReq }, limits: { cpu: cpuLim, memory: memLim } } }] },
      },
    },
    status: { replicas, readyReplicas: ready, availableReplicas: ready, updatedReplicas: replicas, observedGeneration: 1,
      conditions: [{ type: 'Available', status: ready >= replicas ? 'True' : 'False', reason: 'MinimumReplicasAvailable' }, { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }] },
  };
}

function makeStatefulSet(ns, name, opts = {}) {
  const { replicas = 1, ready = replicas, image = 'postgres:16', labels = {}, cpuReq = '250m', memReq = '512Mi', cpuLim = '1', memLim = '1Gi', ports = [5432], createdMin = 2880 } = opts;
  const sel = { app: name, ...labels };
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin), labels: sel, generation: 1 },
    spec: {
      replicas, serviceName: name,
      selector: { matchLabels: sel },
      updateStrategy: { type: 'RollingUpdate' },
      template: { metadata: { labels: sel }, spec: { containers: [{ name, image, ports: ports.map((p) => ({ containerPort: p })), resources: { requests: { cpu: cpuReq, memory: memReq }, limits: { cpu: cpuLim, memory: memLim } } }] } },
      volumeClaimTemplates: [{ metadata: { name: 'data' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '10Gi' } }, storageClassName: 'standard' } }],
    },
    status: { replicas, readyReplicas: ready, currentReplicas: replicas, updatedReplicas: replicas, observedGeneration: 1 },
  };
}

function makeDaemonSet(ns, name, opts = {}) {
  const { desired = 3, ready = 3, image = 'fluent/fluent-bit:2.2', labels = {}, createdMin = 4320 } = opts;
  const sel = { app: name, ...labels };
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin), labels: sel, generation: 1 },
    spec: { selector: { matchLabels: sel }, updateStrategy: { type: 'RollingUpdate' }, template: { metadata: { labels: sel }, spec: { containers: [{ name, image, resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '200m', memory: '128Mi' } } }] } } },
    status: { desiredNumberScheduled: desired, numberReady: ready, numberAvailable: ready, currentNumberScheduled: desired, updatedNumberScheduled: desired, numberMisscheduled: 0 },
  };
}

function makeService(ns, name, opts = {}) {
  const { type = 'ClusterIP', selector = { app: name }, ports = [{ port: 80, targetPort: 8080 }], createdMin = 1440, clusterIP = null } = opts;
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin), labels: { app: name } },
    spec: {
      type, selector,
      clusterIP: clusterIP || `10.96.${uidCounter % 250}.${10 + (uidCounter % 200)}`,
      sessionAffinity: 'None',
      ports: ports.map((p) => ({ name: `port-${p.port}`, port: p.port, targetPort: p.targetPort ?? p.port, protocol: p.protocol || 'TCP', ...(type === 'NodePort' ? { nodePort: 30000 + (p.port % 2767) } : {}) })),
    },
    status: { loadBalancer: {} },
  };
}

function makeConfigMap(ns, name, data, createdMin = 1440) {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin), labels: { app: name } }, data };
}

function makeSecret(ns, name, data, type = 'Opaque', createdMin = 1440) {
  // Values are base64-encoded like the real API returns them.
  const enc = {};
  for (const [k, v] of Object.entries(data)) enc[k] = Buffer.from(String(v)).toString('base64');
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin), labels: { app: name } }, type, data: enc };
}

function makeServiceAccount(ns, name, createdMin = 1440) {
  return { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin) }, secrets: [] };
}

function makeIngress(ns, name, host, svc, port = 80, createdMin = 1440) {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin), annotations: { 'nginx.ingress.kubernetes.io/rewrite-target': '/' } },
    spec: { ingressClassName: 'nginx', rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: svc, port: { number: port } } } }] } }] },
    status: { loadBalancer: { ingress: [{ ip: '203.0.113.42' }] } },
  };
}

function makeNetworkPolicy(ns, name, podApp, createdMin = 1440) {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin) },
    spec: { podSelector: { matchLabels: { app: podApp } }, policyTypes: ['Ingress', 'Egress'], ingress: [{ from: [{ podSelector: {} }] }] },
  };
}

function makePVC(ns, name, opts = {}) {
  const { storage = '10Gi', storageClass = 'standard', volumeName = null, phase = 'Bound', createdMin = 2880 } = opts;
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin) },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage } }, storageClassName: storageClass, volumeName: volumeName || undefined, volumeMode: 'Filesystem' },
    status: { phase, capacity: phase === 'Bound' ? { storage } : undefined, accessModes: ['ReadWriteOnce'] },
  };
}

function makeHPA(ns, name, target, opts = {}) {
  const { min = 2, max = 8, current = 3, cpuPct = 62 } = opts;
  return {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(1440) },
    spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: target }, minReplicas: min, maxReplicas: max, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }] },
    status: { currentReplicas: current, desiredReplicas: current, currentMetrics: [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: cpuPct } } }] },
  };
}

function makeJob(ns, name, opts = {}) {
  const { succeeded = 1, failed = 0, active = 0, createdMin = 300 } = opts;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin) },
    spec: { completions: 1, parallelism: 1, template: { metadata: { labels: { job: name } }, spec: { restartPolicy: 'Never', containers: [{ name, image: 'ghcr.io/shop/migrate:1.4.2' }] } } },
    status: { succeeded, failed, active, startTime: ago(createdMin), completionTime: succeeded ? ago(createdMin - 2) : undefined },
  };
}

function makeCronJob(ns, name, schedule, opts = {}) {
  const { suspend = false, createdMin = 4320 } = opts;
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name, namespace: ns, uid: uid(), creationTimestamp: ago(createdMin) },
    spec: { schedule, suspend, jobTemplate: { spec: { template: { spec: { restartPolicy: 'OnFailure', containers: [{ name, image: 'ghcr.io/shop/housekeeping:1.4.2' }] } } } } },
    status: { lastScheduleTime: ago(30), lastSuccessfulTime: ago(29) },
  };
}

function makeNode(name, opts = {}) {
  const { ip, role = 'worker', cpu = '4', memKi = '16311512Ki', createdMin = 20160 } = opts;
  const labels = {
    'kubernetes.io/hostname': name, 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64',
    'topology.kubernetes.io/region': 'demo-region', 'topology.kubernetes.io/zone': `demo-zone-${name.slice(-1)}`,
  };
  if (role === 'control-plane') labels['node-role.kubernetes.io/control-plane'] = '';
  // Allocatable is slightly below capacity (kube/system reserved).
  const allocCpu = String(parseInt(cpu) - 0) ; // keep simple: same cores, some millis reserved elsewhere
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name, uid: uid(), creationTimestamp: ago(createdMin), labels },
    spec: { podCIDR: '10.24.0.0/24', taints: role === 'control-plane' ? [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] : [] },
    status: {
      capacity: { cpu, memory: memKi, pods: '110', 'ephemeral-storage': '104857600Ki' },
      allocatable: { cpu: allocCpu, memory: `${parseInt(memKi) - 512000}Ki`, pods: '110', 'ephemeral-storage': '95094400Ki' },
      conditions: [
        { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory' },
        { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure' },
        { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID' },
        { type: 'Ready', status: 'True', reason: 'KubeletReady' },
      ],
      addresses: [{ type: 'InternalIP', address: ip }, { type: 'Hostname', address: name }],
      nodeInfo: {
        kubeletVersion: 'v1.29.4', kubeProxyVersion: 'v1.29.4',
        osImage: 'Ubuntu 22.04.4 LTS', kernelVersion: '5.15.0-101-generic',
        containerRuntimeVersion: 'containerd://1.7.13', operatingSystem: 'linux', architecture: 'amd64',
      },
    },
  };
}

function makePV(name, opts = {}) {
  const { storage = '10Gi', sc = 'standard', claimNs, claimName, reclaim = 'Delete' } = opts;
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name, uid: uid(), creationTimestamp: ago(2880) },
    spec: {
      capacity: { storage }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: reclaim,
      storageClassName: sc, volumeMode: 'Filesystem',
      claimRef: claimName ? { kind: 'PersistentVolumeClaim', namespace: claimNs, name: claimName } : undefined,
      csi: { driver: 'demo.csi.k8s.io', volumeHandle: `vol-${name}` },
    },
    status: { phase: claimName ? 'Bound' : 'Available' },
  };
}

function makeStorageClass(name, opts = {}) {
  const { provisioner = 'demo.csi.k8s.io', reclaim = 'Delete', binding = 'WaitForFirstConsumer', isDefault = false } = opts;
  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name, uid: uid(), creationTimestamp: ago(20160), annotations: isDefault ? { 'storageclass.kubernetes.io/is-default-class': 'true' } : {} },
    provisioner, reclaimPolicy: reclaim, volumeBindingMode: binding, allowVolumeExpansion: true,
  };
}

// ----------------------------------------------------------------------------
// Build the cluster ONCE.
// ----------------------------------------------------------------------------
function emptyNs() {
  return {
    pods: [], services: [], deployments: [], statefulSets: [], daemonSets: [], configMaps: [],
    secrets: [], serviceAccounts: [], ingresses: [], networkPolicies: [], persistentVolumeClaims: [],
    jobs: [], cronjobs: [], hpas: [], roles: [], roleBindings: [],
  };
}

const cluster = {
  ns: {}, // namespace name -> collections
  nsMeta: [], // namespace metadata objects
  nodes: [],
  storage: { pvs: [], storageClasses: [] },
  clusterRoles: [], clusterRoleBindings: [],
  helm: [],
  crds: [],
  customResources: {}, // "group/version/plural" -> [objects]
  argo: { apps: [], projects: [], appsets: [], repos: [], clusters: [] },
  flux: [], // Flux CD resources, stored in the server's parsed-row shape + detail fields
  flagger: [], flaggerTemplates: [], flaggerProviders: [], // Flagger canaries + analysis config
  events: [],
  // metrics baselines keyed by "ns/pod" and node name
  podMetricBase: {},
  nodeMetricBase: {},
};

function ns(name) {
  if (!cluster.ns[name]) cluster.ns[name] = emptyNs();
  return cluster.ns[name];
}

function registerNamespace(name, labels = {}, createdMin = 20160) {
  cluster.nsMeta.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, uid: uid(), creationTimestamp: ago(createdMin), labels: { 'kubernetes.io/metadata.name': name, ...labels } }, status: { phase: 'Active' } });
  ns(name);
}

// Set a metrics baseline for a pod (millicores, bytes).
function podMetric(nsName, podName, cpuMilli, memBytes) {
  cluster.podMetricBase[`${nsName}/${podName}`] = { cpuMilli, memBytes };
}

(function build() {
  // ---- namespaces ----
  registerNamespace('default');
  registerNamespace('kube-system');
  registerNamespace('shop', { team: 'commerce', 'app.kubernetes.io/part-of': 'shop' });
  registerNamespace('monitoring', { team: 'platform' });
  registerNamespace('argocd', { 'app.kubernetes.io/part-of': 'argocd' });

  // ---- nodes ----
  cluster.nodes.push(makeNode('demo-node-1', { ip: '10.0.0.11', role: 'control-plane' }));
  cluster.nodes.push(makeNode('demo-node-2', { ip: '10.0.0.12' }));
  cluster.nodes.push(makeNode('demo-node-3', { ip: '10.0.0.13' }));
  cluster.nodeMetricBase['demo-node-1'] = { cpuMilli: 850, memBytes: 5.2 * 1024 ** 3 };
  cluster.nodeMetricBase['demo-node-2'] = { cpuMilli: 1650, memBytes: 8.1 * 1024 ** 3 };
  cluster.nodeMetricBase['demo-node-3'] = { cpuMilli: 1180, memBytes: 6.4 * 1024 ** 3 };

  // ================= default =================
  {
    const d = ns('default');
    d.serviceAccounts.push(makeServiceAccount('default', 'default'));
    const dep = makeDeployment('default', 'hello-web', { replicas: 1, image: 'nginxdemos/hello:0.3', ports: [80] });
    d.deployments.push(dep);
    const p = makePod('default', 'hello-web-6c9d4b7f8-abcde', { image: 'nginxdemos/hello:0.3', node: 'demo-node-2', ports: [80], owner: { kind: 'ReplicaSet', name: 'hello-web-6c9d4b7f8' }, labels: { app: 'hello-web' } });
    d.pods.push(p);
    podMetric('default', p.metadata.name, 12, 34 * 1024 ** 2);
    d.services.push(makeService('default', 'hello-web', { ports: [{ port: 80, targetPort: 80 }] }));
    d.services.push(makeService('default', 'kubernetes', { ports: [{ port: 443, targetPort: 6443 }], selector: {}, clusterIP: '10.96.0.1' }));
  }

  // ================= kube-system =================
  {
    const k = ns('kube-system');
    ['default', 'coredns', 'metrics-server', 'kube-proxy'].forEach((s) => k.serviceAccounts.push(makeServiceAccount('kube-system', s)));
    const coredns = makeDeployment('kube-system', 'coredns', { replicas: 2, image: 'registry.k8s.io/coredns/coredns:v1.11.1', cpuReq: '100m', memReq: '70Mi', cpuLim: '200m', memLim: '170Mi', ports: [53] });
    k.deployments.push(coredns);
    const ms = makeDeployment('kube-system', 'metrics-server', { replicas: 1, image: 'registry.k8s.io/metrics-server/metrics-server:v0.7.1', ports: [10250] });
    k.deployments.push(ms);
    ['coredns-5d78c9869d-11111', 'coredns-5d78c9869d-22222'].forEach((n, i) => {
      const p = makePod('kube-system', n, { image: 'registry.k8s.io/coredns/coredns:v1.11.1', node: `demo-node-${(i % 2) + 1}`, ports: [53], owner: { kind: 'ReplicaSet', name: 'coredns-5d78c9869d' }, labels: { 'k8s-app': 'kube-dns' }, cpuReq: '100m', memReq: '70Mi', sa: 'coredns' });
      k.pods.push(p); podMetric('kube-system', n, 6, 22 * 1024 ** 2);
    });
    const msp = makePod('kube-system', 'metrics-server-7d9c8b6f5-33333', { image: 'registry.k8s.io/metrics-server/metrics-server:v0.7.1', node: 'demo-node-1', ports: [10250], owner: { kind: 'ReplicaSet', name: 'metrics-server-7d9c8b6f5' }, labels: { 'k8s-app': 'metrics-server' }, sa: 'metrics-server' });
    k.pods.push(msp); podMetric('kube-system', msp.metadata.name, 9, 40 * 1024 ** 2);
    const kp = makeDaemonSet('kube-system', 'kube-proxy', { desired: 3, ready: 3, image: 'registry.k8s.io/kube-proxy:v1.29.4', labels: { 'k8s-app': 'kube-proxy' } });
    k.daemonSets.push(kp);
    cluster.nodes.forEach((node, i) => {
      const p = makePod('kube-system', `kube-proxy-${['aa', 'bb', 'cc'][i]}`, { image: 'registry.k8s.io/kube-proxy:v1.29.4', node: node.metadata.name, owner: { kind: 'DaemonSet', name: 'kube-proxy' }, labels: { 'k8s-app': 'kube-proxy' }, cpuReq: '50m', memReq: '64Mi', sa: 'kube-proxy' });
      k.pods.push(p); podMetric('kube-system', p.metadata.name, 4, 18 * 1024 ** 2);
    });
    k.services.push(makeService('kube-system', 'kube-dns', { ports: [{ port: 53, targetPort: 53, protocol: 'UDP' }], selector: { 'k8s-app': 'kube-dns' }, clusterIP: '10.96.0.10' }));
    k.services.push(makeService('kube-system', 'metrics-server', { ports: [{ port: 443, targetPort: 10250 }], selector: { 'k8s-app': 'metrics-server' } }));
    k.configMaps.push(makeConfigMap('kube-system', 'coredns', { Corefile: '.:53 {\n    errors\n    health\n    kubernetes cluster.local in-addr.arpa ip6.arpa\n    forward . /etc/resolv.conf\n    cache 30\n}\n' }));
    k.configMaps.push(makeConfigMap('kube-system', 'kube-proxy', { 'config.conf': 'mode: iptables\n' }));
  }

  // ================= shop (the demo microservices app) =================
  {
    const s = ns('shop');
    ['default', 'frontend', 'checkout', 'cart', 'catalog', 'payments'].forEach((n) => s.serviceAccounts.push(makeServiceAccount('shop', n)));

    // ConfigMaps + Secrets
    s.configMaps.push(makeConfigMap('shop', 'shop-config', { LOG_LEVEL: 'info', CURRENCY: 'USD', FEATURE_RECOMMENDATIONS: 'true' }));
    s.configMaps.push(makeConfigMap('shop', 'checkout-config', { PAYMENT_TIMEOUT: '30s', RETRIES: '3' }));
    s.secrets.push(makeSecret('shop', 'postgres-credentials', { username: 'shop', password: 'S3cr3t-demo-pw' }));
    s.secrets.push(makeSecret('shop', 'stripe-api-key', { 'api-key': 'sk_live_demo_0000000000' }));
    s.secrets.push(makeSecret('shop', 'shop-tls', { 'tls.crt': 'LS0tLS1CRUdJTi==', 'tls.key': 'LS0tLS1CRUdJTi==' }, 'kubernetes.io/tls'));

    // frontend deployment (3/3) + HPA + service + ingress
    s.deployments.push(makeDeployment('shop', 'frontend', { replicas: 3, ready: 3, image: 'ghcr.io/shop/frontend:1.4.2', ports: [8080], cpuReq: '100m', memReq: '128Mi', cpuLim: '500m', memLim: '256Mi', labels: { tier: 'web' } }));
    ['frontend-7f9c6d5b4-fe001', 'frontend-7f9c6d5b4-fe002', 'frontend-7f9c6d5b4-fe003'].forEach((n, i) => {
      const p = makePod('shop', n, { image: 'ghcr.io/shop/frontend:1.4.2', node: `demo-node-${(i % 3) + 1}`, ports: [8080], owner: { kind: 'ReplicaSet', name: 'frontend-7f9c6d5b4' }, labels: { app: 'frontend', tier: 'web' }, sa: 'frontend', configMaps: ['shop-config'] });
      s.pods.push(p); podMetric('shop', n, 120 + i * 15, (140 + i * 20) * 1024 ** 2);
    });
    s.hpas.push(makeHPA('shop', 'frontend', 'frontend', { min: 3, max: 10, current: 3, cpuPct: 58 }));
    s.services.push(makeService('shop', 'frontend', { ports: [{ port: 80, targetPort: 8080 }] }));
    s.ingresses.push(makeIngress('shop', 'shop-ingress', 'shop.demo.example.com', 'frontend', 80));

    // catalog (2/2)
    s.deployments.push(makeDeployment('shop', 'catalog', { replicas: 2, ready: 2, image: 'ghcr.io/shop/catalog:1.4.2', ports: [8080] }));
    ['catalog-6b8d7c9f5-ca001', 'catalog-6b8d7c9f5-ca002'].forEach((n, i) => {
      const p = makePod('shop', n, { image: 'ghcr.io/shop/catalog:1.4.2', node: `demo-node-${(i % 3) + 1}`, ports: [8080], owner: { kind: 'ReplicaSet', name: 'catalog-6b8d7c9f5' }, labels: { app: 'catalog' }, sa: 'catalog', configMaps: ['shop-config'] });
      s.pods.push(p); podMetric('shop', n, 80 + i * 10, (110 + i * 10) * 1024 ** 2);
    });
    s.services.push(makeService('shop', 'catalog', { ports: [{ port: 80, targetPort: 8080 }] }));

    // cart (2/2) — uses redis-ish
    s.deployments.push(makeDeployment('shop', 'cart', { replicas: 2, ready: 2, image: 'ghcr.io/shop/cart:1.4.2', ports: [8080] }));
    ['cart-59f7b6c8d-cr001', 'cart-59f7b6c8d-cr002'].forEach((n, i) => {
      const p = makePod('shop', n, { image: 'ghcr.io/shop/cart:1.4.2', node: `demo-node-${(i % 3) + 1}`, ports: [8080], owner: { kind: 'ReplicaSet', name: 'cart-59f7b6c8d' }, labels: { app: 'cart' }, sa: 'cart' });
      s.pods.push(p); podMetric('shop', n, 55 + i * 8, (90 + i * 8) * 1024 ** 2);
    });
    s.services.push(makeService('shop', 'cart', { ports: [{ port: 80, targetPort: 8080 }] }));

    // checkout (1/2) — ONE pod CrashLoopBackOff (bad config)
    s.deployments.push(makeDeployment('shop', 'checkout', { replicas: 2, ready: 1, image: 'ghcr.io/shop/checkout:1.5.0-rc1', ports: [8080] }));
    const okCheckout = makePod('shop', 'checkout-7c8f9d6b5-ck001', { image: 'ghcr.io/shop/checkout:1.5.0-rc1', node: 'demo-node-2', ports: [8080], owner: { kind: 'ReplicaSet', name: 'checkout-7c8f9d6b5' }, labels: { app: 'checkout' }, sa: 'checkout', configMaps: ['checkout-config'], secrets: ['stripe-api-key'] });
    s.pods.push(okCheckout); podMetric('shop', okCheckout.metadata.name, 70, 130 * 1024 ** 2);
    const crashCheckout = makePod('shop', 'checkout-7c8f9d6b5-ck002', { image: 'ghcr.io/shop/checkout:1.5.0-rc1', node: 'demo-node-3', ports: [8080], owner: { kind: 'ReplicaSet', name: 'checkout-7c8f9d6b5' }, labels: { app: 'checkout' }, sa: 'checkout', ready: false, restarts: 7, waiting: 'CrashLoopBackOff', configMaps: ['checkout-config'], secrets: ['stripe-api-key'], createdMin: 45 });
    s.pods.push(crashCheckout); podMetric('shop', crashCheckout.metadata.name, 2, 40 * 1024 ** 2);
    s.services.push(makeService('shop', 'checkout', { ports: [{ port: 80, targetPort: 8080 }] }));

    // payments (0/1) — ONE pod Pending (unschedulable, too much CPU requested)
    s.deployments.push(makeDeployment('shop', 'payments', { replicas: 1, ready: 0, image: 'ghcr.io/shop/payments:1.4.2', ports: [8080], cpuReq: '8', memReq: '512Mi', cpuLim: '8', memLim: '1Gi' }));
    const pendingPay = makePod('shop', 'payments-8d7c6b5a4-py001', { image: 'ghcr.io/shop/payments:1.4.2', phase: 'Pending', ready: false, ports: [8080], owner: { kind: 'ReplicaSet', name: 'payments-8d7c6b5a4' }, labels: { app: 'payments' }, sa: 'payments', cpuReq: '8', memReq: '512Mi', cpuLim: '8', memLim: '1Gi', secrets: ['stripe-api-key'], createdMin: 22 });
    s.pods.push(pendingPay);
    s.services.push(makeService('shop', 'payments', { ports: [{ port: 80, targetPort: 8080 }] }));

    // postgres statefulset (1/1) + PVC
    s.statefulSets.push(makeStatefulSet('shop', 'postgres', { replicas: 1, ready: 1, image: 'postgres:16.2', ports: [5432] }));
    const pgPod = makePod('shop', 'postgres-0', { image: 'postgres:16.2', node: 'demo-node-2', ports: [5432], owner: { kind: 'StatefulSet', name: 'postgres' }, labels: { app: 'postgres' }, cpuReq: '250m', memReq: '512Mi', cpuLim: '1', memLim: '1Gi', secrets: ['postgres-credentials'], pvc: 'data-postgres-0', createdMin: 2880 });
    s.pods.push(pgPod); podMetric('shop', 'postgres-0', 180, 420 * 1024 ** 2);
    s.persistentVolumeClaims.push(makePVC('shop', 'data-postgres-0', { storage: '10Gi', storageClass: 'standard', volumeName: 'pv-postgres-shop' }));
    s.services.push(makeService('shop', 'postgres', { ports: [{ port: 5432, targetPort: 5432 }], selector: { app: 'postgres' } }));

    // a daemonset (log shipper) in shop
    s.daemonSets.push(makeDaemonSet('shop', 'shop-logging', { desired: 3, ready: 3, image: 'fluent/fluent-bit:2.2.2', labels: { app: 'shop-logging' } }));
    cluster.nodes.forEach((node, i) => {
      const p = makePod('shop', `shop-logging-${['x1', 'x2', 'x3'][i]}`, { image: 'fluent/fluent-bit:2.2.2', node: node.metadata.name, owner: { kind: 'DaemonSet', name: 'shop-logging' }, labels: { app: 'shop-logging' }, cpuReq: '50m', memReq: '64Mi', cpuLim: '200m', memLim: '128Mi' });
      s.pods.push(p); podMetric('shop', p.metadata.name, 15, 48 * 1024 ** 2);
    });

    // network policy, jobs, cronjobs
    s.networkPolicies.push(makeNetworkPolicy('shop', 'payments-restrict', 'payments'));
    s.jobs.push(makeJob('shop', 'db-migrate-1', { succeeded: 1 }));
    s.cronjobs.push(makeCronJob('shop', 'nightly-cleanup', '0 2 * * *'));

    // roles / rolebindings (namespaced RBAC)
    s.roles.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'shop-reader', namespace: 'shop', uid: uid(), creationTimestamp: ago(4320) }, rules: [{ apiGroups: [''], resources: ['pods', 'services', 'configmaps'], verbs: ['get', 'list', 'watch'] }] });
    s.roleBindings.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'shop-reader-binding', namespace: 'shop', uid: uid(), creationTimestamp: ago(4320) }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'shop-reader' }, subjects: [{ kind: 'ServiceAccount', name: 'frontend', namespace: 'shop' }] });
  }

  // ================= monitoring =================
  {
    const m = ns('monitoring');
    ['default', 'prometheus', 'grafana'].forEach((n) => m.serviceAccounts.push(makeServiceAccount('monitoring', n)));
    m.statefulSets.push(makeStatefulSet('monitoring', 'prometheus', { replicas: 1, ready: 1, image: 'quay.io/prometheus/prometheus:v2.51.0', ports: [9090], cpuReq: '500m', memReq: '1Gi', cpuLim: '2', memLim: '2Gi' }));
    const promPod = makePod('monitoring', 'prometheus-0', { image: 'quay.io/prometheus/prometheus:v2.51.0', node: 'demo-node-3', ports: [9090], owner: { kind: 'StatefulSet', name: 'prometheus' }, labels: { app: 'prometheus' }, cpuReq: '500m', memReq: '1Gi', cpuLim: '2', memLim: '2Gi', pvc: 'data-prometheus-0' });
    m.pods.push(promPod); podMetric('monitoring', 'prometheus-0', 340, 1.3 * 1024 ** 3);
    m.persistentVolumeClaims.push(makePVC('monitoring', 'data-prometheus-0', { storage: '50Gi', storageClass: 'fast-ssd', volumeName: 'pv-prometheus' }));
    m.deployments.push(makeDeployment('monitoring', 'grafana', { replicas: 1, ready: 1, image: 'grafana/grafana:10.4.1', ports: [3000] }));
    const grafPod = makePod('monitoring', 'grafana-6d8f7c9b5-gf001', { image: 'grafana/grafana:10.4.1', node: 'demo-node-1', ports: [3000], owner: { kind: 'ReplicaSet', name: 'grafana-6d8f7c9b5' }, labels: { app: 'grafana' }, sa: 'grafana' });
    m.pods.push(grafPod); podMetric('monitoring', grafPod.metadata.name, 45, 160 * 1024 ** 2);
    m.daemonSets.push(makeDaemonSet('monitoring', 'node-exporter', { desired: 3, ready: 3, image: 'quay.io/prometheus/node-exporter:v1.7.0', labels: { app: 'node-exporter' } }));
    cluster.nodes.forEach((node, i) => {
      const p = makePod('monitoring', `node-exporter-${['n1', 'n2', 'n3'][i]}`, { image: 'quay.io/prometheus/node-exporter:v1.7.0', node: node.metadata.name, owner: { kind: 'DaemonSet', name: 'node-exporter' }, labels: { app: 'node-exporter' }, cpuReq: '50m', memReq: '64Mi', cpuLim: '200m', memLim: '128Mi', ports: [9100] });
      p.spec.hostNetwork = true; m.pods.push(p); podMetric('monitoring', p.metadata.name, 8, 30 * 1024 ** 2);
    });
    m.services.push(makeService('monitoring', 'prometheus', { ports: [{ port: 9090, targetPort: 9090 }], selector: { app: 'prometheus' } }));
    m.services.push(makeService('monitoring', 'grafana', { type: 'LoadBalancer', ports: [{ port: 80, targetPort: 3000 }], selector: { app: 'grafana' } }));
    m.configMaps.push(makeConfigMap('monitoring', 'prometheus-config', { 'prometheus.yml': 'global:\n  scrape_interval: 15s\n' }));
  }

  // ================= argocd (workloads) =================
  {
    const a = ns('argocd');
    a.serviceAccounts.push(makeServiceAccount('argocd', 'argocd-application-controller'));
    a.deployments.push(makeDeployment('argocd', 'argocd-server', { replicas: 1, ready: 1, image: 'quay.io/argoproj/argocd:v2.11.0', ports: [8080] }));
    a.deployments.push(makeDeployment('argocd', 'argocd-repo-server', { replicas: 1, ready: 1, image: 'quay.io/argoproj/argocd:v2.11.0', ports: [8081] }));
    const asrv = makePod('argocd', 'argocd-server-5f8c9d7b6-as001', { image: 'quay.io/argoproj/argocd:v2.11.0', node: 'demo-node-1', ports: [8080], owner: { kind: 'ReplicaSet', name: 'argocd-server-5f8c9d7b6' }, labels: { 'app.kubernetes.io/name': 'argocd-server' } });
    a.pods.push(asrv); podMetric('argocd', asrv.metadata.name, 35, 120 * 1024 ** 2);
    a.services.push(makeService('argocd', 'argocd-server', { ports: [{ port: 443, targetPort: 8080 }], selector: { 'app.kubernetes.io/name': 'argocd-server' } }));
    a.configMaps.push(makeConfigMap('argocd', 'argocd-cm', { url: 'https://argocd.demo.example.com' }));
  }

  // ---- cluster-scoped storage ----
  cluster.storage.storageClasses.push(makeStorageClass('standard', { isDefault: true }));
  cluster.storage.storageClasses.push(makeStorageClass('fast-ssd', { binding: 'Immediate' }));
  cluster.storage.pvs.push(makePV('pv-postgres-shop', { storage: '10Gi', sc: 'standard', claimNs: 'shop', claimName: 'data-postgres-0' }));
  cluster.storage.pvs.push(makePV('pv-prometheus', { storage: '50Gi', sc: 'fast-ssd', claimNs: 'monitoring', claimName: 'data-prometheus-0', reclaim: 'Retain' }));
  cluster.storage.pvs.push(makePV('pv-spare', { storage: '20Gi', sc: 'standard' }));

  // ---- cluster-scoped RBAC ----
  cluster.clusterRoles.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'cluster-admin', uid: uid(), creationTimestamp: ago(20160) }, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] });
  cluster.clusterRoles.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'view', uid: uid(), creationTimestamp: ago(20160) }, rules: [{ apiGroups: [''], resources: ['pods', 'services'], verbs: ['get', 'list', 'watch'] }] });
  cluster.clusterRoles.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'shop-deployer', uid: uid(), creationTimestamp: ago(4320) }, rules: [{ apiGroups: ['apps', ''], resources: ['deployments', 'pods'], verbs: ['*'] }] });
  cluster.clusterRoleBindings.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'cluster-admin-binding', uid: uid(), creationTimestamp: ago(20160) }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ kind: 'Group', name: 'system:masters' }] });
  cluster.clusterRoleBindings.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'shop-deployer-binding', uid: uid(), creationTimestamp: ago(4320) }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'shop-deployer' }, subjects: [{ kind: 'ServiceAccount', name: 'default', namespace: 'shop' }] });

  // ---- Helm releases ----
  cluster.helm.push(makeHelmRelease('ingress-nginx', 'kube-system', { chart: 'ingress-nginx', chartVer: '4.10.0', appVersion: '1.10.0', status: 'deployed', revision: 3, values: { controller: { replicaCount: 2, service: { type: 'LoadBalancer' } } } }));
  cluster.helm.push(makeHelmRelease('kube-prometheus-stack', 'monitoring', { chart: 'kube-prometheus-stack', chartVer: '58.1.0', appVersion: 'v0.73.0', status: 'deployed', revision: 5, values: { grafana: { enabled: true }, prometheus: { prometheusSpec: { retention: '15d' } } } }));
  cluster.helm.push(makeHelmRelease('argo-cd', 'argocd', { chart: 'argo-cd', chartVer: '6.7.0', appVersion: 'v2.11.0', status: 'deployed', revision: 2, values: { server: { extraArgs: ['--insecure'] } } }));

  // ---- CRDs ----
  cluster.crds = [
    { name: 'applications.argoproj.io', group: 'argoproj.io', kind: 'Application', plural: 'applications', singular: 'application', scope: 'Namespaced', createdAt: ago(10080), version: 'v1alpha1' },
    { name: 'appprojects.argoproj.io', group: 'argoproj.io', kind: 'AppProject', plural: 'appprojects', singular: 'appproject', scope: 'Namespaced', createdAt: ago(10080), version: 'v1alpha1' },
    { name: 'applicationsets.argoproj.io', group: 'argoproj.io', kind: 'ApplicationSet', plural: 'applicationsets', singular: 'applicationset', scope: 'Namespaced', createdAt: ago(10080), version: 'v1alpha1' },
    { name: 'certificates.cert-manager.io', group: 'cert-manager.io', kind: 'Certificate', plural: 'certificates', singular: 'certificate', scope: 'Namespaced', createdAt: ago(10080), version: 'v1' },
    { name: 'vulnerabilityreports.aquasecurity.github.io', group: 'aquasecurity.github.io', kind: 'VulnerabilityReport', plural: 'vulnerabilityreports', singular: 'vulnerabilityreport', scope: 'Namespaced', createdAt: ago(8640), version: 'v1alpha1' },
    { name: 'configauditreports.aquasecurity.github.io', group: 'aquasecurity.github.io', kind: 'ConfigAuditReport', plural: 'configauditreports', singular: 'configauditreport', scope: 'Namespaced', createdAt: ago(8640), version: 'v1alpha1' },
  ];

  // ---- Custom resources: cert-manager Certificates ----
  cluster.customResources['cert-manager.io/v1/certificates'] = [
    { apiVersion: 'cert-manager.io/v1', kind: 'Certificate', metadata: { name: 'shop-tls', namespace: 'shop', uid: uid(), creationTimestamp: ago(4320) }, spec: { secretName: 'shop-tls', dnsNames: ['shop.demo.example.com'], issuerRef: { name: 'letsencrypt-prod', kind: 'ClusterIssuer' } }, status: { conditions: [{ type: 'Ready', status: 'True', reason: 'Ready' }], notAfter: ago(-129600) } },
    { apiVersion: 'cert-manager.io/v1', kind: 'Certificate', metadata: { name: 'argocd-tls', namespace: 'argocd', uid: uid(), creationTimestamp: ago(4320) }, spec: { secretName: 'argocd-tls', dnsNames: ['argocd.demo.example.com'], issuerRef: { name: 'letsencrypt-prod', kind: 'ClusterIssuer' } }, status: { conditions: [{ type: 'Ready', status: 'True', reason: 'Ready' }], notAfter: ago(-100000) } },
  ];

  buildArgo();
  buildFlux();
  buildFlagger();
})();

// ----------------------------------------------------------------------------
// Helm release record — same on-disk shape server.js decodes (r.name, r.namespace,
// r.version, r.info.status/last_deployed, r.chart.metadata, r.config, r.manifest).
// ----------------------------------------------------------------------------
function makeHelmRelease(name, namespace, opts) {
  const { chart, chartVer, appVersion, status, revision, values } = opts;
  const manifest = `---\n# Source: ${chart}/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\nspec:\n  replicas: 1\n`;
  return {
    name, namespace, version: revision,
    info: { status, first_deployed: ago(20160), last_deployed: ago(120), description: 'Upgrade complete' },
    chart: { metadata: { name: chart, version: chartVer, appVersion } },
    config: values || {},
    manifest,
  };
}

// ----------------------------------------------------------------------------
// ArgoCD dataset (Applications stored as full CRs; projects/appsets/repos/clusters).
// ----------------------------------------------------------------------------
function makeArgoApp(name, opts) {
  const { project = 'default', sync = 'Synced', health = 'Healthy', repoURL, path, targetRevision = 'HEAD', chart = null, destNs = 'default', revision = 'a1b2c3d4e5f6', healthMessage = '', autoSync = true, opPhase = 'Succeeded', images = [], resources = [] } = opts;
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: { name, namespace: 'argocd', uid: uid(), creationTimestamp: ago(4320), finalizers: ['resources-finalizer.argocd.argoproj.io'] },
    spec: {
      project,
      source: { repoURL, path: path || undefined, chart: chart || undefined, targetRevision },
      destination: { server: 'https://kubernetes.default.svc', namespace: destNs },
      syncPolicy: autoSync ? { automated: { prune: true, selfHeal: true } } : {},
    },
    status: {
      sync: { status: sync, revision },
      health: { status: health, message: healthMessage },
      reconciledAt: ago(5),
      summary: { images },
      resources,
      operationState: { phase: opPhase, message: opPhase === 'Succeeded' ? 'successfully synced' : 'sync in progress', startedAt: ago(6), finishedAt: opPhase === 'Running' ? '' : ago(5), syncResult: { revision } },
      history: [
        { id: 1, revision, deployedAt: ago(1440) },
        { id: 2, revision, deployedAt: ago(120) },
      ],
      conditions: health === 'Degraded' ? [{ type: 'ComparisonError', message: healthMessage || 'one or more objects failed to apply' }] : [],
    },
  };
}

function buildArgo() {
  const res = (kind, name, namespace, status, health) => ({ group: kind === 'Deployment' ? 'apps' : '', version: kind === 'Deployment' ? 'v1' : 'v1', kind, namespace, name, status, health: health ? { status: health } : undefined });
  cluster.argo.apps = [
    makeArgoApp('frontend', { repoURL: 'https://github.com/demo-org/shop-gitops', path: 'apps/frontend', destNs: 'shop', sync: 'Synced', health: 'Healthy', images: ['ghcr.io/shop/frontend:1.4.2'], resources: [res('Deployment', 'frontend', 'shop', 'Synced', 'Healthy'), res('Service', 'frontend', 'shop', 'Synced', 'Healthy')] }),
    makeArgoApp('catalog', { repoURL: 'https://github.com/demo-org/shop-gitops', path: 'apps/catalog', destNs: 'shop', sync: 'Synced', health: 'Healthy', images: ['ghcr.io/shop/catalog:1.4.2'], resources: [res('Deployment', 'catalog', 'shop', 'Synced', 'Healthy')] }),
    makeArgoApp('checkout', { repoURL: 'https://github.com/demo-org/shop-gitops', path: 'apps/checkout', destNs: 'shop', sync: 'OutOfSync', health: 'Degraded', healthMessage: 'Deployment has 1/2 replicas available (CrashLoopBackOff)', images: ['ghcr.io/shop/checkout:1.5.0-rc1'], resources: [res('Deployment', 'checkout', 'shop', 'OutOfSync', 'Degraded')] }),
    makeArgoApp('payments', { repoURL: 'https://github.com/demo-org/shop-gitops', path: 'apps/payments', destNs: 'shop', sync: 'OutOfSync', health: 'Progressing', healthMessage: 'Deployment is waiting for pods to be scheduled', opPhase: 'Running', images: ['ghcr.io/shop/payments:1.4.2'], resources: [res('Deployment', 'payments', 'shop', 'OutOfSync', 'Progressing')] }),
    makeArgoApp('monitoring-stack', { project: 'platform', repoURL: 'https://prometheus-community.github.io/helm-charts', chart: 'kube-prometheus-stack', targetRevision: '58.1.0', destNs: 'monitoring', sync: 'Synced', health: 'Healthy', images: ['grafana/grafana:10.4.1', 'quay.io/prometheus/prometheus:v2.51.0'] }),
    makeArgoApp('ingress-nginx', { project: 'platform', repoURL: 'https://kubernetes.github.io/ingress-nginx', chart: 'ingress-nginx', targetRevision: '4.10.0', destNs: 'kube-system', sync: 'Synced', health: 'Progressing', healthMessage: 'Waiting for rollout to finish', opPhase: 'Running' }),
  ];
  cluster.argo.projects = [
    { name: 'default', namespace: 'argocd', description: 'Default project', sourceRepos: ['*'], destinations: ['https://kubernetes.default.svc/*'], clusterResourceWhitelist: 1, roles: [], createdAt: ago(10080) },
    { name: 'platform', namespace: 'argocd', description: 'Platform team infrastructure', sourceRepos: ['https://kubernetes.github.io/ingress-nginx', 'https://prometheus-community.github.io/helm-charts'], destinations: ['https://kubernetes.default.svc/monitoring', 'https://kubernetes.default.svc/kube-system'], clusterResourceWhitelist: 3, roles: ['admin', 'readonly'], createdAt: ago(8640) },
  ];
  cluster.argo.appsets = [
    { name: 'shop-apps', namespace: 'argocd', generators: ['git'], destinationNamespace: 'shop', project: 'default', conditions: [{ type: 'ResourcesUpToDate', status: 'True', message: 'All applications have been generated' }], createdAt: ago(4320) },
  ];
  cluster.argo.repos = [
    { url: 'https://github.com/demo-org/shop-gitops', name: 'shop-gitops', type: 'git', project: 'default', source: 'secret' },
    { url: 'https://kubernetes.github.io/ingress-nginx', name: '', type: 'helm', project: '', source: 'application', appCount: 1 },
    { url: 'https://prometheus-community.github.io/helm-charts', name: '', type: 'helm', project: '', source: 'application', appCount: 1 },
  ];
  cluster.argo.clusters = [
    { name: 'in-cluster', server: 'https://kubernetes.default.svc' },
    { name: 'demo-staging', server: 'https://10.0.5.1' },
  ];
}

// ------------------------------------------------------------------
// Flux CD — a small podinfo GitOps setup. Each resource is stored in the same
// parsed-row shape server.js returns from /api/flux/resources, plus `_`-prefixed
// detail fields (conditions, annotations, finalizers, managed inventory, events).
// ------------------------------------------------------------------
function fluxRes(kindKey, namespace, name, o = {}) {
  const ready = (o.state || 'Ready') === 'Ready';
  const r = {
    kindKey, kind: FLUX_KIND[kindKey], category: FLUX_CATEGORY[kindKey], name, namespace,
    state: o.state || 'Ready', suspended: false, suspendable: FLUX_SUSPENDABLE.has(kindKey),
    message: o.message || '', reason: o.reason || (ready ? 'Succeeded' : ''),
    revision: o.revision || '', source: o.source || null,
    lastReconciled: o.lastReconciled || ago(o.reconciledMins ?? 2), createdAt: o.createdAt || ago(4680),
    interval: o.interval || '5m', url: o.url || '', type: o.type || '',
    chart: o.chart || '', chartVersion: o.chartVersion || '', path: o.path || '', prune: !!o.prune,
    targetNamespace: o.targetNamespace || '', lastAppliedRevision: o.lastAppliedRevision || o.revision || '',
    _baseState: o.state || 'Ready',
    _conditions: o.conditions || (ready
      ? [{ type: 'Ready', status: 'True', reason: o.reason || 'Succeeded', message: o.message || '', lastTransitionTime: ago(o.reconciledMins ?? 2) }, ...(o.extraConditions || [])]
      : [{ type: 'Reconciling', status: 'True', reason: 'Progressing', message: 'Reconciliation in progress', lastTransitionTime: ago(o.reconciledMins ?? 5) },
         { type: 'Ready', status: 'False', reason: o.reason || 'ReconciliationFailed', message: o.message || '', lastTransitionTime: ago(o.reconciledMins ?? 5) }]),
    _annotations: o.annotations || { 'kubectl.kubernetes.io/last-applied-configuration': `{"apiVersion":"…","kind":"${FLUX_KIND[kindKey]}","metadata":{"name":"${name}","namespace":"${namespace}"}}` },
    _finalizers: o.finalizers || (kindKey === 'provider' ? [] : ['finalizers.fluxcd.io']),
    _managed: o.managed || [],
    _events: [],
  };
  return r;
}
// Seeded Flux timestamps are shifted forward by however long the demo has been
// running, so "2m ago" stays "2m ago" and seeded events never age out of the
// dashboard's 1h activity window. Anything created at runtime is left as-is.
function fluxEvent(r, type, reason, message, count, minsAgo) {
  r._events.push({ type, reason, message, count, at: ago(minsAgo), seed: fluxSeeding });
}
function fluxEventOut({ seed, ...e }) { return seed ? { ...e, at: fluxDrift(e.at) } : e; }

function buildFlux() {
  fluxSeededAt = Date.now();
  fluxSeeding = true;
  const fs = 'flux-system';
  const svc = (ns, n) => ({ kind: 'Service', name: n, namespace: ns, group: '' });
  const dep = (ns, n) => ({ kind: 'Deployment', name: n, namespace: ns, group: 'apps' });
  const hpa = (ns, n) => ({ kind: 'HorizontalPodAutoscaler', name: n, namespace: ns, group: 'autoscaling' });

  // ---- Sources (3/3 ready) ----
  const gitRepo = fluxRes('gitrepository', fs, 'podinfo', {
    url: 'https://github.com/stefanprodan/podinfo', revision: GIT_REV, interval: '1m', reason: 'Succeeded',
    message: `stored artifact for revision '${GIT_REV}'`, reconciledMins: 1.75, createdAt: ago(4700),
  });
  fluxEvent(gitRepo, 'Normal', 'GitOperationSucceeded', `no changes since last reconciliation: observed revision '${GIT_REV}'`, 116, 1.75);
  fluxEvent(gitRepo, 'Normal', 'NewArtifact', `stored artifact for commit 'Merge pull request #412 from stefanprodan/release-6.14.0'`, 1, 4600);

  const ociRepo = fluxRes('ocirepository', fs, 'podinfo-oci', {
    url: 'oci://ghcr.io/stefanprodan/manifests/podinfo', revision: OCI_REV, interval: '5m',
    message: `stored artifact for digest '${OCI_REV}'`, reconciledMins: 6.3,
  });
  fluxEvent(ociRepo, 'Normal', 'ArtifactUpToDate', `artifact up-to-date with remote revision: '${OCI_REV}'`, 12, 6.3);

  const helmRepo = fluxRes('helmrepository', fs, 'podinfo', {
    url: 'https://stefanprodan.github.io/podinfo', type: 'default', revision: HELMREPO_REV, interval: '10m',
    message: `stored artifact: revision '${HELMREPO_REV}'`, reconciledMins: 7.1,
  });
  fluxEvent(helmRepo, 'Normal', 'ArtifactUpToDate', `artifact up-to-date with remote revision: '${HELMREPO_REV}'`, 12, 7.1);

  // ---- Kustomizations (3/4 ready, 1 reconciling) ----
  const ksPodinfo = fluxRes('kustomization', fs, 'podinfo', {
    source: { kind: 'GitRepository', name: 'podinfo', namespace: fs }, path: './kustomize', targetNamespace: 'podinfo', prune: true,
    revision: GIT_REV, interval: '5m', reconciledMins: 2.1, createdAt: ago(4680),
    message: `Applied revision: ${GIT_REV}`, reason: 'ReconciliationSucceeded',
    extraConditions: [{ type: 'Healthy', status: 'True', reason: 'Succeeded', message: 'Health check passed' }],
    managed: [svc('podinfo', 'podinfo'), dep('podinfo', 'podinfo'), hpa('podinfo', 'podinfo')],
  });
  fluxEvent(ksPodinfo, 'Normal', 'ReconciliationSucceeded', '(combined from similar events): Reconciliation finished in 74.636625ms, next run in 5m0s', 15, 2.1);

  const ksOci = fluxRes('kustomization', fs, 'podinfo-oci', {
    source: { kind: 'OCIRepository', name: 'podinfo-oci', namespace: fs }, path: './', targetNamespace: 'podinfo-oci', prune: true,
    revision: OCI_REV, interval: '10m', reconciledMins: 7.8, message: `Applied revision: ${OCI_REV}`, reason: 'ReconciliationSucceeded',
    managed: [svc('podinfo-oci', 'podinfo'), dep('podinfo-oci', 'podinfo'), hpa('podinfo-oci', 'podinfo')],
  });
  fluxEvent(ksOci, 'Normal', 'ReconciliationSucceeded', 'Reconciliation finished in 43.951708ms, next run in 10m0s', 1, 7.8);

  const ksApp2 = fluxRes('kustomization', fs, 'dummy-app-2', {
    source: { kind: 'GitRepository', name: 'podinfo', namespace: fs }, path: './kustomize', targetNamespace: 'dummy-app-2', prune: true,
    revision: GIT_REV, interval: '15m', reconciledMins: 12, message: `Applied revision: ${GIT_REV}`, reason: 'ReconciliationSucceeded',
    managed: [svc('dummy-app-2', 'podinfo'), dep('dummy-app-2', 'podinfo')],
  });
  fluxEvent(ksApp2, 'Normal', 'ReconciliationSucceeded', 'Reconciliation finished in 52.407208ms, next run in 15m0s', 1, 12);

  const badPath = 'kustomization path not found: stat /tmp/kustomization-2425333066/this-path-does-not-exist: no such file or directory';
  const ksApp1 = fluxRes('kustomization', fs, 'dummy-app-1', {
    state: 'Reconciling', source: { kind: 'GitRepository', name: 'podinfo', namespace: fs }, path: './this-path-does-not-exist',
    targetNamespace: 'dummy-app-1', prune: true, revision: GIT_REV, lastAppliedRevision: GIT_REV, interval: '10m',
    reconciledMins: 7.27, reason: 'ArtifactFailed', message: badPath,
    managed: [svc('dummy-app-1', 'podinfo'), dep('dummy-app-1', 'podinfo')],
  });
  [7.68, 17, 27, 37, 47, 57].forEach((m, i) => fluxEvent(ksApp1, 'Warning', 'ArtifactFailed',
    `kustomization path not found: stat /tmp/kustomization-${[2425333066, 3065700036, 74904509, 3218940380, 4282917617, 3811965734][i]}/this-path-does-not-exist: no such file or directory`, 1, m));

  // ---- Helm Releases (1/2 ready, 1 reconciling) ----
  const hrA = fluxRes('helmrelease', 'helm-demo-a', 'demo-podinfo-a', {
    source: { kind: 'HelmRepository', name: 'podinfo', namespace: fs }, chart: 'podinfo', chartVersion: '6.x',
    revision: '6.14.0', targetNamespace: 'helm-demo-a', interval: '5m', reconciledMins: 6.3, reason: 'InstallSucceeded',
    message: 'Helm install succeeded for release helm-demo-a/demo-podinfo-a.v1 with chart podinfo@6.14.0', createdAt: ago(4690),
    extraConditions: [{ type: 'Released', status: 'True', reason: 'InstallSucceeded', message: 'Helm install succeeded' }],
    managed: [svc('helm-demo-a', 'demo-podinfo-a'), dep('helm-demo-a', 'demo-podinfo-a')],
  });
  fluxEvent(hrA, 'Normal', 'InstallSucceeded', 'Helm install succeeded for release helm-demo-a/demo-podinfo-a.v1 with chart podinfo@6.14.0', 1, 4689);
  fluxEvent(hrA, 'Normal', 'ArtifactUpToDate', "artifact up-to-date with remote revision: '6.14.0'", 12, 6.33);

  const hrB = fluxRes('helmrelease', 'helm-demo-b', 'demo-podinfo-b', {
    state: 'Reconciling', source: { kind: 'HelmRepository', name: 'podinfo', namespace: fs }, chart: 'podinf', chartVersion: '6.x',
    revision: '6.14.0', lastAppliedRevision: '6.14.0', targetNamespace: 'helm-demo-b', interval: '5m', reconciledMins: 62,
    reason: 'ArtifactFailed', createdAt: ago(4690),
    message: "HelmChart 'flux-system/helm-demo-b-demo-podinfo-b' is not ready: invalid chart reference: no 'podinf' chart with version matching '6.x' found",
  });
  fluxEvent(hrB, 'Normal', 'HelmChartCreated', "created HelmChart object for release helm-demo-b/demo-podinfo-b", 1, 62);

  // ---- Notifications ----
  const provider = fluxRes('provider', fs, 'slack', { type: 'slack', interval: '', message: 'Initialized', reason: 'Succeeded', reconciledMins: 4500 });
  const alert = fluxRes('alert', fs, 'on-call', { interval: '', message: 'Initialized', reason: 'Succeeded', reconciledMins: 4500 });
  const receiver = fluxRes('receiver', fs, 'github-receiver', {
    type: 'github', interval: '10m', reconciledMins: 4500, reason: 'Succeeded',
    message: 'Receiver initialized for path: /hook/bed6d00b5555b1603e1f59b94d7fdbca58089cb5663633fb83f2815dc626d92b',
  });

  cluster.flux = [gitRepo, ociRepo, helmRepo, ksPodinfo, ksOci, ksApp2, ksApp1, hrA, hrB, provider, alert, receiver];
  cluster.flux.forEach((r) => { r._seedReconciled = true; });
  fluxSeeding = false;
}

function fluxRow(r) {
  const row = Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));
  row.createdAt = fluxDrift(r.createdAt);
  if (r._seedReconciled) row.lastReconciled = fluxDrift(r.lastReconciled);
  return row;
}
function findFlux(kindKey, ns, name) { return cluster.flux.find((r) => r.kindKey === kindKey && r.namespace === ns && r.name === name); }

function fluxOverview() {
  const all = cluster.flux;
  const summary = {};
  for (const r of all) {
    const s = (summary[r.category] = summary[r.category] || { total: 0, ready: 0, reconciling: 0, failed: 0, suspended: 0 });
    s.total++;
    if (r.state === 'Ready') s.ready++;
    else if (r.state === 'Reconciling') s.reconciling++;
    else if (r.state === 'Failed') s.failed++;
    else if (r.state === 'Suspended') s.suspended++;
  }
  const attention = all.filter((r) => r.state !== 'Ready').map(fluxRow)
    .sort((a, b) => (a.state === 'Failed' ? -1 : 1) - (b.state === 'Failed' ? -1 : 1));
  const activity = all.flatMap((r) => r._events.map((e) => ({ kind: r.kind, name: r.name, namespace: r.namespace, ...fluxEventOut(e) })))
    .filter((e) => Date.now() - new Date(e.at).getTime() < 60 * 60_000) // last ~1h, like Lens
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  return {
    total: all.length, ready: all.filter((r) => r.state === 'Ready').length,
    healthy: !all.some((r) => r.state === 'Failed'), summary, attention, activity,
  };
}

function fluxDetail(r) {
  return {
    summary: fluxRow(r),
    spec: {
      interval: r.interval, url: r.url, type: r.type, path: r.path, prune: r.prune, targetNamespace: r.targetNamespace, suspend: r.suspended,
      ...(r.source ? { sourceRef: { kind: r.source.kind, name: r.source.name, namespace: r.source.namespace } } : {}),
      ...(r.chart ? { chart: { spec: { chart: r.chart, version: r.chartVersion } } } : {}),
    },
    status: { lastAppliedRevision: r.lastAppliedRevision },
    conditions: r._conditions.map((c) => (r._seedReconciled ? { ...c, lastTransitionTime: fluxDrift(c.lastTransitionTime) } : c)),
    metadata: { annotations: r._annotations, labels: {}, finalizers: r._finalizers, creationTimestamp: fluxDrift(r.createdAt) },
    managed: r._managed,
    events: r._events.map(fluxEventOut).sort((a, b) => new Date(b.at) - new Date(a.at)),
  };
}

// ---------------- Flagger (progressive delivery) ----------------
// Canaries are stored with times as "minutes ago" so they stay fresh however
// long the demo runs. A restarted canary gets a `_sim` start time and walks
// through its steps (one every FLAGGER_STEP_MS) when read, so the UI shows a
// live rollout without any background timers.
const FLAGGER_STEP_MS = 12_000;

function canaryStrategy(a) {
  if ((a.match || []).length) return 'A/B testing';
  if (a.mirror) return 'Blue/Green mirroring';
  if (a.stepWeight || (a.stepWeights || []).length) return a.sessionAffinity ? 'Canary (session affinity)' : 'Canary';
  if (a.iterations) return 'Blue/Green';
  return 'Canary';
}

function flaggerCanary(name, o) {
  const target = o.target || name;
  return {
    kindKey: 'canary', kind: 'Canary', name, namespace: o.namespace || 'shop',
    phase: o.phase, suspended: !!o.suspended, skipAnalysis: !!o.skipAnalysis,
    target: { kind: 'Deployment', name: target }, service: target, port: o.port || 80,
    provider: o.provider || 'istio', autoscaler: o.autoscaler || '',
    weight: o.weight || 0, iterations: o.iterations || 0, failedChecks: o.failedChecks || 0,
    message: o.message || '',
    _analysis: o.analysis,
    _createdMins: o.createdMins ?? 8640,
    _transitionMins: o.transitionMins ?? 1,
    _transitionAt: null,
    _events: (o.events || []).map(([type, message, mins, count]) => ({ type, reason: 'Synced', message, count: count || 1, mins })),
    _sim: null,
  };
}

function buildFlagger() {
  const promMetrics = [
    { name: 'request-success-rate', thresholdRange: { min: 99 }, interval: '1m' },
    { name: 'request-duration', thresholdRange: { max: 500 }, interval: '1m' },
  ];
  const testHooks = [
    { name: 'acceptance-test', type: 'pre-rollout', url: 'http://flagger-loadtester.test/', timeout: '30s', metadata: { type: 'bash', cmd: 'curl -sd \'test\' http://frontend-canary.shop/api/echo | grep test' } },
    { name: 'load-test', type: 'rollout', url: 'http://flagger-loadtester.test/', metadata: { cmd: 'hey -z 1m -q 10 -c 2 http://frontend-canary.shop/' } },
  ];
  cluster.flagger = [
    flaggerCanary('frontend', {
      phase: 'Progressing', weight: 30, failedChecks: 1, autoscaler: 'frontend', transitionMins: 0.5,
      message: 'New revision detected, progressing canary analysis.',
      analysis: { interval: '1m', threshold: 5, maxWeight: 50, stepWeight: 10,
        metrics: [...promMetrics, { name: '404s percentage', templateRef: { name: 'not-found-percentage', namespace: 'shop' }, thresholdRange: { max: 5 }, interval: '1m' }],
        webhooks: testHooks, alerts: [{ name: 'on-call', severity: 'error', providerRef: { name: 'on-call', namespace: 'shop' } }] },
      events: [
        ['Normal', 'New revision detected! Scaling up frontend.shop', 6.2],
        ['Normal', 'Starting canary analysis for frontend.shop', 5.5],
        ['Normal', 'Pre-rollout check acceptance-test passed', 5.4],
        ['Normal', 'Advance frontend.shop canary weight 10', 4.4],
        ['Warning', 'Halt advancement no values found for istio metric request-success-rate probably frontend.shop is not receiving traffic: failed checks: 1', 3.4],
        ['Normal', 'Advance frontend.shop canary weight 20', 2.4],
        ['Normal', 'Advance frontend.shop canary weight 30', 0.5],
      ],
    }),
    flaggerCanary('checkout', {
      phase: 'WaitingPromotion', iterations: 10, provider: 'kubernetes', transitionMins: 3,
      message: 'Waiting for approval: confirm-promotion check promotion-gate is closed.',
      analysis: { interval: '30s', threshold: 2, iterations: 10, metrics: promMetrics,
        webhooks: [...testHooks, { name: 'promotion-gate', type: 'confirm-promotion', url: 'http://flagger-loadtester.test/gate/check' }] },
      events: [
        ['Normal', 'New revision detected! Scaling up checkout.shop', 9],
        ['Normal', 'Starting canary analysis for checkout.shop', 8.5],
        ['Normal', 'Pre-rollout check acceptance-test passed', 8.4],
        ['Normal', 'Advance checkout.shop canary iteration 5/10', 5.5],
        ['Normal', 'Advance checkout.shop canary iteration 10/10', 3],
        ['Normal', 'Confirm-promotion check promotion-gate failed: Halt checkout.shop advancement waiting for promotion approval promotion-gate', 0.2, 6],
      ],
    }),
    flaggerCanary('payments', {
      phase: 'Failed', iterations: 6, failedChecks: 5, provider: 'istio', transitionMins: 22,
      message: 'Canary analysis failed, Deployment scaled to zero.',
      analysis: { interval: '1m', threshold: 5, iterations: 10,
        match: [{ headers: { 'x-canary': { exact: 'insider' } } }, { headers: { cookie: { regex: '^(.*?;)?(canary=always)(;.*)?$' } } }],
        metrics: promMetrics, webhooks: testHooks, alerts: [{ name: 'on-call', severity: 'error', providerRef: { name: 'on-call', namespace: 'shop' } }] },
      events: [
        ['Normal', 'New revision detected! Scaling up payments.shop', 31],
        ['Normal', 'Starting canary analysis for payments.shop', 30],
        ['Normal', 'Advance payments.shop canary iteration 1/10', 29],
        ['Warning', 'Halt payments.shop advancement request duration 1.24s > 500ms', 23, 5],
        ['Warning', 'Rolling back payments.shop failed checks threshold reached 5', 22.2],
        ['Warning', 'Canary failed! Scaling down payments.shop', 22],
      ],
    }),
    flaggerCanary('catalog', {
      phase: 'Succeeded', provider: 'nginx', transitionMins: 140,
      message: 'Canary analysis completed successfully, promotion finished.',
      analysis: { interval: '1m', threshold: 3, stepWeights: [5, 10, 25, 50], metrics: promMetrics, webhooks: testHooks },
      events: [
        ['Normal', 'Advance catalog.shop canary weight 50', 146],
        ['Normal', 'Copying catalog.shop template spec to catalog-primary.shop', 145],
        ['Normal', 'Routing all traffic to primary', 142],
        ['Normal', 'Promotion completed! Scaling down catalog.shop', 140],
      ],
    }),
    flaggerCanary('cart', {
      phase: 'Initialized', suspended: true, provider: 'istio', transitionMins: 4300,
      message: 'Deployment initialization completed.',
      analysis: { interval: '1m', threshold: 5, maxWeight: 50, stepWeight: 10, metrics: promMetrics },
      events: [['Normal', 'Initialization done! cart.shop', 4300]],
    }),
  ];
  cluster.flaggerTemplates = [
    { kindKey: 'metrictemplate', kind: 'MetricTemplate', name: 'not-found-percentage', namespace: 'shop', provider: 'prometheus', address: 'http://prometheus.monitoring:9090',
      query: '100 - sum(rate(istio_requests_total{reporter="destination",destination_workload_namespace="{{ namespace }}",destination_workload="{{ target }}",response_code!="404"}[{{ interval }}])) / sum(rate(istio_requests_total{reporter="destination",destination_workload_namespace="{{ namespace }}",destination_workload="{{ target }}"}[{{ interval }}])) * 100',
      _createdMins: 8700 },
    { kindKey: 'metrictemplate', kind: 'MetricTemplate', name: 'latency-p95', namespace: 'shop', provider: 'datadog', address: 'https://api.datadoghq.com',
      query: 'avg:trace.http.request.duration.by.service.95p{service:{{ target }}}', _createdMins: 8700 },
  ];
  cluster.flaggerProviders = [
    { kindKey: 'alertprovider', kind: 'AlertProvider', name: 'on-call', namespace: 'shop', type: 'slack', channel: '#on-call', username: 'flagger', _createdMins: 8700 },
    { kindKey: 'alertprovider', kind: 'AlertProvider', name: 'release-notes', namespace: 'shop', type: 'msteams', channel: '', username: '', _createdMins: 8700 },
  ];
}

// Advance a restarted canary based on elapsed time.
function flaggerTick(c) {
  if (!c._sim) return;
  const a = c._analysis;
  const strategy = canaryStrategy(a);
  const weighted = strategy.startsWith('Canary');
  const steps = weighted ? (a.stepWeights || Array.from({ length: Math.ceil((a.maxWeight || 50) / (a.stepWeight || 10)) }, (_, i) => Math.min((i + 1) * (a.stepWeight || 10), a.maxWeight || 50)))
    : Array.from({ length: a.iterations || 5 }, (_, i) => i + 1);
  const n = Math.floor((Date.now() - c._sim.startedAt) / FLAGGER_STEP_MS);
  while (c._sim.done < n) {
    const i = c._sim.done; // step index just completed
    const at = new Date(c._sim.startedAt + (i + 1) * FLAGGER_STEP_MS).toISOString();
    const ev = (message, type = 'Normal') => c._events.push({ type, reason: 'Synced', message, count: 1, at });
    if (i === 0) { c.phase = 'Progressing'; ev(`Starting canary analysis for ${c.name}.${c.namespace}`); }
    else if (i <= steps.length) {
      const s = steps[i - 1];
      if (weighted) { c.weight = s; ev(`Advance ${c.name}.${c.namespace} canary weight ${s}`); }
      else { c.iterations = s; ev(`Advance ${c.name}.${c.namespace} canary iteration ${s}/${steps.length}`); }
    } else if (i === steps.length + 1) { c.phase = 'Promoting'; ev(`Copying ${c.name}.${c.namespace} template spec to ${c.name}-primary.${c.namespace}`); }
    else if (i === steps.length + 2) { c.phase = 'Finalising'; c.weight = 0; ev('Routing all traffic to primary'); }
    else {
      c.phase = 'Succeeded'; c.message = 'Canary analysis completed successfully, promotion finished.';
      ev(`Promotion completed! Scaling down ${c.name}.${c.namespace}`); c._sim = null;
      c._transitionAt = at; c._transitionMins = null; return;
    }
    c._transitionAt = at; c._transitionMins = null; c._sim.done++;
  }
}

function canaryRow(c) {
  flaggerTick(c);
  const a = c._analysis;
  const strategy = canaryStrategy(a);
  const weighted = strategy.startsWith('Canary');
  const row = Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_')));
  return {
    ...row, strategy,
    maxWeight: weighted ? (a.maxWeight || (a.stepWeights || []).slice(-1)[0] || 100) : null,
    stepWeight: a.stepWeight || null, stepWeights: a.stepWeights || null,
    maxIterations: a.iterations || null, threshold: a.threshold || null, interval: a.interval || '',
    lastTransition: c._transitionAt || ago(c._transitionMins),
    createdAt: ago(c._createdMins),
  };
}
const flaggerPlainRow = (r) => ({ ...Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_'))), createdAt: ago(r._createdMins) });

function flaggerList(kindKey) {
  if (kindKey === 'canary') return cluster.flagger.map(canaryRow);
  if (kindKey === 'metrictemplate') return cluster.flaggerTemplates.map(flaggerPlainRow);
  if (kindKey === 'alertprovider') return cluster.flaggerProviders.map(flaggerPlainRow);
  return null;
}
function flaggerStore(kindKey) {
  return { canary: 'flagger', metrictemplate: 'flaggerTemplates', alertprovider: 'flaggerProviders' }[kindKey];
}

function flaggerDetail(kindKey, r) {
  if (kindKey !== 'canary') {
    return { summary: flaggerPlainRow(r), spec: {}, status: {}, conditions: [], metadata: { annotations: {}, labels: {}, creationTimestamp: ago(r._createdMins) }, analysis: null, generated: [], events: [] };
  }
  const s = canaryRow(r);
  const a = r._analysis;
  const generated = [
    { kind: 'Deployment', name: `${s.target.name}-primary`, role: 'Primary (stable)' },
    { kind: 'Deployment', name: s.target.name, role: 'Canary (target)' },
    { kind: 'Service', name: s.service, role: 'Apex' },
    { kind: 'Service', name: `${s.service}-primary`, role: 'Primary' },
    { kind: 'Service', name: `${s.service}-canary`, role: 'Canary' },
    ...(s.autoscaler ? [{ kind: 'HorizontalPodAutoscaler', name: `${s.autoscaler}-primary`, role: 'Primary autoscaler' }] : []),
  ].map((g) => ({ ...g, namespace: s.namespace }));
  const done = ['Succeeded', 'Initialized'].includes(s.phase);
  return {
    summary: s,
    spec: { targetRef: { apiVersion: 'apps/v1', ...s.target }, service: { port: s.port }, provider: s.provider, suspend: s.suspended, skipAnalysis: s.skipAnalysis, analysis: a },
    status: { phase: s.phase, canaryWeight: s.weight, failedChecks: s.failedChecks, iterations: s.iterations },
    conditions: [{ type: 'Promoted', status: s.phase === 'Failed' ? 'False' : done ? 'True' : 'Unknown', reason: s.phase, message: s.message, lastTransitionTime: s.lastTransition }],
    metadata: { annotations: {}, labels: {}, creationTimestamp: s.createdAt },
    analysis: { metrics: a.metrics || [], webhooks: a.webhooks || [], alerts: a.alerts || [], match: a.match || [] },
    generated,
    events: r._events.map(({ mins, ...e }) => ({ ...e, at: e.at || ago(mins) })).sort((x, y) => new Date(y.at) - new Date(x.at)),
  };
}

// parseArgoApp — identical shape to server.js.
function parseArgoApp(a) {
  const spec = a.spec || {}, st = a.status || {};
  const src = spec.source || (Array.isArray(spec.sources) ? spec.sources[0] : {}) || {};
  return {
    name: a.metadata?.name, namespace: a.metadata?.namespace, project: spec.project || 'default',
    syncStatus: st.sync?.status || 'Unknown', healthStatus: st.health?.status || 'Unknown', healthMessage: st.health?.message || '',
    repoURL: src.repoURL || '', path: src.path || src.chart || '', targetRevision: src.targetRevision || '',
    revision: (st.sync?.revision || '').slice(0, 7), multiSource: Array.isArray(spec.sources) && spec.sources.length > 1,
    destName: spec.destination?.name || '', destServer: spec.destination?.server || '', destNamespace: spec.destination?.namespace || '',
    resourceCount: (st.resources || []).length, operationPhase: st.operationState?.phase || '', autoSync: !!spec.syncPolicy?.automated,
    createdAt: a.metadata?.creationTimestamp, reconciledAt: st.reconciledAt || '', images: st.summary?.images || [],
    finalizers: a.metadata?.finalizers || [], controlledBy: (a.metadata?.ownerReferences || []).find((o) => o.kind === 'ApplicationSet')?.name || '',
    lastOperation: st.operationState ? { phase: st.operationState.phase || '', message: st.operationState.message || '', finishedAt: st.operationState.finishedAt || st.operationState.startedAt || '' } : null,
  };
}

// ----------------------------------------------------------------------------
// Security dataset (matches SecurityCenter shapes from server.js).
// ----------------------------------------------------------------------------
const emptySummary = () => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
const sevTotal = (s = {}) => (s.CRITICAL || 0) + (s.HIGH || 0) + (s.MEDIUM || 0) + (s.LOW || 0) + (s.UNKNOWN || 0);

function vulnImage(image, summary, workloads, vulns, extra = {}) {
  const g = {
    image, repository: image.split(':')[0], tag: image.split(':')[1] || '', digest: '', registry: image.includes('/') ? image.split('/')[0] : '',
    os: 'debian 12.5', platform: 'debian 12.5', namespace: workloads[0]?.namespace || 'shop', status: 'Scanned',
    scanner: 'Trivy 0.50.1', scannedAt: ago(180), summary: { ...emptySummary(), ...summary },
    workloads, vulnerabilities: vulns, secrets: extra.secrets || 0,
  };
  g.criticalCount = g.summary.CRITICAL;
  return g;
}

function buildSecurityVulns() {
  const images = [
    vulnImage('ghcr.io/shop/checkout:1.5.0-rc1', { CRITICAL: 2, HIGH: 4, MEDIUM: 7, LOW: 12 }, [{ kind: 'Deployment', name: 'checkout', namespace: 'shop', container: 'checkout' }], [
      { id: 'CVE-2024-3094', severity: 'CRITICAL', pkg: 'xz-utils', installedVersion: '5.6.0', fixedVersion: '5.6.2', title: 'Backdoor in liblzma (xz) build', link: 'https://nvd.nist.gov/vuln/detail/CVE-2024-3094', score: 10.0 },
      { id: 'CVE-2023-44487', severity: 'CRITICAL', pkg: 'golang.org/x/net', installedVersion: 'v0.12.0', fixedVersion: 'v0.17.0', title: 'HTTP/2 Rapid Reset', link: 'https://nvd.nist.gov/vuln/detail/CVE-2023-44487', score: 7.5 },
      { id: 'CVE-2024-24790', severity: 'HIGH', pkg: 'stdlib', installedVersion: 'go1.21.5', fixedVersion: 'go1.21.11', title: 'net/netip: unexpected behavior of IPv4-mapped addresses', link: '', score: 8.1 },
    ], { secrets: 1 }),
    vulnImage('ghcr.io/shop/frontend:1.4.2', { CRITICAL: 0, HIGH: 2, MEDIUM: 5, LOW: 9 }, [{ kind: 'Deployment', name: 'frontend', namespace: 'shop', container: 'frontend' }], [
      { id: 'CVE-2024-2961', severity: 'HIGH', pkg: 'glibc', installedVersion: '2.36-9', fixedVersion: '2.36-9+deb12u5', title: 'iconv buffer overflow', link: '', score: 8.1 },
      { id: 'CVE-2023-6246', severity: 'HIGH', pkg: 'glibc', installedVersion: '2.36-9', fixedVersion: '2.36-9+deb12u4', title: '__vsyslog_internal heap overflow', link: '', score: 7.8 },
    ]),
    vulnImage('postgres:16.2', { CRITICAL: 1, HIGH: 3, MEDIUM: 4, LOW: 20 }, [{ kind: 'StatefulSet', name: 'postgres', namespace: 'shop', container: 'postgres' }], [
      { id: 'CVE-2024-0985', severity: 'CRITICAL', pkg: 'postgresql', installedVersion: '16.2', fixedVersion: '16.3', title: 'PostgreSQL REFRESH MATERIALIZED VIEW race condition', link: '', score: 8.0 },
    ]),
    vulnImage('grafana/grafana:10.4.1', { CRITICAL: 0, HIGH: 1, MEDIUM: 3, LOW: 6 }, [{ kind: 'Deployment', name: 'grafana', namespace: 'monitoring', container: 'grafana' }], [
      { id: 'CVE-2024-1313', severity: 'HIGH', pkg: 'grafana', installedVersion: '10.4.1', fixedVersion: '10.4.2', title: 'Grafana broken authorization on dashboards', link: '', score: 6.5 },
    ]),
    vulnImage('nginxdemos/hello:0.3', { CRITICAL: 0, HIGH: 0, MEDIUM: 2, LOW: 4 }, [{ kind: 'Deployment', name: 'hello-web', namespace: 'default', container: 'hello-web' }], []),
  ];
  const total = emptySummary();
  images.forEach((g) => { for (const k of Object.keys(total)) total[k] += g.summary[k]; });
  const vulnerable = images.filter((g) => sevTotal(g.summary) > 0).length;
  const podCount = allPods().length;
  return { installed: true, images, summary: total, reportCount: images.length, results: { vulnerable, ok: images.length - vulnerable }, scanned: images.length, notScanned: Math.max(0, podCount - images.length) };
}

function buildConfigChecks() {
  const mk = (kind, name, namespace, summary, checks) => ({ kind, name, namespace, createdAt: ago(200), scannedAt: ago(180), scanner: 'Trivy 0.50.1', labels: 3, summary: { ...emptySummary(), ...summary }, checks });
  const resources = [
    mk('Deployment', 'payments', 'shop', { HIGH: 1, MEDIUM: 2 }, [
      { id: 'KSV012', title: 'Runs as root user', severity: 'HIGH', category: 'Security', message: 'Container should not run as root; set runAsNonRoot: true', remediation: 'Add securityContext.runAsNonRoot: true' },
      { id: 'KSV018', title: 'No memory limit set', severity: 'MEDIUM', category: 'Resources', message: 'Container does not define a memory limit', remediation: 'Set resources.limits.memory' },
      { id: 'KSV020', title: 'Runs with a low user ID', severity: 'MEDIUM', category: 'Security', message: 'Force running with UID > 10000', remediation: 'Set runAsUser > 10000' },
    ]),
    mk('Deployment', 'checkout', 'shop', { HIGH: 1, LOW: 1 }, [
      { id: 'KSV001', title: 'Can elevate privileges', severity: 'HIGH', category: 'Security', message: 'allowPrivilegeEscalation should be false', remediation: 'Set securityContext.allowPrivilegeEscalation: false' },
      { id: 'KSV106', title: 'Default capabilities not dropped', severity: 'LOW', category: 'Security', message: 'Drop ALL capabilities and add only those required', remediation: 'Set capabilities.drop: [ALL]' },
    ]),
    mk('StatefulSet', 'postgres', 'shop', { MEDIUM: 1 }, [
      { id: 'KSV014', title: 'Root file system is not read-only', severity: 'MEDIUM', category: 'Security', message: 'Set readOnlyRootFilesystem: true', remediation: 'Add securityContext.readOnlyRootFilesystem: true' },
    ]),
  ];
  const total = emptySummary();
  resources.forEach((r) => { for (const k of Object.keys(total)) total[k] += r.summary[k]; });
  return { installed: true, resources, summary: total, reportCount: resources.length };
}

function buildRbacChecks() {
  const mk = (kind, name, namespace, summary, checks) => ({ kind, name, namespace, createdAt: ago(200), scannedAt: ago(180), scanner: 'Trivy 0.50.1', labels: 2, summary: { ...emptySummary(), ...summary }, checks });
  const resources = [
    mk('ClusterRole', 'shop-deployer', '', { HIGH: 1, MEDIUM: 1 }, [
      { id: 'KSV045', title: 'Wildcard verbs on resources', severity: 'HIGH', category: 'RBAC', message: 'ClusterRole grants "*" verbs on deployments/pods', remediation: 'Grant only the specific verbs required' },
      { id: 'KSV041', title: 'Manage secrets', severity: 'MEDIUM', category: 'RBAC', message: 'Role can read secrets cluster-wide', remediation: 'Scope secret access to specific namespaces' },
    ]),
    mk('Cluster', 'cluster-admin-binding', '', { CRITICAL: 1 }, [
      { id: 'KSV044', title: 'system:masters group binding', severity: 'CRITICAL', category: 'RBAC', message: 'Binding grants cluster-admin to system:masters', remediation: 'Avoid binding cluster-admin broadly' },
    ]),
  ];
  const total = emptySummary();
  resources.forEach((r) => { for (const k of Object.keys(total)) total[k] += r.summary[k]; });
  return { installed: true, resources, summary: total, reportCount: resources.length };
}

// ----------------------------------------------------------------------------
// Events dataset (transformed shape from server.js /api/events).
// ----------------------------------------------------------------------------
function buildEvents() {
  const ev = (namespace, type, reason, involvedObject, message, source, count, lastMin) => {
    const lastTimestamp = ago(lastMin);
    return { message, namespace, type, reason, involvedObject, source, count, firstTimestamp: ago(lastMin + count), lastTimestamp, age: Math.floor(lastMin * 60) };
  };
  return [
    ev('shop', 'Warning', 'FailedScheduling', 'Pod/payments-8d7c6b5a4-py001', '0/3 nodes are available: 3 Insufficient cpu.', 'default-scheduler', 14, 2),
    ev('shop', 'Warning', 'BackOff', 'Pod/checkout-7c8f9d6b5-ck002', 'Back-off restarting failed container checkout in pod checkout-7c8f9d6b5-ck002_shop', 'kubelet', 7, 1),
    ev('shop', 'Warning', 'Unhealthy', 'Pod/checkout-7c8f9d6b5-ck002', 'Readiness probe failed: connection refused', 'kubelet', 9, 1),
    ev('shop', 'Normal', 'Scheduled', 'Pod/frontend-7f9c6d5b4-fe001', 'Successfully assigned shop/frontend-7f9c6d5b4-fe001 to demo-node-1', 'default-scheduler', 1, 180),
    ev('shop', 'Normal', 'Pulled', 'Pod/frontend-7f9c6d5b4-fe001', 'Container image "ghcr.io/shop/frontend:1.4.2" already present on machine', 'kubelet', 1, 179),
    ev('shop', 'Normal', 'ScalingReplicaSet', 'Deployment/frontend', 'Scaled up replica set frontend-7f9c6d5b4 to 3', 'deployment-controller', 1, 200),
    ev('monitoring', 'Normal', 'Pulled', 'Pod/prometheus-0', 'Container image "quay.io/prometheus/prometheus:v2.51.0" already present on machine', 'kubelet', 1, 240),
    ev('kube-system', 'Normal', 'LeaderElection', 'Lease/kube-scheduler', 'demo-node-1 became leader', 'default-scheduler', 1, 300),
    ev('default', 'Normal', 'Started', 'Pod/hello-web-6c9d4b7f8-abcde', 'Started container hello-web', 'kubelet', 1, 170),
    ev('shop', 'Normal', 'SuccessfulCreate', 'Job/db-migrate-1', 'Created pod: db-migrate-1-xyz', 'job-controller', 1, 300),
  ];
}

// ----------------------------------------------------------------------------
// Lookup helpers
// ----------------------------------------------------------------------------
function allPods() {
  return Object.values(cluster.ns).flatMap((n) => n.pods);
}

// Canonicalize a kind string (accepts 'Pod', 'pod', 'statefulSet', 'statefulset').
const KIND_CANON = {
  pod: 'Pod', service: 'Service', deployment: 'Deployment', statefulset: 'StatefulSet', daemonset: 'DaemonSet',
  configmap: 'ConfigMap', secret: 'Secret', serviceaccount: 'ServiceAccount', ingress: 'Ingress',
  networkpolicy: 'NetworkPolicy', persistentvolumeclaim: 'PersistentVolumeClaim', persistentvolume: 'PersistentVolume',
  storageclass: 'StorageClass', role: 'Role', rolebinding: 'RoleBinding', clusterrole: 'ClusterRole',
  clusterrolebinding: 'ClusterRoleBinding', job: 'Job', cronjob: 'CronJob', horizontalpodautoscaler: 'HorizontalPodAutoscaler',
};
const canonKind = (k) => KIND_CANON[String(k || '').toLowerCase()] || k;

// The per-namespace collection array for a canonical kind.
const KIND_COLLECTION = {
  Pod: 'pods', Service: 'services', Deployment: 'deployments', StatefulSet: 'statefulSets', DaemonSet: 'daemonSets',
  ConfigMap: 'configMaps', Secret: 'secrets', ServiceAccount: 'serviceAccounts', Ingress: 'ingresses',
  NetworkPolicy: 'networkPolicies', PersistentVolumeClaim: 'persistentVolumeClaims', Job: 'jobs', CronJob: 'cronjobs',
  HorizontalPodAutoscaler: 'hpas', Role: 'roles', RoleBinding: 'roleBindings',
};

// Find one stored object (raw manifest) by namespace/kind/name.
function findResource(namespace, kindRaw, name) {
  const kind = canonKind(kindRaw);
  if (kind === 'PersistentVolume') return cluster.storage.pvs.find((x) => x.metadata.name === name);
  if (kind === 'StorageClass') return cluster.storage.storageClasses.find((x) => x.metadata.name === name);
  if (kind === 'ClusterRole') return cluster.clusterRoles.find((x) => x.metadata.name === name);
  if (kind === 'ClusterRoleBinding') return cluster.clusterRoleBindings.find((x) => x.metadata.name === name);
  const coll = KIND_COLLECTION[kind];
  if (!coll || !cluster.ns[namespace]) return null;
  return cluster.ns[namespace][coll]?.find((x) => x.metadata.name === name);
}

// ----------------------------------------------------------------------------
// Port-forward simulation
// ----------------------------------------------------------------------------
const forwards = new Map();
let pfSeq = 0;

// ----------------------------------------------------------------------------
// Security scan simulation (bundled-trivy style)
// ----------------------------------------------------------------------------
const scanState = { running: false, done: false, phase: 'idle', total: 0, scanned: 0, startedAt: null, finishedAt: null, error: null, images: null, summary: null, results: null };

function scanResultShape() {
  return {
    running: scanState.running, done: scanState.done, phase: scanState.phase, total: scanState.total, scanned: scanState.scanned,
    startedAt: scanState.startedAt, finishedAt: scanState.finishedAt, error: scanState.error,
    installed: !!scanState.images, images: scanState.images || [], summary: scanState.summary, results: scanState.results,
    notScanned: scanState.total ? Math.max(0, scanState.total - scanState.scanned) : null, source: 'trivy-builtin',
  };
}

function startDemoScan() {
  const built = buildSecurityVulns();
  scanState.running = true; scanState.done = false; scanState.phase = 'scanning'; scanState.error = null;
  scanState.total = built.images.length; scanState.scanned = 0; scanState.startedAt = nowISO(); scanState.finishedAt = null;
  scanState.images = null; scanState.summary = null; scanState.results = null;
  // Simulate progress, then completion.
  let i = 0;
  const tick = () => {
    i += 1; scanState.scanned = Math.min(i, scanState.total);
    if (i >= scanState.total) {
      scanState.running = false; scanState.done = true; scanState.phase = 'done'; scanState.finishedAt = nowISO();
      scanState.images = built.images; scanState.summary = built.summary; scanState.results = built.results;
    } else {
      setTimeout(tick, 600);
    }
  };
  setTimeout(tick, 600);
}

// ----------------------------------------------------------------------------
// Metrics
// ----------------------------------------------------------------------------
function podMetricNow(nsName, podName) {
  const base = cluster.podMetricBase[`${nsName}/${podName}`];
  if (!base) return null;
  const cpuMilli = round1(jitter(base.cpuMilli, 0.18));
  const memBytes = Math.round(jitter(base.memBytes, 0.06));
  // one-container demo pods
  return { cpuMilli, memBytes, containers: [{ name: podName.replace(/-[a-z0-9]{5,}$/i, ''), cpuMilli, memBytes }], timestamp: nowISO(), window: '30s' };
}

function nodeMetricNow(name) {
  const base = cluster.nodeMetricBase[name];
  if (!base) return null;
  const node = cluster.nodes.find((n) => n.metadata.name === name);
  const cap = node?.status?.capacity || {};
  const alloc = node?.status?.allocatable || {};
  const parseCpu = (s) => (String(s).endsWith('m') ? parseInt(s) : (parseFloat(s) || 0) * 1000);
  const parseMem = (s) => { const m = String(s).match(/^(\d+)Ki$/); return m ? parseInt(m[1]) * 1024 : parseFloat(s) || 0; };
  return {
    available: true,
    cpuMilli: round1(jitter(base.cpuMilli, 0.15)),
    memBytes: Math.round(jitter(base.memBytes, 0.05)),
    cpuCapacityMilli: parseCpu(cap.cpu), memCapacityBytes: parseMem(cap.memory),
    cpuAllocatableMilli: parseCpu(alloc.cpu), memAllocatableBytes: parseMem(alloc.memory),
  };
}

function demoMetricHistory(kind, namespace, name, period) {
  const durations = { '15m': 15 * 60, '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 24 * 3600 };
  const durationSeconds = durations[period];
  if (!durationSeconds) return { available: false, points: [], message: 'Unsupported time range.' };
  const base = kind === 'pod'
    ? cluster.podMetricBase[`${namespace}/${name}`]
    : cluster.nodeMetricBase[name];
  if (!base) return { available: false, points: [], message: 'No demo metrics for this resource.' };

  const stepSeconds = Math.max(15, Math.ceil(durationSeconds / 120));
  const pointCount = Math.floor(durationSeconds / stepSeconds);
  const seed = [...`${namespace}/${name}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const end = Math.floor(Date.now() / (stepSeconds * 1000)) * stepSeconds;
  const points = Array.from({ length: pointCount + 1 }, (_, index) => {
    const wave = Math.sin((index + seed) / 8) * 0.12 + Math.sin((index + seed) / 21) * 0.05;
    return {
      timestamp: new Date((end - (pointCount - index) * stepSeconds) * 1000).toISOString(),
      cpuMilli: round1(Math.max(0, base.cpuMilli * (1 + wave))),
      memBytes: Math.round(Math.max(0, base.memBytes * (1 + wave * 0.4)))
    };
  });
  return { available: true, source: 'Demo', period, stepSeconds, points, message: null };
}

// ----------------------------------------------------------------------------
// Topology (matches server.js { nodes:[{id,kind,name,category,status}], edges:[{source,target,type}] })
// ----------------------------------------------------------------------------
function buildTopology(nsName) {
  const n = cluster.ns[nsName];
  if (!n) return { nodes: [], edges: [] };
  const CATEGORY = {
    Deployment: 'workload', ReplicaSet: 'workload', StatefulSet: 'workload', DaemonSet: 'workload', Job: 'workload', CronJob: 'workload', Pod: 'workload',
    Service: 'network', Ingress: 'network', NetworkPolicy: 'network',
    PersistentVolumeClaim: 'storage', PersistentVolume: 'storage', StorageClass: 'storage',
    ConfigMap: 'config', Secret: 'config', ServiceAccount: 'rbac', Role: 'rbac', RoleBinding: 'rbac',
  };
  const nodes = [], edges = [], seen = new Set();
  const idFor = (kind, name) => `${kind}/${name}`;
  const addNode = (kind, name, status = 'Active') => {
    const id = idFor(kind, name);
    if (!seen.has(id)) { seen.add(id); nodes.push({ id, kind, name, category: CATEGORY[kind] || 'workload', status }); }
    return id;
  };
  const addEdge = (s, t, type) => { if (s && t) edges.push({ source: s, target: t, type }); };

  // workloads + pods (owner edges)
  const wlReady = (w) => ((w.status?.readyReplicas ?? w.status?.numberReady ?? 0) >= (w.spec?.replicas ?? 0) ? 'Ready' : 'Pending');
  for (const dep of n.deployments) addNode('Deployment', dep.metadata.name, wlReady(dep));
  for (const ss of n.statefulSets) addNode('StatefulSet', ss.metadata.name, wlReady(ss));
  for (const ds of n.daemonSets) addNode('DaemonSet', ds.metadata.name, 'Ready');
  for (const j of n.jobs) addNode('Job', j.metadata.name, j.status?.succeeded ? 'Ready' : 'Pending');
  for (const cj of n.cronjobs) addNode('CronJob', cj.metadata.name, 'Active');
  for (const pod of n.pods) {
    const pid = addNode('Pod', pod.metadata.name, pod.status?.phase || 'Unknown');
    const owner = (pod.metadata.ownerReferences || [])[0];
    if (owner) {
      // link pod to a workload node when present (ReplicaSet owners fold to their Deployment by name prefix)
      let parentKind = owner.kind, parentName = owner.name;
      if (owner.kind === 'ReplicaSet') { parentKind = 'Deployment'; parentName = owner.name.replace(/-[a-z0-9]+$/, ''); }
      if (seen.has(idFor(parentKind, parentName))) addEdge(idFor(parentKind, parentName), pid, 'owns');
    }
  }
  // services -> pods by selector
  for (const svc of n.services) {
    const sid = addNode('Service', svc.metadata.name, svc.spec?.type || 'ClusterIP');
    const sel = svc.spec?.selector || {};
    if (Object.keys(sel).length) {
      for (const pod of n.pods) {
        const labels = pod.metadata.labels || {};
        if (Object.entries(sel).every(([k, v]) => labels[k] === v)) addEdge(idFor('Pod', pod.metadata.name), sid, 'service');
      }
    }
  }
  // ingress -> service
  for (const ing of n.ingresses) {
    const iid = addNode('Ingress', ing.metadata.name, 'Active');
    (ing.spec?.rules || []).forEach((r) => (r.http?.paths || []).forEach((p) => {
      const svc = p.backend?.service?.name; if (svc) addEdge(idFor('Service', svc), iid, 'network');
    }));
  }
  // pvc + storage
  for (const pvc of n.persistentVolumeClaims) {
    const pid = addNode('PersistentVolumeClaim', pvc.metadata.name, pvc.status?.phase || 'Bound');
    if (pvc.spec?.storageClassName) addEdge(pid, addNode('StorageClass', pvc.spec.storageClassName, ''), 'storage');
    if (pvc.spec?.volumeName) addEdge(pid, addNode('PersistentVolume', pvc.spec.volumeName, 'Bound'), 'storage');
  }
  // pod -> pvc / configmap / secret / serviceaccount
  for (const pod of n.pods) {
    const pid = idFor('Pod', pod.metadata.name);
    (pod.spec?.volumes || []).forEach((v) => {
      if (v.persistentVolumeClaim?.claimName && seen.has(idFor('PersistentVolumeClaim', v.persistentVolumeClaim.claimName))) addEdge(pid, idFor('PersistentVolumeClaim', v.persistentVolumeClaim.claimName), 'storage');
      if (v.configMap?.name) addEdge(pid, addNode('ConfigMap', v.configMap.name, 'Active'), 'config');
      if (v.secret?.secretName) addEdge(pid, addNode('Secret', v.secret.secretName, 'Active'), 'config');
    });
    const sa = pod.spec?.serviceAccountName;
    if (sa && sa !== 'default') addEdge(pid, addNode('ServiceAccount', sa, 'Active'), 'rbac');
  }
  // networkpolicy -> pods
  for (const np of n.networkPolicies) {
    const npid = addNode('NetworkPolicy', np.metadata.name, 'Active');
    const sel = np.spec?.podSelector?.matchLabels || {};
    for (const pod of n.pods) {
      const labels = pod.metadata.labels || {};
      if (Object.keys(sel).length && Object.entries(sel).every(([k, v]) => labels[k] === v)) addEdge(idFor('Pod', pod.metadata.name), npid, 'network');
    }
  }
  // dedupe edges + drop dangling
  const eseen = new Set();
  const validEdges = edges.filter((e) => {
    if (!seen.has(e.source) || !seen.has(e.target)) return false;
    const k = `${e.source}|${e.target}|${e.type}`;
    if (eseen.has(k)) return false; eseen.add(k); return true;
  });
  return { nodes, edges: validEdges };
}

// ----------------------------------------------------------------------------
// Mutations
// ----------------------------------------------------------------------------
// Ensure a workload's pod list roughly matches replicas (used by scale).
function reconcileWorkloadPods(nsName, kind, name, replicas) {
  const n = cluster.ns[nsName];
  if (!n) return;
  const label = { app: name };
  const owned = n.pods.filter((p) => (p.metadata.ownerReferences || []).some((o) => o.name.startsWith(name)) || p.metadata.labels?.app === name);
  const image = owned[0]?.spec?.containers?.[0]?.image || 'nginx:1.25';
  const rsName = `${name}-${Math.random().toString(36).slice(2, 10)}`;
  const ownerKind = kind === 'StatefulSet' ? 'StatefulSet' : 'ReplicaSet';
  // remove all existing owned pods, recreate `replicas` fresh ones
  n.pods = n.pods.filter((p) => !owned.includes(p));
  for (let i = 0; i < replicas; i++) {
    const podName = kind === 'StatefulSet' ? `${name}-${i}` : `${rsName}-${Math.random().toString(36).slice(2, 7)}`;
    const p = makePod(nsName, podName, { image, node: `demo-node-${(i % 3) + 1}`, owner: { kind: ownerKind, name: ownerKind === 'ReplicaSet' ? rsName : name }, labels: label, createdMin: 1 });
    n.pods.push(p);
    podMetric(nsName, podName, 60, 120 * 1024 ** 2);
  }
}

// A small canned Artifact Hub result set so the chart search/install flow is
// fully explorable in demo mode (no network call to artifacthub.io).
const DEMO_CHARTS = [
  { id: 'bitnami/nginx', name: 'nginx', displayName: 'NGINX', version: '18.2.0', appVersion: '1.27.3', description: 'NGINX Open Source web server, reverse proxy and load balancer.', logo: null, stars: 106, deprecated: false, repository: { name: 'bitnami', url: 'https://charts.bitnami.com/bitnami', official: true, verified: true } },
  { id: 'prometheus-community/kube-prometheus-stack', name: 'kube-prometheus-stack', displayName: 'Kube Prometheus Stack', version: '65.1.0', appVersion: 'v0.77.1', description: 'Prometheus, Grafana and Alertmanager preconfigured for Kubernetes monitoring.', logo: null, stars: 512, deprecated: false, repository: { name: 'prometheus-community', url: 'https://prometheus-community.github.io/helm-charts', official: false, verified: true } },
  { id: 'grafana/grafana', name: 'grafana', displayName: 'Grafana', version: '8.5.1', appVersion: '11.3.0', description: 'The open observability platform for dashboards and visualization.', logo: null, stars: 287, deprecated: false, repository: { name: 'grafana', url: 'https://grafana.github.io/helm-charts', official: false, verified: true } },
  { id: 'ingress-nginx/ingress-nginx', name: 'ingress-nginx', displayName: 'Ingress NGINX', version: '4.11.3', appVersion: '1.11.3', description: 'Ingress controller for Kubernetes using NGINX as a reverse proxy.', logo: null, stars: 198, deprecated: false, repository: { name: 'ingress-nginx', url: 'https://kubernetes.github.io/ingress-nginx', official: true, verified: true } },
  { id: 'bitnami/postgresql', name: 'postgresql', displayName: 'PostgreSQL', version: '16.2.1', appVersion: '17.2.0', description: 'PostgreSQL is a powerful, open source object-relational database.', logo: null, stars: 154, deprecated: false, repository: { name: 'bitnami', url: 'https://charts.bitnami.com/bitnami', official: true, verified: true } },
  { id: 'bitnami/redis', name: 'redis', displayName: 'Redis', version: '20.2.1', appVersion: '7.4.1', description: 'Redis is an open source, in-memory data store used as a database and cache.', logo: null, stars: 143, deprecated: false, repository: { name: 'bitnami', url: 'https://charts.bitnami.com/bitnami', official: true, verified: true } },
  { id: 'argo/argo-cd', name: 'argo-cd', displayName: 'Argo CD', version: '7.7.0', appVersion: 'v2.13.0', description: 'A declarative, GitOps continuous delivery tool for Kubernetes.', logo: null, stars: 231, deprecated: false, repository: { name: 'argo', url: 'https://argoproj.github.io/argo-helm', official: false, verified: true } },
  { id: 'jetstack/cert-manager', name: 'cert-manager', displayName: 'cert-manager', version: 'v1.16.1', appVersion: 'v1.16.1', description: 'Automatically provision and manage TLS certificates in Kubernetes.', logo: null, stars: 176, deprecated: false, repository: { name: 'jetstack', url: 'https://charts.jetstack.io', official: false, verified: true } },
];

// ----------------------------------------------------------------------------
// Main request handler
// ----------------------------------------------------------------------------
export function handle(req, res) {
  try {
    const method = req.method;
    const url = new URL(req.path, 'http://demo');
    const p = url.pathname;
    const q = req.query || {};

    // Routes we intentionally do NOT handle → let server.js continue.
    if (p.startsWith('/api/config') || p.startsWith('/api/azure') || p.startsWith('/api/aws') ||
        p.startsWith('/api/ai-agents') || p.startsWith('/mcp') || p.startsWith('/api/assistant') ||
        p === '/api/version' || p.startsWith('/api/mcp') || p === '/api/exec') {
      return false;
    }
    if (!p.startsWith('/api/')) return false;

    const seg = p.split('/').filter(Boolean); // e.g. ['api','resources','shop']
    const json = (obj, code = 200) => { res.status(code).json(obj); return true; };

    // ---------- synthetic current + historical metrics ----------
    if (method === 'GET' && seg[1] === 'metrics' && seg[2] === 'history' && seg[3] === 'pod') {
      return json(demoMetricHistory('pod', decodeURIComponent(seg[4] || ''), decodeURIComponent(seg[5] || ''), q.period || '1h'));
    }
    if (method === 'GET' && seg[1] === 'metrics' && seg[2] === 'history' && seg[3] === 'node') {
      return json(demoMetricHistory('node', '', decodeURIComponent(seg[4] || ''), q.period || '1h'));
    }
    if (method === 'GET' && seg[1] === 'metrics' && seg[2] === 'pod' && seg[3] && seg[4]) {
      const metrics = podMetricNow(decodeURIComponent(seg[3]), decodeURIComponent(seg[4]));
      return json(metrics ? { ...metrics, available: true, source: 'Demo metrics' } : { available: false });
    }
    if (method === 'GET' && seg[1] === 'metrics' && seg[2] === 'node' && seg[3]) {
      const metrics = nodeMetricNow(decodeURIComponent(seg[3]));
      return json(metrics || { available: false });
    }

    // ---------- cluster summary ----------
    if (method === 'GET' && p === '/api/cluster/summary') return json(clusterSummary());
    if (method === 'GET' && p === '/api/cluster/pods-summary') {
      return json({ pods: clusterSummary().pods });
    }
    if (method === 'GET' && p === '/api/cluster/metrics') {
      return json({ resourceUsage: clusterSummary().resourceUsage });
    }

    // ---------- namespaces ----------
    if (method === 'GET' && p === '/api/namespaces') {
      const details = cluster.nsMeta.map((n) => ({ name: n.metadata.name, status: n.status?.phase || 'Active', createdAt: n.metadata.creationTimestamp, labels: n.metadata.labels || {} }));
      return json({ namespaces: details.map((d) => d.name), details });
    }

    // ---------- storage ----------
    if (method === 'GET' && p === '/api/storage') {
      return json({
        persistentVolumes: cluster.storage.pvs.map((x) => formatResource(x, 'PersistentVolume')),
        storageClasses: cluster.storage.storageClasses.map((x) => formatResource(x, 'StorageClass')),
      });
    }

    // ---------- rbac ----------
    if (method === 'GET' && p === '/api/rbac') return json(rbacResponse());

    // ---------- nodes ----------
    if (method === 'POST' && seg[1] === 'nodes' && ['cordon', 'uncordon', 'drain'].includes(seg[3])) {
      const nodeName = decodeURIComponent(seg[2] || '');
      const node = cluster.nodes.find((item) => item.metadata.name === nodeName);
      if (!node) return json({ error: `Node not found: ${nodeName}` }, 404);
      if (seg[3] === 'cordon') {
        node.spec.unschedulable = true;
        return json({ success: true, message: `${nodeName} cordoned (demo)` });
      }
      if (seg[3] === 'uncordon') {
        node.spec.unschedulable = false;
        return json({ success: true, message: `${nodeName} uncordoned (demo)` });
      }

      node.spec.unschedulable = true;
      const candidates = cluster.nodes
        .filter((item) => item.metadata.name !== nodeName && !item.spec?.unschedulable)
        .map((item) => ({ name: item.metadata.name, load: allPods().filter((pod) => pod.spec?.nodeName === item.metadata.name).length }))
        .sort((a, b) => a.load - b.load);
      for (const pod of allPods().filter((item) => item.spec?.nodeName === nodeName)) {
        const owners = pod.metadata?.ownerReferences || [];
        const isDaemonSetPod = owners.some((owner) => owner.kind === 'DaemonSet');
        const isMirrorPod = Boolean(pod.metadata?.annotations?.['kubernetes.io/config.mirror']);
        if (isDaemonSetPod || isMirrorPod) continue;
        const destination = candidates.find((candidate) => candidate.name !== nodeName);
        if (destination) {
          pod.spec.nodeName = destination.name;
          destination.load++;
          candidates.sort((a, b) => a.load - b.load);
        } else {
          pod.spec.nodeName = undefined;
          pod.status.phase = 'Pending';
        }
      }
      return json({ success: true, message: `${nodeName} drained (demo)` });
    }
    if (method === 'GET' && p === '/api/nodes') return json({ nodes: cluster.nodes.map(formatNode) });
    if (method === 'GET' && seg[1] === 'nodes' && seg[3] === 'pods') {
      const nodeName = decodeURIComponent(seg[2]);
      const pods = allPods().filter((po) => po.spec?.nodeName === nodeName).map(formatPodForNode);
      return json({ pods });
    }

    // ---------- metrics ----------
    if (method === 'GET' && seg[1] === 'metrics') {
      if (seg[2] === 'pods') {
        const nsName = seg[3] ? decodeURIComponent(seg[3]) : null;
        const metrics = {};
        const pods = nsName && nsName !== 'all' ? (cluster.ns[nsName]?.pods || []) : allPods();
        for (const po of pods) {
          const m = podMetricNow(po.metadata.namespace, po.metadata.name);
          if (m) metrics[`${po.metadata.namespace}/${po.metadata.name}`] = m;
        }
        return json({ metrics, available: true });
      }
      if (seg[2] === 'pod') {
        const m = podMetricNow(decodeURIComponent(seg[3]), decodeURIComponent(seg[4]));
        return m ? json({ available: true, ...m }) : json({ available: false });
      }
      if (seg[2] === 'node') {
        const m = nodeMetricNow(decodeURIComponent(seg[3]));
        return m ? json(m) : json({ available: false });
      }
    }

    // ---------- OpenCost / Kubecost ----------
    if (method === 'GET' && p === '/api/costs/status') {
      return json({ installed: true, provider: 'opencost', namespace: 'opencost', service: 'opencost', port: 9003 });
    }
    if (method === 'GET' && p === '/api/costs/allocation') {
      const groups = {
        namespace: [
          { name: 'shop', cpuCost: 4.21, gpuCost: 0, memoryCost: 1.13, pvCost: 0.30, networkCost: 0.30, loadBalancerCost: 0.70, sharedCost: 0.17, totalCost: 6.81 },
          { name: 'monitoring', cpuCost: 1.40, gpuCost: 0, memoryCost: 0.90, pvCost: 0.20, networkCost: 0.12, loadBalancerCost: 0, sharedCost: 0.24, totalCost: 2.86 },
          { name: 'kube-system', cpuCost: 0.90, gpuCost: 0, memoryCost: 0.51, pvCost: 0.03, networkCost: 0, loadBalancerCost: 0.10, sharedCost: 0.12, totalCost: 1.66 },
          { name: 'argocd', cpuCost: 0.42, gpuCost: 0, memoryCost: 0.28, pvCost: 0, networkCost: 0.02, loadBalancerCost: 0, sharedCost: 0.08, totalCost: 0.80 },
        ],
        controller: [
          { name: 'Deployment/frontend', cpuCost: 1.16, gpuCost: 0, memoryCost: 0.25, pvCost: 0, networkCost: 0.06, loadBalancerCost: 0.35, sharedCost: 0.05, totalCost: 1.87 },
          { name: 'Deployment/catalog', cpuCost: 0.87, gpuCost: 0, memoryCost: 0.23, pvCost: 0, networkCost: 0.03, loadBalancerCost: 0, sharedCost: 0.03, totalCost: 1.16 },
          { name: 'Deployment/checkout', cpuCost: 0.72, gpuCost: 0, memoryCost: 0.20, pvCost: 0, networkCost: 0.02, loadBalancerCost: 0, sharedCost: 0.02, totalCost: 0.96 },
          { name: 'StatefulSet/postgres', cpuCost: 0.56, gpuCost: 0, memoryCost: 0.19, pvCost: 0.30, networkCost: 0.01, loadBalancerCost: 0, sharedCost: 0.03, totalCost: 1.09 },
          { name: 'Deployment/cart', cpuCost: 0.48, gpuCost: 0, memoryCost: 0.16, pvCost: 0, networkCost: 0.02, loadBalancerCost: 0, sharedCost: 0.02, totalCost: 0.68 },
        ],
        node: [
          { name: 'demo-node-1', cpuCost: 2.11, gpuCost: 0, memoryCost: 1.09, pvCost: 0.31, networkCost: 0.13, loadBalancerCost: 0.30, sharedCost: 0.20, totalCost: 4.14 },
          { name: 'demo-node-2', cpuCost: 2.03, gpuCost: 0, memoryCost: 0.97, pvCost: 0.18, networkCost: 0.17, loadBalancerCost: 0.25, sharedCost: 0.18, totalCost: 3.78 },
          { name: 'demo-node-3', cpuCost: 1.82, gpuCost: 0, memoryCost: 0.76, pvCost: 0.04, networkCost: 0.14, loadBalancerCost: 0.25, sharedCost: 0.23, totalCost: 3.24 },
        ],
        cluster: [
          { name: 'demo-cluster', cpuCost: 6.93, gpuCost: 0, memoryCost: 2.82, pvCost: 0.53, networkCost: 0.44, loadBalancerCost: 0.80, sharedCost: 0.61, totalCost: 12.13 },
        ],
      };
      const aggregate = ['cluster', 'namespace', 'controller', 'node'].includes(q.aggregate) ? q.aggregate : 'namespace';
      const factor = ['24h', 'today'].includes(q.window) ? 1 / 7 : q.window === '30d' ? 30 / 7 : q.window === 'month' ? 17 / 7 : 1;
      const allocations = groups[aggregate].map((row) => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, key === 'name' ? value : Number((value * factor).toFixed(4))])
      ));
      return json({
        provider: 'opencost', source: { namespace: 'opencost', service: 'opencost' },
        window: q.window || '7d', aggregate,
        totalCost: allocations.reduce((sum, row) => sum + row.totalCost, 0),
        currency: 'USD', allocations,
      });
    }
    if (method === 'GET' && p === '/api/costs/timeseries') {
      // Per-namespace cost split into time buckets so the Cost-over-time chart
      // has data in demo mode. Totals match the allocation KPIs (sum = $12.13/7d).
      const baseNs = [
        { name: 'shop', total: 6.81 },
        { name: 'monitoring', total: 2.86 },
        { name: 'kube-system', total: 1.66 },
        { name: 'argocd', total: 0.80 },
      ];
      const win = q.window || '7d';
      const factor = ['24h', 'today'].includes(win) ? 1 / 7 : win === '30d' ? 30 / 7 : win === 'month' ? 17 / 7 : 1;
      const hourly = ['24h', 'today'].includes(win);
      const count = hourly ? 24 : win === '30d' ? 30 : win === 'month' ? 17 : 7;
      const stepMs = hourly ? 3600e3 : 86400e3;
      // Deterministic per-bucket weights so bars vary but the demo stays stable.
      const weights = baseNs.map((_, k) => Array.from({ length: count }, (__, i) => 1 + 0.28 * Math.sin(i * 0.7 + k * 1.3) + 0.12 * Math.sin(i * 0.31 + k)));
      const wsum = weights.map((w) => w.reduce((a, b) => a + b, 0));
      const anchor = Math.floor(Date.now() / stepMs) * stepMs; // align to step boundary
      const series = [];
      for (let i = 0; i < count; i++) {
        const costs = {};
        let total = 0;
        baseNs.forEach((ns, k) => {
          const c = Number((ns.total * factor * (weights[k][i] / wsum[k])).toFixed(4));
          costs[ns.name] = c;
          total += c;
        });
        series.push({
          start: new Date(anchor - (count - i) * stepMs).toISOString(),
          end: new Date(anchor - (count - 1 - i) * stepMs).toISOString(),
          total: Number(total.toFixed(4)),
          costs,
        });
      }
      const namespaces = baseNs
        .map((ns) => ({ name: ns.name, totalCost: Number((ns.total * factor).toFixed(4)) }))
        .sort((a, b) => b.totalCost - a.totalCost);
      return json({
        series, namespaces,
        totalCost: namespaces.reduce((s, n) => s + n.totalCost, 0),
        currency: 'USD', provider: 'opencost', window: win, step: hourly ? '1h' : '1d',
      });
    }

    // ---------- compact Overview counts ----------
    if (method === 'GET' && seg[1] === 'resources' && seg[2] && seg[3] === 'overview') {
      const nsName = decodeURIComponent(seg[2]);
      const sources = nsName === 'all'
        ? Object.entries(cluster.ns)
        : cluster.ns[nsName] ? [[nsName, cluster.ns[nsName]]] : [];
      const overviewByNamespace = {};
      for (const [name, source] of sources) {
        const phases = { Running: 0, Pending: 0, Succeeded: 0, Failed: 0, Unknown: 0 };
        for (const pod of source.pods || []) {
          const phase = pod.status?.phase || 'Unknown';
          phases[phase in phases ? phase : 'Unknown']++;
        }
        overviewByNamespace[name] = {
          pods: { total: (source.pods || []).length, phases },
          deployments: (source.deployments || []).length,
          statefulSets: (source.statefulSets || []).length,
          daemonSets: (source.daemonSets || []).length,
          services: (source.services || []).length
        };
      }
      return json({ overviewByNamespace });
    }

    // ---------- single-kind resource list ----------
    if (method === 'GET' && seg[1] === 'resources' && seg[2] && seg[3]) {
      const nsName = decodeURIComponent(seg[2]);
      const resourceType = decodeURIComponent(seg[3]);
      const types = {
        pods: ['pods', 'Pod'], services: ['services', 'Service'], deployments: ['deployments', 'Deployment'],
        statefulSets: ['statefulSets', 'StatefulSet'], daemonSets: ['daemonSets', 'DaemonSet'],
        replicaSets: ['replicaSets', 'ReplicaSet'], replicationControllers: ['replicationControllers', 'ReplicationController'],
        jobs: ['jobs', 'Job'], cronJobs: ['cronjobs', 'CronJob'], configMaps: ['configMaps', 'ConfigMap'],
        secrets: ['secrets', 'Secret'], serviceAccounts: ['serviceAccounts', 'ServiceAccount'],
        ingresses: ['ingresses', 'Ingress'], networkPolicies: ['networkPolicies', 'NetworkPolicy'],
        persistentVolumeClaims: ['persistentVolumeClaims', 'PersistentVolumeClaim']
      };
      const entry = types[resourceType];
      if (!entry) return json({ error: `Unsupported resource type: ${resourceType}` }, 404);
      const [collection, kind] = entry;
      const sources = nsName === 'all' ? Object.values(cluster.ns) : [cluster.ns[nsName]].filter(Boolean);
      return json({ [resourceType]: sources.flatMap((n) => n[collection] || []).map((item) => formatResource(item, kind)) });
    }

    // ---------- resources list (used for Overview) ----------
    if (method === 'GET' && seg[1] === 'resources' && seg[2] && !seg[3]) {
      const nsName = decodeURIComponent(seg[2]);
      const sources = nsName === 'all' ? Object.values(cluster.ns) : [cluster.ns[nsName]].filter(Boolean);
      if (!sources.length) return json({ services: [], deployments: [], statefulSets: [], daemonSets: [], configMaps: [], secrets: [], serviceAccounts: [], ingresses: [], networkPolicies: [], persistentVolumeClaims: [] });
      return json({
        services: sources.flatMap((n) => n.services).map((x) => formatResource(x, 'Service')),
        deployments: sources.flatMap((n) => n.deployments).map((x) => formatResource(x, 'Deployment')),
        statefulSets: sources.flatMap((n) => n.statefulSets).map((x) => formatResource(x, 'StatefulSet')),
        daemonSets: sources.flatMap((n) => n.daemonSets).map((x) => formatResource(x, 'DaemonSet')),
        configMaps: sources.flatMap((n) => n.configMaps).map((x) => formatResource(x, 'ConfigMap')),
        secrets: sources.flatMap((n) => n.secrets).map((x) => formatResource(x, 'Secret')),
        serviceAccounts: sources.flatMap((n) => n.serviceAccounts).map((x) => formatResource(x, 'ServiceAccount')),
        ingresses: sources.flatMap((n) => n.ingresses).map((x) => formatResource(x, 'Ingress')),
        networkPolicies: sources.flatMap((n) => n.networkPolicies).map((x) => formatResource(x, 'NetworkPolicy')),
        persistentVolumeClaims: sources.flatMap((n) => n.persistentVolumeClaims).map((x) => formatResource(x, 'PersistentVolumeClaim')),
      });
    }

    // ---------- resource detail ----------
    if (method === 'GET' && seg[1] === 'resource' && seg.length === 5) {
      const [, , nsp, kind, name] = seg.map(decodeURIComponent);
      const obj = findResource(nsp, kind, name);
      if (!obj) return json({ error: 'Resource not found' }, 404);
      return json(obj);
    }

    // ---------- resource delete ----------
    if (method === 'DELETE' && seg[1] === 'resource' && seg.length === 5) {
      const [, , nsp, kind, name] = seg.map(decodeURIComponent);
      return json(deleteResource(nsp, kind, name));
    }

    // ---------- yaml get / put ----------
    if (seg[1] === 'yaml' && seg.length === 5) {
      const [, , nsp, kind, name] = seg.map(decodeURIComponent);
      if (method === 'GET') {
        const obj = findResource(nsp, kind, name);
        if (!obj) return json({ error: 'Resource not found' }, 404);
        return json({ yaml: yaml.dump(obj, { indent: 2 }) });
      }
      if (method === 'PUT') {
        const text = req.body?.yaml;
        if (!text || !text.trim()) return json({ error: 'Empty YAML' }, 400);
        let parsed;
        try { parsed = yaml.load(text); } catch (e) { return json({ error: `Invalid YAML: ${e.message}` }, 400); }
        const obj = findResource(nsp, kind, name);
        if (obj && parsed && typeof parsed === 'object') {
          // apply edited spec/metadata in place
          if (parsed.spec) obj.spec = parsed.spec;
          if (parsed.metadata?.labels) obj.metadata.labels = parsed.metadata.labels;
          if (parsed.metadata?.annotations) obj.metadata.annotations = parsed.metadata.annotations;
          if (parsed.data) obj.data = parsed.data;
        }
        return json({ success: true, message: `${canonKind(kind).toLowerCase()}.apps/${name} configured` });
      }
    }

    // ---------- logs ----------
    if (method === 'GET' && seg[1] === 'logs' && seg.length === 4) {
      const [, , nsp, pod] = seg.map(decodeURIComponent);
      return json({ logs: demoLogs(nsp, pod, q) });
    }

    // ---------- events ----------
    if (method === 'GET' && seg[1] === 'events') {
      const nsName = seg[2] ? decodeURIComponent(seg[2]) : null;
      return json(eventsResponse(nsName, q));
    }

    // ---------- apply (arbitrary yaml) ----------
    if (method === 'POST' && p === '/api/apply') {
      const text = req.body?.yaml;
      if (!text || !text.trim()) return json({ error: 'Empty YAML' }, 400);
      try { yaml.load(text); } catch (e) { return json({ error: `Invalid YAML: ${e.message}` }, 400); }
      return json({ success: true, message: applyYaml(text) });
    }

    // ---------- scale ----------
    if (method === 'POST' && seg[1] === 'scale' && seg.length === 5) {
      const [, , nsp, kind, name] = seg.map(decodeURIComponent);
      const replicas = parseInt(req.body?.replicas, 10);
      if (Number.isNaN(replicas) || replicas < 0) return json({ error: 'Invalid replicas' }, 400);
      return json(scaleResource(nsp, kind, name, replicas));
    }

    // ---------- restart ----------
    if (method === 'POST' && seg[1] === 'restart' && seg.length === 5) {
      const [, , nsp, kind, name] = seg.map(decodeURIComponent);
      return json(restartResource(nsp, kind, name));
    }

    // ---------- port-forward ----------
    if (seg[1] === 'portforward') {
      if (method === 'POST') return json(pfStart(req.body || {}));
      if (method === 'GET') return json({ forwards: [...forwards.values()].filter((f) => f.status === 'active').map(({ id, namespace, name, remotePort, localPort, status, startedAt }) => ({ id, namespace, name, remotePort, localPort, status, startedAt })) });
      if (method === 'DELETE' && seg[2]) { forwards.delete(decodeURIComponent(seg[2])); return json({ success: true }); }
    }

    // ---------- helm ----------
    if (method === 'GET' && p === '/api/helm/releases') {
      return json({ releases: cluster.helm.map((r) => ({ name: r.name, namespace: r.namespace, revision: String(r.version ?? ''), updated: r.info?.last_deployed || '', status: r.info?.status || '', chart: r.chart?.metadata ? `${r.chart.metadata.name}-${r.chart.metadata.version}` : '', appVersion: r.chart?.metadata?.appVersion || '' })) });
    }
    if (method === 'GET' && seg[1] === 'helm' && seg[2] === 'releases' && seg[5] === 'values') {
      const rel = cluster.helm.find((r) => r.namespace === decodeURIComponent(seg[3]) && r.name === decodeURIComponent(seg[4]));
      if (!rel) return json({ error: 'Release not found' }, 404);
      const vals = rel.config || {};
      return json({ yaml: Object.keys(vals).length ? yaml.dump(vals) : '{}\n' });
    }
    if (method === 'GET' && seg[1] === 'helm' && seg[2] === 'releases' && seg[5] === 'manifest') {
      const rel = cluster.helm.find((r) => r.namespace === decodeURIComponent(seg[3]) && r.name === decodeURIComponent(seg[4]));
      if (!rel) return json({ error: 'Release not found' }, 404);
      return json({ yaml: rel.manifest || '' });
    }
    // ---------- helm chart search & install (canned) ----------
    if (method === 'GET' && p === '/api/helm/available') {
      return json({ installed: true, version: 'v3.16.4+demo' });
    }
    if (method === 'GET' && p === '/api/helm/charts/search') {
      const query = String(q.q || '').trim().toLowerCase();
      if (!query) return json({ charts: [] });
      const charts = DEMO_CHARTS
        .filter((c) => c.name.includes(query) || c.description.toLowerCase().includes(query) || c.repository.name.includes(query))
        .slice(0, Number(q.limit) || 24);
      return json({ charts });
    }
    if (method === 'GET' && p === '/api/helm/charts/versions') {
      const chart = String(q.chart || '').toLowerCase();
      const found = DEMO_CHARTS.find((c) => c.name === chart);
      const base = found?.version || '1.0.0';
      const [maj, min] = base.split('.');
      // Fabricate a small descending version list off the chart's current version.
      const versions = [base, `${maj}.${Math.max(0, Number(min) - 1)}.0`, `${Math.max(0, Number(maj) - 1)}.0.0`]
        .filter((v, i, a) => a.indexOf(v) === i)
        .map((v) => ({ version: v, appVersion: found?.appVersion || '', ts: 0 }));
      return json({ versions });
    }
    if (method === 'POST' && p === '/api/helm/install') {
      const { releaseName, namespace = 'default', chart } = req.body || {};
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(String(releaseName || ''))) {
        return json({ error: 'Invalid release name (use lowercase letters, digits and dashes)' }, 400);
      }
      // Add a live release to the in-memory cluster so it shows up in the list.
      cluster.helm.push(makeHelmRelease(releaseName, namespace, {
        chart: chart || releaseName, chartVer: (req.body?.version || '1.0.0'), appVersion: '', status: 'deployed', revision: 1,
        values: (() => { try { return req.body?.values ? yaml.load(req.body.values) || {} : {}; } catch { return {}; } })(),
      }));
      return json({ ok: true, release: releaseName, namespace, output: `NAME: ${releaseName}\nNAMESPACE: ${namespace}\nSTATUS: deployed\nREVISION: 1\n(demo — no cluster changes were made)` });
    }
    if (method === 'POST' && p === '/api/helm/upgrade') {
      const { releaseName, namespace = 'default', version } = req.body || {};
      const rel = cluster.helm.find((r) => r.name === releaseName && r.namespace === namespace);
      if (!rel) return json({ error: `Release ${releaseName} not found in ${namespace}` }, 404);
      // Bump the revision and swap the chart version to mirror a real up/downgrade.
      rel.version = (rel.version || 1) + 1;
      if (rel.info) rel.info.status = 'deployed';
      if (version && rel.chart?.metadata) rel.chart.metadata.version = version;
      const merged = (() => { try { return req.body?.values ? { ...(rel.config || {}), ...(yaml.load(req.body.values) || {}) } : rel.config; } catch { return rel.config; } })();
      rel.config = merged;
      return json({ ok: true, release: releaseName, namespace, output: `Release "${releaseName}" has been upgraded.\nNAMESPACE: ${namespace}\nSTATUS: deployed\nREVISION: ${rel.version}\n(demo — no cluster changes were made)` });
    }

    // ---------- custom resources ----------
    if (method === 'GET' && p === '/api/customresources') return json({ crds: cluster.crds });
    if (method === 'GET' && seg[1] === 'customresources' && seg.length === 5) {
      const key = `${decodeURIComponent(seg[2])}/${decodeURIComponent(seg[3])}/${decodeURIComponent(seg[4])}`;
      const list = cluster.customResources[key] || [];
      return json({ items: list.map((it) => ({ name: it.metadata.name, namespace: it.metadata.namespace || '-', createdAt: it.metadata.creationTimestamp })) });
    }
    if (method === 'GET' && seg[1] === 'customresource' && seg.length === 6) {
      const key = `${decodeURIComponent(seg[2])}/${decodeURIComponent(seg[3])}/${decodeURIComponent(seg[4])}`;
      const name = decodeURIComponent(seg[5]);
      const nsp = q.namespace;
      const list = cluster.customResources[key] || [];
      const obj = list.find((it) => it.metadata.name === name && (!nsp || nsp === '-' || it.metadata.namespace === nsp));
      if (!obj) return json({ error: 'Resource not found' }, 500);
      return json({ yaml: yaml.dump(obj, { indent: 2 }) });
    }

    // ---------- security ----------
    if (method === 'GET' && p === '/api/security/status') {
      return json({ installed: true, reports: { vulnerability: true, configAudit: true, rbac: true, exposedSecret: true } });
    }
    if (method === 'GET' && p === '/api/security/vulnerabilities') {
      const built = buildSecurityVulns();
      const nsName = q.namespace && q.namespace !== 'all' ? q.namespace : null;
      if (nsName) {
        const images = built.images.filter((g) => g.workloads.some((w) => w.namespace === nsName));
        return json({ ...built, images });
      }
      return json(built);
    }
    if (method === 'GET' && p === '/api/security/checks') {
      return json(q.kind === 'rbac' ? buildRbacChecks() : buildConfigChecks());
    }
    if (method === 'GET' && p === '/api/security/scan/status') {
      return json({ available: true, installable: true, installed: true, running: scanState.running, done: scanState.done, hasResult: !!scanState.images });
    }
    if (method === 'POST' && p === '/api/security/scan') {
      if (scanState.running) return json({ started: false, ...scanResultShape() });
      startDemoScan();
      return json({ started: true, ...scanResultShape() });
    }
    if (method === 'GET' && p === '/api/security/scan') {
      // If no scan has ever run, surface the operator-report data so the view isn't empty.
      if (!scanState.images && !scanState.running) {
        const built = buildSecurityVulns();
        return json({ installed: true, running: false, done: true, phase: 'done', source: 'trivy-builtin', images: built.images, summary: built.summary, results: built.results, scanned: built.images.length, total: built.images.length, notScanned: null, finishedAt: ago(60) });
      }
      return json(scanResultShape());
    }

    // ---------- argocd ----------
    if (method === 'GET' && p === '/api/argocd/status') return json({ installed: true, url: 'https://argocd.demo.example.com' });
    if (method === 'GET' && p === '/api/argocd/applications') {
      return json({ applications: cluster.argo.apps.map(parseArgoApp).sort((a, b) => (a.name || '').localeCompare(b.name || '')) });
    }
    if (method === 'GET' && seg[1] === 'argocd' && seg[2] === 'application' && seg.length === 5) {
      return json(argoAppDetail(decodeURIComponent(seg[3]), decodeURIComponent(seg[4])));
    }
    if (method === 'POST' && seg[1] === 'argocd' && seg[2] === 'application' && seg[5] === 'sync') {
      const app = cluster.argo.apps.find((a) => a.metadata.namespace === decodeURIComponent(seg[3]) && a.metadata.name === decodeURIComponent(seg[4]));
      if (app) { app.status.sync.status = 'Synced'; app.status.health.status = app.status.health.status === 'Degraded' ? 'Degraded' : 'Healthy'; app.status.operationState.phase = 'Succeeded'; app.status.reconciledAt = nowISO(); }
      return json({ success: true, message: 'Sync triggered' });
    }
    if (method === 'POST' && seg[1] === 'argocd' && seg[2] === 'application' && seg[5] === 'refresh') {
      const app = cluster.argo.apps.find((a) => a.metadata.namespace === decodeURIComponent(seg[3]) && a.metadata.name === decodeURIComponent(seg[4]));
      if (app) app.status.reconciledAt = nowISO();
      return json({ success: true, message: 'Refresh requested' });
    }
    if (method === 'DELETE' && seg[1] === 'argocd' && seg[2] === 'application' && seg.length === 5) {
      const nsp = decodeURIComponent(seg[3]), name = decodeURIComponent(seg[4]);
      cluster.argo.apps = cluster.argo.apps.filter((a) => !(a.metadata.namespace === nsp && a.metadata.name === name));
      return json({ success: true, message: `${name} deleted` });
    }
    if (method === 'GET' && p === '/api/argocd/projects') return json({ projects: cluster.argo.projects });
    if (method === 'GET' && p === '/api/argocd/applicationsets') return json({ available: true, applicationSets: cluster.argo.appsets });
    if (method === 'GET' && p === '/api/argocd/repositories') return json({ repositories: cluster.argo.repos });
    if (method === 'GET' && p === '/api/argocd/clusters') return json({ clusters: cluster.argo.clusters });

    // ---------- Flux CD ----------
    if (method === 'GET' && p === '/api/flux/status') {
      const kinds = Object.fromEntries(Object.keys(FLUX_KIND).map((k) => [k, true]));
      return json({ installed: true, groups: { source: true, kustomize: true, helm: true, notification: true, image: false, kinds } });
    }
    if (method === 'GET' && p === '/api/flux/overview') return json(fluxOverview());
    if (method === 'GET' && p === '/api/flagger/status') {
      return json({ installed: true, kinds: { canary: true, metrictemplate: true, alertprovider: true } });
    }
    if (method === 'GET' && p === '/api/flagger/resources') {
      const kindKey = String(q.kind || '');
      const resources = flaggerList(kindKey);
      if (!resources) return json({ error: 'Unknown Flagger kind' }, 400);
      return json({ kindKey, resources: resources.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)) });
    }
    if (seg[1] === 'flagger' && seg[2] === 'resource' && seg.length === 6) {
      const kindKey = seg[3], nsp = decodeURIComponent(seg[4]), name = decodeURIComponent(seg[5]);
      const store = flaggerStore(kindKey);
      if (!store) return json({ error: 'Unknown Flagger kind' }, 400);
      const r = cluster[store].find((x) => x.namespace === nsp && x.name === name);
      if (!r) return json({ error: `${nsp}/${name} not found` }, 404);
      if (method === 'GET') return json(flaggerDetail(kindKey, r));
      if (method === 'DELETE') { cluster[store] = cluster[store].filter((x) => x !== r); return json({ success: true, message: `${name} deleted` }); }
    }
    if (method === 'POST' && seg[1] === 'flagger' && seg[2] === 'canary' && seg.length === 6) {
      const c = cluster.flagger.find((x) => x.namespace === decodeURIComponent(seg[3]) && x.name === decodeURIComponent(seg[4]));
      if (!c) return json({ error: 'Canary not found' }, 404);
      const ev = (message, type = 'Normal') => c._events.push({ type, reason: 'Synced', message, count: 1, at: nowISO() });
      const action = seg[5];
      if (action === 'suspend' || action === 'resume') { c.suspended = action === 'suspend'; return json({ success: true, message: c.suspended ? 'Suspended' : 'Resumed' }); }
      if (action === 'skip-analysis' || action === 'enable-analysis') { c.skipAnalysis = action === 'skip-analysis'; return json({ success: true, message: c.skipAnalysis ? 'Analysis will be skipped' : 'Analysis enabled' }); }
      if (action === 'restart') {
        if (c.suspended) return json({ error: `Canary ${c.name} is suspended; resume it first` }, 409);
        ev(`New revision detected! Scaling up ${c.name}.${c.namespace}`);
        c.weight = 0; c.iterations = 0; c.failedChecks = 0; c._transitionAt = nowISO(); c._transitionMins = null;
        if (c.skipAnalysis) {
          c.phase = 'Succeeded'; c.message = 'Analysis skipped, promotion finished.'; c._sim = null;
          ev(`Skipping analysis for ${c.name}.${c.namespace}`); ev(`Promotion completed! Scaling down ${c.name}.${c.namespace}`);
        } else {
          c.phase = 'Progressing'; c.message = 'New revision detected, progressing canary analysis.';
          c._sim = { startedAt: Date.now(), done: 0 };
        }
        return json({ success: true, message: 'Restarted — Flagger will start a new analysis' });
      }
    }
    if (method === 'GET' && p === '/api/flux/resources') {
      const kindKey = String(q.kind || '');
      if (!FLUX_KIND[kindKey]) return json({ error: 'Unknown Flux kind' }, 400);
      const resources = cluster.flux.filter((r) => r.kindKey === kindKey).map(fluxRow)
        .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
      return json({ kind: FLUX_KIND[kindKey], kindKey, resources });
    }
    if (seg[1] === 'flux' && seg[2] === 'resource' && seg.length >= 6) {
      const kindKey = seg[3], nsp = decodeURIComponent(seg[4]), name = decodeURIComponent(seg[5]), action = seg[6];
      const r = findFlux(kindKey, nsp, name);
      if (!r) return json({ error: `${FLUX_KIND[kindKey] || 'Resource'} ${nsp}/${name} not found` }, 404);
      if (method === 'GET' && !action) return json(fluxDetail(r));
      if (method === 'DELETE' && !action) {
        cluster.flux = cluster.flux.filter((x) => x !== r);
        return json({ success: true, message: `${name} deleted` });
      }
      if (method === 'POST' && action === 'reconcile') {
        r.lastReconciled = nowISO();
        if (r._seedReconciled) {
          r._conditions = r._conditions.map((c) => ({ ...c, lastTransitionTime: fluxDrift(c.lastTransitionTime) }));
          r._seedReconciled = false;
        }
        if (r.state === 'Ready') {
          fluxEvent(r, 'Normal', r.category === 'sources' ? 'ArtifactUpToDate' : 'ReconciliationSucceeded',
            r.category === 'sources' ? `artifact up-to-date with remote revision: '${r.revision}'` : 'Reconciliation finished, next run in ' + (r.interval || '5m'), 1, 0);
        } else if (!r.suspended) {
          fluxEvent(r, 'Warning', r.reason || 'ReconciliationFailed', r.message, 1, 0);
        }
        return json({ success: true, message: 'Reconciliation requested' });
      }
      if (method === 'POST' && (action === 'suspend' || action === 'resume')) {
        r.suspended = action === 'suspend';
        r.state = r.suspended ? 'Suspended' : r._baseState;
        fluxEvent(r, 'Normal', r.suspended ? 'Suspended' : 'Resumed', `Reconciliation ${r.suspended ? 'suspended' : 'resumed'}`, 1, 0);
        return json({ success: true, message: r.suspended ? 'Suspended' : 'Resumed' });
      }
    }

    // ---------- topology ----------
    if (method === 'GET' && seg[1] === 'topology' && seg[2]) return json(buildTopology(decodeURIComponent(seg[2])));

    // Not a demo data route we implement → let caller continue.
    return false;
  } catch (err) {
    // Never let a malformed request throw out of handle().
    try { res.status(500).json({ error: `demo mode error: ${err.message}` }); } catch { /* ignore */ }
    return true;
  }
}

// ----------------------------------------------------------------------------
// Response builders that need the whole cluster
// ----------------------------------------------------------------------------
function formatNode(item) {
  const conditions = item.status?.conditions || [];
  const isReady = conditions.find((c) => c.type === 'Ready')?.status === 'True';
  const labels = item.metadata?.labels || {};
  const roles = Object.keys(labels).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.replace('node-role.kubernetes.io/', '')).filter(Boolean);
  const addresses = item.status?.addresses || [];
  return {
    name: item.metadata.name, status: isReady ? 'Ready' : 'NotReady',
    roles: roles.length ? roles.join(', ') : 'worker',
    version: item.status?.nodeInfo?.kubeletVersion || '-', os: item.status?.nodeInfo?.osImage || '-',
    kernelVersion: item.status?.nodeInfo?.kernelVersion || '-', containerRuntime: item.status?.nodeInfo?.containerRuntimeVersion || '-',
    internalIp: addresses.find((a) => a.type === 'InternalIP')?.address || '-', externalIp: addresses.find((a) => a.type === 'ExternalIP')?.address || '-',
    cpuCapacity: item.status?.capacity?.cpu || '-', memoryCapacity: item.status?.capacity?.memory || '-',
    cpuAllocatable: item.status?.allocatable?.cpu || '-', memoryAllocatable: item.status?.allocatable?.memory || '-',
    createdAt: item.metadata.creationTimestamp, unschedulable: !!item.spec?.unschedulable, taints: (item.spec?.taints || []).length,
  };
}

function formatPodForNode(item) {
  const cs = item.status?.containerStatuses || [];
  const readyCount = cs.filter((c) => c.ready).length;
  return { name: item.metadata.name, namespace: item.metadata.namespace, status: item.status?.phase || 'Unknown', ready: `${readyCount}/${item.spec?.containers?.length || cs.length}`, restarts: cs.reduce((s, c) => s + (c.restartCount || 0), 0), createdAt: item.metadata.creationTimestamp };
}

function rbacResponse() {
  const base = (i) => ({ name: i.metadata.name, namespace: i.metadata.namespace || '-', createdAt: i.metadata.creationTimestamp });
  const binding = (i) => ({ ...base(i), roleRef: i.roleRef ? `${i.roleRef.kind}/${i.roleRef.name}` : '-', subjects: (i.subjects || []).length });
  const allSA = [], allRoles = [], allRB = [];
  for (const n of Object.values(cluster.ns)) {
    for (const sa of n.serviceAccounts) allSA.push({ ...base(sa), secrets: (sa.secrets || []).length });
    for (const r of n.roles) allRoles.push({ ...base(r), rules: (r.rules || []).length });
    for (const rb of n.roleBindings) allRB.push(binding(rb));
  }
  return {
    serviceAccounts: allSA, roles: allRoles, roleBindings: allRB,
    clusterRoles: cluster.clusterRoles.map((i) => ({ ...base(i), rules: (i.rules || []).length })),
    clusterRoleBindings: cluster.clusterRoleBindings.map(binding),
  };
}

function clusterSummary() {
  const nodes = cluster.nodes.map(formatNode);
  const nodeSummary = { total: nodes.length, ready: nodes.filter((n) => n.status === 'Ready').length, notReady: nodes.filter((n) => n.status !== 'Ready').length };
  const roles = {};
  let cpuCapacity = 0, cpuAllocatable = 0, memCapacity = 0, memAllocatable = 0;
  const versions = new Set(), osImages = new Set();
  const parseCpu = (s) => (String(s).endsWith('m') ? parseInt(s) / 1000 : parseFloat(s) || 0);
  const parseMem = (s) => { const m = String(s).match(/^(\d+)Ki$/); return m ? parseInt(m[1]) * 1024 : parseFloat(s) || 0; };
  for (const n of nodes) {
    String(n.roles || 'worker').split(',').map((r) => r.trim()).filter(Boolean).forEach((r) => { roles[r] = (roles[r] || 0) + 1; });
    cpuCapacity += parseCpu(n.cpuCapacity); cpuAllocatable += parseCpu(n.cpuAllocatable);
    memCapacity += parseMem(n.memoryCapacity); memAllocatable += parseMem(n.memoryAllocatable);
    if (n.version) versions.add(n.version); if (n.os) osImages.add(n.os);
  }
  const phases = { Running: 0, Pending: 0, Succeeded: 0, Failed: 0, Unknown: 0 };
  let podTotal = 0;
  for (const po of allPods()) { const ph = po.status?.phase || 'Unknown'; phases[ph] = (phases[ph] || 0) + 1; podTotal++; }
  return {
    currentContext: DEMO_CONTEXT, serverVersion: 'v1.29.4', platform: 'linux/amd64',
    contexts: [DEMO_CONTEXT], clusters: [DEMO_CONTEXT], nodes: nodeSummary, roles,
    capacity: { cpuCapacity: +cpuCapacity.toFixed(1), cpuAllocatable: +cpuAllocatable.toFixed(1), memCapacityBytes: memCapacity, memAllocatableBytes: memAllocatable },
    resourceUsage: {
      source: null, cpuSource: null, memorySource: null,
      cpuMilli: null, memBytes: null, cpuRequestsMilli: null,
      cpuLimitsMilli: null, memRequestsBytes: null, memLimitsBytes: null
    },
    versions: [...versions], osImages: [...osImages], pods: { total: podTotal, phases }, namespaceCount: cluster.nsMeta.length,
  };
}

function eventsResponse(nsName, q) {
  const page = parseInt(q.page) || 1;
  const limit = Math.min(parseInt(q.limit) || 50, 100);
  let events = buildEvents();
  if (nsName && nsName !== 'all') events = events.filter((e) => e.namespace === nsName);
  events.sort((a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp));
  const total = events.length;
  const start = (page - 1) * limit;
  return { events: events.slice(start, start + limit), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

function demoLogs(nsName, pod, q) {
  const tail = parseInt(q.tail) || 200;
  const ts = q.timestamps === 'true';
  const isCrash = /checkout-.*ck002/.test(pod);
  const line = (msg, level = 'INFO') => (ts ? `${nowISO()} ` : '') + `${level} ${msg}`;
  let lines;
  if (isCrash) {
    lines = [
      line('starting checkout service v1.5.0-rc1'),
      line('loading configuration from /etc/checkout/config'),
      line('connecting to payments upstream at payments.shop.svc:80'),
      line('FATAL: required env STRIPE_WEBHOOK_SECRET is not set', 'ERROR'),
      line('panic: configuration validation failed', 'ERROR'),
      line('goroutine 1 [running]: main.mustConfig(...)', 'ERROR'),
      line('process exited with code 1', 'ERROR'),
    ];
  } else {
    lines = [];
    for (let i = 0; i < Math.min(tail, 30); i++) {
      lines.push(line(`handled GET /healthz 200 in ${(2 + Math.random() * 8).toFixed(1)}ms`));
    }
    lines.push(line('request /api/products completed 200'));
  }
  return lines.slice(-tail).join('\n');
}

function argoAppDetail(nsp, name) {
  const a = cluster.argo.apps.find((x) => x.metadata.namespace === nsp && x.metadata.name === name);
  if (!a) return { error: 'Application not found' };
  const spec = a.spec || {}, st = a.status || {};
  const resources = (st.resources || []).map((r) => ({ group: r.group || '', version: r.version || '', kind: r.kind, namespace: r.namespace || '', name: r.name, syncStatus: r.status || 'Unknown', healthStatus: r.health?.status || '', healthMessage: r.health?.message || '', parentKey: null, managed: true, createdAt: '' }));
  // add a couple of live descendants (pods) so the tree is non-trivial
  const keyOf = (kind, ns2, nm) => `${kind}|${ns2 || ''}|${nm}`;
  const dep = resources.find((r) => r.kind === 'Deployment');
  if (dep) {
    const rsName = `${dep.name}-rs`;
    resources.push({ group: 'apps', version: 'v1', kind: 'ReplicaSet', namespace: dep.namespace, name: rsName, syncStatus: '', healthStatus: dep.healthStatus, healthMessage: '', parentKey: keyOf('Deployment', dep.namespace, dep.name), managed: false, createdAt: ago(1440) });
    const pods = (cluster.ns[dep.namespace]?.pods || []).filter((po) => po.metadata.labels?.app === dep.name);
    pods.forEach((po) => resources.push({ group: '', version: 'v1', kind: 'Pod', namespace: dep.namespace, name: po.metadata.name, syncStatus: '', healthStatus: po.status?.phase === 'Running' && (po.status?.containerStatuses || []).every((c) => c.ready) ? 'Healthy' : (po.status?.phase === 'Pending' ? 'Progressing' : 'Degraded'), healthMessage: '', parentKey: keyOf('ReplicaSet', dep.namespace, rsName), managed: false, createdAt: po.metadata.creationTimestamp }));
  }
  return {
    app: parseArgoApp(a),
    sources: spec.sources || (spec.source ? [spec.source] : []),
    destination: spec.destination || {}, syncPolicy: spec.syncPolicy || {},
    resources, conditions: st.conditions || [],
    operationState: st.operationState ? { phase: st.operationState.phase, message: st.operationState.message, startedAt: st.operationState.startedAt, finishedAt: st.operationState.finishedAt, revision: (st.operationState.syncResult?.revision || '').slice(0, 7) } : null,
    history: (st.history || []).map((h) => ({ id: h.id, revision: h.revision, deployedAt: h.deployedAt })).reverse(),
    events: [
      { type: 'Normal', reason: 'ResourceUpdated', message: 'Updated sync status', count: 1, lastTimestamp: ago(5) },
      { type: st.health?.status === 'Degraded' ? 'Warning' : 'Normal', reason: 'OperationCompleted', message: st.operationState?.message || 'sync completed', count: 1, lastTimestamp: ago(6) },
    ],
  };
}

// ---- mutations ----
function deleteResource(nsp, kind, name) {
  const k = canonKind(kind);
  if (k === 'PersistentVolume') { cluster.storage.pvs = cluster.storage.pvs.filter((x) => x.metadata.name !== name); return { success: true, message: `${name} deleted` }; }
  if (k === 'StorageClass') { cluster.storage.storageClasses = cluster.storage.storageClasses.filter((x) => x.metadata.name !== name); return { success: true, message: `${name} deleted` }; }
  if (k === 'ClusterRole') { cluster.clusterRoles = cluster.clusterRoles.filter((x) => x.metadata.name !== name); return { success: true, message: `${name} deleted` }; }
  if (k === 'ClusterRoleBinding') { cluster.clusterRoleBindings = cluster.clusterRoleBindings.filter((x) => x.metadata.name !== name); return { success: true, message: `${name} deleted` }; }
  const n = cluster.ns[nsp];
  const coll = KIND_COLLECTION[k];
  if (n && coll) {
    n[coll] = n[coll].filter((x) => x.metadata.name !== name);
    // deleting a workload removes its pods too
    if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(k)) {
      n.pods = n.pods.filter((po) => !(po.metadata.labels?.app === name || (po.metadata.ownerReferences || []).some((o) => o.name.startsWith(name))));
    }
  }
  return { success: true, message: `${name} deleted` };
}

function scaleResource(nsp, kind, name, replicas) {
  const k = canonKind(kind);
  const obj = findResource(nsp, k, name);
  if (obj) {
    obj.spec.replicas = replicas;
    obj.status = obj.status || {};
    obj.status.replicas = replicas; obj.status.readyReplicas = replicas; obj.status.availableReplicas = replicas; obj.status.updatedReplicas = replicas;
    if (['Deployment', 'StatefulSet'].includes(k)) reconcileWorkloadPods(nsp, k, name, replicas);
  }
  return { success: true, message: `${canonKind(kind).toLowerCase()} "${name}" scaled to ${replicas}` };
}

function restartResource(nsp, kind, name) {
  const k = canonKind(kind);
  const obj = findResource(nsp, k, name);
  if (obj) {
    obj.spec.template = obj.spec.template || { metadata: {} };
    obj.spec.template.metadata = obj.spec.template.metadata || {};
    obj.spec.template.metadata.annotations = { ...(obj.spec.template.metadata.annotations || {}), 'kubectl.kubernetes.io/restartedAt': nowISO() };
    // reset owned pods' age + restarts
    const n = cluster.ns[nsp];
    if (n) {
      for (const po of n.pods) {
        if (po.metadata.labels?.app === name || (po.metadata.ownerReferences || []).some((o) => o.name.startsWith(name))) {
          po.metadata.creationTimestamp = nowISO();
          if (po.status?.containerStatuses) po.status.containerStatuses.forEach((c) => { c.restartCount = 0; c.state = { running: { startedAt: nowISO() } }; c.ready = true; });
          po.status.phase = 'Running';
        }
      }
    }
  }
  return { success: true, message: `${canonKind(kind).toLowerCase()}.apps/${name} restarted` };
}

// Upsert applied YAML into the store (best-effort; supports single doc).
function applyYaml(text) {
  let docs = [];
  try { docs = yaml.loadAll(text).filter(Boolean); } catch { return 'Applied'; }
  const names = [];
  for (const doc of docs) {
    if (!doc.kind || !doc.metadata?.name) continue;
    const k = canonKind(doc.kind);
    const nsp = doc.metadata.namespace || 'default';
    const existing = findResource(nsp, k, doc.metadata.name);
    if (existing) {
      if (doc.spec) existing.spec = doc.spec;
      if (doc.data) existing.data = doc.data;
      names.push(`${doc.kind.toLowerCase()}/${doc.metadata.name} configured`);
    } else {
      const coll = KIND_COLLECTION[k];
      if (coll && cluster.ns[nsp]) {
        doc.metadata.uid = doc.metadata.uid || uid();
        doc.metadata.creationTimestamp = doc.metadata.creationTimestamp || nowISO();
        cluster.ns[nsp][coll].push(doc);
        names.push(`${doc.kind.toLowerCase()}/${doc.metadata.name} created`);
      }
    }
  }
  return names.length ? names.join('\n') : 'Applied';
}

function pfStart(body) {
  const { namespace, name, remotePort } = body;
  const localPort = body.localPort ? parseInt(body.localPort, 10) : 30000 + (++pfSeq % 2000);
  const id = `pf-${++pfSeq}`;
  const entry = { id, namespace, name, remotePort, localPort, status: 'active', startedAt: Date.now() };
  forwards.set(id, entry);
  return entry;
}

// ----------------------------------------------------------------------------
// Scripted pseudo-terminal for the pod-shell WebSocket.
//
// server.js frames browser→server messages as JSON: { type:'data', data } for
// keystrokes and { type:'resize', cols, rows }. The server→browser direction is
// raw terminal bytes (xterm writes them directly). We mirror that here.
// ----------------------------------------------------------------------------
export function shellSession(ws, meta = {}) {
  const send = (s) => { try { if (ws.readyState === 1) ws.send(s); } catch { /* ignore */ } };
  const targetName = meta.node || meta.pod || 'pod';
  const isNode = Boolean(meta.node);
  const PROMPT = '\x1b[1;32mdemo@' + targetName + '\x1b[0m:\x1b[1;34m' + (isNode ? '/' : '/app') + '\x1b[0m' + (isNode ? '# ' : '$ ');
  let line = '';

  const banner = [
    '\r\n\x1b[1;36m╭──────────────────────────────────────────────╮\x1b[0m',
    isNode
      ? '\r\n\x1b[1;36m│\x1b[0m  k8sight demo shell (synthetic node)          \x1b[1;36m│\x1b[0m'
      : '\r\n\x1b[1;36m│\x1b[0m  k8sight demo shell (synthetic pod)           \x1b[1;36m│\x1b[0m',
    '\r\n\x1b[1;36m╰──────────────────────────────────────────────╯\x1b[0m',
    isNode
      ? `\r\n\x1b[90mConnected to node/${meta.node}. This is a demo — no real cluster.\x1b[0m`
      : `\r\n\x1b[90mConnected to ${meta.namespace || 'shop'}/${meta.pod || 'pod'}${meta.container ? ' [' + meta.container + ']' : ''}. This is a demo — no real cluster.\x1b[0m`,
    "\r\n\x1b[90mTry: ls, pwd, whoami, cat <file>, env, help, clear, exit\x1b[0m\r\n\r\n",
  ].join('');
  send(banner);
  send(PROMPT);

  const FS = isNode
    ? {
        'etc/os-release': 'NAME="Demo Linux"\nVERSION="1.0"\n',
        'var/log/kubelet.log': 'demo kubelet: node is Ready\n',
      }
    : {
        'app.js': "console.log('demo app listening on :8080');\n",
        'config.yaml': 'log_level: info\ncurrency: USD\n',
        'readme.txt': 'This is a synthetic demo pod filesystem.\n',
      };

  const run = (cmd) => {
    const [name, ...args] = cmd.trim().split(/\s+/);
    switch (name) {
      case '': return '';
      case 'help': return 'Available: ls, pwd, whoami, cat <file>, echo, env, hostname, date, uname, ps, clear, exit\r\n';
      case 'ls': return Object.keys(FS).join('  ') + '\r\n';
      case 'pwd': return (isNode ? '/' : '/app') + '\r\n';
      case 'whoami': return 'root\r\n';
      case 'hostname': return targetName + '\r\n';
      case 'date': return new Date().toString() + '\r\n';
      case 'uname': return 'Linux ' + targetName + ' 5.15.0-101-generic #111-Ubuntu x86_64 GNU/Linux\r\n';
      case 'env': return `${isNode ? `NODE_NAME=${meta.node}\r\n` : `POD_NAMESPACE=${meta.namespace || 'shop'}\r\n`}HOSTNAME=${targetName}\r\nPATH=/usr/local/bin:/usr/bin:/bin\r\nHOME=/root\r\n`;
      case 'ps': return '  PID TTY          TIME CMD\r\n    1 ?        00:00:01 app\r\n   42 pts/0    00:00:00 sh\r\n';
      case 'echo': return args.join(' ') + '\r\n';
      case 'cat': {
        if (!args[0]) return 'cat: missing operand\r\n';
        const f = args[0].replace(/^\.?\//, '');
        return FS[f] != null ? FS[f].replace(/\n/g, '\r\n') : `cat: ${args[0]}: No such file or directory\r\n`;
      }
      case 'clear': return '\x1b[2J\x1b[H';
      case 'exit': send('\r\nlogout\r\n'); try { ws.close(); } catch { /* ignore */ } return null;
      default: return `sh: ${name}: command not found\r\n`;
    }
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'resize') return; // no-op in the scripted shell
    if (msg.type !== 'data') return;
    const data = msg.data || '';
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        send('\r\n');
        const out = run(line);
        line = '';
        if (out === null) return; // exit closed the socket
        if (out) send(out);
        send(PROMPT);
      } else if (ch === '\x7f' || ch === '\b') { // backspace
        if (line.length) { line = line.slice(0, -1); send('\b \b'); }
      } else if (ch === '\x03') { // Ctrl-C
        send('^C\r\n'); line = ''; send(PROMPT);
      } else if (ch >= ' ') {
        line += ch; send(ch); // echo
      }
    }
  });

  ws.on('close', () => { /* nothing to clean up */ });
}

// ----------------------------------------------------------------------------
// Canned AI assistant reply, grounded in the demo cluster.
//
// The real assistant streams `tool` SSE events carrying { name, input } before
// its text (assistant.js). We return both a short answer string and the list of
// tool names the reply is "grounded in", so a demo assistant wiring can stream
// those first. Returns { text, toolCalls }.
// ----------------------------------------------------------------------------
export function aiReply(question) {
  const qq = String(question || '').toLowerCase();
  const reply = (text, toolCalls = []) => ({ text, toolCalls });

  if (/pending|schedul|unschedulable|payments/.test(qq)) {
    return reply(
      'The pod `payments-8d7c6b5a4-py001` in namespace `shop` is **Pending**. The scheduler event says: "0/3 nodes are available: 3 Insufficient cpu." The payments Deployment requests 8 CPU cores per pod, but each demo node only has 4 allocatable cores, so it can never be scheduled. Lower `spec.containers[].resources.requests.cpu` (e.g. to 500m) or add a larger node, then it will schedule.',
      ['get_events', 'describe_resource', 'list_resources'],
    );
  }
  if (/crash|crashloop|checkout|restart|backoff/.test(qq)) {
    return reply(
      'The pod `checkout-7c8f9d6b5-ck002` in `shop` is in **CrashLoopBackOff** with 7 restarts. Its logs end with: "FATAL: required env STRIPE_WEBHOOK_SECRET is not set" followed by a panic and exit code 1. The container is missing a required environment variable. Add `STRIPE_WEBHOOK_SECRET` to the checkout Deployment (e.g. from the `stripe-api-key` secret) and it will start cleanly.',
      ['get_events', 'describe_resource', 'get_pod_logs'],
    );
  }
  if (/argo|gitops|sync|out ?of ?sync|degraded/.test(qq)) {
    return reply(
      'ArgoCD has 6 Applications. `frontend`, `catalog`, `monitoring-stack` are Synced/Healthy. `checkout` is OutOfSync/Degraded (its Deployment has 1/2 replicas because of the CrashLoopBackOff). `payments` is OutOfSync/Progressing (a pod is stuck Pending). `ingress-nginx` is Progressing while its rollout finishes. Fix the underlying checkout and payments pods and re-sync those apps.',
      ['list_resources', 'describe_resource'],
    );
  }
  if (/vuln|cve|security|scan|image/.test(qq)) {
    return reply(
      'The image scan flagged critical CVEs. `ghcr.io/shop/checkout:1.5.0-rc1` has 2 Critical (including CVE-2024-3094, the xz backdoor) plus 4 High. `postgres:16.2` has 1 Critical (CVE-2024-0985). Prioritise upgrading checkout off the RC tag and bumping postgres to 16.3. There is also a config-audit finding that the payments container runs as root.',
      ['list_resources', 'describe_resource'],
    );
  }
  if (/node|cpu|memory|capacity|utili/.test(qq)) {
    return reply(
      'There are 3 nodes (demo-node-1 is the control-plane). Each has 4 CPU and ~15.5Gi memory. Current usage is moderate: demo-node-2 is the busiest at roughly 1.65 cores. Nothing is under memory or disk pressure. Note demo-node-1 carries a control-plane NoSchedule taint, which is part of why the 8-core payments pod cannot be placed.',
      ['list_nodes'],
    );
  }
  if (/helm|release/.test(qq)) {
    return reply(
      'Three Helm releases are installed: `ingress-nginx` (chart 4.10.0) in kube-system, `kube-prometheus-stack` (58.1.0) in monitoring, and `argo-cd` (6.7.0) in argocd. All three report status "deployed".',
      ['get_helm_releases'],
    );
  }
  // generic overview
  return reply(
    'This is the synthetic demo cluster: 3 nodes and 5 namespaces (default, kube-system, shop, monitoring, argocd). The `shop` app runs frontend, catalog, cart, checkout, payments and a postgres StatefulSet. Two workloads need attention — a checkout pod is CrashLoopBackOff and a payments pod is stuck Pending. Ask me about either, or about ArgoCD, image vulnerabilities, nodes, or Helm releases.',
    ['list_namespaces', 'list_nodes'],
  );
}
