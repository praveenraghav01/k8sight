import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';
import ContextMenu from './ContextMenu';
import { useToast } from './Toast';
import { askLabel } from '../aiConfig';
import useClickOutside from '../hooks/useClickOutside';

// ArgoCD dashboard — auto-detected when the applications.argoproj.io CRD exists.
// Sub-views: Dashboard, Applications, Application Sets, Projects. Applications
// have sync/health status, a detail drawer (properties, source, destination,
// resource tree, history), Sync (with options) / Refresh / Delete, and an
// "Ask AI → Summarize" action that hands the resource to the assistant.

const formatAge = (t) => {
  if (!t) return '-';
  const s = Math.floor((new Date() - new Date(t)) / 1000);
  if (s < 0) return '-';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const SYNC_CLASS = { Synced: 'ok', OutOfSync: 'warn', Unknown: 'muted' };
const HEALTH_CLASS = { Healthy: 'ok', Progressing: 'info', Degraded: 'bad', Missing: 'warn', Suspended: 'purple', Unknown: 'muted' };
const SYNC_ORDER = ['Synced', 'OutOfSync', 'Unknown'];
const HEALTH_ORDER = ['Healthy', 'Progressing', 'Degraded', 'Missing', 'Suspended', 'Unknown'];
const shortRepo = (url) => (url ? url.replace(/^https?:\/\//, '').replace(/\.git$/, '') : '');
const Badge = ({ kind, cls, children }) => <span className={`argo-badge ${cls}`}>{children}</span>;

export default function ArgoCD({ refreshSignal = 0, view, onViewChange }) {
  const toast = useToast();
  const [tab, setTab] = useState(view || 'dashboard');
  // Keep the internal view and the sidebar sub-menu in sync in both directions.
  const selectTab = useCallback((t) => { setTab(t); onViewChange?.(t); }, [onViewChange]);
  useEffect(() => { if (view && view !== tab) setTab(view); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const [apps, setApps] = useState([]);
  const [projects, setProjects] = useState([]);
  const [appSets, setAppSets] = useState([]);
  const [appSetsAvailable, setAppSetsAvailable] = useState(true);
  const [repositories, setRepositories] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [argoUrl, setArgoUrl] = useState('');
  const [selRows, setSelRows] = useState(new Set());   // bulk selection (ns/name)
  const [bulk, setBulk] = useState(null);              // { type, apps, prune, hard, busy }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState('');
  const [syncFilter, setSyncFilter] = useState(null);
  const [healthFilter, setHealthFilter] = useState(null);

  // Topology-style navigator: pick a namespace, then an application to open it.
  const [navNs, setNavNs] = useState('');

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [drawerTab, setDrawerTab] = useState('summary');
  const argoDrawerRef = useRef(null);
  useClickOutside(argoDrawerRef, () => setSelected(null), !!selected && tab !== 'view');

  const [menu, setMenu] = useState(null);      // { x, y, app }
  const [syncDialog, setSyncDialog] = useState(null); // { app, prune, dryRun, applyOnly, force, replace, busy }
  const [confirmDel, setConfirmDel] = useState(null); // { app, cascade, busy }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const [a, p, s, r, c, st] = await Promise.all([
        axios.get('/api/argocd/applications'),
        axios.get('/api/argocd/projects').catch(() => ({ data: { projects: [] } })),
        axios.get('/api/argocd/applicationsets').catch(() => ({ data: { available: false, applicationSets: [] } })),
        axios.get('/api/argocd/repositories').catch(() => ({ data: { repositories: [] } })),
        axios.get('/api/argocd/clusters').catch(() => ({ data: { clusters: [] } })),
        axios.get('/api/argocd/status').catch(() => ({ data: {} })),
      ]);
      setApps(a.data.applications || []);
      setError(a.data.error || null);
      setProjects(p.data.projects || []);
      setAppSets(s.data.applicationSets || []);
      setAppSetsAvailable(s.data.available !== false);
      setRepositories(r.data.repositories || []);
      setClusters(c.data.clusters || []);
      setArgoUrl(st.data.url || '');
    } catch (e) {
      if (!silent) setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Global refresh re-fetches in place (no remount → drawer/tab/selection kept)
  // and silently: no loader over the app list, the rows just get new values.
  const didMount = React.useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    load({ silent: true });
  }, [refreshSignal, load]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let live = true; setDetailLoading(true); setDetail(null); setDrawerTab('summary');
    axios.get(`/api/argocd/application/${encodeURIComponent(selected.namespace)}/${encodeURIComponent(selected.name)}`)
      .then(({ data }) => { if (live) setDetail(data); })
      .catch((e) => { if (live) setDetail({ error: e.response?.data?.error || e.message }); })
      .finally(() => { if (live) setDetailLoading(false); });
    return () => { live = false; };
  }, [selected]);

  const counts = useMemo(() => {
    const sync = {}, health = {};
    for (const a of apps) { sync[a.syncStatus] = (sync[a.syncStatus] || 0) + 1; health[a.healthStatus] = (health[a.healthStatus] || 0) + 1; }
    const healthy = apps.filter((a) => a.syncStatus === 'Synced' && a.healthStatus === 'Healthy').length;
    return { sync, health, healthy };
  }, [apps]);

  const attention = useMemo(
    () => apps.filter((a) => a.syncStatus !== 'Synced' || (a.healthStatus !== 'Healthy' && a.healthStatus !== 'Unknown')),
    [apps]);

  const recent = useMemo(
    () => apps.filter((a) => a.lastOperation?.finishedAt)
      .sort((a, b) => new Date(b.lastOperation.finishedAt) - new Date(a.lastOperation.finishedAt))
      .slice(0, 12),
    [apps]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return apps.filter((a) =>
      (!q || a.name.toLowerCase().includes(q) || (a.project || '').toLowerCase().includes(q) || (a.destNamespace || '').toLowerCase().includes(q))
      && (!syncFilter || a.syncStatus === syncFilter)
      && (!healthFilter || a.healthStatus === healthFilter));
  }, [apps, search, syncFilter, healthFilter]);

  const isSel = (a) => selected && selected.name === a.name && selected.namespace === a.namespace;

  // Navigator dropdowns: namespaces that hold Applications, and the apps in the
  // currently-picked namespace (sorted for the second dropdown).
  const navNamespaces = useMemo(
    () => [...new Set(apps.map((a) => a.namespace))].sort((a, b) => a.localeCompare(b)),
    [apps]);
  const navApps = useMemo(
    () => apps.filter((a) => !navNs || a.namespace === navNs).sort((a, b) => a.name.localeCompare(b.name)),
    [apps, navNs]);
  useEffect(() => {
    if ((!navNs || !navNamespaces.includes(navNs)) && navNamespaces.length) {
      setNavNs(navNamespaces.includes('argocd') ? 'argocd' : navNamespaces[0]);
    }
  }, [navNamespaces, navNs]);

  // ---- actions ----
  const doSync = async (app, options = {}) => {
    setBusy(true);
    try {
      const { data } = await axios.post(`/api/argocd/application/${encodeURIComponent(app.namespace)}/${encodeURIComponent(app.name)}/sync`, options);
      toast.success(data.message || 'Sync triggered', { title: app.name });
      setTimeout(() => load({ silent: true }), 1000);
    } catch (e) { toast.error(e.response?.data?.error || e.message, { title: 'Sync' }); }
    finally { setBusy(false); }
  };
  const doRefresh = async (app, hard = false) => {
    setBusy(true);
    try {
      const { data } = await axios.post(`/api/argocd/application/${encodeURIComponent(app.namespace)}/${encodeURIComponent(app.name)}/refresh`, { hard });
      toast.success(data.message || `${hard ? 'Hard refresh' : 'Refresh'} requested`, { title: app.name });
      setTimeout(() => load({ silent: true }), 1000);
    } catch (e) { toast.error(e.response?.data?.error || e.message, { title: 'Refresh' }); }
    finally { setBusy(false); }
  };

  const selectedApps = () => apps.filter((a) => selRows.has(`${a.namespace}/${a.name}`));

  // Open the Sync/Refresh multi-select dialog over a pool of apps. Sync starts
  // with nothing selected (deliberate opt-in); Refresh starts with all selected.
  const openBulk = (type, pool, preselectAll = false) => {
    const keys = pool.map((a) => `${a.namespace}/${a.name}`);
    const sel = preselectAll || type === 'refresh' ? new Set(keys) : new Set();
    setBulk({ type, apps: pool, sel, filter: '', prune: false, hard: false });
  };
  const toggleBulkSel = (k) => setBulk((b) => {
    const sel = new Set(b.sel); sel.has(k) ? sel.delete(k) : sel.add(k); return { ...b, sel };
  });

  const runBulk = async () => {
    if (!bulk) return;
    setBulk((b) => ({ ...b, busy: true }));
    const targets = bulk.apps.filter((a) => bulk.sel.has(`${a.namespace}/${a.name}`));
    if (!targets.length) { setBulk(null); return; }
    let ok = 0, failed = 0, lastErr = '';
    for (const app of targets) {
      try {
        if (bulk.type === 'sync') await axios.post(`/api/argocd/application/${encodeURIComponent(app.namespace)}/${encodeURIComponent(app.name)}/sync`, { prune: bulk.prune });
        else await axios.post(`/api/argocd/application/${encodeURIComponent(app.namespace)}/${encodeURIComponent(app.name)}/refresh`, { hard: bulk.hard });
        ok++;
      } catch (e) { failed++; lastErr = e.response?.data?.error || e.message; }
    }
    const verb = bulk.type === 'sync' ? 'Synced' : 'Refreshed';
    if (!failed) toast.success(`${verb} ${ok} application${ok === 1 ? '' : 's'}`, { title: 'ArgoCD' });
    else toast.error(`${verb} ${ok}, ${failed} failed — ${lastErr}`, { title: 'ArgoCD' });
    setBulk(null); setSelRows(new Set()); setTimeout(() => load({ silent: true }), 1000);
  };
  const doDelete = async () => {
    if (!confirmDel) return;
    setConfirmDel((c) => ({ ...c, busy: true }));
    const { app, cascade } = confirmDel;
    try {
      const { data } = await axios.delete(`/api/argocd/application/${encodeURIComponent(app.namespace)}/${encodeURIComponent(app.name)}`, { params: { cascade } });
      toast.success(data.message || `${app.name} deleted`, { title: 'Delete' });
      setConfirmDel(null);
      if (isSel(app)) setSelected(null);
      setTimeout(() => load({ silent: true }), 800);
    } catch (e) { toast.error(e.response?.data?.error || e.message, { title: 'Delete' }); setConfirmDel((c) => ({ ...c, busy: false })); }
  };

  // Ask AI → Summarize: fetch the app's condition and hand it to the assistant.
  const summarize = async (app) => {
    toast.info(`Summarizing ${app.name}…`, { title: askLabel() });
    let d = detail && isSel(app) ? detail : null;
    if (!d) {
      try { d = (await axios.get(`/api/argocd/application/${encodeURIComponent(app.namespace)}/${encodeURIComponent(app.name)}`)).data; }
      catch { d = { app }; }
    }
    const a = d.app || app;
    const bad = (d.resources || []).filter((r) => r.syncStatus !== 'Synced' || (r.healthStatus && r.healthStatus !== 'Healthy'));
    const lines = [
      `Analyze the current condition of the ArgoCD Application "${a.name}" (namespace ${a.namespace}, project ${a.project}).`,
      `Sync status: ${a.syncStatus}. Health status: ${a.healthStatus}${a.healthMessage ? ` — ${a.healthMessage}` : ''}.`,
      a.repoURL ? `Source: ${a.repoURL}${a.path ? ` (path ${a.path})` : ''} @ ${a.targetRevision || 'HEAD'}.` : '',
      `Destination: cluster ${a.destName || a.destServer || '?'}, namespace ${a.destNamespace || '?'}.`,
      bad.length ? `Resources needing attention:\n${bad.slice(0, 25).map((r) => `- ${r.kind}/${r.name}: sync=${r.syncStatus} health=${r.healthStatus || 'n/a'}${r.healthMessage ? ` (${r.healthMessage})` : ''}`).join('\n')}` : 'All managed resources are Synced and Healthy.',
      (d.conditions || []).length ? `Conditions:\n${d.conditions.map((c) => `- ${c.type}: ${c.message}`).join('\n')}` : '',
      'Explain what is wrong (if anything), the likely root cause, and concrete steps to fix it.',
    ].filter(Boolean);
    window.dispatchEvent(new CustomEvent('assistant:ask', { detail: { prompt: lines.join('\n') } }));
  };

  const menuItems = (app) => [
    { icon: 'details', label: 'Show details', onClick: () => setSelected(app) },
    { icon: 'sparkles', label: `Summarize (${askLabel()})`, onClick: () => summarize(app) },
    { icon: 'argocd', label: 'Sync', onClick: () => setSyncDialog({ app, prune: false, dryRun: false, applyOnly: false, force: false, replace: false }) },
    { icon: 'refresh', label: 'Refresh', onClick: () => doRefresh(app, false) },
    { icon: 'refresh', label: 'Hard refresh', onClick: () => doRefresh(app, true) },
    { icon: 'delete', label: 'Delete', danger: true, onClick: () => setConfirmDel({ app, cascade: true }) },
  ];

  const rowKey = (a) => `${a.namespace}/${a.name}`;
  const toggleRow = (a) => setSelRows((s) => { const n = new Set(s); const k = rowKey(a); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allFilteredSelected = filtered.length > 0 && filtered.every((a) => selRows.has(rowKey(a)));
  const toggleAllFiltered = () => setSelRows((s) => {
    if (allFilteredSelected) { const n = new Set(s); filtered.forEach((a) => n.delete(rowKey(a))); return n; }
    return new Set([...s, ...filtered.map(rowKey)]);
  });

  // ---------------------------------------------------------------- render
  const tabs = [
    { key: 'dashboard', label: 'Dashboard', icon: 'overview' },
    { key: 'applications', label: 'Applications', icon: 'argocd', count: apps.length },
    { key: 'view', label: 'View', icon: 'topology' },
    { key: 'appsets', label: 'Application Sets', icon: 'box', count: appSets.length },
    { key: 'projects', label: 'Projects', icon: 'accessControl', count: projects.length },
    { key: 'repositories', label: 'Repositories', icon: 'git', count: repositories.length },
    { key: 'clusters', label: 'Clusters', icon: 'cluster', count: clusters.length },
  ];

  return (
    <div className="resource-viewer argo-view">
      <div className="resource-tabs argo-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={`resource-tab ${tab === t.key ? 'active' : ''}`} onClick={() => selectTab(t.key)}>
            <Icon name={t.icon} size={15} /> {t.label}
            {typeof t.count === 'number' && <span className="argo-tab-count">{t.count}</span>}
          </button>
        ))}
        {argoUrl && (
          <a className="argo-open-ui" href={argoUrl} target="_blank" rel="noreferrer" title="Open the Argo CD web UI">
            <Icon name="externalLink" size={13} /> Open Argo CD UI
          </a>
        )}
      </div>

      {loading && apps.length === 0 ? <div className="resource-table-wrapper"><Loader label="Loading ArgoCD…" /></div>
        : error && apps.length === 0 && tab !== 'projects' && tab !== 'appsets' ? <div className="loading-indicator" style={{ color: 'var(--red)', padding: 24 }}>{error}</div>
        : (
          <>
            {tab === 'dashboard' && (
              <div className="argo-dashboard">
                <div className="argo-statusbar">
                  {SYNC_ORDER.filter((s) => counts.sync[s]).map((s) => (
                    <span key={s} className={`argo-stat ${SYNC_CLASS[s]}`}><b>{counts.sync[s]}</b> {s}</span>
                  ))}
                  <span className="argo-statusbar-sep" />
                  {HEALTH_ORDER.filter((h) => counts.health[h]).map((h) => (
                    <span key={h} className={`argo-stat ${HEALTH_CLASS[h]}`}><b>{counts.health[h]}</b> {h}</span>
                  ))}
                </div>

                <div className="argo-cards">
                  <div className="argo-card">
                    <div className="argo-card-head"><Icon name="argocd" size={16} /> Applications</div>
                    <div className="argo-card-big">{counts.healthy}<span>/{apps.length}</span></div>
                    <div className="argo-card-sub">{counts.healthy === apps.length ? 'all healthy' : `${apps.length - counts.healthy} need attention`}</div>
                    {apps.length > 0 && (
                      <div className="argo-card-actions" style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                        <button className="bulk-btn" disabled={busy} onClick={() => openBulk('sync', apps)}>
                          <Icon name="argocd" size={14} /> Sync
                        </button>
                        <button className="bulk-btn" disabled={busy} onClick={() => openBulk('refresh', apps)}>
                          <Icon name="refresh" size={14} /> Refresh
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="argo-card">
                    <div className="argo-card-head"><Icon name="box" size={16} /> Application Sets</div>
                    <div className="argo-card-big">{appSets.length}</div>
                    <div className="argo-card-sub">{appSetsAvailable ? 'total' : 'controller not installed'}</div>
                  </div>
                  <div className="argo-card">
                    <div className="argo-card-head"><Icon name="accessControl" size={16} /> Projects</div>
                    <div className="argo-card-big">{projects.length}</div>
                    <div className="argo-card-sub">total</div>
                  </div>
                </div>

                <div className="argo-panel">
                  <div className="argo-panel-title">Needs attention {attention.length > 0 && <span className="argo-panel-count">{attention.length}</span>}</div>
                  {attention.length === 0 ? (
                    <div className="argo-panel-empty"><Icon name="check" size={15} /> All applications are synced and healthy.</div>
                  ) : (
                    <div className="argo-mini-table">
                      {attention.slice(0, 12).map((a) => (
                        <div key={`${a.namespace}/${a.name}`} className="argo-mini-row" onClick={() => { selectTab('applications'); setSelected(a); }}>
                          <span className="argo-mini-name">{a.name}</span>
                          <span className="argo-mini-ns">{a.destNamespace || a.namespace}</span>
                          <Badge cls={SYNC_CLASS[a.syncStatus] || 'muted'}>{a.syncStatus}</Badge>
                          <Badge cls={HEALTH_CLASS[a.healthStatus] || 'muted'}>{a.healthStatus}</Badge>
                        </div>
                      ))}
                      {attention.length > 12 && <div className="argo-mini-more" onClick={() => selectTab('applications')}>+{attention.length - 12} more…</div>}
                    </div>
                  )}
                </div>

                <div className="argo-panel">
                  <div className="argo-panel-title">Recent activity</div>
                  {recent.length === 0 ? <div className="argo-panel-empty">No recent sync operations.</div> : (
                    <div className="argo-mini-table">
                      {recent.map((a) => (
                        <div key={`${a.namespace}/${a.name}`} className="argo-mini-row" onClick={() => { selectTab('applications'); setSelected(a); }}>
                          <span className={`argo-dot ${a.lastOperation.phase === 'Succeeded' ? 'ok' : a.lastOperation.phase === 'Failed' || a.lastOperation.phase === 'Error' ? 'bad' : 'info'}`} />
                          <span className="argo-mini-name">{a.name}</span>
                          <span className="argo-mini-msg">{a.lastOperation.phase} · {a.lastOperation.message || 'sync operation'}</span>
                          <span className="argo-mini-age">{formatAge(a.lastOperation.finishedAt)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'applications' && (
              <>
                <div className="resource-header argo-sub-header">
                  <div><span className="resource-count">{filtered.length}{filtered.length !== apps.length ? ` of ${apps.length}` : ''} applications</span></div>
                  <div className="resource-controls">
                    <div className="search-box">
                      <input className="search-input" placeholder="Search applications…" value={search} onChange={(e) => setSearch(e.target.value)} />
                      <span className="search-icon"><Icon name="search" size={15} /></span>
                    </div>
                  </div>
                </div>
                <div className="argo-filterbar">
                  <span className="argo-filter-label">Sync</span>
                  {SYNC_ORDER.filter((s) => counts.sync[s]).map((s) => (
                    <button key={s} className={`argo-chip ${SYNC_CLASS[s]} ${syncFilter === s ? 'active' : ''}`} onClick={() => setSyncFilter((f) => (f === s ? null : s))}>{s}<b>{counts.sync[s]}</b></button>
                  ))}
                  <span className="argo-filter-label">Health</span>
                  {HEALTH_ORDER.filter((h) => counts.health[h]).map((h) => (
                    <button key={h} className={`argo-chip ${HEALTH_CLASS[h]} ${healthFilter === h ? 'active' : ''}`} onClick={() => setHealthFilter((f) => (f === h ? null : h))}>{h}<b>{counts.health[h]}</b></button>
                  ))}
                </div>
                <div className="resource-table-wrapper">
                  {filtered.length === 0 ? <div className="loading-indicator">No applications match.</div> : (
                    <table className="resource-table">
                      <thead><tr>
                        <th className="argo-check"><input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} /></th>
                        <th>Name</th><th>Project</th><th>Sync</th><th>Health</th><th>Destination</th><th>Repository</th><th>Revision</th><th>Age</th><th></th>
                      </tr></thead>
                      <tbody>
                        {filtered.map((a) => (
                          <tr key={`${a.namespace}/${a.name}`} className={`resource-table-row ${isSel(a) ? 'active' : ''} ${selRows.has(rowKey(a)) ? 'checked' : ''}`}
                            onClick={() => setSelected(a)}
                            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, app: a }); }}>
                            <td className="argo-check" onClick={(e) => { e.stopPropagation(); toggleRow(a); }}><input type="checkbox" checked={selRows.has(rowKey(a))} onChange={() => {}} /></td>
                            <td><span className="resource-name-cell">{a.name}</span></td>
                            <td>{a.project}</td>
                            <td><Badge cls={SYNC_CLASS[a.syncStatus] || 'muted'}>{a.syncStatus}</Badge></td>
                            <td><Badge cls={HEALTH_CLASS[a.healthStatus] || 'muted'}>{a.healthStatus}</Badge></td>
                            <td>{a.destNamespace || a.destName || '-'}</td>
                            <td className="argo-repo" title={a.repoURL}>{a.multiSource ? '(multi-source)' : shortRepo(a.repoURL) || '-'}</td>
                            <td><span style={{ fontFamily: 'var(--mono)', fontSize: '11.5px' }}>{a.revision || '-'}</span></td>
                            <td>{formatAge(a.createdAt)}</td>
                            <td className="actions" onClick={(e) => { e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, app: a }); }}><Icon name="more" size={16} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            )}

            {tab === 'view' && (
              <div className="argo-view-tab">
                <div className="argo-navbar" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 16px', borderBottom: '1px solid var(--border,#30363d)', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-secondary,#8b949e)' }}>Namespace</span>
                    <ArgoSelect
                      width={190} icon="namespace" placeholder="Namespace…"
                      value={navNs}
                      options={navNamespaces.map((ns) => ({ value: ns, label: ns }))}
                      onChange={(v) => setNavNs(v)}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-secondary,#8b949e)' }}>Application</span>
                    <ArgoSelect
                      width={280} icon="argocd" placeholder="Select an application…"
                      value={selected && selected.namespace === navNs ? selected.name : ''}
                      options={navApps.map((a) => ({ value: a.name, label: a.name }))}
                      onChange={(v) => setSelected(navApps.find((a) => a.name === v) || null)}
                    />
                  </div>
                  {selected && detail && !detail.error && (
                    <span style={{ fontSize: 12, color: 'var(--text-secondary,#8b949e)' }}>{(detail.resources || []).length} managed resource{(detail.resources || []).length === 1 ? '' : 's'}</span>
                  )}
                </div>

                {!selected ? (
                  <div className="argo-view-placeholder">Pick a namespace and an application to see its resource graph.</div>
                ) : detailLoading ? (
                  <div className="argo-view-placeholder"><Loader label={`Loading ${selected.name}…`} /></div>
                ) : detail?.error ? (
                  <div className="argo-view-placeholder" style={{ color: 'var(--red)' }}>{detail.error}</div>
                ) : detail ? (
                  <>
                    <AppSummaryBar detail={detail} />
                    <AppResourceGraph app={detail.app} resources={detail.resources || []} />
                  </>
                ) : null}
              </div>
            )}

            {tab === 'appsets' && (
              <div className="resource-table-wrapper">
                {!appSetsAvailable ? <div className="loading-indicator">The ApplicationSet controller isn't installed on this cluster.</div>
                  : appSets.length === 0 ? <div className="loading-indicator">No ApplicationSets.</div> : (
                    <table className="resource-table">
                      <thead><tr><th>Name</th><th>Namespace</th><th>Generators</th><th>Project</th><th>Dest. Namespace</th><th>Age</th></tr></thead>
                      <tbody>
                        {appSets.map((s) => (
                          <tr key={`${s.namespace}/${s.name}`} className="resource-table-row">
                            <td><span className="resource-name-cell">{s.name}</span></td>
                            <td>{s.namespace}</td>
                            <td>{s.generators.join(', ') || '-'}</td>
                            <td>{s.project || '-'}</td>
                            <td>{s.destinationNamespace || '-'}</td>
                            <td>{formatAge(s.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              </div>
            )}

            {tab === 'projects' && (
              <div className="resource-table-wrapper">
                {projects.length === 0 ? <div className="loading-indicator">No AppProjects.</div> : (
                  <table className="resource-table">
                    <thead><tr><th>Name</th><th>Description</th><th>Source Repos</th><th>Destinations</th><th>Roles</th><th>Age</th></tr></thead>
                    <tbody>
                      {projects.map((p) => (
                        <tr key={p.name} className="resource-table-row">
                          <td><span className="resource-name-cell">{p.name}</span></td>
                          <td>{p.description || '-'}</td>
                          <td className="argo-repo" title={p.sourceRepos.join(', ')}>{p.sourceRepos.join(', ') || '-'}</td>
                          <td>{p.destinations.length ? p.destinations.slice(0, 2).join(', ') + (p.destinations.length > 2 ? ` +${p.destinations.length - 2}` : '') : '-'}</td>
                          <td>{p.roles.length || '-'}</td>
                          <td>{formatAge(p.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {tab === 'repositories' && (
              <div className="resource-table-wrapper">
                {repositories.length === 0 ? <div className="loading-indicator">No repositories.</div> : (
                  <table className="resource-table">
                    <thead><tr><th>Repository</th><th>Type</th><th>Applications</th><th>Source</th></tr></thead>
                    <tbody>
                      {repositories.map((r, i) => (
                        <tr key={i} className="resource-table-row">
                          <td><a className="xlink" href={r.url.startsWith('http') ? r.url : `https://${r.url}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{r.url}</a></td>
                          <td><span className="argo-badge muted">{r.type}</span></td>
                          <td>{r.appCount || (r.source === 'secret' ? '—' : 0)}</td>
                          <td className="drawer-dim">{r.source === 'secret' ? 'configured' : 'from applications'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {tab === 'clusters' && (
              <div className="resource-table-wrapper">
                {clusters.length === 0 ? <div className="loading-indicator">No clusters registered.</div> : (
                  <table className="resource-table">
                    <thead><tr><th>Name</th><th>Server</th></tr></thead>
                    <tbody>
                      {clusters.map((c, i) => (
                        <tr key={i} className="resource-table-row">
                          <td><span className="resource-name-cell">{c.name || '(in-cluster)'}</span></td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: '11.5px' }}>{c.server}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}

      {/* bulk actions bar for selected applications */}
      {tab === 'applications' && selRows.size > 0 && (
        <div className="bulk-bar">
          <span className="bulk-count">{selRows.size} selected</span>
          <button className="bulk-btn" onClick={() => openBulk('sync', selectedApps(), true)}><Icon name="argocd" size={14} /> Sync</button>
          <button className="bulk-btn" onClick={() => openBulk('refresh', selectedApps(), true)}><Icon name="refresh" size={14} /> Refresh</button>
          <button className="bulk-btn ghost" onClick={() => setSelRows(new Set())} title="Clear selection"><Icon name="close" size={14} /></button>
        </div>
      )}

      {/* -------- application detail drawer (hidden on the graph View tab) -------- */}
      {selected && tab !== 'view' && (
        <div className="resource-drawer argo-drawer" ref={argoDrawerRef}>
          <div className="drawer-header">
            <div className="drawer-title">
              <div className="drawer-title-icon blue"><Icon name="argocd" size={18} /></div>
              <div className="drawer-title-text">
                <span className="drawer-kind">Application · {selected.project}</span>
                <span className="drawer-name" title={selected.name}>{selected.name}</span>
              </div>
            </div>
            <div className="drawer-actions">
              <button className="drawer-action-btn" title={`Summarize (${askLabel()})`} onClick={() => summarize(selected)}><Icon name="sparkles" size={16} /></button>
              <button className="drawer-action-btn" title="Refresh" disabled={busy} onClick={() => doRefresh(selected)}><Icon name="refresh" size={16} /></button>
              <button className="drawer-action-btn argo-sync" title="Sync" disabled={busy} onClick={() => setSyncDialog({ app: selected, prune: false, dryRun: false, applyOnly: false, force: false, replace: false })}><Icon name="argocd" size={16} /></button>
              <button className="drawer-action-btn danger" title="Delete" disabled={busy} onClick={() => setConfirmDel({ app: selected, cascade: true })}><Icon name="delete" size={16} /></button>
              <button className="drawer-action-btn" title="Close" onClick={() => setSelected(null)}><Icon name="close" size={17} /></button>
            </div>
          </div>

          <div className="argo-drawer-tabs">
            {['summary', 'tree', 'history'].map((t) => (
              <button key={t} className={`argo-dtab ${drawerTab === t ? 'active' : ''}`} onClick={() => setDrawerTab(t)}>
                {t === 'summary' ? 'Summary' : t === 'tree' ? 'Resources' : 'History'}
              </button>
            ))}
          </div>

          <div className="drawer-body">
            {detailLoading ? <Loader label="Loading…" inline />
              : detail?.error ? <div className="drawer-error">{detail.error}</div>
              : detail ? (
                <>
                  {drawerTab === 'summary' && <SummaryTab detail={detail} attentionResources={(detail.resources || []).filter((r) => r.syncStatus !== 'Synced' || (r.healthStatus && r.healthStatus !== 'Healthy'))} />}
                  {drawerTab === 'tree' && <TreeTab app={detail.app} resources={detail.resources || []} />}
                  {drawerTab === 'history' && <HistoryTab history={detail.history || []} onSyncRevision={(rev) => setSyncDialog({ app: selected, prune: false, dryRun: false, applyOnly: false, force: false, replace: false, revision: rev })} />}
                </>
              ) : null}
          </div>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.app)} onClose={() => setMenu(null)} />}

      {syncDialog && (
        <div className="action-modal-backdrop" onClick={() => !busy && setSyncDialog(null)}>
          <div className="action-modal argo-sync-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="action-modal-title"><Icon name="argocd" size={16} /> Sync {syncDialog.app.name}</h3>
            {syncDialog.confirmStep === 2 ? (
              <p className="action-modal-body">
                <b>Confirm sync</b> — apply the target Git state to <b>{syncDialog.app.name}</b>
                {syncDialog.revision ? <> at revision <b>{syncDialog.revision}</b></> : null}
                {syncDialog.prune ? <>, and <b>prune</b> resources no longer in Git</> : null}
                {syncDialog.dryRun ? ' (dry run — nothing is applied)' : ''}?
              </p>
            ) : (
              <>
                {syncDialog.revision && <p className="action-modal-body">Syncing to revision <b>{syncDialog.revision}</b>.</p>}
                <div className="argo-sync-opts">
                  {[['prune', 'Prune', 'Delete resources no longer in Git'], ['dryRun', 'Dry run', 'Preview only, apply nothing'], ['applyOnly', 'Apply only', 'Skip sync hooks'], ['force', 'Force', 'kubectl apply --force'], ['replace', 'Replace', 'Use replace instead of apply']].map(([k, label, hint]) => (
                    <label key={k} className="argo-opt">
                      <input type="checkbox" checked={!!syncDialog[k]} onChange={(e) => setSyncDialog((d) => ({ ...d, [k]: e.target.checked }))} />
                      <span className="argo-opt-label">{label}</span>
                      <span className="argo-opt-hint">{hint}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
            <div className="action-modal-actions">
              {syncDialog.confirmStep === 2 ? (
                <>
                  <button className="action-modal-btn" onClick={() => setSyncDialog((d) => ({ ...d, confirmStep: 1 }))} disabled={busy}>Back</button>
                  <button className="action-modal-btn primary" disabled={busy} onClick={async () => { const d = syncDialog; setSyncDialog(null); await doSync(d.app, { prune: d.prune, dryRun: d.dryRun, applyOnly: d.applyOnly, force: d.force, replace: d.replace, revision: d.revision }); }}>
                    {busy ? 'Syncing…' : 'Yes, sync'}
                  </button>
                </>
              ) : (
                <>
                  <button className="action-modal-btn" onClick={() => setSyncDialog(null)} disabled={busy}>Cancel</button>
                  <button className="action-modal-btn primary" disabled={busy} onClick={() => setSyncDialog((d) => ({ ...d, confirmStep: 2 }))}>Synchronize</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmDel && (
        <div className="action-modal-backdrop" onClick={() => !confirmDel.busy && setConfirmDel(null)}>
          <div className="action-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="action-modal-title danger"><Icon name="delete" size={16} /> Delete application</h3>
            {confirmDel.confirmStep === 2 ? (
              <p className="action-modal-body">
                <b>Are you absolutely sure?</b> This permanently deletes <b>{confirmDel.app.name}</b>
                {confirmDel.cascade ? <> and <b>all resources it manages</b></> : <> (its managed resources are left in place)</>} and cannot be undone.
              </p>
            ) : (
              <>
                <p className="action-modal-body">Delete <b>{confirmDel.app.name}</b>?</p>
                <label className="argo-opt" style={{ marginBottom: 16 }}>
                  <input type="checkbox" checked={confirmDel.cascade} onChange={(e) => setConfirmDel((c) => ({ ...c, cascade: e.target.checked }))} />
                  <span className="argo-opt-label">Cascade</span>
                  <span className="argo-opt-hint">also delete the resources this app manages (uncheck to orphan them)</span>
                </label>
              </>
            )}
            <div className="action-modal-actions">
              {confirmDel.confirmStep === 2 ? (
                <>
                  <button className="action-modal-btn" onClick={() => setConfirmDel((c) => ({ ...c, confirmStep: 1 }))} disabled={confirmDel.busy}>Back</button>
                  <button className="action-modal-btn primary danger" onClick={doDelete} disabled={confirmDel.busy}>{confirmDel.busy ? 'Deleting…' : 'Yes, delete'}</button>
                </>
              ) : (
                <>
                  <button className="action-modal-btn" onClick={() => setConfirmDel(null)} disabled={confirmDel.busy}>Cancel</button>
                  <button className="action-modal-btn primary danger" onClick={() => setConfirmDel((c) => ({ ...c, confirmStep: 2 }))} disabled={confirmDel.busy}>Delete</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {bulk && (() => {
        const key = (a) => `${a.namespace}/${a.name}`;
        const q = (bulk.filter || '').toLowerCase();
        const visible = bulk.apps.filter((a) => !q || a.name.toLowerCase().includes(q));
        const allKeys = bulk.apps.map(key);
        const outKeys = bulk.apps.filter((a) => a.syncStatus !== 'Synced').map(key);
        const eqSel = (arr) => arr.length === bulk.sel.size && arr.every((k) => bulk.sel.has(k));
        const activePreset = bulk.sel.size === 0 ? 'none' : eqSel(allKeys) ? 'all' : (outKeys.length && eqSel(outKeys)) ? 'out of sync' : null;
        const applyPreset = (p) => setBulk((b) => ({
          ...b, sel: p === 'all' ? new Set(allKeys) : p === 'out of sync' ? new Set(outKeys) : new Set(),
        }));
        const syncColor = (s) => s === 'Synced' ? 'var(--green,#3fb950)' : s === 'OutOfSync' ? 'var(--yellow,#d29922)' : 'var(--text-secondary,#8b949e)';
        const healthColor = (h) => h === 'Healthy' ? 'var(--green,#3fb950)' : (h === 'Degraded' || h === 'Missing') ? 'var(--red,#f85149)' : h === 'Progressing' ? 'var(--blue,#58a6ff)' : 'var(--text-secondary,#8b949e)';
        const presetStyle = (p) => ({
          padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
          border: `1px solid ${activePreset === p ? 'var(--accent,#4c8bf5)' : 'var(--border,#30363d)'}`,
          background: 'transparent', color: activePreset === p ? 'var(--accent,#4c8bf5)' : 'var(--text,inherit)',
        });
        const n = bulk.sel.size;
        return (
          <div className="action-modal-backdrop" onClick={() => !bulk.busy && setBulk(null)}>
            <div className="action-modal" onClick={(e) => e.stopPropagation()} style={{ width: 620, maxWidth: '92vw' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <h3 className="action-modal-title" style={{ margin: 0 }}>{bulk.type === 'sync' ? 'Sync app(s)' : 'Refresh app(s)'}</h3>
                <button onClick={() => !bulk.busy && setBulk(null)} title="Close"
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary,#8b949e)', cursor: 'pointer', padding: 4, display: 'flex' }}>
                  <Icon name="close" size={16} />
                </button>
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input value={bulk.filter} onChange={(e) => setBulk((b) => ({ ...b, filter: e.target.value }))}
                  placeholder="Filter by name…"
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border,#30363d)', background: 'var(--bg,#0d1117)', color: 'var(--text,inherit)', fontSize: 13 }} />
                <button style={presetStyle('all')} onClick={() => applyPreset('all')}>all</button>
                <button style={presetStyle('out of sync')} onClick={() => applyPreset('out of sync')}>out of sync</button>
                <button style={presetStyle('none')} onClick={() => applyPreset('none')}>none</button>
              </div>

              <div style={{ maxHeight: 300, overflowY: 'auto', borderTop: '1px solid var(--border,#30363d)', borderBottom: '1px solid var(--border,#30363d)' }}>
                {visible.length === 0 ? (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary,#8b949e)', fontSize: 13 }}>No applications match your filter.</div>
                ) : visible.map((a) => {
                  const k = key(a); const checked = bulk.sel.has(k);
                  return (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 6px', cursor: 'pointer', fontSize: 13.5 }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleBulkSel(k)} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      <span style={{ color: syncColor(a.syncStatus), fontWeight: 600, minWidth: 84, textAlign: 'right' }}>{a.syncStatus}</span>
                      <span style={{ color: healthColor(a.healthStatus), fontWeight: 600, minWidth: 76 }}>{a.healthStatus}</span>
                    </label>
                  );
                })}
              </div>

              <div style={{ margin: '16px 2px' }}>
                {bulk.type === 'sync' ? (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                    <input type="checkbox" checked={bulk.prune} onChange={(e) => setBulk((b) => ({ ...b, prune: e.target.checked }))} />
                    Prune resources not in Git
                  </label>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 13 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!bulk.hard} onChange={() => setBulk((b) => ({ ...b, hard: false }))} /> normal
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                      <input type="checkbox" checked={bulk.hard} onChange={() => setBulk((b) => ({ ...b, hard: true }))} /> hard
                    </label>
                    <span title="Hard refresh also clears Argo CD's cached manifests" style={{ display: 'flex', color: 'var(--text-secondary,#8b949e)' }}>
                      <Icon name="details" size={15} />
                    </span>
                  </div>
                )}
              </div>

              <div className="action-modal-actions">
                <button className="action-modal-btn" onClick={() => setBulk(null)} disabled={bulk.busy}>Cancel</button>
                <button className="action-modal-btn primary" disabled={bulk.busy || n === 0} onClick={runBulk}>
                  {bulk.busy ? 'Working…' : `${bulk.type === 'sync' ? 'Sync' : 'Refresh'} ${n} app${n === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ---------- drawer tab: Summary (properties + source + destination + needs attention) ----------
function SummaryTab({ detail, attentionResources }) {
  const a = detail.app;
  return (
    <>
      <div className="drawer-section">
        <div className="argo-status-row">
          <Badge cls={SYNC_CLASS[a.syncStatus] || 'muted'}>{a.syncStatus}</Badge>
          <Badge cls={HEALTH_CLASS[a.healthStatus] || 'muted'}>{a.healthStatus}</Badge>
          {a.autoSync && <span className="argo-badge muted">auto-sync</span>}
        </div>
        {a.healthMessage && <div className="argo-msg">{a.healthMessage}</div>}
      </div>

      {attentionResources.length > 0 && (
        <div className="drawer-section">
          <div className="drawer-section-title">Needs attention ({attentionResources.length})</div>
          <div className="argo-res-list">
            {attentionResources.map((r, i) => (
              <div key={i} className="argo-res">
                <span className={`argo-dot ${SYNC_CLASS[r.syncStatus] || 'muted'}`} title={`Sync: ${r.syncStatus}`} />
                <span className="argo-res-kind">{r.kind}</span>
                <span className="argo-res-name" title={`${r.namespace ? r.namespace + '/' : ''}${r.name}`}>{r.name}</span>
                {r.healthStatus && <span className={`argo-badge sm ${HEALTH_CLASS[r.healthStatus] || 'muted'}`}>{r.healthStatus}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="drawer-section">
        <div className="drawer-section-title">Properties</div>
        <div className="argo-kv">
          <div><span>Created</span><code>{a.createdAt ? new Date(a.createdAt).toLocaleString() : '-'}</code></div>
          <div><span>Reconciled</span><code>{a.reconciledAt ? new Date(a.reconciledAt).toLocaleString() : '-'}</code></div>
          {a.controlledBy && <div><span>App&nbsp;Set</span><code>{a.controlledBy}</code></div>}
          {a.finalizers?.length > 0 && <div><span>Finalizers</span><code>{a.finalizers.join(', ')}</code></div>}
          {a.images?.length > 0 && <div><span>Images</span><code>{a.images.join('\n')}</code></div>}
        </div>
      </div>

      <div className="drawer-section">
        <div className="drawer-section-title">Source</div>
        {(detail.sources || []).map((s, i) => (
          <div key={i} className="argo-kv">
            <div><span>Repo</span>{s.repoURL ? <a className="xlink argo-kv-link" href={s.repoURL.startsWith('http') ? s.repoURL : `https://${s.repoURL}`} target="_blank" rel="noreferrer">{s.repoURL}</a> : <code>-</code>}</div>
            {(s.path || s.chart) && <div><span>{s.chart ? 'Chart' : 'Path'}</span><code>{s.path || s.chart}</code></div>}
            <div><span>Target</span><code>{s.targetRevision || 'HEAD'}</code></div>
          </div>
        ))}
      </div>

      <div className="drawer-section">
        <div className="drawer-section-title">Destination</div>
        <div className="argo-kv">
          <div><span>Cluster</span><code>{detail.destination.name || detail.destination.server || '-'}</code></div>
          <div><span>Namespace</span><code>{detail.destination.namespace || '-'}</code></div>
        </div>
      </div>

      <div className="drawer-section">
        <div className="drawer-section-title">Sync Policy</div>
        {detail.syncPolicy?.automated ? (
          <div className="argo-status-row">
            <span className="argo-badge info">automated</span>
            {detail.syncPolicy.automated.prune && <span className="argo-badge muted">prune</span>}
            {detail.syncPolicy.automated.selfHeal && <span className="argo-badge muted">self-heal</span>}
          </div>
        ) : <div className="argo-msg">Manual — syncs are triggered by hand.</div>}
        {detail.syncPolicy?.syncOptions?.length > 0 && (
          <div className="argo-status-row" style={{ marginTop: 8 }}>
            {detail.syncPolicy.syncOptions.map((o, i) => <span key={i} className="argo-badge muted">{o}</span>)}
          </div>
        )}
      </div>

      {detail.operationState && (
        <div className="drawer-section">
          <div className="drawer-section-title">Last Operation</div>
          <div className="argo-kv">
            <div><span>Phase</span><code>{detail.operationState.phase || '-'}</code></div>
            {detail.operationState.revision && <div><span>Revision</span><code>{detail.operationState.revision}</code></div>}
            {detail.operationState.finishedAt && <div><span>Finished</span><code>{new Date(detail.operationState.finishedAt).toLocaleString()}</code></div>}
          </div>
          {detail.operationState.message && <div className="argo-msg">{detail.operationState.message}</div>}
        </div>
      )}

      {detail.conditions?.length > 0 && (
        <div className="drawer-section">
          <div className="drawer-section-title">Conditions</div>
          {detail.conditions.map((c, i) => <div key={i} className="argo-msg"><b>{c.type}:</b> {c.message}</div>)}
        </div>
      )}

      {detail.events?.length > 0 && (
        <div className="drawer-section">
          <div className="drawer-section-title">Events ({detail.events.length})</div>
          <div className="argo-events">
            {detail.events.map((e, i) => (
              <div key={i} className={`argo-event ${e.type === 'Warning' ? 'warn' : ''}`}>
                <span className="argo-event-reason">{e.reason}</span>
                <span className="argo-event-msg">{e.message}</span>
                <span className="argo-event-age">{formatAge(e.lastTimestamp)}{e.count > 1 ? ` ×${e.count}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---------- drawer tab: Resources tree ----------
function TreeTab({ app, resources }) {
  return (
    <div className="drawer-section">
      <div className="argo-tree">
        <div className="argo-tree-root">
          <Icon name="argocd" size={14} />
          <span className="argo-tree-app">{app.name}</span>
          <Badge cls={SYNC_CLASS[app.syncStatus] || 'muted'}>{app.syncStatus}</Badge>
          <Badge cls={HEALTH_CLASS[app.healthStatus] || 'muted'}>{app.healthStatus}</Badge>
        </div>
        <div className="argo-tree-children">
          {resources.length === 0 && <div className="argo-msg">No resources reported.</div>}
          {resources.map((r, i) => (
            <div key={i} className="argo-tree-node">
              <span className="argo-tree-branch" />
              <span className={`argo-dot ${SYNC_CLASS[r.syncStatus] || 'muted'}`} title={`Sync: ${r.syncStatus}`} />
              <span className="argo-res-kind">{r.kind}</span>
              <span className="argo-res-name" title={`${r.namespace ? r.namespace + '/' : ''}${r.name}`}>{r.name}</span>
              {r.healthStatus && <span className={`argo-badge sm ${HEALTH_CLASS[r.healthStatus] || 'muted'}`}>{r.healthStatus}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- drawer tab: History (with sync-to-revision rollback) ----------
function HistoryTab({ history, onSyncRevision }) {
  if (!history.length) return <div className="drawer-section"><div className="argo-msg">No deployment history.</div></div>;
  return (
    <div className="drawer-section">
      <div className="drawer-section-title">Deployment history ({history.length})</div>
      <div className="argo-history">
        {history.map((h, i) => (
          <div key={h.id ?? i} className="argo-hist-row">
            <div className="argo-hist-main">
              <span className="argo-hist-rev" title={h.revision}>{(h.revision || '').slice(0, 12) || '(unknown)'}</span>
              <span className="argo-hist-time">{h.deployedAt ? new Date(h.deployedAt).toLocaleString() : ''}</span>
            </div>
            {i !== 0 && h.revision && (
              <button className="argo-hist-rollback" title="Sync to this revision" onClick={() => onSyncRevision(h.revision)}>
                <Icon name="refresh" size={12} /> Roll back
              </button>
            )}
            {i === 0 && <span className="argo-badge sm ok">current</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- searchable dropdown (native <select> is unusable with 100s of apps
//            and closes on the view's periodic re-render; this stays open) -------
function ArgoSelect({ value, options, placeholder, onChange, icon, width, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const searchRef = useRef(null);
  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, []);
  useEffect(() => { if (open) setTimeout(() => searchRef.current?.focus(), 0); else setQuery(''); }, [open]);
  const q = query.toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const current = options.find((o) => o.value === value);
  return (
    <div className="ctx-select" ref={ref} style={{ width }}>
      <button className={`ctx-trigger ${open ? 'open' : ''}`} disabled={disabled} onClick={() => !disabled && setOpen(!open)} title={current?.label || placeholder}>
        {icon && <Icon name={icon} size={15} className="ctx-trigger-icon" />}
        <span className="ctx-trigger-label" style={{ color: current ? undefined : 'var(--text-muted)' }}>{current?.label || placeholder}</span>
        <span className="ctx-trigger-arrow"><Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} strokeWidth={2.2} /></span>
      </button>
      {open && (
        <div className="ctx-dropdown">
          <div className="ctx-search">
            <Icon name="search" size={14} />
            <input ref={searchRef} type="text" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="ctx-list">
            {filtered.length === 0 && <div className="ctx-empty">No matches</div>}
            {filtered.map((o) => (
              <button key={o.value} className={`ctx-option ${o.value === value ? 'active' : ''}`} onClick={() => { setOpen(false); onChange(o.value); }} title={o.label}>
                <span className="ctx-option-check">{o.value === value && <Icon name="check" size={14} strokeWidth={2.4} />}</span>
                <span className="ctx-option-label">{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- View tab: interactive resource graph for a single Application ----------
// ArgoCD-style "Application Details Tree": white cards with a kind glyph, the
// short kind label, the resource name and a health heart, wired left→right.
const GNODE_W = 250, GNODE_H = 66, GGAP_X = 74, GGAP_Y = 18;

const G_KIND_ICON = {
  Deployment: 'deployment', StatefulSet: 'statefulSet', DaemonSet: 'daemonSet',
  ReplicaSet: 'replicaSet', Pod: 'pod', Service: 'service', Job: 'job', CronJob: 'cronJob',
  Ingress: 'ingress', IngressClass: 'ingress', NetworkPolicy: 'networkPolicy', Endpoints: 'service', EndpointSlice: 'service',
  PersistentVolumeClaim: 'persistentVolumeClaim', PersistentVolume: 'persistentVolume', StorageClass: 'storageClass',
  ConfigMap: 'configMap', Secret: 'secret', ExternalSecret: 'secret', SecretStore: 'secret', ClusterSecretStore: 'secret',
  ServiceAccount: 'serviceAccount', ServiceMonitor: 'activity', PodMonitor: 'activity',
  Role: 'accessControl', ClusterRole: 'accessControl', RoleBinding: 'accessControl', ClusterRoleBinding: 'accessControl',
  Namespace: 'namespace', HorizontalPodAutoscaler: 'scale', Rollout: 'deployment',
  PodDisruptionBudget: 'box', CustomResourceDefinition: 'customResources', ValidatingWebhookConfiguration: 'accessControl',
  Certificate: 'secret', Issuer: 'secret', ClusterIssuer: 'secret',
};
const G_KIND_COLOR = {
  Deployment: '#3fb950', StatefulSet: '#bc8cff', DaemonSet: '#39c5cf', ReplicaSet: '#58a6ff',
  Pod: '#58a6ff', Job: '#bc8cff', CronJob: '#bc8cff', Service: '#d29922', Ingress: '#e3b341', IngressClass: '#e3b341',
  NetworkPolicy: '#f0883e', Endpoints: '#d29922', EndpointSlice: '#d29922',
  PersistentVolumeClaim: '#db6d28', PersistentVolume: '#db6d28', StorageClass: '#bf8040',
  ConfigMap: '#f778ba', Secret: '#f778ba', ExternalSecret: '#f778ba', SecretStore: '#f778ba',
  ServiceAccount: '#3fb0ac', ServiceMonitor: '#7c8cff', PodDisruptionBudget: '#39c5cf',
  Role: '#3fb0ac', ClusterRole: '#3fb0ac', RoleBinding: '#3fb0ac', HorizontalPodAutoscaler: '#e3b341',
};
// Short kind labels shown under the glyph, matching the Argo CD tree.
const SHORT_KIND = {
  Application: 'application', Service: 'svc', ServiceAccount: 'sa', Deployment: 'deploy',
  ReplicaSet: 'rs', StatefulSet: 'sts', DaemonSet: 'ds', Pod: 'pod', ConfigMap: 'cm',
  Secret: 'secret', ExternalSecret: 'externalsecret', SecretStore: 'secretstore', ClusterSecretStore: 'clustersecretstore',
  Ingress: 'ing', IngressClass: 'ingressclass', ServiceMonitor: 'servicemonitor', PodMonitor: 'podmonitor',
  Job: 'job', CronJob: 'cronjob', NetworkPolicy: 'netpol', HorizontalPodAutoscaler: 'hpa',
  PersistentVolumeClaim: 'pvc', PersistentVolume: 'pv', Role: 'role', RoleBinding: 'rolebinding',
  ClusterRole: 'clusterrole', ClusterRoleBinding: 'clusterrolebinding', PodDisruptionBudget: 'pdb',
  CustomResourceDefinition: 'crd', ValidatingWebhookConfiguration: 'webhook', Certificate: 'cert',
};
const shortKind = (k) => SHORT_KIND[k] || (k || '').toLowerCase();
const healthColor = (h) => h === 'Healthy' ? '#18be94' : (h === 'Degraded' || h === 'Missing') ? '#e96d76'
  : h === 'Progressing' ? '#0d99ff' : h === 'Suspended' ? '#8b949e' : '#b7bcc4';
const syncColor2 = (s) => s === 'Synced' ? '#18be94' : s === 'OutOfSync' ? '#f4c030' : '#b7bcc4';

function AppResourceGraph({ app, resources }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 20 });
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  // Build an ownership tree: App → workload controllers → ReplicaSets/Jobs → Pods,
  // plus Services/config/etc. hung directly off the App. ArgoCD's status.resources
  // has no parent links, so we infer them from Kubernetes' name-prefix convention.
  const { positioned, links } = useMemo(() => {
    const keyOf = (kind, ns, nm) => `${kind}|${ns || ''}|${nm}`;
    const nodes = [{ id: '__app__', kind: 'Application', name: app.name, sync: app.syncStatus, health: app.healthStatus, isApp: true }];
    const rs = resources.map((r) => ({ ...r, id: keyOf(r.kind, r.namespace, r.name) }));
    const ids = new Set(rs.map((x) => x.id));
    const byKind = (k) => rs.filter((x) => x.kind === k);
    const prefixParent = (nm, candidates) => candidates
      .filter((c) => nm === c.name || nm.startsWith(c.name + '-'))
      .sort((a, b) => b.name.length - a.name.length)[0];   // longest matching prefix wins
    const parentOf = (r) => {
      // Prefer the real ownerReference link the backend resolved.
      if (r.parentKey) return ids.has(r.parentKey) ? r.parentKey : '__app__';
      // Fallback (older payloads / unlinked): infer by name prefix, else the app root.
      if (r.kind === 'Pod') return (prefixParent(r.name, byKind('ReplicaSet')) || prefixParent(r.name, [...byKind('StatefulSet'), ...byKind('DaemonSet'), ...byKind('Job')]))?.id || '__app__';
      if (r.kind === 'ReplicaSet') return prefixParent(r.name, byKind('Deployment'))?.id || '__app__';
      if (r.kind === 'Job') return prefixParent(r.name, byKind('CronJob'))?.id || '__app__';
      if (r.kind === 'Endpoints' || r.kind === 'EndpointSlice') return prefixParent(r.name, byKind('Service'))?.id || '__app__';
      return '__app__';
    };
    const edges = [];
    const seen = new Set();
    rs.forEach((r) => {
      if (seen.has(r.id)) return; // guard against duplicate kind/ns/name keys
      seen.add(r.id);
      nodes.push({ id: r.id, kind: r.kind, name: r.name, namespace: r.namespace, sync: r.syncStatus, health: r.healthStatus, msg: r.healthMessage });
      edges.push({ source: parentOf(r), target: r.id });
    });

    // depth = BFS distance from the app root
    const kids = new Map();
    edges.forEach((e) => { if (!kids.has(e.source)) kids.set(e.source, []); kids.get(e.source).push(e.target); });
    const nameById = new Map(nodes.map((n) => [n.id, n.name]));
    kids.forEach((arr) => arr.sort((a, b) => (nameById.get(a) || '').localeCompare(nameById.get(b) || '')));
    const depth = new Map([['__app__', 0]]);
    const queue = ['__app__'];
    while (queue.length) { const id = queue.shift(); (kids.get(id) || []).forEach((c) => { if (!depth.has(c)) { depth.set(c, depth.get(id) + 1); queue.push(c); } }); }

    // y: pre-order DFS — the Application sits at the top, each resource stacked
    // below it in tree order, so the view always starts at the app root.
    const yPos = new Map(); let cursor = 0;
    const walk = (id) => { yPos.set(id, cursor); cursor += GNODE_H + GGAP_Y; (kids.get(id) || []).forEach(walk); };
    walk('__app__');

    const pos = new Map();
    nodes.forEach((n) => pos.set(n.id, { ...n, x: (depth.get(n.id) || 0) * (GNODE_W + GGAP_X), y: yPos.get(n.id) || 0 }));
    const positioned = [...pos.values()];
    const links = edges.map((e) => ({ s: pos.get(e.source), t: pos.get(e.target) })).filter((l) => l.s && l.t);
    const width = Math.max(...positioned.map((n) => n.x + GNODE_W), 400);
    const height = Math.max(...positioned.map((n) => n.y + GNODE_H), 200);
    return { positioned, links, width, height, appY: pos.get('__app__')?.y || 0 };
  }, [app, resources]);

  // Reset to the top-left (the Application root) at a readable zoom.
  const fitView = useCallback(() => { setZoom(1); setPan({ x: 40, y: 24 }); }, []);
  useEffect(() => { fitView(); }, [app.name, fitView]);

  const onMouseDown = (e) => { dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }; setDragging(true); };
  const onMouseMove = useCallback((e) => { if (!dragRef.current) return; setPan({ x: dragRef.current.px + (e.clientX - dragRef.current.sx), y: dragRef.current.py + (e.clientY - dragRef.current.sy) }); }, []);
  const onMouseUp = useCallback(() => { dragRef.current = null; setDragging(false); }, []);
  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, [onMouseMove, onMouseUp]);
  const onWheel = (e) => { setZoom((z) => Math.min(2, Math.max(0.3, +(z + (e.deltaY < 0 ? 0.12 : -0.12)).toFixed(2)))); };

  const edgePath = (l) => {
    const sx = l.s.x + GNODE_W, sy = l.s.y + GNODE_H / 2, tx = l.t.x, ty = l.t.y + GNODE_H / 2;
    const dx = Math.max(24, (tx - sx) * 0.5);
    return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  };

  return (
    <div className={`topology-canvas argo-tree-canvas ${dragging ? 'dragging' : ''}`} style={{ minHeight: 460 }} onMouseDown={onMouseDown} onWheel={onWheel}>
      {positioned.length <= 1 && (
        <div className="topo-empty">This application reports no managed resources.</div>
      )}
      <svg>
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {links.map((l, i) => (
            <path key={i} className="argo-tree-edge" d={edgePath(l)} />
          ))}
          {positioned.map((n) => {
            const color = n.isApp ? '#f97316' : (G_KIND_COLOR[n.kind] || '#6b7684');
            const hc = healthColor(n.health);
            return (
              <foreignObject key={n.id} x={n.x} y={n.y} width={GNODE_W} height={GNODE_H}>
                <div className={`argo-gnode ${n.isApp ? 'is-app' : ''}`} title={`${n.kind}: ${n.namespace ? n.namespace + '/' : ''}${n.name}${n.health ? '\nHealth: ' + n.health : ''}${n.sync ? '\nSync: ' + n.sync : ''}${n.msg ? '\n' + n.msg : ''}`}>
                  <div className="argo-gnode-kind">
                    <span className="argo-gnode-glyph" style={{ color }}><Icon name={n.isApp ? 'argocd' : (G_KIND_ICON[n.kind] || 'box')} size={21} /></span>
                    <span className="argo-gnode-klabel">{shortKind(n.kind)}</span>
                  </div>
                  <div className="argo-gnode-main">
                    <span className="argo-gnode-name">{n.name}</span>
                    <span className="argo-gnode-status">
                      {n.health && <span className="argo-gnode-heart" style={{ color: hc }} title={`Health: ${n.health}`}><Icon name="heart" size={13} style={{ fill: hc }} /></span>}
                      <span className="argo-gnode-syncdot" style={{ background: syncColor2(n.sync) }} title={`Sync: ${n.sync || 'n/a'}`} />
                    </span>
                  </div>
                  <span className="argo-gnode-menu"><Icon name="more" size={15} /></span>
                </div>
              </foreignObject>
            );
          })}
        </g>
      </svg>

      <div className="topo-controls">
        <button className="topo-ctrl-btn" title="Zoom in" onClick={() => setZoom((z) => Math.min(2, +(z + 0.15).toFixed(2)))}><Icon name="plus" size={16} /></button>
        <button className="topo-ctrl-btn" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.3, +(z - 0.15).toFixed(2)))}><Icon name="minus" size={16} /></button>
        <button className="topo-ctrl-btn" title="Fit / reset view" onClick={fitView}><Icon name="refresh" size={15} /></button>
      </div>
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, s] of units) { const v = Math.floor(secs / s); if (v >= 1) return `${v} ${name}${v === 1 ? '' : 's'} ago`; }
  return 'just now';
}

// ---------- View tab: App Health / Sync Status / Last Sync summary (Argo CD style) ----------
function AppSummaryBar({ detail }) {
  const a = detail.app || {};
  const op = detail.operationState;
  const auto = !!(detail.syncPolicy && detail.syncPolicy.automated);
  const hc = healthColor(a.healthStatus);
  const sc = syncColor2(a.syncStatus);
  const opColor = op ? (op.phase === 'Succeeded' ? '#18be94' : op.phase === 'Failed' || op.phase === 'Error' ? '#e96d76' : 'var(--text)') : 'var(--text)';
  return (
    <div className="argo-appsum">
      <div className="argo-appsum-card">
        <div className="argo-appsum-label">App Health</div>
        <div className="argo-appsum-main" style={{ color: hc }}>
          <Icon name="heart" size={18} style={{ fill: hc }} /> {a.healthStatus || 'Unknown'}
        </div>
      </div>
      <div className="argo-appsum-card">
        <div className="argo-appsum-label">Sync Status</div>
        <div className="argo-appsum-main" style={{ color: sc }}>
          <Icon name={a.syncStatus === 'Synced' ? 'check' : 'refresh'} size={16} strokeWidth={2.4} /> {a.syncStatus || 'Unknown'}
          {a.revision && <span className="argo-appsum-rev">to {String(a.revision).slice(0, 7)}</span>}
        </div>
        <div className="argo-appsum-sub">{auto ? 'Auto sync is enabled.' : 'Auto sync is not enabled.'}</div>
      </div>
      {op && (
        <div className="argo-appsum-card">
          <div className="argo-appsum-label">Last Sync</div>
          <div className="argo-appsum-main" style={{ color: opColor }}>
            <Icon name={op.phase === 'Succeeded' ? 'check' : 'warning'} size={16} strokeWidth={2.4} /> {op.phase === 'Succeeded' ? 'Sync OK' : op.phase}
            {op.revision && <span className="argo-appsum-rev">to {op.revision}</span>}
          </div>
          <div className="argo-appsum-sub">{op.phase}{op.finishedAt ? ` ${timeAgo(op.finishedAt)}` : ''}</div>
        </div>
      )}
    </div>
  );
}
