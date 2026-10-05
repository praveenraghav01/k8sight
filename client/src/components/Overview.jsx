import React from 'react';
import Icon from './Icons';
import NamespaceMultiSelect from './NamespaceMultiSelect';
import Loader from './Loader';

const COLORS = {
  running: '#3fb950',
  pending: '#d29922',
  failed: '#f85149',
  idle: '#30363d'
};

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
          const dash = `${len} ${c - len}`;
          const el = (
            <circle
              key={i}
              cx="65"
              cy="65"
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth="16"
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
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

export default function Overview({
  allResources,
  selectedNamespaces = ['all'],
  namespaces,
  onNamespaceSelect,
  onResourceTypeChange,
  loading
}) {
  const overviewByNamespace = allResources.overviewByNamespace || null;
  const overviewRows = Object.values(overviewByNamespace || {});
  const hasSummary = overviewByNamespace != null;
  const hasData = hasSummary || Array.isArray(allResources.pods);
  const pods = allResources.pods || [];
  const deployments = allResources.deployments || [];
  const statefulSets = allResources.statefulSets || [];
  const daemonSets = allResources.daemonSets || [];
  const services = allResources.services || [];
  const counts = hasSummary ? overviewRows.reduce((total, row) => ({
    pods: total.pods + (row.pods?.total || 0),
    deployments: total.deployments + (row.deployments || 0),
    statefulSets: total.statefulSets + (row.statefulSets || 0),
    daemonSets: total.daemonSets + (row.daemonSets || 0),
    services: total.services + (row.services || 0)
  }), { pods: 0, deployments: 0, statefulSets: 0, daemonSets: 0, services: 0 }) : {
    pods: pods.length,
    deployments: deployments.length,
    statefulSets: statefulSets.length,
    daemonSets: daemonSets.length,
    services: services.length
  };
  const loaded = {
    pods: hasSummary || Array.isArray(allResources.pods),
    deployments: hasSummary || Array.isArray(allResources.deployments),
    statefulSets: hasSummary || Array.isArray(allResources.statefulSets),
    daemonSets: hasSummary || Array.isArray(allResources.daemonSets),
    services: hasSummary || Array.isArray(allResources.services)
  };

  const podHealth = hasSummary ? overviewRows.reduce((total, row) => ({
    running: total.running + (row.pods?.phases?.Running || 0) + (row.pods?.phases?.Succeeded || 0),
    pending: total.pending + (row.pods?.phases?.Pending || 0),
    failed: total.failed + (row.pods?.phases?.Failed || 0) + (row.pods?.phases?.Unknown || 0)
  }), { running: 0, pending: 0, failed: 0 }) : pods.reduce(
    (acc, p) => {
      const s = (p.status || '').toLowerCase();
      if (s === 'running' || s === 'succeeded') acc.running++;
      else if (s === 'pending') acc.pending++;
      else acc.failed++;
      return acc;
    },
    { running: 0, pending: 0, failed: 0 }
  );

  const kpis = [
    { key: 'pod', dataKey: 'pods', label: 'Pods', value: counts.pods, sub: podHealth.running + ' running', icon: 'pod', tone: 'blue' },
    { key: 'deployment', dataKey: 'deployments', label: 'Deployments', value: counts.deployments, sub: 'workloads', icon: 'deployment', tone: 'green' },
    { key: 'statefulSet', dataKey: 'statefulSets', label: 'StatefulSets', value: counts.statefulSets, sub: 'stateful', icon: 'statefulSet', tone: 'purple' },
    { key: 'daemonSet', dataKey: 'daemonSets', label: 'DaemonSets', value: counts.daemonSets, sub: 'per-node', icon: 'daemonSet', tone: 'cyan' },
    { key: 'service', dataKey: 'services', label: 'Services', value: counts.services, sub: 'networking', icon: 'service', tone: 'yellow' }
  ];

  const workloadBars = [
    { label: 'Pods', value: counts.pods, loaded: loaded.pods, icon: 'pod', color: '#58a6ff' },
    { label: 'Deployments', value: counts.deployments, loaded: loaded.deployments, icon: 'deployment', color: '#3fb950' },
    { label: 'StatefulSets', value: counts.statefulSets, loaded: loaded.statefulSets, icon: 'statefulSet', color: '#bc8cff' },
    { label: 'DaemonSets', value: counts.daemonSets, loaded: loaded.daemonSets, icon: 'daemonSet', color: '#39c5cf' },
    { label: 'Services', value: counts.services, loaded: loaded.services, icon: 'service', color: '#d29922' }
  ];
  const maxBar = Math.max(...workloadBars.filter((bar) => bar.loaded).map((bar) => bar.value), 1);

  const healthSegments = [
    { label: 'Running', value: podHealth.running, color: COLORS.running },
    { label: 'Pending', value: podHealth.pending, color: COLORS.pending },
    { label: 'Failed', value: podHealth.failed, color: COLORS.failed }
  ];

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>
          <Icon name="overview" size={18} />
          Cluster Overview
        </h2>
        <NamespaceMultiSelect
          namespaces={namespaces}
          selected={selectedNamespaces}
          onChange={onNamespaceSelect}
        />
      </div>

      {loading && !hasData ? (
        <Loader label="Loading cluster overview…" />
      ) : (
      <div className="dashboard-body">
        <div className="kpi-row">
          {kpis.map(k => (
            <div key={k.key} className="kpi-card" onClick={() => onResourceTypeChange(k.key)}>
              <div className={`kpi-icon ${k.tone}`}>
                <Icon name={k.icon} size={22} />
              </div>
              <div className="kpi-meta">
                <div className="kpi-value">{loaded[k.dataKey] ? k.value : '…'}</div>
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-sub">{loaded[k.dataKey] ? k.sub : 'loading'}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="chart-grid">
          <div className="chart-card">
            <div className="chart-card-title">
              <h3>Pod Health</h3>
              <span className="total">{loaded.pods ? `${counts.pods} total` : 'loading'}</span>
            </div>
            <div className="donut-wrap">
              <Donut
                segments={healthSegments}
                centerNum={counts.pods ? Math.round((podHealth.running / counts.pods) * 100) + '%' : '0%'}
                centerLabel="healthy"
              />
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
              <h3>Workloads by Type</h3>
              <span className="total">
                {workloadBars.every((bar) => bar.loaded)
                  ? `${workloadBars.reduce((s, b) => s + b.value, 0)} objects`
                  : 'loading'}
              </span>
            </div>
            <div className="bars">
              {workloadBars.map(b => (
                <div key={b.label} className="bar-row" onClick={() => onResourceTypeChange(b.label.toLowerCase().replace(/s$/, ''))}>
                  <div className="bar-head">
                    <span className="name">
                      <Icon name={b.icon} size={14} />
                      {b.label}
                    </span>
                    <span className="val">{b.loaded ? b.value : '…'}</span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${b.loaded ? (b.value / maxBar) * 100 : 0}%`, background: b.color }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
