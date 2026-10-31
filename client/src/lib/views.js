// Display names and icons for every page a tab can show, so the tab strip can
// label a tab the same way the sidebar names it.
const VIEWS = {
  overview: ['Overview', 'overview'],
  cluster: ['Cluster', 'cluster'],
  nodes: ['Nodes', 'nodes'],
  namespaces: ['Namespaces', 'namespace'],
  topology: ['Topology', 'topology'],
  pod: ['Pods', 'pod'],
  deployment: ['Deployments', 'deployment'],
  statefulSet: ['StatefulSets', 'statefulSet'],
  daemonSet: ['DaemonSets', 'daemonSet'],
  replicaSet: ['Replica Sets', 'replicaSet'],
  replicationController: ['Replication Controllers', 'replicationController'],
  job: ['Jobs', 'job'],
  cronJob: ['Cron Jobs', 'cronJob'],
  service: ['Services', 'service'],
  ingress: ['Ingress', 'ingress'],
  networkPolicy: ['Network Policies', 'networkPolicy'],
  persistentVolume: ['PersistentVolumes', 'persistentVolume'],
  persistentVolumeClaim: ['PersistentVolumeClaims', 'persistentVolumeClaim'],
  storageClass: ['StorageClasses', 'storageClass'],
  configMap: ['ConfigMaps', 'configMap'],
  secret: ['Secrets', 'secret'],
  serviceAccount: ['ServiceAccounts', 'serviceAccount'],
  events: ['Events', 'events'],
  helm: ['Helm', 'helm'],
  accessControl: ['Access Control', 'accessControl'],
  customResources: ['Custom Resources', 'customResources'],
  security: ['Security', 'security'],
  costs: ['Costs', 'costs'],
  argocd: ['Argo CD', 'argocd'],
  flux: ['Flux', 'flux'],
  flagger: ['Flagger', 'flagger'],
  preferences: ['Preferences', 'settings'],
};

// Sub-view names, for pages that have them. The page's own default sub-view
// (dashboard / overview / canary) isn't repeated in the label.
const SUB = {
  argocd: { default: 'dashboard', applications: 'Applications', view: 'View', appsets: 'Application Sets', projects: 'Projects', repositories: 'Repositories', clusters: 'Clusters' },
  flux: { default: 'dashboard', helmrelease: 'Helm Releases', kustomization: 'Kustomizations', alert: 'Alerts', provider: 'Providers', receiver: 'Receivers', gitrepository: 'Git Repositories', ocirepository: 'OCI Repositories', helmrepository: 'Helm Repositories', bucket: 'Buckets', externalartifact: 'External Artifacts' },
  flagger: { default: 'canary', metrictemplate: 'Metric Templates', alertprovider: 'Alert Providers' },
  security: { default: 'overview', images: 'Images', resources: 'Resources', roles: 'Roles' },
  costs: { default: 'overview', namespaces: 'Namespaces', workloads: 'Workloads', nodes: 'Nodes' },
};

export function viewIcon(view) {
  return (VIEWS[view] || [null, 'box'])[1];
}

export function tabLabel(tab) {
  const [base] = VIEWS[tab.view] || [tab.view];
  const subs = SUB[tab.view];
  const sub = tab.sub?.[tab.view];
  if (subs && sub && sub !== subs.default && subs[sub]) return `${base} · ${subs[sub]}`;
  if (tab.view === 'customResources' && tab.sub?.customResources?.kind) return tab.sub.customResources.kind;
  return base;
}

// Shown under the label on hover: the namespaces the tab is filtered to.
export function tabScope(tab) {
  const ns = (tab.namespaces || []).filter((n) => n !== 'all');
  return ns.length ? ns.join(', ') : '';
}
