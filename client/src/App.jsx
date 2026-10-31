import React, { useState, useEffect, useRef, useReducer, useCallback } from 'react';
import axios from 'axios';
import './App.css';
import Navigation from './components/Navigation';
import useProductionMark from './hooks/useProductionMark';
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
import Flux from './components/Flux';
import Flagger from './components/Flagger';
import Assistant from './components/Assistant';
import AgentPanel from './components/AgentPanel';
import CommandPalette from './components/CommandPalette';
import TopBar from './components/TopBar';
import Preferences from './components/Preferences';
import ClusterRail from './components/ClusterRail';
import Workspace from './components/Workspace';
import Icon from './components/Icons';
import { useToast } from './components/Toast';
import {
  reduce as reduceWorkspace, initialWorkspace, newTab, focusedGroup, focusedTab, activeTab,
  serialize, deserialize, MAX_GROUPS,
} from './lib/workspace';
import { tabLabel } from './lib/views';
import { parseTabWindow, openTabWindow, portableTab, saveWindowTab, forgetWindowTab, channel as tabWindowChannel } from './lib/tabWindows';

// Set when this window is a tab window (one tab, opened from the main window).
const TAB_WINDOW = parseTabWindow();

// Views that load their own data and should NOT trigger the shared resource fetch.
// (Overview is intentionally excluded — its dashboard is built from the shared fetch.)
const STANDALONE_RESOURCE_TYPES = ['cluster', 'nodes', 'namespaces', 'helm', 'customResources', 'accessControl', 'topology', 'argocd', 'flux', 'flagger', 'security', 'costs'];

// Maps a resourceType to the key it lives under in a resource snapshot.
// Naive `type + 's'` breaks for a few types.
const PLURAL_KEY = { ingress: 'ingresses', networkPolicy: 'networkPolicies', storageClass: 'storageClasses' };
const pluralKey = (rt) => PLURAL_KEY[rt] || `${rt}s`;

// Cluster-scoped types come from a single /api/storage call (not per-namespace)
const CLUSTER_SCOPED = ['persistentVolume', 'storageClass'];

// Each tab keeps one mounted page per page key it has visited; all the plain
// resource lists share the 'resources' page (one ResourceViewer per tab).
const pageKeyFor = (type) => type === 'overview' || type === 'preferences' || STANDALONE_RESOURCE_TYPES.includes(type)
  ? type
  : 'resources';
const usesSharedResources = (type) => type === 'overview'
  || (type !== 'preferences' && !STANDALONE_RESOURCE_TYPES.includes(type));
const hasCachedFor = (type, data) => (type === 'overview'
  ? data.overviewByNamespace != null || Array.isArray(data.pods)
  : type === 'events' ? true : Array.isArray(data[pluralKey(type)]));

// Default sub-view per page, when the tab hasn't picked one.
const SUB_DEFAULT = { argocd: 'dashboard', flux: 'dashboard', flagger: 'canary', security: 'overview', costs: 'overview' };
const subOf = (tab, view) => tab?.sub?.[view] || SUB_DEFAULT[view];

// The split-screen layout is remembered per cluster context.
const layoutKey = (ctx) => `k8sight.workspace.${ctx || ''}`;
const loadLayout = (ctx) => { try { return deserialize(JSON.parse(localStorage.getItem(layoutKey(ctx)))); } catch { return null; } };
const saveLayout = (ctx, ws) => { try { localStorage.setItem(layoutKey(ctx), JSON.stringify(serialize(ws))); } catch { /* storage blocked */ } };

function App() {
  const toast = useToast();
  const [configStatus, setConfigStatus] = useState({ loaded: false, contexts: [] });
  const prodMark = useProductionMark();
  const [configChecked, setConfigChecked] = useState(false);
  const [serverUnreachable, setServerUnreachable] = useState(false);
  // Cluster auth pre-check: { checked, ok, reason, message, currentContext, server }
  const [authState, setAuthState] = useState({ checked: false, ok: false });
  const [authRetrying, setAuthRetrying] = useState(false);
  const [autoRecovering, setAutoRecovering] = useState(false);
  const autoRecoverRef = useRef(null); // context we've already auto-retried, so we try once
  const [forceConfigModal, setForceConfigModal] = useState(false);
  const [namespaces, setNamespaces] = useState([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [resourceSnapshots, setResourceSnapshots] = useState({});
  const snapshotsRef = useRef(resourceSnapshots);
  snapshotsRef.current = resourceSnapshots;
  // Per request (data key + type): in flight, and attempted at least once.
  const [loadingReqs, setLoadingReqs] = useState({});
  const [attemptedReqs, setAttemptedReqs] = useState({});
  const fetchIdsRef = useRef({});
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system');
  const [refreshing, setRefreshing] = useState(false);
  // Auto-refresh cadence (key into REFRESH_OPTIONS). Defaults to 'auto' (= 1 min).
  const [refreshInterval, setRefreshInterval] = useState(() => localStorage.getItem('refreshInterval') || 'auto');
  const [argocdInstalled, setArgocdInstalled] = useState(false);
  const [fluxInstalled, setFluxInstalled] = useState(false);
  const [flaggerInstalled, setFlaggerInstalled] = useState(false);
  const handleRefreshRef = useRef(() => {});
  const refreshInFlight = useRef(false);

  // ---- split-screen workspace: groups of tabs, each tab one page ----
  const [workspace, dispatch] = useReducer(reduceWorkspace, undefined, () => (TAB_WINDOW
    ? initialWorkspace(newTab(TAB_WINDOW.tab.view, { sub: TAB_WINDOW.tab.sub, namespaces: TAB_WINDOW.tab.namespaces, search: TAB_WINDOW.tab.search }))
    : initialWorkspace()));
  const tabChannelRef = useRef(null);
  const [mainWindowOpen, setMainWindowOpen] = useState(false); // tab window: can it demote?
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [tabSignals, setTabSignals] = useState({}); // tabId -> refresh counter
  const layoutCtxRef = useRef(null); // context whose layout is loaded
  const pendingLayoutRef = useRef(null); // layout dispatched but not rendered yet
  const preserveLayoutRef = useRef(false);
  const fGroup = focusedGroup(workspace);
  const fTab = focusedTab(workspace);
  const fView = fTab?.view || null;

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
  const [navExpanded, setNavExpanded] = useState({
    workloads: true,
    network: false,
    storage: false,
    config: false,
    argocd: false,
    argocdSettings: false,
    flux: false,
    fluxSources: false,
    fluxNotifications: false,
    fluxImage: false,
    flagger: false,
    security: false,
    costs: false
  });
  const [showAzure, setShowAzure] = useState(false);
  // When the failing cluster uses kubelogin/azurecli, the fix is `az login` (the
  // browser OAuth flow doesn't refresh the CLI token that kubelogin reads), so
  // the auth-error "Sign in to Azure" opens the modal in CLI-login mode.
  const [azureMode, setAzureMode] = useState(null); // null | 'az'
  const openAzure = (mode) => { setAzureMode(mode === 'az' ? 'az' : null); setShowAzure(true); };
  const [showAws, setShowAws] = useState(false);
  const [showGke, setShowGke] = useState(false);
  const [prefSection, setPrefSection] = useState('general');
  const [agentOpen, setAgentOpen] = useState(false);

  // Preferences opens as a tab: reuse an open one, or add one to the focused group.
  const openPreferences = (section) => {
    setPrefSection(section);
    if (TAB_WINDOW) { dispatch({ type: 'navigate', view: 'preferences' }); return; }
    const existing = workspaceRef.current.groups.flatMap((g) => g.tabs).find((t) => t.view === 'preferences');
    if (existing) dispatch({ type: 'activateTab', tabId: existing.id });
    else dispatch({ type: 'openTab', view: 'preferences' });
  };

  const authOk = authState.ok;
  const currentContext = configStatus.currentContext || '';

  // Restore the remembered layout whenever the cluster changes (or on first
  // load). A cluster with no saved layout starts on Overview, unless the switch
  // asked to keep the current pages, which then reset their namespaces.
  useEffect(() => {
    if (TAB_WINDOW) return; // a tab window shows its one tab, whatever the cluster
    if (!configStatus.loaded || !currentContext || layoutCtxRef.current === currentContext) return;
    const saved = loadLayout(currentContext);
    let next = saved;
    if (!next && preserveLayoutRef.current && layoutCtxRef.current) {
      next = deserialize(serialize({
        ...workspaceRef.current,
        groups: workspaceRef.current.groups.map((g) => ({ ...g, tabs: g.tabs.map((t) => ({ ...t, namespaces: ['all'], search: '' })) })),
      }));
    }
    preserveLayoutRef.current = false;
    layoutCtxRef.current = currentContext;
    pendingLayoutRef.current = next || initialWorkspace();
    dispatch({ type: 'reset', state: pendingLayoutRef.current });
  }, [configStatus.loaded, currentContext]);

  // Remember the layout. Skip the render where the previous cluster's layout
  // is still on screen, so it never overwrites the one being restored.
  useEffect(() => {
    // A tab window remembers just its tab, so a restart can reopen it.
    if (TAB_WINDOW) { const t = focusedTab(workspace); if (t) saveWindowTab(TAB_WINDOW.wid, t); return; }
    if (pendingLayoutRef.current) {
      if (workspace !== pendingLayoutRef.current) return;
      pendingLayoutRef.current = null;
    }
    if (layoutCtxRef.current && layoutCtxRef.current === currentContext) saveLayout(currentContext, workspace);
  }, [workspace, currentContext]);

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

  // Detect optional integrations (Argo CD, Flux CD, Flagger) on the active cluster.
  useEffect(() => {
    if (!authOk) { setArgocdInstalled(false); setFluxInstalled(false); setFlaggerInstalled(false); return; }
    let live = true;
    setArgocdInstalled(false);
    setFluxInstalled(false);
    setFlaggerInstalled(false);
    axios.get('/api/argocd/status')
      .then(({ data }) => { if (live) setArgocdInstalled(!!data.installed); })
      .catch(() => { if (live) setArgocdInstalled(false); });
    axios.get('/api/flux/status')
      .then(({ data }) => { if (live) setFluxInstalled(!!data.installed); })
      .catch(() => { if (live) setFluxInstalled(false); });
    axios.get('/api/flagger/status')
      .then(({ data }) => { if (live) setFlaggerInstalled(!!data.installed); })
      .catch(() => { if (live) setFlaggerInstalled(false); });
    return () => { live = false; };
  }, [authOk, configStatus.currentContext]);

  // ---- shared resource data, keyed by cluster + namespace scope ----
  const namespaceScope = (sel) => (sel.includes('all') || sel.length === 0
    ? namespaces.filter((name) => name !== 'all').slice().sort()
    : sel.filter((name) => name !== 'all').slice().sort());
  const dataKeyFor = (type, sel) => JSON.stringify({
    context: currentContext,
    scope: CLUSTER_SCOPED.includes(type) ? 'cluster' : namespaceScope(sel),
  });
  const reqKeyFor = (type, sel) => `${dataKeyFor(type, sel)}|${type}`;
  const dataFor = (tab) => resourceSnapshots[dataKeyFor(tab.view, tab.namespaces)] || {};
  const loadingFor = (tab) => {
    if (!usesSharedResources(tab.view) || hasCachedFor(tab.view, dataFor(tab))) return false;
    const req = reqKeyFor(tab.view, tab.namespaces);
    return !!loadingReqs[req] || (authOk && !attemptedReqs[req]);
  };

  // Merge part of a snapshot in, keeping the 8 most recent keys.
  const mergeSnapshot = (key, partial) => {
    setResourceSnapshots((previous) => {
      const base = previous[key] || {};
      const recent = Object.entries(previous).filter(([cachedKey]) => cachedKey !== key);
      return Object.fromEntries([...recent.slice(-7), [key, { ...base, ...partial }]]);
    });
  };

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
  // The layout effect above then restores that cluster's tabs.
  const switchContext = async (ctx, { preservePage = false } = {}) => {
    if (!ctx || ctx === configStatus.currentContext) return;
    try {
      const resp = await fetch('/api/config/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextName: ctx }),
      });
      if (!resp.ok) throw new Error('switch failed');
      preserveLayoutRef.current = preservePage;
      tabChannelRef.current?.postMessage({ type: 'context', ctx });
      setConfigStatus((current) => ({ ...current, currentContext: ctx }));
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
        toast.info(`Switched to ${ctx}, but the cluster isn't reachable`, { title: 'Cluster' });
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

  // The tabs on screen right now: the selected tab of every group.
  const visibleTabs = workspace.groups.map(activeTab).filter(Boolean);

  // Global refresh: reload the shared data behind every visible tab, and bump
  // the refresh signal of each visible tab so self-fetching pages reload too.
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
      const tabs = workspaceRef.current.groups.map(activeTab).filter(Boolean);
      if (!namespaceListChanged) {
        const seen = new Set();
        await Promise.all(tabs.filter((t) => usesSharedResources(t.view)).map((t) => {
          const req = reqKeyFor(t.view, t.namespaces);
          if (seen.has(req)) return null;
          seen.add(req);
          return fetchResourcesFor(t.view, t.namespaces, { silent });
        }));
      }
      setTabSignals((current) => {
        const next = { ...current };
        for (const t of tabs) {
          const pk = pageKeyFor(t.view);
          if (pk !== 'overview' && pk !== 'preferences') next[t.id] = (next[t.id] || 0) + 1;
        }
        return next;
      });
    } finally {
      refreshInFlight.current = false;
      // brief spin so the action is perceptible even when the fetch is instant
      if (!silent) setTimeout(() => setRefreshing(false), 400);
    }
  };
  handleRefreshRef.current = handleRefresh;

  // ---- tabs in windows ----
  // The main window answers "are you there?" pings from tab windows and takes
  // demoted tabs back; tab windows track whether the main window is open (the
  // Demote button only shows then) and follow cluster switches made there.
  useEffect(() => {
    const ch = tabWindowChannel();
    if (!ch) return undefined;
    tabChannelRef.current = ch;
    if (TAB_WINDOW) {
      let lastPong = 0;
      ch.onmessage = ({ data = {} }) => {
        if (data.type === 'pong') { lastPong = Date.now(); setMainWindowOpen(true); }
        if (data.type === 'context') { fetchConfigStatus(); fetchNamespaces({ silent: true }); }
      };
      const ping = () => {
        ch.postMessage({ type: 'ping' });
        setTimeout(() => setMainWindowOpen(Date.now() - lastPong < 3000), 800);
      };
      ping();
      const id = setInterval(ping, 2000);
      return () => { clearInterval(id); ch.close(); };
    }
    ch.onmessage = ({ data = {} }) => {
      if (data.type === 'ping') ch.postMessage({ type: 'pong' });
      if (data.type === 'demote' && data.tab?.view) {
        dispatch({ type: 'openTab', view: data.tab.view, sub: data.tab.sub, namespaces: data.tab.namespaces, search: data.tab.search });
        window.focus();
      }
    };
    return () => ch.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Move a tab out of the main view into its own window.
  const moveTabToWindow = (tab, at) => {
    if (openTabWindow(tab, { ctx: currentContext, at })) dispatch({ type: 'closeTab', tabId: tab.id, keepOne: true });
  };
  // Open a page straight into a window (sidebar "Open in new window").
  const openViewInWindow = (view, sub) => openTabWindow({ view, sub: sub || {}, namespaces: ['all'], search: '' }, { ctx: currentContext });
  // Tab window: hand the tab back to the main window and close this one.
  const demoteTab = () => {
    const t = focusedTab(workspaceRef.current);
    if (!t || !tabChannelRef.current) return;
    tabChannelRef.current.postMessage({ type: 'demote', tab: portableTab(t) });
    forgetWindowTab(TAB_WINDOW.wid);
    window.close();
  };

  // ---- keyboard: ⌘K palette, ⌘\ split, ⇧⌘\ next group ----
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPaletteOpen((o) => !o); return; }
      if (TAB_WINDOW) return; // one tab per window: nothing to split
      // Not inside a pod shell: there Ctrl+\ is the terminal's quit signal.
      if (mod && e.code === 'Backslash' && !e.target?.closest?.('.xterm')) {
        e.preventDefault();
        if (e.shiftKey) dispatch({ type: 'focusNext' });
        else dispatch({ type: 'split' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ⌘W / Ctrl+W (desktop app). The Window → Close menu item asks the page
  // first: close the focused empty group, else the focused tab; when only one
  // tab is left, let the window close as before.
  const closeFocused = useCallback(() => {
    const ws = workspaceRef.current;
    const g = focusedGroup(ws);
    if (!g) return false;
    if (!g.tabs.length) {
      if (ws.groups.length > 1) { dispatch({ type: 'closeGroup', groupId: g.id }); return true; }
      return false;
    }
    if (g.tabs.length > 1 || ws.groups.length > 1) { dispatch({ type: 'closeTab', tabId: g.active }); return true; }
    return false;
  }, []);
  useEffect(() => window.k8sight?.onCloseRequest?.(closeFocused), [closeFocused]);

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

  // A namespace was deleted: drop it from every tab that was filtered to it.
  const handleNamespaceDeleted = (deletedNamespace) => {
    for (const g of workspaceRef.current.groups) {
      for (const t of g.tabs) {
        if (t.namespaces.includes('all') || !t.namespaces.includes(deletedNamespace)) continue;
        const remaining = t.namespaces.filter((namespace) => namespace !== deletedNamespace);
        dispatch({ type: 'patchTab', tabId: t.id, patch: { namespaces: remaining.length ? remaining : ['all'] } });
      }
    }
    fetchNamespaces({ silent: true });
  };

  const resolveNamespaces = (sel, availableNamespaces = namespaces) => {
    if (sel.includes('all') || sel.length === 0) {
      return availableNamespaces.filter(n => n !== 'all');
    }
    return sel;
  };

  // Fetch one page's shared data (a resource list or the Overview dashboard)
  // for one namespace selection. Several tabs can share a request.
  const fetchResourcesFor = async (type, selected, { silent = false } = {}) => {
    const dataKey = dataKeyFor(type, selected);
    const req = `${dataKey}|${type}`;
    const fetchId = (fetchIdsRef.current[req] = (fetchIdsRef.current[req] || 0) + 1);
    const stale = () => fetchId !== fetchIdsRef.current[req];
    const current = snapshotsRef.current[dataKey] || {};
    const cached = hasCachedFor(type, current);
    setAttemptedReqs((a) => (a[req] ? a : { ...a, [req]: true }));
    // A silent (background) fetch keeps whatever is already on screen — the list
    // is replaced once the data is in, so there's no "Loading pods…" flash.
    setLoadingReqs((l) => ({ ...l, [req]: !silent || !cached }));
    try {
      // Cluster-scoped types (PersistentVolumes, StorageClasses) are a single call
      if (CLUSTER_SCOPED.includes(type)) {
        const res = await axios.get('/api/storage');
        if (stale()) return;
        mergeSnapshot(dataKey, res.data);
        return;
      }
      // Events have their own paginated view and do not use the resource cache.
      if (type === 'events') return;

      const namespacesToFetch = resolveNamespaces(selected);
      const CONCURRENCY = 12;

      const fetchNamespaceData = async (pathSuffix = '') => {
        const result = {};
        const failedNamespaces = new Set();
        const fetchAllNamespaces = selected.includes('all') || selected.length === 0;
        if (fetchAllNamespaces) {
          try {
            const response = await axios.get(`/api/resources/all${pathSuffix}`);
            if (stale()) return { result, failedNamespaces };
            return { result: response.data || {}, failedNamespaces };
          } catch {
            // Some RBAC setups allow namespace-scoped lists but deny the
            // cluster-wide list verb. Fall back to the existing per-namespace
            // requests so those users still see every namespace they can read.
          }
        }
        let cursor = 0;
        const worker = async () => {
          while (cursor < namespacesToFetch.length) {
            if (stale()) return;
            const ns = namespacesToFetch[cursor++];
            try {
              const response = await axios.get(`/api/resources/${encodeURIComponent(ns)}${pathSuffix}`);
              if (stale()) return;
              Object.keys(response.data).forEach((key) => {
                const value = response.data[key];
                if (Array.isArray(value)) {
                  if (!Array.isArray(result[key])) result[key] = [];
                  result[key].push(...value);
                } else if (value && typeof value === 'object') {
                  if (!result[key] || typeof result[key] !== 'object' || Array.isArray(result[key])) result[key] = {};
                  Object.assign(result[key], value);
                } else {
                  result[key] = value;
                }
              });
            } catch {
              if (silent) failedNamespaces.add(ns);
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, namespacesToFetch.length) }, worker)
        );
        return { result, failedNamespaces };
      };

      if (type === 'overview') {
        const { result: overviewData, failedNamespaces } = await fetchNamespaceData('/overview');
        if (stale()) return;
        const overviewByNamespace = { ...(overviewData.overviewByNamespace || {}) };
        if (silent && failedNamespaces.size) {
          const previous = current.overviewByNamespace || {};
          for (const ns of failedNamespaces) {
            if (previous[ns]) overviewByNamespace[ns] = previous[ns];
          }
        }
        mergeSnapshot(dataKey, { overviewByNamespace });
        return;
      }

      const resourceKey = pluralKey(type);
      const { result: resourceData, failedNamespaces } = await fetchNamespaceData(type === 'pod' ? '/pods' : `/${resourceKey}`);
      if (stale()) return;
      let rows = resourceData[resourceKey] || [];
      if (silent && failedNamespaces.size) {
        rows = [
          ...rows,
          ...(current[resourceKey] || []).filter((row) => failedNamespaces.has(row.namespace))
        ];
      }
      mergeSnapshot(dataKey, { [resourceKey]: rows });
    } catch (err) {
      if (!stale() && !silent) toast.error('Failed to fetch resources', { title: 'Resources' });
    } finally {
      if (!stale()) setLoadingReqs((l) => ({ ...l, [req]: false }));
    }
  };

  // Fetch the data behind each tab as it comes on screen (quietly when a copy
  // is already cached). Tabs showing the same data share one request.
  const visibleReqs = visibleTabs
    .filter((t) => usesSharedResources(t.view))
    .map((t) => ({ type: t.view, namespaces: t.namespaces, req: reqKeyFor(t.view, t.namespaces) }));
  const visibleReqSig = visibleReqs.map((r) => r.req).sort().join('\n');
  const shownReqsRef = useRef(new Set());
  useEffect(() => {
    if (!authOk || !namespaces.length) { shownReqsRef.current = new Set(); return; }
    const now = new Set();
    for (const r of visibleReqs) {
      if (now.has(r.req)) continue;
      now.add(r.req);
      if (!shownReqsRef.current.has(r.req)) {
        fetchResourcesFor(r.type, r.namespaces, { silent: hasCachedFor(r.type, snapshotsRef.current[dataKeyFor(r.type, r.namespaces)] || {}) });
      }
    }
    shownReqsRef.current = now;
  }, [visibleReqSig, authOk, namespaces]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve a tab's pending cross-link target once its list has loaded.
  useEffect(() => {
    for (const g of workspace.groups) {
      for (const tab of g.tabs) {
        const target = tab.focusResource;
        if (!target) continue;
        const list = dataFor(tab)[pluralKey(target.type)] || [];
        // Normalise namespace so cluster-scoped targets (StorageClass, PV, …) match
        // whether the row/target uses '' or undefined.
        const match = list.find(r => r.name === target.name && (r.namespace || '') === (target.namespace || ''));
        if (match) dispatch({ type: 'patchTab', tabId: tab.id, patch: { selected: { type: target.type, resource: match }, focusResource: null } });
      }
    }
  }, [resourceSnapshots, workspace]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cross-navigation used by tables, drawers and the topology/nodes views —
  // always inside the tab the link was clicked in.
  const navFor = (tab) => ({
    toNamespace: (ns) => {
      if (!ns) return;
      const view = STANDALONE_RESOURCE_TYPES.includes(tab.view) || tab.view === 'overview' ? 'pod' : tab.view;
      dispatch({ type: 'navigate', tabId: tab.id, view, namespaces: [ns] });
    },
    toNode: (name) => {
      if (!name) return;
      dispatch({ type: 'navigate', tabId: tab.id, view: 'nodes', focusNode: name });
    },
    toResource: ({ type, namespace, name }) => {
      if (!type || !name) return;
      dispatch({ type: 'navigate', tabId: tab.id, view: type, namespaces: [namespace || 'all'], focusResource: { type, namespace, name } });
    },
    // Open the Pods view scoped to a workload. We rarely have the exact pod name
    // (e.g. Trivy attributes CVEs to the owning ReplicaSet), so filter the pod
    // list by the owner name — pods are named `<owner>-<hash>` and match.
    toPods: (namespace, nameFilter) => {
      dispatch({ type: 'navigate', tabId: tab.id, view: 'pod', namespaces: [namespace || 'all'], search: nameFilter || '' });
    }
  });

  const toggleNavSection = (section) => {
    setNavExpanded(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  // ---- sidebar / palette → workspace ----
  // A click shows the page in the focused tab; middle-click or ⌘/Ctrl-click
  // opens it in a new tab in the group beside.
  const showView = (view, sub) => dispatch({ type: 'navigate', view, sub });
  const openBeside = (view, sub) => dispatch({ type: 'openTab', view, sub, beside: true });

  // ---- gate: what to render before the app is ready ----
  const showConfigModal = configChecked && !serverUnreachable && (!configStatus.loaded || forceConfigModal);
  const checkingAuth = configStatus.loaded && !forceConfigModal && (!authState.checked || autoRecovering);
  const showAuthError = configStatus.loaded && !forceConfigModal && authState.checked && !authState.ok && !autoRecovering;

  // One page of one tab. `visible` is true when this page is on screen.
  const renderTab = (tab, viewType, { visible, focused, signal }) => {
    const refreshSignal = signal;
    const go = (view, extra = {}) => dispatch({ type: 'navigate', tabId: tab.id, view, ...extra });
    const setSub = (view) => (v) => go(view, { sub: { [view]: v } });
    const subView = (view) => (tab.view === view ? subOf(tab, view) : null);
    const nav = navFor(tab);
    const allResources = dataFor(tab);
    if (viewType === 'overview') {
      return (
        <Overview
          allResources={allResources}
          selectedNamespaces={tab.namespaces}
          namespaces={namespaces}
          onNamespaceSelect={(ns) => dispatch({ type: 'patchTab', tabId: tab.id, patch: { namespaces: ns } })}
          loading={loadingFor(tab)}
          onResourceTypeChange={(v) => go(v)}
        />
      );
    }
    if (viewType === 'cluster') return <Cluster configStatus={configStatus} onSwitchContext={switchContext} refreshSignal={refreshSignal} />;
    if (viewType === 'nodes') return <Nodes active={visible} focusNode={tab.focusNode} onFocusHandled={() => dispatch({ type: 'patchTab', tabId: tab.id, patch: { focusNode: null } })} onNavigate={nav} refreshSignal={refreshSignal} />;
    if (viewType === 'namespaces') return <Namespaces onNavigate={nav} onNamespaceDeleted={handleNamespaceDeleted} refreshSignal={refreshSignal} />;
    if (viewType === 'topology') return <Topology namespaces={namespaces} refreshSignal={refreshSignal} />;
    if (viewType === 'helm') return <Helm refreshSignal={refreshSignal} />;
    if (viewType === 'customResources') return <CustomResourceDetail selection={tab.sub?.customResources || null} onSelect={(sel) => go('customResources', { sub: { customResources: sel } })} refreshSignal={refreshSignal} />;
    if (viewType === 'accessControl') return <AccessControl onNavigate={nav} refreshSignal={refreshSignal} />;
    if (viewType === 'security') return <SecurityCenter namespaces={namespaces} onNavigate={nav} view={subView('security')} onViewChange={setSub('security')} refreshSignal={refreshSignal} />;
    if (viewType === 'costs') return <CostsCenter key={`costs-${configStatus.currentContext}`} context={configStatus.currentContext} refreshSignal={refreshSignal} view={subView('costs')} onViewChange={setSub('costs')} />;
    if (viewType === 'argocd') return <ArgoCD onNavigate={nav} refreshSignal={refreshSignal} view={subView('argocd')} onViewChange={setSub('argocd')} />;
    if (viewType === 'flagger') return <Flagger onNavigate={nav} refreshSignal={refreshSignal} view={subView('flagger')} />;
    if (viewType === 'flux') return <Flux onNavigate={nav} refreshSignal={refreshSignal} view={subView('flux')} onViewChange={setSub('flux')} />;
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
          prodMark={prodMark}
          active={visible && focused}
          onClose={() => dispatch(TAB_WINDOW ? { type: 'back' } : { type: 'closeTab', tabId: tab.id, keepOne: true })}
        />
      );
    }
    if (viewType === 'resources') {
      const base = allResources[pluralKey(tab.view)] || [];
      const q = (tab.search || '').toLowerCase();
      const filtered = q
        ? base.filter(r => r.name.toLowerCase().includes(q) || (r.namespace || '').toLowerCase().includes(q))
        : base;
      return (
        <ResourceViewer
          active={visible}
          resourceType={tab.view}
          resources={filtered}
          selectedResource={tab.selected?.type === tab.view ? tab.selected.resource : null}
          onSelectResource={(resource) => dispatch({ type: 'patchTab', tabId: tab.id, patch: { selected: resource ? { type: tab.view, resource } : null } })}
          selectedNamespaces={tab.namespaces}
          namespaces={namespaces}
          onNamespaceChange={(ns) => dispatch({ type: 'patchTab', tabId: tab.id, patch: { namespaces: ns } })}
          loading={loadingFor(tab)}
          hasCachedData={hasCachedFor(tab.view, allResources)}
          searchQuery={tab.search || ''}
          onSearchChange={(value) => dispatch({ type: 'patchTab', tabId: tab.id, patch: { search: value } })}
          totalCount={base.length}
          onResourceTypeChange={(v) => go(v)}
          onNavigate={nav}
          onRefresh={handleRefresh}
          refreshSignal={refreshSignal}
        />
      );
    }
    return null;
  };

  const currentIsProd = authOk && prodMark.isProd(configStatus.currentContext);
  const tabHistory = fTab?.history || { stack: [], idx: 0 };
  useEffect(() => {
    if (TAB_WINDOW && fTab) document.title = `${tabLabel(fTab)} · ${currentContext || 'k8sight'}`;
  }, [fTab?.view, fTab?.sub, currentContext]); // eslint-disable-line react-hooks/exhaustive-deps

  // Commands the palette offers for the layout itself.
  const viewCommands = [
    { id: 'view:split', label: 'View: Split', icon: 'splitView', hint: '⌘\\', disabled: workspace.groups.length >= MAX_GROUPS, run: () => dispatch({ type: 'split' }) },
    { id: 'view:focus-next', label: 'View: Focus next group', icon: 'arrowRight', hint: '⇧⌘\\', run: () => dispatch({ type: 'focusNext' }) },
    { id: 'view:new-tab', label: 'View: New tab', icon: 'plus', run: () => dispatch({ type: 'openTab', view: 'overview' }) },
    { id: 'view:close-tab', label: 'View: Close tab', icon: 'close', run: () => { if (fGroup?.active) dispatch({ type: 'closeTab', tabId: fGroup.active, keepOne: true }); } },
    ...(fGroup && !fGroup.tabs.length && workspace.groups.length > 1
      ? [{ id: 'view:close-group', label: 'View: Close group', icon: 'close', run: () => dispatch({ type: 'closeGroup', groupId: fGroup.id }) }]
      : []),
  ];

  return (
    <div className="app-shell">
      {currentIsProd && prodMark.prefs.edge && (
        <div
          className="prod-edge"
          aria-hidden="true"
          style={{ '--prod-color': prodMark.prefs.color, '--prod-thick': `${prodMark.prefs.edgeThickness}px` }}
        />
      )}
      {authOk && (
        <TopBar
          onBack={() => dispatch({ type: 'back' })}
          onForward={() => dispatch({ type: 'forward' })}
          canBack={tabHistory.idx > 0}
          canForward={tabHistory.idx < tabHistory.stack.length - 1}
          onNotifications={() => showView('events')}
          onConfigureAi={() => openPreferences('external-tools')}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          compact={!!TAB_WINDOW}
          title={TAB_WINDOW && fTab ? (
            <div className="tabwin-title">
              <span className="tabwin-title-label">{tabLabel(fTab)}</span>
              {currentContext && <span className="tabwin-title-ctx">{currentContext}</span>}
            </div>
          ) : null}
          actions={TAB_WINDOW && mainWindowOpen ? (
            <button type="button" className="tabwin-demote" onClick={demoteTab} title="Put this tab back in the main window and close this window">
              <Icon name="demoteTab" size={14} /> Demote as Tab
            </button>
          ) : null}
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

      {authOk && !TAB_WINDOW && (
        <Assistant
          context={{
            view: fView,
            namespaces: fTab?.namespaces || ['all'],
            selected: fTab?.selected && fTab.selected.type === fView
              ? { type: fView, namespace: fTab.selected.resource.namespace, name: fTab.selected.resource.name }
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


      {authOk && TAB_WINDOW ? (
        <div className="layout-main">
          <div className="content-col">
            <Workspace
              state={workspace}
              dispatch={dispatch}
              renderTab={renderTab}
              pageKeyFor={pageKeyFor}
              tabSignals={tabSignals}
              contextKey={currentContext}
              hideStrip
            />
          </div>
        </div>
      ) : authOk ? (
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
            resourceType={fView}
            onResourceTypeChange={(v) => showView(v)}
            onOpenBeside={openBeside}
            onOpenInWindow={openViewInWindow}
            navExpanded={navExpanded}
            onToggleNav={toggleNavSection}
            crSelection={fView === 'customResources' ? fTab?.sub?.customResources || null : null}
            onSelectCustomResource={(sel) => showView('customResources', { customResources: sel })}
            argocdInstalled={argocdInstalled}
            argoView={fView === 'argocd' ? subOf(fTab, 'argocd') : null}
            onSelectArgoView={(v) => showView('argocd', { argocd: v })}
            fluxInstalled={fluxInstalled}
            fluxView={fView === 'flux' ? subOf(fTab, 'flux') : null}
            onSelectFluxView={(v) => showView('flux', { flux: v })}
            flaggerInstalled={flaggerInstalled}
            flaggerView={fView === 'flagger' ? subOf(fTab, 'flagger') : null}
            onSelectFlaggerView={(v) => showView('flagger', { flagger: v })}
            securityView={fView === 'security' ? subOf(fTab, 'security') : null}
            onSelectSecurityView={(v) => showView('security', { security: v })}
            costsView={fView === 'costs' ? subOf(fTab, 'costs') : null}
            onSelectCostsView={(v) => showView('costs', { costs: v })}
            onAddAzure={() => openAzure()}
            onAddAws={() => setShowAws(true)}
            onAddGke={() => setShowGke(true)}
            onAddLocal={() => setForceConfigModal(true)}
            onOpenPreferences={() => openPreferences('general')}
            prodMark={prodMark}
            currentIsProd={currentIsProd}
          />

          <div className="content-col">
            <Workspace
              state={workspace}
              dispatch={dispatch}
              renderTab={renderTab}
              pageKeyFor={pageKeyFor}
              tabSignals={tabSignals}
              contextKey={currentContext}
              onNewTab={(groupId) => dispatch({ type: 'openTab', groupId, view: 'overview' })}
              onOpenInWindow={moveTabToWindow}
            />
            <AgentPanel context={{ currentContext: configStatus.currentContext }} onOpenChange={setAgentOpen} />
          </div>
        </div>
      ) : !configChecked ? (
        <div className="loading-state">
          <Loader label="Loading kubeconfig…" size={36} />
        </div>
      ) : checkingAuth ? (
        <div className="loading-state">
          <Loader label={autoRecovering ? 'Reconnecting and refreshing credentials…' : 'Checking cluster authentication…'} size={36} />
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
          onNavigate={(k) => showView(k)}
          contexts={TAB_WINDOW ? [] : configStatus.contexts || []}
          currentContext={configStatus.currentContext}
          onSwitchContext={switchContext}
          onOpenPreferences={() => openPreferences('general')}
          onRefresh={handleRefresh}
          onSetTheme={setTheme}
          prodMark={TAB_WINDOW ? null : prodMark}
          extraCommands={TAB_WINDOW ? [] : viewCommands}
        />
      )}
    </div>
  );
}

export default App;
