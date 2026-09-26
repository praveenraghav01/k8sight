import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

const TABS = [
  ['overview', 'Overview'],
  ['namespaces', 'Namespaces'],
  ['workloads', 'Workloads'],
  ['nodes', 'Nodes'],
];
const WINDOWS = [
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['month', 'Month to date'],
];
const buildOpenCostInstallCommand = (prometheus) => {
  const lines = [
    'helm repo add opencost-charts https://opencost.github.io/opencost-helm-chart',
    'helm repo update',
    'helm upgrade --install opencost opencost-charts/opencost \\',
    '  --namespace opencost --create-namespace \\',
    '  --set opencost.ui.enabled=false \\',
    '  --set opencost.mcp.enabled=false \\',
    '  --set opencost.exporter.resources.requests.cpu=10m \\',
    '  --set opencost.exporter.resources.requests.memory=55Mi \\',
  ];

  if (prometheus?.installed && prometheus.ready) {
    lines.push(
      '  --set opencost.exporter.collectorDataSource.enabled=false \\',
      '  --set opencost.prometheus.internal.enabled=true \\',
      `  --set opencost.prometheus.internal.serviceName=${prometheus.service} \\`,
      `  --set opencost.prometheus.internal.namespaceName=${prometheus.namespace} \\`,
      `  --set opencost.prometheus.internal.port=${prometheus.port}`
    );
  } else {
    lines.push(
      '  --set opencost.exporter.collectorDataSource.enabled=true \\',
      '  --set opencost.prometheus.internal.enabled=false \\',
      '  --set opencost.exporter.collectorDataSource.retention1d=30 \\',
      '  --set opencost.exporter.persistence.enabled=true \\',
      '  --set opencost.exporter.persistence.mountPath=/var/configs \\',
      '  --set opencost.exporter.persistence.accessMode=ReadWriteOnce \\',
      '  --set opencost.exporter.persistence.size=1Gi \\',
      '  --set podSecurityContext.fsGroup=1001'
    );
  }
  return lines.join('\n');
};
const AGGREGATE = { overview: 'namespace', namespaces: 'namespace', workloads: 'controller', nodes: 'node' };
const COST_PARTS = [
  ['cpuCost', 'CPU', '#58a6ff'],
  ['memoryCost', 'Memory', '#bc8cff'],
  ['pvCost', 'Storage', '#3fb950'],
  ['networkCost', 'Network', '#d29922'],
  ['loadBalancerCost', 'Load balancers', '#f778ba'],
  ['gpuCost', 'GPU', '#79c0ff'],
  ['sharedCost', 'Shared', '#8b949e'],
  ['externalCost', 'External', '#e3b341'],
];
const defaultManualConfig = (provider = 'opencost') => provider === 'kubecost'
  ? { provider, namespace: 'kubecost', service: 'kubecost-frontend', port: '9090' }
  : { provider: 'opencost', namespace: 'opencost', service: 'opencost', port: '9003' };
const configStorageKey = (context) => `k8sight.costs.service.${context || 'default'}`;
const readManualConfig = (context) => {
  try {
    const value = JSON.parse(localStorage.getItem(configStorageKey(context)) || 'null');
    return value && ['opencost', 'kubecost'].includes(value.provider) ? value : null;
  } catch { return null; }
};

const formatMoney = (value) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Number.isFinite(Number(value)) ? Number(value) : 0);

const rowLabel = (name) => {
  if (name === '__idle__' || name?.startsWith('__idle__/')) return 'Cluster idle';
  if (name === '__unallocated__') return 'Unallocated';
  return name || 'Unknown allocation';
};

function AllocationTable({ rows, limit }) {
  const visible = limit ? rows.slice(0, limit) : rows;
  if (!visible.length) return <div className="cost-empty">No allocation data for this period.</div>;
  return (
    <div className="cost-table-scroll">
      <table className="cost-table">
        <thead>
          <tr><th>Name</th><th>CPU</th><th>Memory</th><th>Storage</th><th>Network</th><th>Shared</th><th>Other</th><th>Total</th></tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={row.name}>
              <td className="cost-name" title={row.name}>{rowLabel(row.name)}</td>
              <td>{formatMoney(row.cpuCost)}</td>
              <td>{formatMoney(row.memoryCost)}</td>
              <td>{formatMoney(row.pvCost)}</td>
              <td>{formatMoney(Number(row.networkCost || 0) + Number(row.loadBalancerCost || 0))}</td>
              <td>{formatMoney(row.sharedCost)}</td>
              <td>{formatMoney(row.externalCost)}</td>
              <td className="cost-total-cell">{formatMoney(row.totalCost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Cost-over-time area chart. Uniform-scaling SVG (fixed viewBox) so it fills the
// panel width without distorting. Needs at least two points to draw a trend.
// Categorical palette for the per-namespace stacked bars; "Other" is grey.
const COST_COLORS = ['#3b82f6', '#f97316', '#22c55e', '#eab308', '#ec4899', '#a855f7'];
const COST_OTHER_COLOR = '#8e8e93';

const niceCeil = (m) => {
  if (!(m > 0)) return 0.1;
  const pow = Math.pow(10, Math.floor(Math.log10(m)));
  for (const s of [1, 2, 2.5, 5, 10]) if (pow * s >= m) return pow * s;
  return pow * 10;
};

// Cost over time, stacked per namespace (top 6 + Other), with a legend showing
// each namespace's window total and share. Uniform-scaling SVG fills the panel.
function CostTrend({ series, window }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null); // { i, mx, my }
  const points = Array.isArray(series?.series) ? series.series.filter((p) => p && p.start && p.costs) : [];
  const namespaces = Array.isArray(series?.namespaces) ? series.namespaces.filter((n) => n.totalCost > 0) : [];
  if (!points.length || !namespaces.length) {
    return <div className="cost-empty">Not enough data yet for a breakdown — this fills in once the cost provider has collected some history.</div>;
  }
  const TOP = 6;
  const top = namespaces.slice(0, TOP);
  const rest = namespaces.slice(TOP);
  const grand = series.totalCost || namespaces.reduce((s, n) => s + n.totalCost, 0) || 1;
  const legend = [
    ...top.map((n, i) => ({ name: n.name, total: n.totalCost, color: COST_COLORS[i % COST_COLORS.length] })),
    ...(rest.length ? [{ name: `Other (${rest.length})`, total: rest.reduce((s, n) => s + n.totalCost, 0), color: COST_OTHER_COLOR }] : []),
  ];
  const topNames = top.map((n) => n.name);
  const stacks = points.map((p) => {
    const vals = topNames.map((nm) => p.costs[nm] || 0);
    return rest.length ? [...vals, rest.reduce((s, n) => s + (p.costs[n.name] || 0), 0)] : vals;
  });
  const yMax = niceCeil(Math.max(...stacks.map((v) => v.reduce((a, b) => a + b, 0)), 0) * 1.05);

  const W = 900, H = 300, ML = 52, MR = 10, MT = 12, MB = 28;
  const plotH = H - MT - MB;
  const n = points.length;
  const slot = (W - ML - MR) / n;
  const barW = Math.min(slot * 0.72, 46);
  const yTo = (v) => MT + plotH - (v / yMax) * plotH;
  const yTicks = Array.from({ length: 6 }, (_, i) => (yMax / 5) * i);
  const fmtT = (s) => { try { const d = new Date(s); return (window === '24h' || window === 'today') ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; } };
  const fmtFull = (s) => { try { return new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  const fmtFine = (v) => (v >= 1 ? formatMoney(v) : `$${v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') || '0'}`);
  const xEvery = Math.max(1, Math.ceil(n / 8));
  const onMove = (e, i) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setHover({ i, mx: e.clientX - r.left, my: e.clientY - r.top });
  };

  return (
    <div className="cost-trend" ref={wrapRef} style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Cost over time by namespace">
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={ML} y1={yTo(t)} x2={W - MR} y2={yTo(t)} stroke="var(--border, #333336)" strokeOpacity="0.55" strokeWidth="1" />
            <text x={ML - 6} y={yTo(t) + 3.5} textAnchor="end" fontSize="11" fill="var(--text-muted)">{formatMoney(t)}</text>
          </g>
        ))}
        {hover && <rect x={ML + hover.i * slot} y={MT} width={slot} height={plotH} fill="var(--text, #f5f5f7)" opacity="0.06" />}
        {points.map((p, i) => {
          const x0 = ML + i * slot + (slot - barW) / 2;
          let acc = 0;
          return (
            <g key={`b${i}`}>
              {stacks[i].map((v, si) => {
                if (v <= 0) return null;
                const y1 = yTo(acc + v); const y0 = yTo(acc); acc += v;
                return <rect key={si} x={x0} y={y1} width={barW} height={Math.max(0, y0 - y1)} fill={legend[si].color} />;
              })}
            </g>
          );
        })}
        {/* transparent full-height hit areas for hover */}
        {points.map((p, i) => (
          <rect key={`hit${i}`} x={ML + i * slot} y={MT} width={slot} height={plotH} fill="transparent"
            onMouseEnter={(e) => onMove(e, i)} onMouseMove={(e) => onMove(e, i)} style={{ cursor: 'pointer' }} />
        ))}
        {points.map((p, i) => (i % xEvery === 0
          ? <text key={`x${i}`} x={ML + i * slot + slot / 2} y={H - 9} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{fmtT(p.start)}</text>
          : null))}
      </svg>
      {hover && points[hover.i] && (() => {
        const rows = legend.map((l, si) => ({ ...l, v: stacks[hover.i][si] })).filter((r) => r.v > 0);
        const cw = wrapRef.current?.clientWidth || W;
        const left = Math.max(0, Math.min(hover.mx + 14, cw - 210));
        return (
          <div style={{ position: 'absolute', left, top: Math.max(0, hover.my - 12), pointerEvents: 'none', background: 'var(--bg-elevated)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '10px 12px', boxShadow: '0 8px 24px rgba(0,0,0,0.25)', zIndex: 5, minWidth: 190 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>{fmtFull(points[hover.i].start)}</div>
            {rows.map((r) => (
              <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, lineHeight: 1.75 }}>
                <i style={{ width: 10, height: 10, borderRadius: 2, background: r.color, flex: 'none' }} />
                <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{r.name}</span>
                <b>{fmtFine(r.v)}</b>
              </div>
            ))}
          </div>
        );
      })()}
      <div className="cost-trend-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 22px', marginTop: 14, paddingLeft: 12, paddingBottom: 10 }}>
        {legend.map((l) => (
          <span key={l.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
            <i style={{ width: 11, height: 11, borderRadius: 3, background: l.color, display: 'inline-block', flex: 'none' }} />
            <b style={{ fontWeight: 600 }}>{l.name}</b>
            <span style={{ color: 'var(--text-muted)' }}>{formatMoney(l.total)} · {Math.round((l.total / grand) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function CostsCenter({ view, onViewChange, refreshSignal = 0, context }) {
  const [localTab, setLocalTab] = useState('overview');
  const tab = view || localTab;
  const setTab = (next) => { setLocalTab(next); onViewChange?.(next); };
  const [window, setWindow] = useState('7d');
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const statusIdentityRef = useRef(null);
  const [data, setData] = useState(null);
  const [series, setSeries] = useState(null);
  const [dataQueryKey, setDataQueryKey] = useState(null);
  const [loading, setLoading] = useState(false);
  const costQueryKeyRef = useRef(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [installCopyState, setInstallCopyState] = useState('idle');
  const [refreshCount, setRefreshCount] = useState(0);
  const [manualConfig, setManualConfig] = useState(() => readManualConfig(context));
  const [configDraft, setConfigDraft] = useState(() => readManualConfig(context) || defaultManualConfig());
  const [configOpen, setConfigOpen] = useState(false);
  const [configError, setConfigError] = useState('');
  const aggregate = AGGREGATE[tab] || 'namespace';
  const prometheus = status?.prometheus?.installed && status.prometheus.ready ? status.prometheus : null;
  const installCommand = buildOpenCostInstallCommand(prometheus);
  const costQueryKey = status?.installed ? JSON.stringify({
    context: context || '', window, aggregate, manualConfig: manualConfig || null,
    provider: status.provider, namespace: status.namespace, service: status.service, port: status.port,
  }) : null;

  const copyInstallCommand = async () => {
    try {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
        await navigator.clipboard.writeText(installCommand);
      } catch {
        const textarea = document.createElement('textarea');
        textarea.value = installCommand;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        let copied = false;
        try {
          textarea.focus();
          textarea.select();
          copied = document.execCommand('copy');
        } finally {
          textarea.remove();
        }
        if (!copied) throw new Error('Could not copy install command');
      }
      setInstallCopyState('copied');
      window.setTimeout(() => setInstallCopyState('idle'), 1600);
    } catch {
      setInstallCopyState('error');
    }
  };

  useEffect(() => {
    let active = true;
    const identity = JSON.stringify({ context: context || '', manualConfig: manualConfig || null });
    const identityChanged = statusIdentityRef.current !== identity;
    statusIdentityRef.current = identity;
    if (identityChanged) {
      setStatusLoading(true);
      setStatus(null);
      setData(null);
      setDataQueryKey(null);
      setLoading(false);
      setError(null);
    }
    const params = { ...(manualConfig || {}), ...(!manualConfig && refreshCount ? { refresh: 1 } : {}) };
    axios.get('/api/costs/status', { params })
      .then(({ data: result }) => { if (active) setStatus(result); })
      .catch((err) => {
        if (active) setStatus((previous) => previous || { installed: false, error: err.response?.data?.error || err.message });
      })
      .finally(() => { if (active) setStatusLoading(false); });
    return () => { active = false; };
  }, [context, manualConfig, refreshSignal, refreshCount]);

  useEffect(() => {
    if (!status?.installed) {
      setData(null);
      setDataQueryKey(null);
      setLoading(false);
      costQueryKeyRef.current = null;
      return undefined;
    }
    let active = true;
    const queryChanged = costQueryKeyRef.current !== costQueryKey;
    costQueryKeyRef.current = costQueryKey;
    if (queryChanged) setError(null);
    setLoading(true);
    axios.get('/api/costs/allocation', { params: { window, aggregate, ...(manualConfig || {}) } })
      .then(({ data: result }) => {
        if (active) {
          setData(result);
          setDataQueryKey(costQueryKey);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(err.response?.data?.error || err.message || 'Failed to load cost allocation.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [status, window, aggregate, manualConfig, context, costQueryKey]);

  // Cost-over-time trend (cluster total per day/hour) for the Overview chart.
  useEffect(() => {
    if (!status?.installed) { setSeries(null); return undefined; }
    let active = true;
    axios.get('/api/costs/timeseries', { params: { window, ...(manualConfig || {}) } })
      .then(({ data: result }) => { if (active) setSeries(result); })
      .catch(() => { if (active) setSeries(null); });
    return () => { active = false; };
  }, [status, window, manualConfig, context, costQueryKey]);

  const openConfig = () => {
    const source = manualConfig || (status?.installed ? {
      provider: status.provider,
      namespace: status.namespace,
      service: status.service,
      port: String(status.port),
    } : defaultManualConfig());
    setConfigDraft(source);
    setConfigError('');
    setConfigOpen((open) => !open);
  };

  const saveConfig = (event) => {
    event.preventDefault();
    const next = {
      provider: configDraft.provider,
      namespace: String(configDraft.namespace || '').trim(),
      service: String(configDraft.service || '').trim(),
      port: Number(configDraft.port),
    };
    if (!next.namespace || !next.service || !Number.isInteger(next.port) || next.port < 1 || next.port > 65535) {
      setConfigError('Enter a namespace, Service name, and port from 1 to 65535.');
      return;
    }
    try { localStorage.setItem(configStorageKey(context), JSON.stringify(next)); }
    catch { setConfigError('Could not save this configuration in local storage.'); return; }
    setManualConfig(next);
    setConfigOpen(false);
    setRefreshCount((n) => n + 1);
  };

  const useAutoDetection = () => {
    try { localStorage.removeItem(configStorageKey(context)); } catch { /* ignore local storage errors */ }
    setManualConfig(null);
    setConfigOpen(false);
    setRefreshCount((n) => n + 1);
  };

  const allocations = data?.allocations || [];
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? allocations.filter((row) => rowLabel(row.name).toLowerCase().includes(q)) : allocations;
  }, [allocations, query]);
  const mix = useMemo(() => COST_PARTS.map(([key, label, color]) => ({
    key, label, color,
    value: allocations.reduce((sum, row) => sum + (Number(row[key]) || 0), 0),
  })).filter((part) => part.value > 0), [allocations]);
  const biggest = allocations[0];
  const hasCurrentData = Boolean(data && dataQueryKey === costQueryKey);

  return (
    <div className="cost-view">
      <div className="cost-head">
        <div className="cost-title">
          <Icon name="costs" size={21} />
          <h1>Costs</h1>
          {status?.installed && <span className="cost-provider">{status.provider === 'opencost' ? 'OpenCost' : 'Kubecost'}</span>}
          {status?.prometheus?.installed && <span className="cost-provider" title={`${status.prometheus.namespace}/${status.prometheus.service}:${status.prometheus.port}`}>
            {status.openCostUsesPrometheus ? 'Prometheus connected' : 'Prometheus detected'}
          </span>}
          {status?.manual && <span className="cost-manual-badge">manual</span>}
        </div>
        <div className="cost-controls">
          {status?.installed && <span className="cost-source" title={`${status.namespace}/${status.service}`}>{status.namespace}/{status.service}</span>}
          <button className="cost-config-btn" onClick={openConfig}><Icon name="settings" size={14} /> Configure</button>
          <select aria-label="Cost period" className="cost-window" value={window} onChange={(e) => setWindow(e.target.value)}>
            {WINDOWS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button className="cost-refresh" onClick={() => setRefreshCount((n) => n + 1)} disabled={statusLoading || loading} title="Refresh costs">
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </div>
      </div>

      <div className="cost-tabs">
        {TABS.map(([key, label]) => (
          <button key={key} className={`cost-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {status?.prometheus?.installed && (
        <div className={`cost-prometheus-banner${status.openCostUsesPrometheus ? ' connected' : ''}`}>
          <strong>{status.openCostUsesPrometheus ? 'Using existing Prometheus' : 'Existing Prometheus detected'}</strong>
          <span>{status.prometheus.namespace}/{status.prometheus.service}:{status.prometheus.port}
            {status.prometheus.version ? ` · Prometheus ${status.prometheus.version}` : ''}
          </span>
          <p>{status.openCostUsesPrometheus
            ? 'OpenCost is querying this in-cluster Prometheus for cost allocation.'
            : 'New OpenCost installation commands will use this Prometheus instead of running a separate collector.'}
          </p>
        </div>
      )}

      {configOpen && (
        <form className="cost-config" onSubmit={saveConfig}>
          <div className="cost-config-heading">
            <div><strong>Cost provider Service</strong><span>Saved locally for {context || 'this kube context'}.</span></div>
            <button type="button" className="cost-config-close" onClick={() => setConfigOpen(false)} aria-label="Close configuration">×</button>
          </div>
          <div className="cost-config-fields">
            <label>Provider
              <select value={configDraft.provider} onChange={(e) => setConfigDraft(defaultManualConfig(e.target.value))}>
                <option value="opencost">OpenCost</option>
                <option value="kubecost">Kubecost</option>
              </select>
            </label>
            <label>Namespace<input value={configDraft.namespace} onChange={(e) => setConfigDraft((d) => ({ ...d, namespace: e.target.value }))} required /></label>
            <label>Service<input value={configDraft.service} onChange={(e) => setConfigDraft((d) => ({ ...d, service: e.target.value }))} required /></label>
            <label>Port<input type="number" min="1" max="65535" value={configDraft.port} onChange={(e) => setConfigDraft((d) => ({ ...d, port: e.target.value }))} required /></label>
          </div>
          {configError && <div className="cost-config-error">{configError}</div>}
          <div className="cost-config-actions">
            <button type="button" className="cost-config-clear" onClick={useAutoDetection}>Use automatic detection</button>
            <span />
            <button type="button" className="cost-config-cancel" onClick={() => setConfigOpen(false)}>Cancel</button>
            <button type="submit" className="cost-config-save">Save and connect</button>
          </div>
        </form>
      )}

      <div className="cost-body">
        {statusLoading ? <div className="cost-state"><Loader label="Looking for OpenCost or Kubecost…" /></div> : !status?.installed ? (
          <div className="sec-setup cost-setup">
            <div className="sec-setup-icon cost-setup-icon"><Icon name="costs" size={38} /></div>
            <h2>Install lightweight cost monitoring</h2>
            {prometheus ? (
              <p>Found Prometheus at <strong>{prometheus.namespace}/{prometheus.service}:{prometheus.port}</strong>. OpenCost will query this existing service; it will not run a duplicate collector or Prometheus.</p>
            ) : (
              <p>Recommended: <strong>OpenCost Collector</strong>. This configuration runs without a separate Prometheus or OpenCost UI and stores the collector’s 30-day history on an initial 1 GiB volume.</p>
            )}
            <p className="cost-setup-resource-note">One OpenCost pod · resource requests: 10m CPU / 55Mi memory.{prometheus ? '' : ' The cluster needs a default StorageClass; increase the volume for larger clusters.'}</p>
            <div className="cost-setup-code">
              <div className="cost-setup-code-head">
                <span>{prometheus ? 'Install using existing Prometheus' : 'Install with Helm'}</span>
                <button type="button" className="cost-setup-copy" onClick={copyInstallCommand} aria-live="polite">
                  <Icon name={installCopyState === 'copied' ? 'check' : installCopyState === 'error' ? 'warning' : 'copy'} size={13} />
                  {installCopyState === 'copied' ? 'Copied' : installCopyState === 'error' ? 'Copy failed' : 'Copy command'}
                </button>
              </div>
              <div className="sec-setup-cmd"><pre><code>{installCommand}</code></pre></div>
              {installCopyState === 'error' && <p className="cost-setup-copy-error" role="alert">Could not access the clipboard. Select the command and copy it manually.</p>}
            </div>
            <a className="sec-link" href="https://opencost.io/docs/installation/helm/" target="_blank" rel="noreferrer">OpenCost Helm installation guide <Icon name="externalLink" size={12} /></a>
            <div className="cost-setup-actions">
              {status?.error && <div className="cost-error">{status.error}</div>}
              <button className="cost-refresh" onClick={() => setRefreshCount((n) => n + 1)}><Icon name="refresh" size={14} /> Check again</button>
              <span>Already have Kubecost or OpenCost? Use Configure to connect it.</span>
            </div>
          </div>
        ) : loading && !hasCurrentData ? <div className="cost-state"><Loader label="Loading cost allocation…" /></div> : error && !hasCurrentData ? (
          <div className="cost-state">
            <Icon name="warning" size={30} />
            <h2>Cost data is unavailable</h2>
            <p>{error}</p>
            <p className="cost-state-note">Check that the selected kube context can access the provider Service proxy.</p>
            <button className="cost-refresh" onClick={() => setRefreshCount((n) => n + 1)}><Icon name="refresh" size={14} /> Retry</button>
          </div>
        ) : (
          <>
            {error && <div className="cost-error cost-refresh-error" role="status">Refresh failed: {error} Showing the last successful result.</div>}
            {data?.idleCostUnavailable === true && <div className="cost-idle-warning" role="status">
              OpenCost returned no Node assets for this period, so its idle cost is {formatMoney(data.idleCost)} and may be incomplete. The total can exclude unreported idle infrastructure cost.
            </div>}
            {tab === 'overview' ? (
              <>
                <div className="cost-kpis">
                  <article className="cost-kpi main">
                    <span className="cost-kpi-label">{data?.idleIncluded ? 'Total incl. idle bucket' : 'Allocated cost'}</span>
                    <strong>{formatMoney(data?.totalCost)}</strong>
                    <span className="cost-kpi-note">{WINDOWS.find(([value]) => value === window)?.[1] || window} · USD</span>
                  </article>
                  {data?.idleIncluded && <article className="cost-kpi">
                    <span className="cost-kpi-label">Idle cost</span>
                    <strong>{formatMoney(data.idleCost)}</strong>
                    <span className="cost-kpi-note">{data.idleCostUnavailable === true ? 'Provider returned no Node assets' : 'Reported by OpenCost'}</span>
                  </article>}
                  <article className="cost-kpi">
                    <span className="cost-kpi-label">Allocations</span>
                    <strong>{allocations.length}</strong>
                    <span className="cost-kpi-note">{tab === 'overview' ? 'namespaces' : 'items'}</span>
                  </article>
                  <article className="cost-kpi">
                    <span className="cost-kpi-label">Largest allocation</span>
                    <strong className="cost-kpi-name" title={biggest?.name}>{biggest ? rowLabel(biggest.name) : '—'}</strong>
                    <span className="cost-kpi-note">{biggest ? formatMoney(biggest.totalCost) : 'No cost data'}</span>
                  </article>
                </div>

                <section className="cost-panel" style={{ marginBottom: 16 }}>
                  <div className="cost-panel-title">Cost over time</div>
                  <CostTrend series={series} window={window} />
                </section>

                <div className="cost-panels">
                  <section className="cost-panel">
                    <div className="cost-panel-title">Cost breakdown</div>
                    {mix.length ? <div className="cost-breakdown">
                      {mix.map((part) => {
                        const pct = data?.totalCost > 0 ? Math.min(100, (part.value / data.totalCost) * 100) : 0;
                        return <div className="cost-part" key={part.key}>
                          <div className="cost-part-head"><span>{part.label}</span><b>{formatMoney(part.value)}</b></div>
                          <div className="cost-bar"><i style={{ width: `${pct}%`, background: part.color }} /></div>
                        </div>;
                      })}
                    </div> : <div className="cost-empty">No cost breakdown available.</div>}
                  </section>
                  <section className="cost-panel">
                    <div className="cost-panel-title">Top namespaces</div>
                    <AllocationTable rows={allocations} limit={6} />
                  </section>
                </div>
              </>
            ) : (
              <>
                <div className="cost-list-head">
                  <div>
                    <h2>{TABS.find(([key]) => key === tab)?.[1] || 'Allocations'}</h2>
                    <span>{allocations.length} allocations · {WINDOWS.find(([value]) => value === window)?.[1]?.toLowerCase()}</span>
                  </div>
                  <label className="cost-search"><Icon name="search" size={14} /><input placeholder={`Filter ${tab}…`} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
                </div>
                <AllocationTable rows={visibleRows} />
              </>
            )}
            <p className="cost-footnote">Allocation estimates come from {status.provider === 'opencost' ? 'OpenCost' : 'Kubecost'} and follow its pricing configuration; they may differ from billed cloud charges.</p>
          </>
        )}
      </div>
    </div>
  );
}
