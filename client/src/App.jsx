import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';
import Navigation from './components/Navigation';
import { REFRESH_OPTIONS } from './components/RefreshControl';
import ResourceViewer from './components/ResourceViewer';
import Overview from './components/Overview';
import Cluster from './components/Cluster';
import Nodes from './components/Nodes';
import Helm from './components/Helm';
import CustomResourceDetail from './components/CustomResourceDetail';
import Topology from './components/Topology';
import AzureIntegration from './components/AzureIntegration';
import AwsIntegration from './components/AwsIntegration';
import GkeIntegration from './components/GkeIntegration';
import Loader from './components/Loader';
import Namespaces from './components/Namespaces';
import KubeConfigModal from './components/KubeConfigModal';
import AuthErrorModal from './components/AuthErrorModal';
import AccessControl from './components/AccessControl';
import SecurityCenter from './components/SecurityCenter';
import CostsCenter from './components/CostsCenter';
import ArgoCD from './components/ArgoCD';
import Assistant from './components/Assistant';
import AgentPanel from './components/AgentPanel';
import CommandPalette from './components/CommandPalette';
import TopBar from './components/TopBar';
import Preferences from './components/Preferences';
import ClusterRail from './components/ClusterRail';
import { useToast } from './components/Toast';

// Views that load their own data and should NOT trigger the shared resource fetch.
// (Overview is intentionally excluded — its dashboard is built from the shared fetch.)
const STANDALONE_RESOURCE_TYPES = ['cluster', 'nodes', 'namespaces', 'helm', 'customResources', 'accessControl', 'topology', 'argocd', 'security', 'costs'];

// Maps a resourceType to the key it lives under in allResources.
// Naive `type + 's'` breaks for a few types.
const PLURAL_KEY = { ingress: 'ingresses', networkPolicy: 'networkPolicies', storageClass: 'storageClasses' };
const pluralKey = (rt) => PLURAL_KEY[rt] || `${rt}s`;

// Cluster-scoped types come from a single /api/storage call (not per-namespace)
const CLUSTER_SCOPED = ['persistentVolume', 'storageClass'];

const APP_VIEW_TYPES = ['overview', ...STANDALONE_RESOURCE_TYPES, 'resources', 'preferences'];
const pageKeyFor = (type) => type === 'overview' || type === 'preferences' || STANDALONE_RESOURCE_TYPES.includes(type)
  ? type
  : 'resources';

function CachedViewSlot({ active, children }) {
  const [mounted, setMounted] = useState(active);
  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);
  if (!mounted && !active) return null;
  return <div className="cached-view-slot" hidden={!active}>{children}</div>;
}

function App() {
  const toast = useToast();
  const [configStatus, setConfigStatus] = useState({ loaded: false, contexts: [] });
  const [configChecked, setConfigChecked] = useState(false);
  const [serverUnreachable, setServerUnreachable] = useState(false);
  // Cluster auth pre-check: { checked, ok, reason, message, currentContext, server }
  const [authState, setAuthState] = useState({ checked: false, ok: false });
  const [authRetrying, setAuthRetrying] = useState(false);
  const [autoRecovering, setAutoRecovering] = useState(false);
  const autoRecoverRef = useRef(null); // context we've already auto-retried, so we try once
  const [forceConfigModal, setForceConfigModal] = useState(false);
  const [selectedNamespaces, setSelectedNamespaces] = useState(['all']);
  const [namespaces, setNamespaces] = useState([]);
  const [resourceType, setResourceType] = useState('overview');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [history, setHistory] = useState({ stack: ['overview'], idx: 0 });
  const navGuard = useRef(false);
  const [resourceSnapshots, setResourceSnapshots] = useState({});
  const [selectedResource, setSelectedResource] = useState(null);
  const [selectedResourceType, setSelectedResourceType] = useState(null);
  const [loading, setLoading] = useState(false);
  const [resourceAttemptKey, setResourceAttemptKey] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [focusResource, setFocusResource] = useState(null); // { type, namespace, name }
  const [focusNode, setFocusNode] = useState(null);
  const [crSelection, setCrSelection] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system');
  const [refreshSignals, setRefreshSignals] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  // Auto-refresh cadence (key into REFRESH_OPTIONS). Defaults to 'auto' (= 1 min).
  const [refreshInterval, setRefreshInterval] = useState(() => localStorage.getItem('refreshInterval') || 'auto');
  const [argocdInstalled, setArgocdInstalled] = useState(false);
  const handleRefreshRef = useRef(() => {});
  const refreshInFlight = useRef(false);
  const visitedViewsRef = useRef(new Set());
  const previousViewIdentityRef = useRef(null);

  useEffect(() => { localStorage.setItem('refreshInterval', refreshInterval); }, [refreshInterval]);

  useEffect(() => {
    localStorage.setItem('theme', theme);
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const eff = theme === 'system' ? (mq.matches ? 'light' : 'dark') : theme;
      document.documentElement.setAttribute('data-theme', eff);
    };
    apply();
    if (theme === 'system') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);
  const fetchIdRef = useRef(0);
  const [navExpanded, setNavExpanded] = useState({
    workloads: true,
    network: false,
    storage: false,
    config: false,
    argocd: false,
    argocdSettings: false,
    security: false,
    costs: false
  });
  // Which ArgoCD sub-view the sidebar is pointing at (dashboard/applications/…).
  const [argoView, setArgoView] = useState('dashboard');
  // Which Security Center sub-view the sidebar is pointing at.
  const [securityView, setSecurityView] = useState('overview');
  // Which Cost Center sub-view the sidebar is pointing at.
  const [costsView, setCostsView] = useState('overview');
  const [showAzure, setShowAzure] = useState(false);
  // When the failing cluster uses kubelogin/azurecli, the fix is `az login` (the
  // browser OAuth flow doesn't refresh the CLI token that kubelogin reads), so
  // the auth-error "Sign in to Azure" opens the modal in CLI-login mode.
  const [azureMode, setAzureMode] = useState(null); // null | 'az'
  const openAzure = (mode) => { setAzureMode(mode === 'az' ? 'az' : null); setShowAzure(true); };
  const [showAws, setShowAws] = useState(false);
  const [showGke, setShowGke] = useState(false);
  const [prefSection, setPrefSection] = useState('general');
  const [prefReturn, setPrefReturn] = useState('overview');
  const [agentOpen, setAgentOpen] = useState(false);
  const openPreferences = (section) => {
    setResourceType((cur) => { if (cur !== 'preferences') setPrefReturn(cur); return 'preferences'; });
    setPrefSection(section);
  };

  const authOk = authState.ok;
  const activePageKey = pageKeyFor(resourceType);
  const usesSharedResources = resourceType === 'overview'
    || (resourceType !== 'preferences' && !STANDALONE_RESOURCE_TYPES.includes(resourceType));

  useEffect(() => {
    fetchConfigStatus();
  }, []);

  // Once a kubeconfig is parsed, verify the credentials actually work before
  // loading the app (unless the user asked to switch configs).
  useEffect(() => {
    if (configStatus.loaded && !forceConfigModal) checkAuth();
  }, [configStatus.loaded, forceConfigModal]);

  useEffect(() => {
    if (authOk) fetchNamespaces();
  }, [authOk]);

  // Detect optional integrations (ArgoCD) on the active cluster.
  useEffect(() => {
    if (!authOk) { setArgocdInstalled(false); return; }
    let live = true;
    setArgocdInstalled(false);
    axios.get('/api/argocd/status')
      .then(({ data }) => { if (live) setArgocdInstalled(!!data.installed); })
      .catch(() => { if (live) setArgocdInstalled(false); });
    return () => { live = false; };
  }, [authOk, configStatus.currentContext]);

  const selectedNamespaceScope = selectedNamespaces.includes('all') || selectedNamespaces.length === 0
    ? namespaces.filter((name) => name !== 'all').slice().sort()
    : selectedNamespaces.filter((name) => name !== 'all').slice().sort();
  const resourceDataKey = JSON.stringify({
    context: configStatus.currentContext || '',
    scope: CLUSTER_SCOPED.includes(resourceType) ? 'cluster' : selectedNamespaceScope,
  });
  const allResources = resourceSnapshots[resourceDataKey] || {};
  const hasCachedResourceData = Object.prototype.hasOwnProperty.call(resourceSnapshots, resourceDataKey);
  const resourceLoading = usesSharedResources && !hasCachedResourceData
    && (loading || (authOk && resourceAttemptKey !== resourceDataKey));

  const storeResourceSnapshot = (key, data) => {
    setResourceSnapshots((previous) => {
      const recent = Object.entries(previous).filter(([cachedKey]) => cachedKey !== key);
      return Object.fromEntries([...recent.slice(-7), [key, data]]);
    });
  };

  useEffect(() => {
    if (authOk && usesSharedResources) {
      fetchResources({ silent: hasCachedResourceData });
    }
  }, [selectedNamespaces, resourceType, authOk, namespaces, resourceDataKey, usesSharedResources]);

  // Keep each visited page mounted for the current cluster. Returning to one
  // bumps only its refresh signal, so it can update quietly from its last view.
  useEffect(() => {
    const identity = JSON.stringify([configStatus.currentContext || '', activePageKey]);
    const previous = previousViewIdentityRef.current;
    if (previous === identity) return;
    if (visitedViewsRef.current.has(identity)
      && activePageKey !== 'overview'
      && activePageKey !== 'resources'
      && activePageKey !== 'preferences') {
      setRefreshSignals((current) => ({ ...current, [activePageKey]: (current[activePageKey] || 0) + 1 }));
    } else {
      visitedViewsRef.current.add(identity);
    }
    previousViewIdentityRef.current = identity;
  }, [activePageKey, configStatus.currentContext]);

  const fetchConfigStatus = async () => {
    try {
      const response = await axios.get('/api/config/status');
      setConfigStatus(response.data);
      setServerUnreachable(false);
    } catch (err) {
      setServerUnreachable(true);
      setConfigStatus({ loaded: false, contexts: [] });
    } finally {
      setConfigChecked(true);
    }
  };

  // Verify the loaded kubeconfig can authenticate + reach the cluster.
  const checkAuth = async () => {
    try {
      const { data } = await axios.get('/api/config/auth');
      setAuthState({ ...data, checked: true });
      if (!data.ok && data.limited) toast.info(data.message, { title: 'Limited access' });
      return data.ok;
    } catch (err) {
      setAuthState({
        checked: true, ok: false, reason: 'error',
        message: 'Failed to reach the backend server on port 3001.',
      });
      return false;
    }
  };

  const retryAuth = async () => {
    setAuthRetrying(true);
    if (serverUnreachable) await fetchConfigStatus();
    // Reload the kubeconfig first so a fresh cloud login (in-app sign-in, or an
    // external `az login` / `aws sso login`) is actually picked up — the backend
    // caches exec-credential tokens on the loaded kubeconfig otherwise, and a
    // plain re-check would keep failing with the stale token.
    try { await axios.post('/api/config/reload'); } catch { /* non-fatal — fall back to a plain re-check */ }
    await checkAuth();
    setAuthRetrying(false);
  };

  // Auto-recover: if the selected context's auth is expired but the credential
  // looks refreshable (a rejected/expired token — not a missing CLI, TLS, or
  // network fault), silently reload + re-check once before showing the error
  // modal. This transparently picks up refreshed tokens for the CLI-free AKS/EKS
  // helpers and still-valid cloud sessions, so a routine token expiry no longer
  // interrupts the user. One attempt per context avoids a retry loop.
  useEffect(() => {
    if (authOk) { autoRecoverRef.current = null; return; }
    if (forceConfigModal || serverUnreachable) return;
    if (!authState.checked || authRetrying || autoRecovering) return;
    const recoverable = authState.reason === 'unauthorized' || authState.reason === 'error';
    const ctx = authState.currentContext || configStatus.currentContext;
    if (recoverable && ctx && autoRecoverRef.current !== ctx) {
      autoRecoverRef.current = ctx;
      setAutoRecovering(true);
      Promise.resolve(retryAuth()).finally(() => setAutoRecovering(false));
    }
  }, [authState, authOk, authRetrying, autoRecovering, forceConfigModal, serverUnreachable, configStatus.currentContext]);

  // Switch the active cluster/context (from the pinned rail or the selector).
  const switchContext = async (ctx) => {
    if (!ctx || ctx === configStatus.currentContext) return;
    try {
      const resp = await fetch('/api/config/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextName: ctx }),
      });
      if (!resp.ok) throw new Error('switch failed');
      // Reset the view for the new cluster, then reload config + re-check auth.
      setConfigStatus((current) => ({ ...current, currentContext: ctx }));
      setResourceType('overview');
      setSelectedResource(null);
      setSelectedResourceType(null);
      setSelectedNamespaces(['all']);
      setNamespaces([]);
      await fetchConfigStatus();
      const ok = await checkAuth();
      // `authOk` was already true, so the effect that fetches namespaces won't
      // re-fire on its own — repopulate the new cluster's data explicitly, or the
      // whole app shows empty (0 pods/deployments/…) after a pin switch.
      if (ok) {
        await fetchNamespaces();
        toast.success(`Switched to ${ctx}`, { title: 'Cluster' });
      } else {
        // switched, but the new context can't authenticate — the auth-error
        // screen will explain; don't show a misleading success toast.
        toast.info(`Switched to ${ctx} — cluster not reachable`, { title: 'Cluster' });
      }
    } catch (err) {
      toast.error(`Failed to switch to ${ctx}`, { title: 'Cluster' });
    }
  };

  // Enter the demo cluster from any connect screen. Also clears a
  // settings-forced config modal, and closes it directly when we're already in
  // demo (switchContext would no-op on the same context, leaving it stuck).
  const startDemo = () => {
    setForceConfigModal(false);
    if (configStatus.currentContext !== 'demo-cluster') switchContext('demo-cluster');
  };

  // Global refresh for the active page. App-managed views (Overview + resource
  // lists) reload via the shared fetch; self-fetching views watch only their own
  // signal, so hidden pages stay idle and keep their current data.
  // `silent: true` (auto-refresh) also skips the spinning refresh icon, so a
  // background reload is invisible: the values just change.
  const handleRefresh = async ({ silent = false } = {}) => {
    // A silent refresh doesn't set `refreshing`, so guard overlapping reloads
    // (a slow fetch + a short cadence) with a ref as well.
    if (refreshing || refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!silent) setRefreshing(true);
    try {
      const refreshedNamespaces = await fetchNamespaces({ silent });
      const namespaceListChanged = refreshedNamespaces
        && (refreshedNamespaces.length !== namespaces.length
          || refreshedNamespaces.some((name, index) => name !== namespaces[index]));
      if (usesSharedResources && !namespaceListChanged) {
        await fetchResources({ silent });
      }
      if (activePageKey !== 'overview' && activePageKey !== 'preferences') {
        setRefreshSignals((current) => ({ ...current, [activePageKey]: (current[activePageKey] || 0) + 1 }));
      }
    } finally {
      refreshInFlight.current = false;
      // brief spin so the action is perceptible even when the fetch is instant
      if (!silent) setTimeout(() => setRefreshing(false), 400);
    }
  };
  handleRefreshRef.current = handleRefresh;

  // ⌘K / Ctrl+K opens the command palette.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Back/forward view history for the top bar. Record each view change unless it
  // was driven by a back/forward navigation (navGuard) or is the settings overlay.
  useEffect(() => {
    if (navGuard.current) { navGuard.current = false; return; }
    if (resourceType === 'preferences') return;
    setHistory((h) => {
      if (h.stack[h.idx] === resourceType) return h;
      const stack = h.stack.slice(0, h.idx + 1).concat(resourceType);
      return { stack, idx: stack.length - 1 };
    });
  }, [resourceType]);
  const goBack = () => setHistory((h) => {
    if (h.idx <= 0) return h;
    const idx = h.idx - 1; navGuard.current = true; setResourceType(h.stack[idx]);
    return { ...h, idx };
  });
  const goForward = () => setHistory((h) => {
    if (h.idx >= h.stack.length - 1) return h;
    const idx = h.idx + 1; navGuard.current = true; setResourceType(h.stack[idx]);
    return { ...h, idx };
  });

  // Auto-refresh timer. Fires the same handleRefresh used by the button, so it
  // works on every page. Uses a ref so the interval isn't torn down on each
  // page change / render — only when the cadence itself changes.
  useEffect(() => {
    const ms = REFRESH_OPTIONS.find(o => o.key === refreshInterval)?.ms || 0;
    if (!ms || !authOk) return;
    const id = setInterval(() => { handleRefreshRef.current?.({ silent: true }); }, ms);
    return () => clearInterval(id);
  }, [refreshInterval, authOk]);

  // Load a kubeconfig from a user-provided path; returns an error string or null
  const loadConfigFromPath = async (filePath) => {
    try {
      await axios.post('/api/config/load', { filePath });
      setForceConfigModal(false);
      setAuthState({ checked: false, ok: false }); // re-gate on the new config
      await fetchConfigStatus();
      return null;
    } catch (err) {
      return err.response?.data?.error || err.message || 'Failed to load kubeconfig';
    }
  };

  const fetchNamespaces = async ({ silent = false } = {}) => {
    try {
      const response = await axios.get('/api/namespaces');
      const next = ['all', ...response.data.namespaces];
      setNamespaces((previous) => previous.length === next.length
        && previous.every((name, index) => name === next[index]) ? previous : next);
      return next;
    } catch (err) {
      if (!silent) toast.error('Failed to fetch namespaces', { title: 'Namespaces' });
      return null;
    }
  };

  const handleNamespaceDeleted = (deletedNamespace) => {
    setSelectedNamespaces((current) => {
      if (current.includes('all')) return current;
      const remaining = current.filter((namespace) => namespace !== deletedNamespace);
      return remaining.length ? remaining : ['all'];
    });
    fetchNamespaces({ silent: true });
  };

  const resolveNamespaces = (availableNamespaces = namespaces) => {
    if (selectedNamespaces.includes('all') || selectedNamespaces.length === 0) {
      return availableNamespaces.filter(n => n !== 'all');
    }
    return selectedNamespaces;
  };

  const fetchResources = async ({ silent = false } = {}) => {
    const fetchId = ++fetchIdRef.current;
    setResourceAttemptKey(resourceDataKey);
    // A silent (background) fetch keeps whatever is already on screen — the list
    // is replaced once the data is in, so there's no "Loading pods…" flash.
    if (!silent || !hasCachedResourceData) setLoading(true);
    else setLoading(false);
    try {
      // Cluster-scoped types (PersistentVolumes, StorageClasses) are a single call
      if (CLUSTER_SCOPED.includes(resourceType)) {
        const res = await axios.get('/api/storage');
        if (fetchId !== fetchIdRef.current) return;
        storeResourceSnapshot(resourceDataKey, res.data);
        return;
      }

      const namespacesToFetch = resolveNamespaces();
      const allData = {};
      const failedNamespaces = new Set();

      // Fetch namespaces in parallel with a bounded concurrency pool.
      // The backend now uses in-process API calls (no process spawn), so we
      // can afford a higher fan-out.
      const CONCURRENCY = 12;
      let cursor = 0;
      const worker = async () => {
        while (cursor < namespacesToFetch.length) {
          if (fetchId !== fetchIdRef.current) return; // a newer fetch started
          const ns = namespacesToFetch[cursor++];
          try {
            const response = await axios.get(`/api/resources/${ns}`);
            if (fetchId !== fetchIdRef.current) return;
            // Synchronous merge — safe on JS's single thread, no data race
            Object.keys(response.data).forEach(key => {
              if (!allData[key]) allData[key] = [];
              allData[key].push(...response.data[key]);
            });
          } catch (e) {
            // Skip a namespace that fails (e.g. RBAC) rather than failing all
            if (silent) failedNamespaces.add(ns);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, namespacesToFetch.length) }, worker)
      );

      if (fetchId !== fetchIdRef.current) return;
      if (silent && failedNamespaces.size) {
        for (const [key, rows] of Object.entries(allResources)) {
          const staleRows = rows.filter((row) => failedNamespaces.has(row.namespace));
          if (staleRows.length) allData[key] = [...(allData[key] || []), ...staleRows];
        }
      }
      storeResourceSnapshot(resourceDataKey, allData);
    } catch (err) {
      if (fetchId === fetchIdRef.current && !silent) toast.error('Failed to fetch resources', { title: 'Resources' });
    } finally {
      if (fetchId === fetchIdRef.current) setLoading(false);
    }
  };

  // Clear the selected resource (and drawer) only when the resource type changes.
  useEffect(() => {
    setSelectedResource(null);
    setSelectedResourceType(null);
  }, [resourceType]);

  // Resolve a pending focus target once its list has loaded (cross-link navigation).
  useEffect(() => {
    if (!focusResource) return;
    // Use the app's pluralisation (naive +'s' breaks e.g. storageClass→storageClasses).
    const list = allResources[pluralKey(focusResource.type)] || [];
    // Normalise namespace so cluster-scoped targets (StorageClass, PV, …) match
    // whether the row/target uses '' or undefined.
    const match = list.find(r => r.name === focusResource.name && (r.namespace || '') === (focusResource.namespace || ''));
    if (match) {
      setSelectedResource(match);
      setSelectedResourceType(focusResource.type);
      setFocusResource(null);
    }
  }, [allResources, focusResource]);

  // Cross-navigation used by tables, drawers and the topology/nodes views.
  const nav = {
    toNamespace: (ns) => {
      if (!ns) return;
      setSelectedNamespaces([ns]);
      if (STANDALONE_RESOURCE_TYPES.includes(resourceType) || resourceType === 'overview') {
        setResourceType('pod');
      }
    },
    toNode: (name) => {
      if (!name) return;
      setFocusNode(name);
      setResourceType('nodes');
    },
    toResource: ({ type, namespace, name }) => {
      if (!type || !name) return;
      setSelectedNamespaces([namespace || 'all']);
      setResourceType(type);
      setFocusResource({ type, namespace, name });
    },
    // Open the Pods view scoped to a workload. We rarely have the exact pod name
    // (e.g. Trivy attributes CVEs to the owning ReplicaSet), so filter the pod
    // list by the owner name — pods are named `<owner>-<hash>` and match.
    toPods: (namespace, nameFilter) => {
      setSelectedNamespaces([namespace || 'all']);
      setResourceType('pod');
      setSearchQuery(nameFilter || '');
    }
  };

  const toggleNavSection = (section) => {
    setNavExpanded(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const getFilteredResources = (type = resourceType) => {
    const baseResources = allResources[pluralKey(type)] || [];

    if (!searchQuery) return baseResources;
    return baseResources.filter(r =>
      r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.namespace || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
  };

  const getTotalCount = (type = resourceType) => (allResources[pluralKey(type)] || []).length;

  // ---- gate: what to render before the app is ready ----
  const showConfigModal = configChecked && !serverUnreachable && (!configStatus.loaded || forceConfigModal);
  const checkingAuth = configStatus.loaded && !forceConfigModal && (!authState.checked || autoRecovering);
  const showAuthError = configStatus.loaded && !forceConfigModal && authState.checked && !authState.ok && !autoRecovering;

  const renderPage = (viewType) => {
    const refreshSignal = refreshSignals[viewType] || 0;
    if (viewType === 'overview') {
      return (
        <Overview
          allResources={allResources}
          selectedNamespaces={selectedNamespaces}
          namespaces={namespaces}
          onNamespaceSelect={setSelectedNamespaces}
          loading={resourceLoading}
          onResourceTypeChange={setResourceType}
        />
      );
    }
    if (viewType === 'cluster') return <Cluster configStatus={configStatus} refreshSignal={refreshSignal} />;
    if (viewType === 'nodes') return <Nodes active={resourceType === viewType} focusNode={focusNode} onFocusHandled={() => setFocusNode(null)} onNavigate={nav} refreshSignal={refreshSignal} />;
    if (viewType === 'namespaces') return <Namespaces onNavigate={nav} onNamespaceDeleted={handleNamespaceDeleted} refreshSignal={refreshSignal} />;
    if (viewType === 'topology') return <Topology namespaces={namespaces} refreshSignal={refreshSignal} />;
    if (viewType === 'helm') return <Helm refreshSignal={refreshSignal} />;
    if (viewType === 'customResources') return <CustomResourceDetail selection={crSelection} onSelect={setCrSelection} refreshSignal={refreshSignal} />;
    if (viewType === 'accessControl') return <AccessControl onNavigate={nav} refreshSignal={refreshSignal} />;
    if (viewType === 'security') return <SecurityCenter namespaces={namespaces} onNavigate={nav} view={resourceType === viewType ? securityView : null} onViewChange={setSecurityView} refreshSignal={refreshSignal} />;
    if (viewType === 'costs') return <CostsCenter key={`costs-${configStatus.currentContext}`} context={configStatus.currentContext} refreshSignal={refreshSignal} view={resourceType === viewType ? costsView : null} onViewChange={setCostsView} />;
    if (viewType === 'argocd') return <ArgoCD onNavigate={nav} refreshSignal={refreshSignal} view={resourceType === viewType ? argoView : null} onViewChange={setArgoView} />;
    if (viewType === 'preferences') {
      return (
        <Preferences
          configStatus={configStatus}
          theme={theme}
          onSetTheme={setTheme}
          onChangeConfig={() => setForceConfigModal(true)}
          onAddAzure={() => openAzure()}
          onAddAws={() => setShowAws(true)}
          onAddGke={() => setShowGke(true)}
          initialSection={prefSection}
          onClose={() => setResourceType(prefReturn || 'overview')}
        />
      );
    }
    if (viewType === 'resources') {
      return (
        <ResourceViewer
          active={activePageKey === 'resources'}
          resourceType={resourceType}
          resources={getFilteredResources()}
          selectedResource={selectedResourceType === resourceType ? selectedResource : null}
          onSelectResource={(resource) => {
            setSelectedResource(resource);
            setSelectedResourceType(resource ? resourceType : null);
          }}
          selectedNamespaces={selectedNamespaces}
          namespaces={namespaces}
          onNamespaceChange={setSelectedNamespaces}
          loading={resourceLoading}
          hasCachedData={hasCachedResourceData}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          totalCount={getTotalCount()}
          onResourceTypeChange={setResourceType}
          onNavigate={nav}
          onRefresh={handleRefresh}
          refreshSignal={refreshSignal}
        />
      );
    }
    return null;
  };

  return (
    <div className="app-shell">
      {authOk && (
        <TopBar
          onBack={goBack}
          onForward={goForward}
          canBack={history.idx > 0}
          canForward={history.idx < history.stack.length - 1}
          onNotifications={() => setResourceType('events')}
          onConfigureAi={() => openPreferences('external-tools')}
          onRefresh={handleRefresh}
          refreshing={refreshing}
        />
      )}
      {serverUnreachable && configChecked && (
        <AuthErrorModal
          auth={{ reason: 'error', message: 'Cannot reach the backend server on port 3001. Is it running?' }}
          onRetry={retryAuth}
          retrying={authRetrying}
        />
      )}

      {!serverUnreachable && showConfigModal && (
        <KubeConfigModal
          defaultPath={configStatus.defaultPath}
          exists={configStatus.exists}
          onSubmit={loadConfigFromPath}
          onDemo={startDemo}
          onClose={configStatus.loaded ? () => setForceConfigModal(false) : undefined}
        />
      )}

      {!serverUnreachable && showAuthError && (
        <AuthErrorModal
          auth={authState}
          onRetry={retryAuth}
          onChangeConfig={() => setForceConfigModal(true)}
          retrying={authRetrying}
          contexts={configStatus.contexts || []}
          contextsInfo={configStatus.contextsInfo}
          currentContext={configStatus.currentContext}
          onSwitchContext={switchContext}
          onAddAzure={(mode) => openAzure(mode)}
          onAddAws={() => setShowAws(true)}
          onAddGke={() => setShowGke(true)}
          onDemo={startDemo}
        />
      )}

      {authOk && (
        <Assistant
          context={{
            view: resourceType,
            namespaces: selectedNamespaces,
            selected: selectedResource && selectedResourceType === resourceType
              ? { type: resourceType, namespace: selectedResource.namespace, name: selectedResource.name }
              : null,
          }}
        />
      )}

      {showAzure && (
        <AzureIntegration
          initialLogin={azureMode}
          onClose={() => { setShowAzure(false); setAzureMode(null); }}
          onImported={async () => { await fetchConfigStatus(); retryAuth(); }}
        />
      )}

      {showAws && (
        <AwsIntegration
          onClose={() => setShowAws(false)}
          onImported={async () => { await fetchConfigStatus(); retryAuth(); }}
        />
      )}

      {showGke && (
        <GkeIntegration
          onClose={() => setShowGke(false)}
          onImported={async () => { await fetchConfigStatus(); retryAuth(); }}
        />
      )}


      {authOk ? (
        <div className="layout-main">
          <ClusterRail
            contexts={configStatus.contexts || []}
            currentContext={configStatus.currentContext}
            onSwitch={switchContext}
          />
          <Navigation
            configStatus={configStatus}
            onConfigChange={fetchConfigStatus}
            onSwitchContext={switchContext}
            resourceType={resourceType}
            onResourceTypeChange={setResourceType}
            navExpanded={navExpanded}
            onToggleNav={toggleNavSection}
            crSelection={crSelection}
            onSelectCustomResource={(sel) => { setResourceType('customResources'); setCrSelection(sel); }}
            argocdInstalled={argocdInstalled}
            argoView={resourceType === 'argocd' ? argoView : null}
            onSelectArgoView={(v) => { setArgoView(v); setResourceType('argocd'); }}
            securityView={resourceType === 'security' ? securityView : null}
            onSelectSecurityView={(v) => { setSecurityView(v); setResourceType('security'); }}
            costsView={resourceType === 'costs' ? costsView : null}
            onSelectCostsView={(v) => { setCostsView(v); setResourceType('costs'); }}
            onAddAzure={() => openAzure()}
            onAddAws={() => setShowAws(true)}
            onAddGke={() => setShowGke(true)}
            onAddLocal={() => setForceConfigModal(true)}
            onOpenPreferences={() => openPreferences('general')}
          />

          <div className="content-col">
          {APP_VIEW_TYPES.map((viewType) => (
            <CachedViewSlot
              key={JSON.stringify([configStatus.currentContext || '', viewType])}
              active={activePageKey === viewType}
            >
              {renderPage(viewType)}
            </CachedViewSlot>
          ))}
          <AgentPanel context={{ currentContext: configStatus.currentContext }} onOpenChange={setAgentOpen} />
          </div>
        </div>
      ) : !configChecked ? (
        <div className="loading-state">
          <Loader label="Loading kubeconfig…" size={36} />
        </div>
      ) : checkingAuth ? (
        <div className="loading-state">
          <Loader label={autoRecovering ? 'Reconnecting — refreshing credentials…' : 'Checking cluster authentication…'} size={36} />
        </div>
      ) : (
        // A modal (config / auth / server error) is overlaid above; keep a
        // neutral backdrop underneath it.
        <div className="loading-state" />
      )}

      {authOk && (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onNavigate={(k) => setResourceType(k)}
          contexts={configStatus.contexts || []}
          currentContext={configStatus.currentContext}
          onSwitchContext={switchContext}
          onOpenPreferences={() => openPreferences('general')}
          onRefresh={handleRefresh}
          onSetTheme={setTheme}
        />
      )}
    </div>
  );
}

export default App;
