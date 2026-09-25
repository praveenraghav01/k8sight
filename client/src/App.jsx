import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';
import Navigation from './components/Navigation';
import { REFRESH_OPTIONS } from './components/RefreshControl';
import ResourceViewer, { TAB_KEYS } from './components/ResourceViewer';
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
const STANDALONE_RESOURCE_TYPES = ['cluster', 'nodes', 'namespaces', 'helm', 'customResources', 'accessControl', 'topology', 'argocd', 'security'];

// Maps a resourceType to the key it lives under in allResources.
// Naive `type + 's'` breaks for a few types.
const PLURAL_KEY = { ingress: 'ingresses', networkPolicy: 'networkPolicies', storageClass: 'storageClasses' };
const pluralKey = (rt) => PLURAL_KEY[rt] || `${rt}s`;

// Cluster-scoped types come from a single /api/storage call (not per-namespace)
const CLUSTER_SCOPED = ['persistentVolume', 'storageClass'];

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
  const [allResources, setAllResources] = useState({});
  const [selectedResource, setSelectedResource] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [focusResource, setFocusResource] = useState(null); // { type, namespace, name }
  const [focusNode, setFocusNode] = useState(null);
  const [crSelection, setCrSelection] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Auto-refresh cadence (key into REFRESH_OPTIONS). Defaults to 'auto' (= 1 min).
  const [refreshInterval, setRefreshInterval] = useState(() => localStorage.getItem('refreshInterval') || 'auto');
  const [argocdInstalled, setArgocdInstalled] = useState(false);
  const handleRefreshRef = useRef(() => {});
  const refreshInFlight = useRef(false);

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
    security: false
  });
  // Which ArgoCD sub-view the sidebar is pointing at (dashboard/applications/…).
  const [argoView, setArgoView] = useState('dashboard');
  // Which Security Center sub-view the sidebar is pointing at.
  const [securityView, setSecurityView] = useState('overview');
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

  useEffect(() => {
    if (authOk && !STANDALONE_RESOURCE_TYPES.includes(resourceType)) {
      fetchResources();
    }
  }, [selectedNamespaces, resourceType, authOk, namespaces]);

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
      setResourceType('overview');
      setSelectedResource(null);
      setSelectedNamespaces(['all']);
      setAllResources({});
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
  // lists) reload via the shared fetch; self-fetching views (Cluster, Nodes,
  // Topology, Helm, Namespaces, Custom Resources, Access Control, …) watch
  // `refreshNonce` and re-fetch in place — no remount, so their selection, tab,
  // scroll and pan/zoom survive a refresh and no loader flashes over the data.
  // `silent: true` (auto-refresh) also skips the spinning refresh icon, so a
  // background reload is invisible: the values just change.
  const handleRefresh = async ({ silent = false } = {}) => {
    // A silent refresh doesn't set `refreshing`, so guard overlapping reloads
    // (a slow fetch + a short cadence) with a ref as well.
    if (refreshing || refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!silent) setRefreshing(true);
    try {
      if (!STANDALONE_RESOURCE_TYPES.includes(resourceType)) {
        await fetchNamespaces();
        await fetchResources({ silent });
      }
      setRefreshNonce(n => n + 1);
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

  const fetchNamespaces = async () => {
    try {
      const response = await axios.get('/api/namespaces');
      setNamespaces(['all', ...response.data.namespaces]);
    } catch (err) {
      toast.error('Failed to fetch namespaces', { title: 'Namespaces' });
    }
  };

  const resolveNamespaces = () => {
    if (selectedNamespaces.includes('all') || selectedNamespaces.length === 0) {
      return namespaces.filter(n => n !== 'all');
    }
    return selectedNamespaces;
  };

  const fetchResources = async ({ silent = false } = {}) => {
    const fetchId = ++fetchIdRef.current;
    // A silent (background) fetch keeps whatever is already on screen — the list
    // is replaced once the data is in, so there's no "Loading pods…" flash.
    if (!silent) setLoading(true);
    try {
      // Cluster-scoped types (PersistentVolumes, StorageClasses) are a single call
      if (CLUSTER_SCOPED.includes(resourceType)) {
        const res = await axios.get('/api/storage');
        if (fetchId !== fetchIdRef.current) return;
        setAllResources(res.data);
        return;
      }

      const namespacesToFetch = resolveNamespaces();
      const allData = {};

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
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, namespacesToFetch.length) }, worker)
      );

      if (fetchId !== fetchIdRef.current) return;
      setAllResources(allData);
    } catch (err) {
      if (fetchId === fetchIdRef.current) toast.error('Failed to fetch resources', { title: 'Resources' });
    } finally {
      if (fetchId === fetchIdRef.current) setLoading(false);
    }
  };

  // Clear the selected resource (and drawer) only when the resource type changes.
  useEffect(() => {
    setSelectedResource(null);
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

  const getFilteredResources = () => {
    const baseResources = allResources[pluralKey(resourceType)] || [];

    if (!searchQuery) return baseResources;
    return baseResources.filter(r =>
      r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.namespace.toLowerCase().includes(searchQuery.toLowerCase())
    );
  };

  const getTotalCount = () => (allResources[pluralKey(resourceType)] || []).length;

  // ---- gate: what to render before the app is ready ----
  const showConfigModal = configChecked && !serverUnreachable && (!configStatus.loaded || forceConfigModal);
  const checkingAuth = configStatus.loaded && !forceConfigModal && (!authState.checked || autoRecovering);
  const showAuthError = configStatus.loaded && !forceConfigModal && authState.checked && !authState.ok && !autoRecovering;

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
            selected: selectedResource
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
            onAddAzure={() => openAzure()}
            onAddAws={() => setShowAws(true)}
            onAddGke={() => setShowGke(true)}
            onAddLocal={() => setForceConfigModal(true)}
            onOpenPreferences={() => openPreferences('general')}
          />

          <div className="content-col">
          {resourceType === 'overview' ? (
            <Overview
              allResources={allResources}
              selectedNamespaces={selectedNamespaces}
              namespaces={namespaces}
              onNamespaceSelect={setSelectedNamespaces}
              loading={loading}
              onResourceTypeChange={setResourceType}
            />
          ) : resourceType === 'cluster' ? (
            <Cluster configStatus={configStatus} refreshSignal={refreshNonce} />
          ) : resourceType === 'nodes' ? (
            <Nodes focusNode={focusNode} onFocusHandled={() => setFocusNode(null)} onNavigate={nav} refreshSignal={refreshNonce} />
          ) : resourceType === 'namespaces' ? (
            <Namespaces onNavigate={nav} refreshSignal={refreshNonce} />
          ) : resourceType === 'topology' ? (
            <Topology namespaces={namespaces} refreshSignal={refreshNonce} />
          ) : resourceType === 'helm' ? (
            <Helm refreshSignal={refreshNonce} />
          ) : resourceType === 'customResources' ? (
            <CustomResourceDetail selection={crSelection} onSelect={setCrSelection} refreshSignal={refreshNonce} />
          ) : resourceType === 'accessControl' ? (
            <AccessControl onNavigate={nav} refreshSignal={refreshNonce} />
          ) : resourceType === 'security' ? (
            <SecurityCenter namespaces={namespaces} onNavigate={nav} view={securityView} onViewChange={setSecurityView} refreshSignal={refreshNonce} />
          ) : resourceType === 'argocd' ? (
            <ArgoCD onNavigate={nav} refreshSignal={refreshNonce} view={argoView} onViewChange={setArgoView} />
          ) : resourceType === 'preferences' ? (
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
          ) : (
            <ResourceViewer
              resourceType={resourceType}
              resources={getFilteredResources()}
              selectedResource={selectedResource}
              onSelectResource={setSelectedResource}
              selectedNamespaces={selectedNamespaces}
              namespaces={namespaces}
              onNamespaceChange={setSelectedNamespaces}
              loading={loading}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              totalCount={getTotalCount()}
              onResourceTypeChange={setResourceType}
              onNavigate={nav}
              onRefresh={handleRefresh}
              refreshSignal={refreshNonce}
            />
          )}
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
