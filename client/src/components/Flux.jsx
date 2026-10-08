import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';
import ContextMenu from './ContextMenu';
import { useToast } from './Toast';
import { askLabel } from '../aiConfig';
import useClickOutside from '../hooks/useClickOutside';

// Flux CD — auto-detected from the *.toolkit.fluxcd.io CRDs. A dashboard plus a
// list + detail view per Flux kind, with Reconcile / Suspend / Resume actions
// and an "Ask AI → Summarize" hand-off to the assistant. Reads straight from the
// cluster via the backend's kubectl shell-out; reuses the Argo CD styles.

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

const KINDS = {
  kustomization: { kind: 'Kustomization', label: 'Kustomizations', category: 'kustomizations' },
  helmrelease: { kind: 'HelmRelease', label: 'Helm Releases', category: 'helmreleases' },
  gitrepository: { kind: 'GitRepository', label: 'Git Repositories', category: 'sources' },
  ocirepository: { kind: 'OCIRepository', label: 'OCI Repositories', category: 'sources' },
  helmrepository: { kind: 'HelmRepository', label: 'Helm Repositories', category: 'sources' },
  bucket: { kind: 'Bucket', label: 'Buckets', category: 'sources' },
  helmchart: { kind: 'HelmChart', label: 'Helm Charts', category: 'sources' },
  alert: { kind: 'Alert', label: 'Alerts', category: 'notifications' },
  provider: { kind: 'Provider', label: 'Providers', category: 'notifications' },
  receiver: { kind: 'Receiver', label: 'Receivers', category: 'notifications' },
  imagerepository: { kind: 'ImageRepository', label: 'Image Repositories', category: 'image' },
  imagepolicy: { kind: 'ImagePolicy', label: 'Image Policies', category: 'image' },
  imageupdateautomation: { kind: 'ImageUpdateAutomation', label: 'Image Update Automations', category: 'image' },
};
const KIND_TO_KEY = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v.kind, k]));
const SOURCE_KIND_KEY = { GitRepository: 'gitrepository', OCIRepository: 'ocirepository', HelmRepository: 'helmrepository', Bucket: 'bucket', HelmChart: 'helmchart' };

const STATE_CLASS = { Ready: 'ok', Reconciling: 'info', Suspended: 'purple', Failed: 'bad', Unknown: 'muted' };
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
  const [selected, setSelected] = useState(null); // { kindKey, name, namespace }
  const [detail, setDetail] = useState(null);
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(false);
  const drawerRef = useRef(null);
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
    setSelected(null); setQ(''); setNs('all');
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

  // ---- actions ----
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
    return items;
  };

  // ---- derived ----
  const namespaces = useMemo(() => [...new Set(resources.map((r) => r.namespace).filter(Boolean))].sort(), [resources]);
  const filtered = useMemo(() => resources.filter((r) =>
    (ns === 'all' || r.namespace === ns)
    && (!q || `${r.name} ${r.namespace} ${r.message}`.toLowerCase().includes(q.toLowerCase()))), [resources, ns, q]);

  const goToResource = (kindKey, r) => { onViewChange?.(kindKey); setSelected({ kindKey, name: r.name, namespace: r.namespace }); };

  // =========================================================== render
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
          onReconcile={reconcile} onSuspend={toggleSuspend} onSummarize={summarize}
        />
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.r)} onClose={() => setMenu(null)} />
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
    const c = sum[key] || { total: 0, ready: 0 };
    return (
      <div className="argo-card" key={key}>
        <div className="argo-card-head"><Icon name={icon} size={16} /> {label}</div>
        <div className="argo-card-big">{c.ready}<span>/{c.total}</span></div>
        <div className="argo-card-sub">{c.total === 0 ? 'none' : c.ready === c.total ? 'all ready' : `${c.total - c.ready} not ready`}</div>
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
        {overview.healthy ? 'All Flux resources are reconciled.' : `${(overview.attention || []).filter((a) => a.state === 'Failed').length} failing, ${(overview.attention || []).filter((a) => a.state === 'Suspended').length} suspended.`}
      </div>

      <div className="argo-cards">
        {card('kustomizations', 'Kustomizations', 'configuration')}
        {card('helmreleases', 'Helm Releases', 'helm')}
        {card('sources', 'Sources', 'flux')}
        {(sum.notifications?.total > 0) && card('notifications', 'Notifications', 'events')}
        {(sum.image?.total > 0) && card('image', 'Image Automation', 'box')}
      </div>

      <div className="flux-dash-cols">
        <div className="argo-panel">
          <div className="argo-panel-title">Needs attention {(overview.attention || []).length > 0 && <span className="argo-panel-count">{overview.attention.length}</span>}</div>
          {(overview.attention || []).length === 0 ? (
            <div className="argo-panel-empty"><Icon name="check" size={15} /> Everything is reconciled.</div>
          ) : (
            <div className="argo-mini-table">
              {overview.attention.slice(0, 20).map((r) => (
                <div key={`${r.kindKey}/${r.namespace}/${r.name}`} className="argo-mini-row" onClick={() => onOpen(r.kindKey, r)}>
                  <StateBadge s={r.state} />
                  <span className="argo-mini-name">{r.name}</span>
                  <span className="argo-mini-ns">{r.kind} · {r.namespace}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="argo-panel">
          <div className="argo-panel-title">Recent activity {(overview.activity || []).length > 0 && <span className="argo-panel-count">{overview.activity.length}</span>}</div>
          <div className="argo-filterbar" style={{ padding: '2px 0 10px' }}>
            <input className="flux-filter-input" placeholder="Filter by kind, namespace or name…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button className={`argo-chip ${warnOnly ? 'active bad' : 'muted'}`} onClick={() => setWarnOnly((w) => !w)}>Warnings<b>{warnings}</b></button>
          </div>
          {activity.length === 0 ? <div className="argo-panel-empty">No recent activity.</div> : (
            <div className="argo-mini-table flux-activity">
              {activity.slice(0, 50).map((a, i) => (
                <div key={i} className="argo-mini-row">
                  <span className={`argo-dot ${a.type === 'Warning' ? 'bad' : 'ok'}`} />
                  <span className="argo-mini-name">{a.kind} {a.namespace}/{a.name}</span>
                  <span className="argo-mini-msg">{a.reason} · {a.message}</span>
                  <span className="argo-mini-age">{a.count > 1 ? `×${a.count} ` : ''}{formatAge(a.at)}</span>
                </div>
              ))}
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
            <thead><tr><th>Name</th><th>Namespace</th><th>Ready</th><th>Status</th><th>Age</th><th></th></tr></thead>
            <tbody>
              {resources.map((r) => (
                <tr key={`${r.namespace}/${r.name}`} className="resource-table-row"
                  onClick={() => onSelect(r)} onContextMenu={(e) => onMenu(e, r)}>
                  <td><span className="resource-name-cell">{r.name}</span></td>
                  <td>{r.namespace}</td>
                  <td><StateBadge s={r.state} /></td>
                  <td className="flux-msg" title={r.message}>{r.message || '-'}</td>
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
const FluxDrawer = React.forwardRef(({ selected, detail, busy, onClose, onNavigate, onViewChange, onReconcile, onSuspend, onSummarize }, ref) => {
  const s = detail?.summary || selected;
  const conds = detail?.conditions || [];
  const spec = detail?.spec || {};
  const meta = detail?.metadata || {};
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
          <button className="drawer-action-btn" title="Close" onClick={onClose}><Icon name="close" size={17} /></button>
        </div>
      </div>

      <div className="drawer-body">
        {!detail ? <Loader label="Loading…" inline /> : (
          <>
            <div className="drawer-section">
              <div className="argo-status-row">
                <StateBadge s={s.state} />
                {s.suspended && <span className="argo-badge purple">suspended</span>}
              </div>
              {s.message && <div className="argo-msg">{s.message}</div>}
            </div>

            <div className="drawer-section">
              <div className="drawer-section-title">Properties</div>
              <div className="argo-kv">
                {row('Created', meta.creationTimestamp ? new Date(meta.creationTimestamp).toLocaleString() : '-')}
                {row('Name', s.name)}
                <div><span>Namespace</span><code className="flux-link" onClick={() => onNavigate?.toNamespace?.(s.namespace)}>{s.namespace}</code></div>
                {(meta.finalizers || []).length > 0 && row('Finalizers', meta.finalizers.join(', '))}
              </div>
            </div>

            <div className="drawer-section">
              <div className="drawer-section-title">Reconciliation</div>
              <div className="argo-kv">
                {row('Interval', spec.interval)}
                {row('Last reconciled', s.lastReconciled ? new Date(s.lastReconciled).toLocaleString() : null)}
                {row('Revision', s.revision)}
              </div>
              {conds.length > 0 && (
                <div className="argo-status-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  {conds.map((c) => <Badge key={c.type} cls={c.status === 'True' ? (c.type === 'Ready' ? 'ok' : 'info') : 'bad'}>{c.type}</Badge>)}
                </div>
              )}
            </div>

            {(s.source || s.chart || spec.url || s.path || s.targetNamespace) && (
              <div className="drawer-section">
                <div className="drawer-section-title">Source</div>
                <div className="argo-kv">
                  {s.source && <div><span>Source</span><code className="flux-link" onClick={() => onViewChange?.(SOURCE_KIND_KEY[s.source.kind] || '')}>{s.source.kind}/{s.source.name}</code></div>}
                  {row('URL', spec.url)}
                  {row('Chart', s.chart)}
                  {row('Path', s.path)}
                  {row('Target namespace', s.targetNamespace)}
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
