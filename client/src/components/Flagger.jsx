import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';
import ContextMenu from './ContextMenu';
import { useToast } from './Toast';
import { askLabel } from '../aiConfig';
import useClickOutside from '../hooks/useClickOutside';

// Flagger — progressive delivery, auto-detected from the flagger.app CRDs.
// Canaries (with a live rollout view), MetricTemplates and AlertProviders, plus
// Restart / Suspend / Skip analysis / Delete actions and an Ask AI hand-off.
// Reuses the Argo CD + Flux styles.

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
  canary: { kind: 'Canary', label: 'Canaries' },
  metrictemplate: { kind: 'MetricTemplate', label: 'Metric Templates' },
  alertprovider: { kind: 'AlertProvider', label: 'Alert Providers' },
};

// status.phase → badge colour + wording.
const PHASE_CLASS = {
  Initializing: 'info', Initialized: 'ok', Waiting: 'warn', Progressing: 'info', WaitingPromotion: 'warn',
  Promoting: 'info', Finalising: 'info', Succeeded: 'ok', Failed: 'bad', Terminating: 'muted', Terminated: 'muted',
};
const PHASE_WORD = { WaitingPromotion: 'Waiting promotion' };
const ACTIVE_PHASES = new Set(['Progressing', 'Promoting', 'Finalising', 'Waiting', 'WaitingPromotion', 'Initializing']);
const phaseWord = (p) => PHASE_WORD[p] || p;

// Kinds Flagger generates that have a view in the app.
const GEN_TYPE = { Deployment: 'deployment', DaemonSet: 'daemonSet', Service: 'service' };

const Badge = ({ cls, children }) => <span className={`argo-badge ${cls}`}>{children}</span>;
const PhaseBadge = ({ c }) => (
  <span className="flagger-phase">
    <Badge cls={PHASE_CLASS[c.phase] || 'muted'}>{phaseWord(c.phase)}</Badge>
    {c.suspended && <Badge cls="purple">Suspended</Badge>}
  </span>
);

// Progress of the current release: traffic weight for canary strategies,
// iterations for A/B and blue/green.
const progressOf = (c) => {
  if (c.maxWeight) return { pct: Math.min(100, Math.round((c.weight / c.maxWeight) * 100)), label: `${c.weight}% / ${c.maxWeight}%` };
  if (c.maxIterations) return { pct: Math.min(100, Math.round((c.iterations / c.maxIterations) * 100)), label: `${c.iterations} / ${c.maxIterations} iterations` };
  return { pct: 0, label: '-' };
};
const Progress = ({ c, big }) => {
  const done = c.phase === 'Succeeded' || c.phase === 'Initialized';
  const p = progressOf(c);
  const pct = done ? 100 : p.pct;
  const cls = c.phase === 'Failed' ? 'bad' : done ? 'ok' : PHASE_CLASS[c.phase] === 'warn' ? 'warn' : 'info';
  return (
    <span className={`flagger-progress ${big ? 'big' : ''}`} title={p.label}>
      <span className="flagger-bar"><span className={`flagger-bar-fill ${cls}`} style={{ width: `${pct}%` }} /></span>
      <span className="flagger-progress-label">{done ? (c.phase === 'Succeeded' ? 'Promoted' : 'Idle') : p.label}</span>
    </span>
  );
};

export default function Flagger({ refreshSignal = 0, view, onNavigate }) {
  const toast = useToast();
  const sub = KINDS[view] ? view : 'canary';

  const [resources, setResources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [ns, setNs] = useState('all');
  const [phaseFilter, setPhaseFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { title, body, label, danger, run }
  const drawerRef = useRef(null);
  const selRef = useRef(null);
  selRef.current = selected;
  useClickOutside(drawerRef, () => setSelected(null));

  const load = async (silent = false) => {
    if (!silent) { setLoading(true); setError(null); }
    try { setResources((await axios.get('/api/flagger/resources', { params: { kind: sub } })).data.resources || []); }
    catch (e) { if (!silent) { setError(e.response?.data?.error || 'Failed to load Flagger resources'); setResources([]); } }
    finally { setLoading(false); }
  };
  // `keep` refreshes in place (no loader flash); a stale response for a
  // resource that is no longer selected is dropped.
  const loadDetail = (sel, keep = false) => {
    if (!sel) { setDetail(null); return; }
    if (!keep) setDetail(null);
    const key = `${sel.kindKey}/${sel.namespace}/${sel.name}`;
    axios.get(`/api/flagger/resource/${sel.kindKey}/${enc(sel.namespace)}/${enc(sel.name)}`)
      .then((r) => { const cur = selRef.current; if (cur && `${cur.kindKey}/${cur.namespace}/${cur.name}` === key) setDetail(r.data); })
      .catch(() => {});
  };

  useEffect(() => {
    setSelected(null); setQ(''); setNs('all'); setPhaseFilter('all'); setResources([]);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub]);
  useEffect(() => { load(true); if (selected) loadDetail(selected, true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [refreshSignal]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadDetail(selected); }, [selected]);

  // While a canary is mid-rollout, poll so the progress bar and events move.
  const rolling = resources.some((r) => ACTIVE_PHASES.has(r.phase) && !r.suspended);
  useEffect(() => {
    if (sub !== 'canary' || !rolling) return undefined;
    const t = setInterval(() => { load(true); if (selected) loadDetail(selected, true); }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, rolling, selected]);

  const reload = () => { load(true); if (selected) loadDetail(selected, true); };
  const post = async (r, action, okMsg) => {
    setBusy(true);
    try {
      const { data } = await axios.post(`/api/flagger/canary/${enc(r.namespace)}/${enc(r.name)}/${action}`);
      toast.success(okMsg || data.message, { title: r.name }); setConfirm(null); reload();
    } catch (e) { toast.error(e.response?.data?.error || e.message || 'Action failed', { title: r.name }); }
    finally { setBusy(false); }
  };
  const doDelete = async (r) => {
    setBusy(true);
    try { await axios.delete(`/api/flagger/resource/${r.kindKey}/${enc(r.namespace)}/${enc(r.name)}`); toast.success('Deleted', { title: r.name }); setConfirm(null); setSelected(null); load(true); }
    catch (e) { toast.error(e.response?.data?.error || e.message || 'Delete failed', { title: 'Delete' }); }
    finally { setBusy(false); }
  };

  const askRestart = (r) => setConfirm({
    title: 'Restart rollout', icon: 'refresh', label: 'Restart',
    body: <>Run <code>kubectl rollout restart</code> on <b>{r.target?.kind}/{r.target?.name}</b>? Flagger treats it as a new revision and {r.skipAnalysis ? <>promotes it straight away (analysis is <b>skipped</b>).</> : 'starts a new canary analysis.'}</>,
    run: () => post(r, 'restart'),
  });
  const askDelete = (r) => setConfirm({
    title: `Delete ${r.kind}`, icon: 'delete', label: 'Delete', danger: true,
    body: r.kindKey === 'canary'
      ? <>Delete canary <b>{r.name}</b> in <b>{r.namespace}</b>? Flagger removes the primary deployment and services it created{' '}(unless <code>revertOnDeletion</code> is off, in which case traffic stays on the primary). This cannot be undone.</>
      : <>Delete <b>{r.name}</b> in <b>{r.namespace}</b>? Canaries that reference it will fail their analysis. This cannot be undone.</>,
    run: () => doDelete(r),
  });
  const toggleSuspend = (r) => post(r, r.suspended ? 'resume' : 'suspend', r.suspended ? 'Resumed' : 'Suspended');
  const toggleSkip = (r) => post(r, r.skipAnalysis ? 'enable-analysis' : 'skip-analysis', r.skipAnalysis ? 'Analysis enabled' : 'Analysis will be skipped');

  const summarize = async (r) => {
    toast.info(`Summarizing ${r.name}…`, { title: askLabel() });
    let d = detail && selected && selected.name === r.name && selected.namespace === r.namespace ? detail : null;
    if (!d) { try { d = (await axios.get(`/api/flagger/resource/${r.kindKey}/${enc(r.namespace)}/${enc(r.name)}`)).data; } catch { d = { summary: r }; } }
    const s = d.summary || r;
    const a = d.analysis || {};
    const lines = r.kindKey !== 'canary' ? [
      `Explain the Flagger ${s.kind} "${s.name}" (namespace ${s.namespace}) and whether its configuration looks correct.`,
      s.provider ? `Provider: ${s.provider}${s.address ? ` at ${s.address}` : ''}.` : '',
      s.query ? `Query:\n${s.query}` : '',
      s.type ? `Type: ${s.type}${s.channel ? `, channel ${s.channel}` : ''}.` : '',
    ] : [
      `Analyze the Flagger canary "${s.name}" (namespace ${s.namespace}) targeting ${s.target?.kind}/${s.target?.name}.`,
      `Strategy: ${s.strategy}; mesh/ingress provider: ${s.provider || 'default'}.`,
      `Phase: ${s.phase}${s.suspended ? ' (suspended)' : ''}${s.skipAnalysis ? ' (analysis skipped)' : ''}. Progress: ${progressOf(s).label}. Failed checks: ${s.failedChecks}/${s.threshold ?? '?'}.`,
      s.message ? `Status message: ${s.message}` : '',
      (a.metrics || []).length ? `Metrics:\n${a.metrics.map((m) => `- ${m.name} ${JSON.stringify(m.thresholdRange || {})}${m.templateRef ? ` (template ${m.templateRef.name})` : ''}`).join('\n')}` : '',
      (a.webhooks || []).length ? `Webhooks:\n${a.webhooks.map((w) => `- ${w.name} (${w.type || 'rollout'}) ${w.url}`).join('\n')}` : '',
      (d.events || []).length ? `Recent events:\n${d.events.slice(0, 12).map((e) => `- [${e.type}] ${e.message}`).join('\n')}` : '',
      'Explain where the rollout is, why it is stuck or failed if so, and concrete next steps (e.g. fix metrics, open a gate, roll back).',
    ];
    window.dispatchEvent(new CustomEvent('assistant:ask', { detail: { prompt: lines.filter(Boolean).join('\n') } }));
  };

  const menuItems = (r) => {
    const items = [
      { icon: 'details', label: 'Show details', onClick: () => setSelected(r) },
      { icon: 'sparkles', label: `Summarize (${askLabel()})`, onClick: () => summarize(r) },
    ];
    if (r.kindKey === 'canary') {
      items.push({ icon: 'refresh', label: 'Restart rollout', onClick: () => askRestart(r) });
      items.push({ icon: r.suspended ? 'play' : 'pause', label: r.suspended ? 'Resume' : 'Suspend', onClick: () => toggleSuspend(r) });
      items.push({ icon: r.skipAnalysis ? 'check' : 'arrowRight', label: r.skipAnalysis ? 'Enable analysis' : 'Skip analysis', onClick: () => toggleSkip(r) });
    }
    items.push({ icon: 'delete', label: 'Delete', danger: true, onClick: () => askDelete(r) });
    return items;
  };

  const namespaces = useMemo(() => [...new Set(resources.map((r) => r.namespace).filter(Boolean))].sort(), [resources]);
  const counts = useMemo(() => {
    const c = { progressing: 0, waiting: 0, succeeded: 0, failed: 0 };
    for (const r of resources) {
      if (r.phase === 'Failed') c.failed++;
      else if (r.phase === 'WaitingPromotion' || r.phase === 'Waiting') c.waiting++;
      else if (ACTIVE_PHASES.has(r.phase)) c.progressing++;
      else if (r.phase === 'Succeeded' || r.phase === 'Initialized') c.succeeded++;
    }
    return c;
  }, [resources]);
  const phaseGroup = (r) => (r.phase === 'Failed' ? 'failed'
    : r.phase === 'WaitingPromotion' || r.phase === 'Waiting' ? 'waiting'
      : ACTIVE_PHASES.has(r.phase) ? 'progressing' : 'succeeded');
  const filtered = useMemo(() => resources.filter((r) =>
    (ns === 'all' || r.namespace === ns)
    && (phaseFilter === 'all' || phaseGroup(r) === phaseFilter)
    && (!q || `${r.name} ${r.namespace} ${r.target?.name || ''} ${r.provider || ''} ${r.type || ''}`.toLowerCase().includes(q.toLowerCase()))),
  [resources, ns, q, phaseFilter]);

  return (
    <div className="resource-viewer argo-view">
      {loading && resources.length === 0 ? (
        <div className="resource-table-wrapper"><Loader label="Loading Flagger…" /></div>
      ) : error ? (
        <div className="loading-indicator" style={{ color: 'var(--red)', padding: 24 }}>{error}</div>
      ) : (
        <>
          {sub === 'canary' && resources.length > 0 && (
            <div className="flagger-stats">
              {[
                ['progressing', 'In progress', 'refresh', 'info'],
                ['waiting', 'Waiting approval', 'timer', 'warn'],
                ['failed', 'Failed', 'warning', 'bad'],
                ['succeeded', 'Promoted / idle', 'check', 'ok'],
              ].map(([key, label, icon, cls]) => (
                <button type="button" key={key} className={`flagger-stat ${cls} ${phaseFilter === key ? 'active' : ''}`}
                  onClick={() => setPhaseFilter((f) => (f === key ? 'all' : key))} title={phaseFilter === key ? 'Clear filter' : `Show ${label.toLowerCase()}`}>
                  <span className="flagger-stat-icon"><Icon name={icon} size={15} /></span>
                  <span className="flagger-stat-num">{counts[key]}</span>
                  <span className="flagger-stat-label">{label}</span>
                </button>
              ))}
            </div>
          )}
          <FlaggerList
            kindKey={sub} resources={filtered} total={resources.length}
            q={q} setQ={setQ} ns={ns} setNs={setNs} namespaces={namespaces}
            onSelect={(r) => setSelected(r)} onMenu={(e, r) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, r }); }}
          />
        </>
      )}

      {selected && (
        <FlaggerDrawer
          ref={drawerRef} selected={selected} detail={detail} busy={busy}
          onClose={() => setSelected(null)} onNavigate={onNavigate}
          onRestart={askRestart} onSuspend={toggleSuspend} onSkip={toggleSkip} onSummarize={summarize}
          onDelete={() => askDelete(detail?.summary || selected)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.r)} onClose={() => setMenu(null)} />}
      {confirm && (
        <div className="action-modal-backdrop" onClick={() => !busy && setConfirm(null)}>
          <div className="action-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="action-modal-title"><Icon name={confirm.icon} size={16} /> {confirm.title}</h3>
            <p className="action-modal-body">{confirm.body}</p>
            <div className="action-modal-actions">
              <button className="action-modal-btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button className={`action-modal-btn primary ${confirm.danger ? 'danger' : ''}`} disabled={busy} onClick={confirm.run}>{busy ? 'Working…' : confirm.label}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- List ---------------- */
const LIST_COLS = {
  canary: [
    ['Status', (r) => <PhaseBadge c={r} />],
    ['Strategy', (r) => r.strategy],
    ['Target', (r) => (r.target ? `${r.target.kind}/${r.target.name}` : '-')],
    ['Progress', (r) => <Progress c={r} />],
    ['Failed checks', (r) => (r.threshold ? <span className={r.failedChecks >= r.threshold ? 'flagger-fail' : r.failedChecks ? 'flagger-warn' : ''}>{r.failedChecks}/{r.threshold}</span> : r.failedChecks)],
    ['Last transition', (r) => formatAge(r.lastTransition)],
  ],
  metrictemplate: [
    ['Provider', (r) => r.provider || '-'],
    ['Address', (r) => r.address || '-'],
  ],
  alertprovider: [
    ['Type', (r) => r.type || '-'],
    ['Channel', (r) => r.channel || '-'],
  ],
};

function FlaggerList({ kindKey, resources, total, q, setQ, ns, setNs, namespaces, onSelect, onMenu }) {
  const label = KINDS[kindKey].label;
  const cols = LIST_COLS[kindKey];
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
        {resources.length === 0 ? <div className="loading-indicator">No {label} {total ? 'match the filter' : 'found'}.</div> : (
          <table className="resource-table">
            <thead><tr>
              <th>Name</th><th>Namespace</th>{cols.map(([h]) => <th key={h}>{h}</th>)}<th>Age</th><th></th>
            </tr></thead>
            <tbody>
              {resources.map((r) => (
                <tr key={`${r.namespace}/${r.name}`} className="resource-table-row"
                  onClick={() => onSelect(r)} onContextMenu={(e) => onMenu(e, r)}>
                  <td>
                    <span className="resource-name-cell">{r.name}</span>
                    {r.skipAnalysis && <span className="flagger-skip-chip" title="spec.skipAnalysis is on: new revisions are promoted without analysis">skip analysis</span>}
                  </td>
                  <td>{r.namespace}</td>
                  {cols.map(([h, fn]) => <td key={h} className="flux-cell">{fn(r)}</td>)}
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

/* ---------------- Rollout timeline ---------------- */
// The stages a release walks through (docs.flagger.app "How it works").
const STAGES = [
  ['Progressing', 'Analysis'],
  ['WaitingPromotion', 'Approval'],
  ['Promoting', 'Promote'],
  ['Finalising', 'Finalise'],
  ['Succeeded', 'Done'],
];
const STAGE_INDEX = { Initializing: -1, Initialized: -1, Waiting: 0, Progressing: 0, WaitingPromotion: 1, Promoting: 2, Finalising: 3, Succeeded: 4, Failed: 0 };

function RolloutTimeline({ c }) {
  const idle = c.phase === 'Initialized' || c.phase === 'Initializing';
  const cur = STAGE_INDEX[c.phase] ?? -1;
  const failed = c.phase === 'Failed';
  const steps = c.stepWeights || (c.stepWeight && c.maxWeight
    ? Array.from({ length: Math.ceil(c.maxWeight / c.stepWeight) }, (_, i) => Math.min((i + 1) * c.stepWeight, c.maxWeight)) : null);
  return (
    <div className="flagger-rollout">
      <div className="flagger-stages">
        {STAGES.map(([key, label], i) => {
          const state = idle ? 'todo' : failed && i === 0 ? 'failed' : i < cur || c.phase === 'Succeeded' ? 'done' : i === cur ? 'current' : 'todo';
          return (
            <React.Fragment key={key}>
              {i > 0 && <span className={`flagger-stage-line ${state === 'done' || state === 'current' ? 'on' : ''}`} />}
              <span className={`flagger-stage ${state}`}>
                <span className="flagger-stage-dot">
                  {state === 'done' ? <Icon name="check" size={11} /> : state === 'failed' ? <Icon name="close" size={11} /> : i + 1}
                </span>
                <span className="flagger-stage-label">{failed && i === 0 ? 'Rolled back' : label}</span>
              </span>
            </React.Fragment>
          );
        })}
      </div>
      {steps && !idle && (
        <div className="flagger-steps" title="Canary traffic weight steps">
          {steps.map((w) => {
            const done = c.phase === 'Succeeded' || ['Promoting', 'Finalising', 'WaitingPromotion'].includes(c.phase) || w <= c.weight;
            return <span key={w} className={`flagger-step ${done ? (failed ? 'bad' : 'on') : ''}`}>{w}%</span>;
          })}
        </div>
      )}
      {!steps && c.maxIterations && !idle && (
        <div className="flagger-steps" title="Analysis iterations">
          {Array.from({ length: c.maxIterations }, (_, i) => i + 1).map((n) => {
            const done = c.phase === 'Succeeded' || n <= c.iterations;
            return <span key={n} className={`flagger-step dot ${done ? (failed ? 'bad' : 'on') : ''}`} title={`Iteration ${n}`} />;
          })}
        </div>
      )}
    </div>
  );
}

const rangeText = (r = {}) => {
  if (r.min != null && r.max != null) return `${r.min} – ${r.max}`;
  if (r.min != null) return `≥ ${r.min}`;
  if (r.max != null) return `≤ ${r.max}`;
  return '-';
};
const matchText = (m) => Object.entries(m.headers || {}).map(([h, v]) => `${h} ${Object.keys(v)[0]} "${Object.values(v)[0]}"`)
  .concat(Object.entries(m.sourceLabels || {}).map(([k, v]) => `source ${k}=${v}`)).join(' and ') || JSON.stringify(m);

/* ---------------- Detail drawer ---------------- */
const FlaggerDrawer = React.forwardRef(({ selected, detail, busy, onClose, onNavigate, onRestart, onSuspend, onSkip, onSummarize, onDelete }, ref) => {
  const s = detail?.summary || selected;
  const isCanary = s.kindKey === 'canary';
  const meta = detail?.metadata || {};
  const a = detail?.analysis || {};
  const row = (label, value) => (value || value === 0) ? <div><span>{label}</span><code>{value}</code></div> : null;
  const go = (kind, name, namespace) => GEN_TYPE[kind] && onNavigate?.toResource?.({ type: GEN_TYPE[kind], namespace, name });
  return (
    <div className="resource-drawer argo-drawer" ref={ref}>
      <div className="drawer-header">
        <div className="drawer-title">
          <div className="drawer-title-icon blue"><Icon name="flagger" size={18} /></div>
          <div className="drawer-title-text">
            <span className="drawer-kind">{s.kind}</span>
            <span className="drawer-name" title={s.name}>{s.name}</span>
          </div>
        </div>
        <div className="drawer-actions">
          <button className="drawer-action-btn" title={`Summarize (${askLabel()})`} onClick={() => onSummarize(s)}><Icon name="sparkles" size={16} /></button>
          {isCanary && <button className="drawer-action-btn" title="Restart rollout" disabled={busy || s.suspended} onClick={() => onRestart(s)}><Icon name="refresh" size={16} /></button>}
          {isCanary && <button className="drawer-action-btn" title={s.suspended ? 'Resume' : 'Suspend'} disabled={busy} onClick={() => onSuspend(s)}><Icon name={s.suspended ? 'play' : 'pause'} size={16} /></button>}
          <button className="drawer-action-btn danger" title="Delete" disabled={busy} onClick={onDelete}><Icon name="delete" size={16} /></button>
          <button className="drawer-action-btn" title="Close" onClick={onClose}><Icon name="close" size={17} /></button>
        </div>
      </div>

      <div className="drawer-body">
        {!detail ? <Loader label="Loading…" inline /> : (
          <>
            {isCanary && (
              <div className="drawer-section">
                <div className="drawer-section-title">Rollout</div>
                <div className="flagger-rollout-head">
                  <PhaseBadge c={s} />
                  <span className="flagger-rollout-when">{s.lastTransition ? `${formatAge(s.lastTransition)} ago` : ''}</span>
                </div>
                {s.message && <div className={`argo-msg ${s.phase === 'Failed' ? 'bad' : ''}`}>{s.message}</div>}
                <RolloutTimeline c={s} />
                <div className="flagger-rollout-stats">
                  <div><span>{s.maxWeight ? 'Canary weight' : 'Iterations'}</span><b>{s.maxWeight ? `${s.weight}% / ${s.maxWeight}%` : `${s.iterations} / ${s.maxIterations ?? '-'}`}</b></div>
                  <div><span>Failed checks</span><b className={s.threshold && s.failedChecks >= s.threshold ? 'flagger-fail' : s.failedChecks ? 'flagger-warn' : ''}>{s.failedChecks}{s.threshold ? ` / ${s.threshold}` : ''}</b></div>
                  <div><span>Interval</span><b>{s.interval || '-'}</b></div>
                </div>
                <div className="flagger-toggle-row">
                  <span>Skip analysis</span>
                  <button type="button" className={`flagger-switch ${s.skipAnalysis ? 'on' : ''}`} disabled={busy} onClick={() => onSkip(s)}
                    title={s.skipAnalysis ? 'New revisions are promoted without analysis. Click to enable analysis.' : 'Promote new revisions without running the analysis'}>
                    <span />
                  </button>
                </div>
              </div>
            )}

            <div className="drawer-section">
              <div className="drawer-section-title">Properties</div>
              <div className="argo-kv">
                {row('Created', meta.creationTimestamp ? `${formatAge(meta.creationTimestamp)} ago (${new Date(meta.creationTimestamp).toLocaleString()})` : '-')}
                {row('Name', s.name)}
                <div><span>Namespace</span><code className="flux-link" onClick={() => onNavigate?.toNamespace?.(s.namespace)}>{s.namespace}</code></div>
                {isCanary && s.target && <div><span>Target</span><code className="flux-link" onClick={() => go(s.target.kind, s.target.name, s.namespace)}>{s.target.kind}/{s.target.name}</code></div>}
                {isCanary && row('Strategy', s.strategy)}
                {row('Provider', s.provider)}
                {isCanary && row('Service', s.service ? `${s.service}${s.port ? `:${s.port}` : ''}` : null)}
                {isCanary && row('Autoscaler', s.autoscaler)}
                {row('Address', s.address)}
                {row('Type', s.type)}
                {row('Channel', s.channel)}
                {row('Username', s.username)}
              </div>
            </div>

            {s.query && (
              <div className="drawer-section">
                <div className="drawer-section-title">Query</div>
                <pre className="flagger-query">{s.query}</pre>
              </div>
            )}

            {(a.match || []).length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">A/B match conditions</div>
                <div className="flagger-match">
                  {a.match.map((m, i) => <code key={i}>{i > 0 && <span className="flagger-or">or</span>}{matchText(m)}</code>)}
                </div>
              </div>
            )}

            {(a.metrics || []).length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">Metrics ({a.metrics.length})</div>
                <FlaggerTable head={['Metric', 'Threshold', 'Interval']} rows={a.metrics.map((m) => [
                  <span key="n" className="flagger-metric">{m.name}{m.templateRef && <span className="flagger-tpl" title="MetricTemplate">template: {m.templateRef.name}</span>}</span>,
                  rangeText(m.thresholdRange), m.interval || '-',
                ])} />
              </div>
            )}

            {(a.webhooks || []).length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">Webhooks ({a.webhooks.length})</div>
                <FlaggerTable head={['Name', 'Type', 'URL']} rows={a.webhooks.map((w) => [
                  w.name, <span key="t" className="flux-kind-chip">{w.type || 'rollout'}</span>, <span key="u" className="flagger-url" title={w.url}>{w.url}</span>,
                ])} />
              </div>
            )}

            {(a.alerts || []).length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">Alerts</div>
                <FlaggerTable head={['Name', 'Severity', 'Provider']} rows={a.alerts.map((al) => [al.name, al.severity || 'info', al.providerRef?.name || '-'])} />
              </div>
            )}

            {(detail.generated || []).length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">Generated objects ({detail.generated.length})</div>
                <FlaggerTable head={['Kind', 'Name', 'Role']} rows={detail.generated.map((g) => [
                  g.kind === 'HorizontalPodAutoscaler' ? <span key="k" title={g.kind}>HPA</span> : g.kind,
                  GEN_TYPE[g.kind] ? <span key="n" className="flux-link" onClick={() => go(g.kind, g.name, g.namespace)}>{g.name}</span> : g.name,
                  <span key="r" className="flagger-role">{g.role}</span>,
                ])} />
              </div>
            )}

            {(detail.events || []).length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">Events ({detail.events.length})</div>
                <div className="argo-events">
                  {detail.events.map((e, i) => (
                    <div key={i} className={`argo-event ${e.type === 'Warning' ? 'warn' : ''}`}>
                      <span className="argo-event-reason">{e.type === 'Warning' ? 'Warning' : 'Normal'}</span>
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
FlaggerDrawer.displayName = 'FlaggerDrawer';

function FlaggerTable({ head, rows }) {
  return (
    <div className="resource-table-wrapper flagger-table" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
      <table className="resource-table">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
