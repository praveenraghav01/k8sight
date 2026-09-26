import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

const COLORS = {
  running: '#3fb950',
  pending: '#d29922',
  failed: '#f85149',
  idle: '#30363d'
};

const fmtBytes = (bytes) => {
  if (!bytes) return '0';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TiB`;
  return `${gib.toFixed(1)} GiB`;
};

const fmtCpuUsage = (milli) => {
  if (milli == null) return '—';
  return milli < 1000 ? `${Math.round(milli)}m` : `${(milli / 1000).toFixed(2)} cores`;
};

const fmtMemoryUsage = (bytes) => bytes == null ? '—' : fmtBytes(bytes);

function Donut({ segments, centerNum, centerLabel }) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let offset = 0;
  return (
    <div className="donut">
      <svg width="130" height="130" viewBox="0 0 130 130">
        <circle cx="65" cy="65" r={r} fill="none" stroke={COLORS.idle} strokeWidth="16" />
        {segments.map((seg, i) => {
          if (seg.value <= 0) return null;
          const len = (seg.value / total) * c;
          const el = (
            <circle
              key={i}
              cx="65" cy="65" r={r} fill="none"
              stroke={seg.color} strokeWidth="16"
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="donut-center">
        <div>
          <div className="num">{centerNum}</div>
          <div className="lbl">{centerLabel}</div>
        </div>
      </div>
    </div>
  );
}

function CapacityBar({ label, icon, used, total, unit, color }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="bar-row">
      <div className="bar-head">
        <span className="name"><Icon name={icon} size={14} /> {label}</span>
        <span className="val">{used}{unit} / {total}{unit}</span>
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export default function Cluster({ refreshSignal = 0 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // First load shows the loader; every later refresh re-fetches in place, so the
  // numbers just change instead of the page blanking out.
  const didMount = useRef(false);
  useEffect(() => {
    fetchSummary({ silent: didMount.current });
    didMount.current = true;
  }, [refreshSignal]);

  const fetchSummary = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await axios.get('/api/cluster/summary');
      setData(res.data);
      setError(res.data?.error || null);
    } catch (err) {
      // A background reload keeps the last good data on screen rather than
      // replacing it with an error the user didn't ask for.
      if (!silent) setError(`Failed to load cluster summary: ${err.response?.data?.error || err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const phases = data?.pods?.phases || {};
  const healthSegments = [
    { label: 'Running', value: (phases.Running || 0) + (phases.Succeeded || 0), color: COLORS.running },
    { label: 'Pending', value: phases.Pending || 0, color: COLORS.pending },
    { label: 'Failed', value: (phases.Failed || 0) + (phases.Unknown || 0), color: COLORS.failed }
  ];
  const podTotal = data?.pods?.total || 0;
  const healthyPct = podTotal ? Math.round((healthSegments[0].value / podTotal) * 100) : 0;

  const nodeSegments = [
    { label: 'Ready', value: data?.nodes?.ready || 0, color: COLORS.running },
    { label: 'Not Ready', value: data?.nodes?.notReady || 0, color: COLORS.failed }
  ];
  const nodeTotal = data?.nodes?.total || 0;
  const nodeReadyPct = nodeTotal ? Math.round(((data?.nodes?.ready || 0) / nodeTotal) * 100) : 0;

  const cap = data?.capacity || {};
  const resources = data?.resourceUsage || {};
  const roleEntries = Object.entries(data?.roles || {});

  const kpis = data ? [
    { label: 'Nodes', value: `${data.nodes.ready}/${data.nodes.total}`, sub: 'ready', icon: 'nodes', tone: 'blue' },
    {
      label: 'CPU Cores', value: cap.cpuCapacity, sub: `${cap.cpuAllocatable} allocatable`, icon: 'cpu', tone: 'green',
      resourceLine: `Usage ${fmtCpuUsage(resources.cpuMilli)} · Request ${fmtCpuUsage(resources.cpuRequestsMilli)} · Limit ${fmtCpuUsage(resources.cpuLimitsMilli)}`,
      resourceSource: resources.cpuSource
    },
    {
      label: 'Memory', value: fmtBytes(cap.memCapacityBytes), sub: `${fmtBytes(cap.memAllocatableBytes)} alloc`, icon: 'memory', tone: 'purple',
      resourceLine: `Usage ${fmtMemoryUsage(resources.memBytes)} · Request ${fmtMemoryUsage(resources.memRequestsBytes)} · Limit ${fmtMemoryUsage(resources.memLimitsBytes)}`,
      resourceSource: resources.memorySource
    },
    { label: 'Pods', value: podTotal, sub: `${healthSegments[0].value} running`, icon: 'pod', tone: 'cyan' },
    { label: 'Namespaces', value: data.namespaceCount, sub: 'total', icon: 'apps', tone: 'yellow' }
  ] : [];

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>
          <Icon name="cluster" size={19} />
          {data?.currentContext || 'Cluster'}
          {data?.serverVersion && data.serverVersion !== 'unknown' && (
            <span className="cluster-version-badge">{data.serverVersion}</span>
          )}
        </h2>
      </div>

      {loading && <Loader label="Loading cluster information…" />}
      {error && <div className="cluster-error">{error}</div>}

      {!loading && !error && data && (
        <div className="dashboard-body">
          <div className="kpi-row">
            {kpis.map(k => (
              <div key={k.label} className="kpi-card" style={{ cursor: 'default' }}>
                <div className={`kpi-icon ${k.tone}`}><Icon name={k.icon} size={22} /></div>
                <div className="kpi-meta">
                  <div className="kpi-value">{k.value}</div>
                  <div className="kpi-label">{k.label}</div>
                  <div className="kpi-sub">{k.sub}</div>
                  {k.resourceLine && (
                    <>
                      <div className="kpi-resource-line">{k.resourceLine}</div>
                      <div className="kpi-resource-source">
                        Usage source: {k.resourceSource || 'unavailable'}
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="chart-grid">
            <div className="chart-card">
              <div className="chart-card-title">
                <h3>Node Health</h3>
                <span className="total">{nodeTotal} nodes</span>
              </div>
              <div className="donut-wrap">
                <Donut segments={nodeSegments} centerNum={`${nodeReadyPct}%`} centerLabel="ready" />
                <div className="legend">
                  {nodeSegments.map(s => (
                    <div key={s.label} className="legend-item">
                      <span className="legend-dot" style={{ background: s.color }} />
                      {s.label}
                      <span className="legend-val">{s.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="chart-card">
              <div className="chart-card-title">
                <h3>Pod Health</h3>
                <span className="total">{podTotal} pods</span>
              </div>
              <div className="donut-wrap">
                <Donut segments={healthSegments} centerNum={`${healthyPct}%`} centerLabel="healthy" />
                <div className="legend">
                  {healthSegments.map(s => (
                    <div key={s.label} className="legend-item">
                      <span className="legend-dot" style={{ background: s.color }} />
                      {s.label}
                      <span className="legend-val">{s.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="chart-card">
              <div className="chart-card-title">
                <h3>Cluster Capacity</h3>
                <span className="total">allocatable / total</span>
              </div>
              <div className="bars">
                <CapacityBar
                  label="CPU" icon="cpu"
                  used={cap.cpuAllocatable} total={cap.cpuCapacity}
                  unit=" cores" color="#58a6ff"
                />
                <CapacityBar
                  label="Memory" icon="memory"
                  used={Math.round((cap.memAllocatableBytes || 0) / 1024 ** 3)}
                  total={Math.round((cap.memCapacityBytes || 0) / 1024 ** 3)}
                  unit=" GiB" color="#bc8cff"
                />
              </div>
            </div>
          </div>

          <div className="cluster-info-container">
            <div className="cluster-info-card">
              <h3><Icon name="nodes" size={15} /> Node Roles</h3>
              {roleEntries.length === 0 ? (
                <div className="info-item"><label>No roles reported</label></div>
              ) : roleEntries.map(([role, count]) => (
                <div key={role} className="info-item">
                  <label>{role}</label>
                  <span className="context-value">{count}</span>
                </div>
              ))}
            </div>

            <div className="cluster-info-card">
              <h3><Icon name="details" size={15} /> Cluster Info</h3>
              <div className="info-item">
                <label>Kubernetes Version</label>
                <span className="context-value">{data.serverVersion}</span>
              </div>
              <div className="info-item">
                <label>Platform</label>
                <span className="context-value">{data.platform || '—'}</span>
              </div>
              <div className="info-item">
                <label>Kubelet</label>
                <span className="context-value">{data.versions.join(', ') || '—'}</span>
              </div>
              <div className="info-item">
                <label>OS Image</label>
                <span className="context-value">{data.osImages.join(', ') || '—'}</span>
              </div>
            </div>

            <div className="cluster-info-card">
              <h3><Icon name="apps" size={15} /> Contexts ({data.contexts.length})</h3>
              <div className="contexts-list">
                {data.contexts.map((ctx, idx) => (
                  <div key={idx} className="context-item">
                    <span className={ctx === data.currentContext ? 'active' : ''}>{ctx}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="cluster-info-card">
              <h3><Icon name="cluster" size={15} /> Clusters ({data.clusters.length})</h3>
              <div className="clusters-list">
                {data.clusters.map((cluster, idx) => (
                  <div key={idx} className="cluster-item"><span>{cluster}</span></div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
