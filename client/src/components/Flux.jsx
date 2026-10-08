import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';
import ContextMenu from './ContextMenu';
import { useToast } from './Toast';
import { askLabel } from '../aiConfig';
import useClickOutside from '../hooks/useClickOutside';

// Flux CD — auto-detected from the *.toolkit.fluxcd.io CRDs. A dashboard plus a
// list + detail view per Flux kind, with Reconcile / Suspend / Resume / Delete
// actions and an "Ask AI → Summarize" hand-off. Reads from the backend's kubectl
// shell-out; reuses the Argo CD styles. Modelled on the Lens Flux CD UX.

const enc = encodeURIComponent;
const formatAge = (t) => {
  if (!t) return '-';
  const s = Math.floor((new Date() - new Date(t)) / 1000);
  if (s < 0) return '-';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const shortRev = (rev) => { if (!rev) return '-'; const tail = String(rev).split(/[:@/]/).pop() || rev; return tail.slice(0, 8); };

const KINDS = {
  kustomization: { kind: 'Kustomization', label: 'Kustomizations', category: 'kustomizations' },
  helmrelease: { kind: 'HelmRelease', label: 'Helm Releases', category: 'helmreleases' },
  gitrepository: { kind: 'GitRepository', label: 'Git Repositories', category: 'sources' },
  ocirepository: { kind: 'OCIRepository', label: 'OCI Repositories', category: 'sources' },
  helmrepository: { kind: 'HelmRepository', label: 'Helm Repositories', category: 'sources' },
  bucket: { kind: 'Bucket', label: 'Buckets', category: 'sources' },
  helmchart: { kind: 'HelmChart', label: 'Helm Charts', category: 'sources' },
  externalartifact: { kind: 'ExternalArtifact', label: 'External Artifacts', category: 'sources' },
  alert: { kind: 'Alert', label: 'Alerts', category: 'notifications' },
  provider: { kind: 'Provider', label: 'Providers', category: 'notifications' },
  receiver: { kind: 'Receiver', label: 'Receivers', category: 'notifications' },
};
const SOURCE_KIND_KEY = { GitRepository: 'gitrepository', OCIRepository: 'ocirepository', HelmRepository: 'helmrepository', Bucket: 'bucket', HelmChart: 'helmchart', ExternalArtifact: 'externalartifact' };

// Per-kind extra list columns (after Status, before Age), matching Lens.
const LIST_COLS = {
  kustomization: [['Source', (r) => (r.source ? `${r.source.kind}/${r.source.name}` : '-')], ['Revision', (r) => shortRev(r.revision)]],
  helmrelease: [['Chart', (r) => (r.chart ? `${r.chart}${r.chartVersion ? `@${r.chartVersion}` : ''}` : '-')], ['Revision', (r) => shortRev(r.revision)]],
  gitrepository: [['URL', (r) => r.url || '-'], ['Revision', (r) => shortRev(r.revision)]],
  ocirepository: [['URL', (r) => r.url || '-'], ['Revision', (r) => shortRev(r.revision)]],
  helmrepository: [['URL', (r) => r.url || '-'], ['Type', (r) => r.type || 'default']],
  bucket: [['Endpoint', (r) => r.url || '-'], ['Revision', (r) => shortRev(r.revision)]],
  helmchart: [['Chart', (r) => r.chart || '-'], ['Revision', (r) => shortRev(r.revision)]],
  externalartifact: [['Revision', (r) => shortRev(r.revision)]],
  alert: [['Type', (r) => r.type || '-']],
  provider: [['Type', (r) => r.type || '-']],
  receiver: [['Type', (r) => r.type || '-']],
};

const STATE_CLASS = { Ready: 'ok', Reconciling: 'info', Suspended: 'purple', Failed: 'bad', Unknown: 'muted' };
const STATE_WORD = { Ready: 'Ready', Reconciling: 'Reconciling', Suspended: 'Suspended', Failed: 'Not ready', Unknown: 'Unknown' };
const STATE_ICON = { Ready: 'check', Reconciling: 'refresh', Suspended: 'pause', Failed: 'warning', Unknown: 'warning' };
const KIND_TO_KEY = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v.kind, k]));
const Badge = ({ cls, children }) => <span className={`argo-badge ${cls}`}>{children}</span>;
const StateBadge = ({ s }) => <Badge cls={STATE_CLASS[s] || 'muted'}>{s}</Badge>;

export default function Flux({ refreshSignal = 0, view, onViewChange, onNavigate }) {
  const toast = useToast();
  const sub = view || 'dashboard';
  const isKind = sub !== 'dashboard' && !!KINDS[sub];

  const [overview, setOverview] = useState(null);
  const [resources, setResources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [ns, setNs] = useState('all');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const drawerRef = useRef(null);
  const pendingOpen = useRef(null); // resource to open once a dashboard click has switched the view
  useClickOutside(drawerRef, () => setSelected(null));

  const loadOverview = async (silent = false) => {
    if (!silent) { setLoading(true); setError(null); }
    try { setOverview((await axios.get('/api/flux/overview')).data); }
    catch (e) { if (!silent) setError(e.response?.data?.error || 'Failed to load Flux overview'); }
    finally { setLoading(false); }
  };
  const loadKind = async (kindKey, silent = false) => {
    if (!silent) { setLoading(true); setError(null); }
    try { setResources((await axios.get('/api/flux/resources', { params: { kind: kindKey } })).data.resources || []); }
    catch (e) { if (!silent) { setError(e.response?.data?.error || 'Failed to load resources'); setResources([]); } }
    finally { setLoading(false); }
  };

  useEffect(() => {
    setSelected(pendingOpen.current); pendingOpen.current = null; setQ(''); setNs('all');
    if (sub === 'dashboard') loadOverview(); else if (isKind) loadKind(sub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub]);

  useEffect(() => {
    if (sub === 'dashboard') loadOverview(true); else if (isKind) loadKind(sub, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  useEffect(() => {
    if (!selected) { setDetail(null); return undefined; }
    let on = true; setDetail(null);
    axios.get(`/api/flux/resource/${selected.kindKey}/${enc(selected.namespace)}/${enc(selected.name)}`)
      .then((r) => { if (on) setDetail(r.data); }).catch(() => {});
    return () => { on = false; };
  }, [selected]);

  const reload = () => { if (sub === 'dashboard') loadOverview(true); else loadKind(sub, true); if (selected) setSelected({ ...selected }); };

  const reconcile = async (r) => {
    setBusy(true);
    try { await axios.post(`/api/flux/resource/${r.kindKey}/${enc(r.namespace)}/${enc(r.name)}/reconcile`); toast.success('Reconciliation requested', { title: r.name }); reload(); }
    catch (e) { toast.error(e.response?.data?.error || e.message || 'Reconcile failed', { title: 'Reconcile' }); }
    finally { setBusy(false); }
  };
  const toggleSuspend = async (r) => {
    const action = r.suspended ? 'resume' : 'suspend';
    setBusy(true);
    try { await axios.post(`/api/flux/resource/${r.kindKey}/${enc(r.namespace)}/${enc(r.name)}/${action}`); toast.success(r.suspended ? 'Resumed' : 'Suspended', { title: r.name }); reload(); }
    catch (e) { toast.error(e.response?.data?.error || e.message || 'Action failed', { title: action }); }
    finally { setBusy(false); }
  };
  const doDelete = async (r) => {
    setBusy(true);
    try { await axios.delete(`/api/flux/resource/${r.kindKey}/${enc(r.namespace)}/${enc(r.name)}`); toast.success('Deleted', { title: r.name }); setConfirmDel(null); setSelected(null); reload(); }
    catch (e) { toast.error(e.response?.data?.error || e.message || 'Delete failed', { title: 'Delete' }); }
    finally { setBusy(false); }
  };
  const summarize = async (r) => {
    toast.info(`Summarizing ${r.name}…`, { title: askLabel() });
    let d = detail && selected && selected.name === r.name && selected.namespace === r.namespace ? detail : null;
    if (!d) { try { d = (await axios.get(`/api/flux/resource/${r.kindKey}/${enc(r.namespace)}/${enc(r.name)}`)).data; } catch { d = { summary: r }; } }
    const s = d.summary || r;
    const lines = [
      `Analyze the current condition of the Flux ${s.kind} "${s.name}" (namespace ${s.namespace}).`,
      `Reconciliation state: ${s.state}${s.suspended ? ' (suspended)' : ''}.`,
      s.message ? `Status message: ${s.message}` : '',
      s.source ? `Source: ${s.source.kind}/${s.source.name}.` : '',
      s.revision ? `Current revision: ${s.revision}.` : '',
      (d.conditions || []).length ? `Conditions:\n${d.conditions.map((c) => `- ${c.type}=${c.status} (${c.reason || ''}): ${c.message || ''}`).join('\n')}` : '',
      (d.events || []).filter((e) => e.type === 'Warning').length ? `Recent warnings:\n${d.events.filter((e) => e.type === 'Warning').slice(0, 10).map((e) => `- ${e.reason}: ${e.message}`).join('\n')}` : '',
      'Explain whether it is healthy, the likely root cause of any problem, and concrete steps to fix it.',
    ].filter(Boolean);
    window.dispatchEvent(new CustomEvent('assistant:ask', { detail: { prompt: lines.join('\n') } }));
  };

  const menuItems = (r) => {
    const items = [
      { icon: 'details', label: 'Show details', onClick: () => setSelected(r) },
      { icon: 'sparkles', label: `Summarize (${askLabel()})`, onClick: () => summarize(r) },
      { icon: 'refresh', label: 'Reconcile', onClick: () => reconcile(r) },
    ];
    if (r.suspendable) items.push({ icon: r.suspended ? 'play' : 'pause', label: r.suspended ? 'Resume' : 'Suspend', onClick: () => toggleSuspend(r) });
    items.push({ icon: 'delete', label: 'Delete', danger: true, onClick: () => setConfirmDel(r) });
    return items;
  };

  const namespaces = useMemo(() => [...new Set(resources.map((r) => r.namespace).filter(Boolean))].sort(), [resources]);
  const filtered = useMemo(() => resources.filter((r) =>
    (ns === 'all' || r.namespace === ns)
    && (!q || `${r.name} ${r.namespace} ${r.message}`.toLowerCase().includes(q.toLowerCase()))), [resources, ns, q]);

  const goToResource = (kindKey, r) => {
    const target = { kindKey, name: r.name, namespace: r.namespace };
    if (kindKey === sub) { setSelected(target); return; }
    pendingOpen.current = target;
    onViewChange?.(kindKey);
  };

  return (
    <div className="resource-viewer argo-view">
      {loading && !overview && resources.length === 0 ? (
        <div className="resource-table-wrapper"><Loader label="Loading Flux…" /></div>
      ) : error ? (
        <div className="loading-indicator" style={{ color: 'var(--red)', padding: 24 }}>{error}</div>
      ) : sub === 'dashboard' ? (
        <FluxDashboard overview={overview} onOpen={goToResource} />
      ) : (
        <FluxList
          kindKey={sub} resources={filtered} total={resources.length}
          q={q} setQ={setQ} ns={ns} setNs={setNs} namespaces={namespaces}
          onSelect={(r) => setSelected(r)} onMenu={(e, r) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, r }); }}
        />
      )}

      {selected && (
        <FluxDrawer
          ref={drawerRef} selected={selected} detail={detail} busy={busy}
          onClose={() => setSelected(null)} onNavigate={onNavigate} onViewChange={onViewChange}
          onReconcile={reconcile} onSuspend={toggleSuspend} onSummarize={summarize} onDelete={() => setConfirmDel(detail?.summary || selected)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.r)} onClose={() => setMenu(null)} />}
      {confirmDel && (
        <div className="action-modal-backdrop" onClick={() => !busy && setConfirmDel(null)}>
          <div className="action-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="action-modal-title"><Icon name="delete" size={16} /> Delete {confirmDel.kind}</h3>
            <p className="action-modal-body">Delete <b>{confirmDel.name}</b> in <b>{confirmDel.namespace}</b>? Flux will stop reconciling it; this cannot be undone.</p>
            <div className="action-modal-actions">
              <button className="action-modal-btn" disabled={busy} onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="action-modal-btn danger" disabled={busy} onClick={() => doDelete(confirmDel)}>{busy ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Dashboard ---------------- */
function FluxDashboard({ overview, onOpen }) {
  const [filter, setFilter] = useState('');
  const [warnOnly, setWarnOnly] = useState(false);
  if (!overview) return <div className="resource-table-wrapper"><Loader label="Loading Flux…" /></div>;
  const sum = overview.summary || {};
  const card = (key, label, icon) => {
    const c = sum[key] || { total: 0, ready: 0, reconciling: 0, failed: 0 };
    return (
      <div className="argo-card" key={key}>
        <div className="argo-card-head"><Icon name={icon} size={16} /> {label}</div>
        <div className="argo-card-big">{c.ready}<span>/{c.total} ready</span></div>
        <div className="flux-substat">
          {c.reconciling > 0 && <span className="reconciling"><Icon name="refresh" size={12} /> {c.reconciling} reconciling</span>}
          {c.failed > 0 && <span className="failed"><Icon name="warning" size={12} /> {c.failed} failed</span>}
          {c.suspended > 0 && <span className="suspended">{c.suspended} suspended</span>}
          {c.total > 0 && c.reconciling === 0 && c.failed === 0 && !c.suspended && <span className="argo-card-sub">all ready</span>}
          {c.total === 0 && <span className="argo-card-sub">none</span>}
        </div>
      </div>
    );
  };
  const warnings = (overview.activity || []).filter((a) => a.type === 'Warning').length;
  const activity = (overview.activity || []).filter((a) =>
    (!warnOnly || a.type === 'Warning')
    && (!filter || `${a.kind} ${a.namespace} ${a.name} ${a.reason}`.toLowerCase().includes(filter.toLowerCase())));

  return (
    <div className="argo-dashboard">
      <div className={`flux-banner ${overview.healthy ? 'ok' : 'bad'}`}>
        <Icon name={overview.healthy ? 'check' : 'warning'} size={16} />
        <b>{overview.healthy ? 'Healthy' : 'Attention needed'}</b>
        {overview.healthy ? 'All Flux workloads are reconciled.' : `${(overview.attention || []).filter((a) => a.state === 'Failed').length} failing.`}
      </div>

      <div className="argo-cards">
        {card('kustomizations', 'Kustomizations', 'configuration')}
        {card('helmreleases', 'Helm Releases', 'helm')}
        {card('sources', 'Sources', 'flux')}
        {(sum.notifications?.total > 0) && card('notifications', 'Notifications', 'events')}
      </div>

      <div className="flux-dash-cols">
        <div className="argo-panel">
          <div className="argo-panel-title">Needs attention {(overview.attention || []).length > 0 && <span className="argo-panel-count">{overview.attention.length}</span>}</div>
          {(overview.attention || []).length === 0 ? (
            <div className="argo-panel-empty"><Icon name="check" size={15} /> Everything is reconciled.</div>
          ) : (
            <div className="flux-attn">
              {overview.attention.slice(0, 20).map((r) => {
                const cls = STATE_CLASS[r.state] || 'muted';
                return (
                  <button type="button" key={`${r.kindKey}/${r.namespace}/${r.name}`} className={`flux-attn-row ${cls}`}
                    onClick={() => onOpen(r.kindKey, r)} title={`Open ${r.kind} ${r.namespace}/${r.name}`}>
                    <span className={`flux-attn-icon ${cls}`}><Icon name={STATE_ICON[r.state] || 'warning'} size={14} /></span>
                    <span className="flux-attn-body">
                      <span className="flux-attn-top">
                        <span className="flux-attn-name"><span className="flux-ns">{r.namespace}/</span>{r.name}</span>
                        {r.lastReconciled && <span className="flux-attn-age">{formatAge(r.lastReconciled)}</span>}
                      </span>
                      <span className="flux-attn-meta">
                        <span className="flux-kind-chip">{r.kind}</span>
                        <span className={`flux-attn-state ${cls}`}>{STATE_WORD[r.state] || r.state}</span>
                      </span>
                      {r.message && <span className="flux-attn-msg" title={r.message}>{r.message}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="argo-panel">
          <div className="argo-panel-title">Recent activity {(overview.activity || []).length > 0 && <span className="argo-panel-count">{overview.activity.length}</span>}<span className="flux-activity-when">last ~1h</span></div>
          <div className="flux-activity-bar">
            <label className="flux-filter">
              <Icon name="search" size={13} />
              <input className="flux-filter-input" placeholder="Filter by kind, namespace or name…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              {filter && <button type="button" className="flux-filter-clear" onClick={() => setFilter('')} title="Clear"><Icon name="close" size={12} /></button>}
            </label>
            <button type="button" className={`flux-warn-toggle ${warnOnly ? 'active' : ''}`} onClick={() => setWarnOnly((w) => !w)} disabled={!warnings && !warnOnly}>
              <Icon name="warning" size={12} /> Warnings <b>{warnings}</b>
            </button>
          </div>
          {activity.length === 0 ? (
            <div className="argo-panel-empty">{filter || warnOnly ? 'No events match the filter.' : 'No recent activity.'}</div>
          ) : (
            <div className="flux-activity">
              {activity.slice(0, 60).map((a, i) => {
                const warn = a.type === 'Warning';
                const key = KIND_TO_KEY[a.kind];
                return (
                  <button type="button" key={i} className={`flux-act-row ${warn ? 'warn' : ''}`} disabled={!key}
                    onClick={() => key && onOpen(key, { name: a.name, namespace: a.namespace })}>
                    <span className={`flux-act-dot ${warn ? 'bad' : 'ok'}`}><Icon name={warn ? 'warning' : 'check'} size={13} /></span>
                    <span className="flux-act-main">
                      <span className="flux-act-title"><span className="flux-kind-chip">{a.kind}</span><span className="flux-act-name"><span className="flux-ns">{a.namespace}/</span>{a.name}</span></span>
                      <span className="flux-act-msg" title={`${a.reason}: ${a.message}`}><b className="flux-act-reason">{a.reason}</b> {a.message}</span>
                    </span>
                    <span className="flux-act-meta">
                      {a.count > 1 && <span className="flux-act-count" title={`Seen ${a.count} times`}>×{a.count}</span>}
                      <span className="flux-act-age">{formatAge(a.at)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- List ---------------- */
function FluxList({ kindKey, resources, total, q, setQ, ns, setNs, namespaces, onSelect, onMenu }) {
  const label = KINDS[kindKey]?.label || kindKey;
  const cols = LIST_COLS[kindKey] || [];
  return (
    <>
      <div className="resource-header argo-sub-header">
        <div className="search-box">
          <span className="search-icon"><Icon name="search" size={15} /></span>
          <input className="search-input" placeholder={`Search ${label}…`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="flux-ns-select" value={ns} onChange={(e) => setNs(e.target.value)}>
          <option value="all">All namespaces</option>
          {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="flux-count">{resources.length}{resources.length !== total ? ` of ${total}` : ''} item{resources.length === 1 ? '' : 's'}</span>
      </div>
      <div className="resource-table-wrapper">
        {resources.length === 0 ? <div className="loading-indicator">No {label} found.</div> : (
          <table className="resource-table">
            <thead><tr>
              <th>Name</th><th>Namespace</th><th>Status</th>{cols.map(([h]) => <th key={h}>{h}</th>)}<th>Age</th><th></th>
            </tr></thead>
            <tbody>
              {resources.map((r) => (
                <tr key={`${r.namespace}/${r.name}`} className="resource-table-row"
                  onClick={() => onSelect(r)} onContextMenu={(e) => onMenu(e, r)}>
                  <td><span className="resource-name-cell">{r.name}</span></td>
                  <td>{r.namespace}</td>
                  <td><StateBadge s={r.state} /></td>
                  {cols.map(([h, fn]) => <td key={h} className="flux-cell" title={fn(r)}>{fn(r)}</td>)}
                  <td>{formatAge(r.createdAt)}</td>
                  <td className="actions" onClick={(e) => onMenu(e, r)}><Icon name="more" size={16} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/* ---------------- Detail drawer ---------------- */
const FluxDrawer = React.forwardRef(({ selected, detail, busy, onClose, onNavigate, onViewChange, onReconcile, onSuspend, onSummarize, onDelete }, ref) => {
  const s = detail?.summary || selected;
  const conds = detail?.conditions || [];
  const spec = detail?.spec || {};
  const meta = detail?.metadata || {};
  const managed = detail?.managed || [];
  const annCount = Object.keys(meta.annotations || {}).length;
  const row = (label, value) => (value || value === 0) ? <div><span>{label}</span><code>{value}</code></div> : null;
  return (
    <div className="resource-drawer argo-drawer" ref={ref}>
      <div className="drawer-header">
        <div className="drawer-title">
          <div className="drawer-title-icon blue"><Icon name="flux" size={18} /></div>
          <div className="drawer-title-text">
            <span className="drawer-kind">{s.kind}</span>
            <span className="drawer-name" title={s.name}>{s.name}</span>
          </div>
        </div>
        <div className="drawer-actions">
          <button className="drawer-action-btn" title={`Summarize (${askLabel()})`} onClick={() => onSummarize(s)}><Icon name="sparkles" size={16} /></button>
          <button className="drawer-action-btn" title="Reconcile" disabled={busy} onClick={() => onReconcile(s)}><Icon name="refresh" size={16} /></button>
          {s.suspendable && <button className="drawer-action-btn" title={s.suspended ? 'Resume' : 'Suspend'} disabled={busy} onClick={() => onSuspend(s)}><Icon name={s.suspended ? 'play' : 'pause'} size={16} /></button>}
          <button className="drawer-action-btn danger" title="Delete" disabled={busy} onClick={onDelete}><Icon name="delete" size={16} /></button>
          <button className="drawer-action-btn" title="Close" onClick={onClose}><Icon name="close" size={17} /></button>
        </div>
      </div>

      <div className="drawer-body">
        {!detail ? <Loader label="Loading…" inline /> : (
          <>
            <div className="drawer-section">
              <div className="drawer-section-title">Properties</div>
              <div className="argo-kv">
                {row('Created', meta.creationTimestamp ? `${formatAge(meta.creationTimestamp)} ago (${new Date(meta.creationTimestamp).toLocaleString()})` : '-')}
                {row('Name', s.name)}
                <div><span>Namespace</span><code className="flux-link" onClick={() => onNavigate?.toNamespace?.(s.namespace)}>{s.namespace}</code></div>
                {annCount > 0 && row('Annotations', `${annCount} annotation${annCount === 1 ? '' : 's'}`)}
                {(meta.finalizers || []).length > 0 && row('Finalizers', meta.finalizers.join(', '))}
              </div>
            </div>

            <div className="drawer-section">
              <div className="drawer-section-title">Reconciliation</div>
              <div className="argo-kv">
                <div><span>Status</span><code><span className={`flux-status-word ${STATE_CLASS[s.state] || 'muted'}`}>{STATE_WORD[s.state] || s.state}</span>{s.message ? ` — ${s.message}` : ''}</code></div>
                {row('Interval', spec.interval)}
                {row('Last reconciled', s.lastReconciled ? `${formatAge(s.lastReconciled)} ago` : null)}
              </div>
              {conds.length > 0 && (
                <div className="argo-status-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  {conds.map((c) => <Badge key={c.type} cls={c.status === 'True' ? (c.type === 'Ready' ? 'ok' : 'info') : 'bad'}>{c.type}</Badge>)}
                </div>
              )}
            </div>

            {(s.source || s.chart || spec.url || s.path || s.targetNamespace || s.lastAppliedRevision) && (
              <div className="drawer-section">
                <div className="drawer-section-title">Source</div>
                <div className="argo-kv">
                  {s.source && <div><span>Source</span><code className="flux-link" onClick={() => onViewChange?.(SOURCE_KIND_KEY[s.source.kind] || '')}>{s.source.kind}/{s.source.name}</code></div>}
                  {row('URL', spec.url)}
                  {row('Type', s.type)}
                  {row('Chart', s.chart)}
                  {row('Path', s.path)}
                  {row('Target namespace', s.targetNamespace)}
                  {s.kindKey === 'kustomization' && <div><span>Prune</span><code>{s.prune ? 'Yes' : 'No'}</code></div>}
                  {row('Last applied revision', s.lastAppliedRevision)}
                </div>
              </div>
            )}

            {managed.length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">Managed resources ({managed.length})</div>
                <div className="resource-table-wrapper" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <table className="resource-table">
                    <thead><tr><th>Kind</th><th>Name</th><th>Namespace</th></tr></thead>
                    <tbody>
                      {managed.slice(0, 50).map((m, i) => (
                        <tr key={i} className="resource-table-row" onClick={() => onNavigate?.toResource?.({ type: (m.kind || '').toLowerCase(), namespace: m.namespace, name: m.name })}>
                          <td>{m.kind}</td>
                          <td><span className="flux-link">{m.name}</span></td>
                          <td>{m.namespace || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(detail.events || []).length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">Events ({detail.events.length})</div>
                <div className="argo-events">
                  {detail.events.map((e, i) => (
                    <div key={i} className={`argo-event ${e.type === 'Warning' ? 'warn' : ''}`}>
                      <span className="argo-event-reason">{e.reason}</span>
                      <span className="argo-event-msg">{e.message}</span>
                      <span className="argo-event-age">{formatAge(e.at)}{e.count > 1 ? ` ×${e.count}` : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
FluxDrawer.displayName = 'FluxDrawer';
