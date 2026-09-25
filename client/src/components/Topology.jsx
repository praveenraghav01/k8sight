import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

const NODE_W = 190;
const NODE_H = 54;
const GAP_X = 90;
const GAP_Y = 22;

// left→right columns; edges flow forward from workloads to their dependencies
const RANK = {
  CronJob: 0, Deployment: 0, StatefulSet: 0, DaemonSet: 0,
  ReplicaSet: 1, Job: 1,
  Pod: 2,
  Service: 3, PersistentVolumeClaim: 3, ConfigMap: 3, Secret: 3, ServiceAccount: 3, NetworkPolicy: 3,
  Ingress: 4, PersistentVolume: 4, RoleBinding: 4,
  StorageClass: 5, Role: 5, ClusterRole: 5
};

const KIND_ICON = {
  Deployment: 'deployment', StatefulSet: 'statefulSet', DaemonSet: 'daemonSet',
  ReplicaSet: 'replicaSet', Pod: 'pod', Service: 'service', Job: 'job', CronJob: 'cronJob',
  Ingress: 'ingress', NetworkPolicy: 'networkPolicy',
  PersistentVolumeClaim: 'persistentVolumeClaim', PersistentVolume: 'persistentVolume', StorageClass: 'storageClass',
  ConfigMap: 'configMap', Secret: 'secret',
  ServiceAccount: 'serviceAccount', Role: 'accessControl', ClusterRole: 'accessControl', RoleBinding: 'accessControl'
};

// per-kind accent colour for the node badge
const KIND_COLOR = {
  Deployment: '#3fb950', StatefulSet: '#bc8cff', DaemonSet: '#39c5cf',
  ReplicaSet: '#58a6ff', Pod: '#58a6ff', Job: '#bc8cff', CronJob: '#bc8cff',
  Service: '#d29922', Ingress: '#e3b341', NetworkPolicy: '#f0883e',
  PersistentVolumeClaim: '#db6d28', PersistentVolume: '#db6d28', StorageClass: '#bf8040',
  ConfigMap: '#f778ba', Secret: '#f778ba',
  ServiceAccount: '#3fb0ac', Role: '#3fb0ac', ClusterRole: '#3fb0ac', RoleBinding: '#2ea19c'
};

// relationship colour per edge type
const EDGE_COLOR = {
  owns: '#6e7681', service: '#d29922', network: '#e3b341',
  storage: '#db6d28', config: '#f778ba', rbac: '#3fb0ac'
};

const CATEGORIES = [
  { key: 'network', label: 'Network', color: '#e3b341' },
  { key: 'storage', label: 'Storage', color: '#db6d28' },
  { key: 'config', label: 'Config', color: '#f778ba' },
  { key: 'rbac', label: 'RBAC', color: '#3fb0ac' }
];

const statusClass = (status) => {
  const s = (status || '').toLowerCase();
  if (s === 'running' || s === 'ready' || s === 'active' || s === 'succeeded' || s === 'bound') return 'running';
  if (s === 'pending') return 'pending';
  if (!s || s === 'unknown') return '';
  return 'failed';
};

export default function Topology({ namespaces = [], refreshSignal = 0 }) {
  const realNamespaces = useMemo(() => namespaces.filter(n => n !== 'all'), [namespaces]);
  const [namespace, setNamespace] = useState('');
  const [data, setData] = useState({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [cats, setCats] = useState({ network: true, storage: true, config: true, rbac: true });
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!namespace && realNamespaces.length) {
      setNamespace(realNamespaces.includes('default') ? 'default' : realNamespaces[0]);
    }
  }, [realNamespaces, namespace]);

  useEffect(() => {
    if (namespace) fetchTopology(namespace);
  }, [namespace]);

  // Re-fetch on a global refresh WITHOUT remounting, so the selected namespace
  // (and zoom/pan) are preserved. Skips the initial mount (handled above).
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if (namespace) fetchTopology(namespace, { silent: true });
  }, [refreshSignal]);

  // `silent` = background refresh: no loader over the graph, and the view the
  // user has framed (pan/zoom) is left exactly as it is.
  const fetchTopology = async (ns, { silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await axios.get(`/api/topology/${ns}`);
      setData({ nodes: res.data.nodes || [], edges: res.data.edges || [] });
      setError(res.data.error || null);
      if (!silent) { setPan({ x: 40, y: 40 }); setZoom(1); }
    } catch (err) {
      if (!silent) {
        setError(`Failed to load topology: ${err.message}`);
        setData({ nodes: [], edges: [] });
      }
    } finally {
      setLoading(false);
    }
  };

  // apply category filters (workloads always visible)
  const filtered = useMemo(() => {
    const nodes = data.nodes.filter(n => n.category === 'workload' || cats[n.category]);
    const ids = new Set(nodes.map(n => n.id));
    const edges = data.edges.filter(e => ids.has(e.source) && ids.has(e.target));
    return { nodes, edges };
  }, [data, cats]);

  const catCounts = useMemo(() => {
    const c = {};
    data.nodes.forEach(n => { c[n.category] = (c[n.category] || 0) + 1; });
    return c;
  }, [data]);

  // Layout: rank by kind, order via DFS over ownership edges to cluster related nodes
  const { positioned, links, width, height } = useMemo(() => {
    const { nodes, edges } = filtered;
    if (!nodes.length) return { positioned: [], links: [], width: 0, height: 0 };

    const byId = new Map(nodes.map(n => [n.id, { ...n, rank: RANK[n.kind] ?? 2 }]));
    const children = new Map();
    const hasParent = new Set();
    edges.filter(e => e.type === 'owns').forEach(e => {
      if (!children.has(e.source)) children.set(e.source, []);
      children.get(e.source).push(e.target);
      hasParent.add(e.target);
    });

    // order: DFS from roots (rank 0, no parent), then any leftovers
    const order = new Map();
    let seq = 0;
    const visit = (id) => {
      if (order.has(id) || !byId.has(id)) return;
      order.set(id, seq++);
      (children.get(id) || []).slice().sort().forEach(visit);
    };
    nodes
      .filter(n => (RANK[n.kind] ?? 2) === 0 && !hasParent.has(n.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(n => visit(n.id));
    nodes.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(n => visit(n.id));

    const ranks = {};
    byId.forEach(n => { (ranks[n.rank] = ranks[n.rank] || []).push(n); });
    Object.values(ranks).forEach(bucket =>
      bucket.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    );

    const pos = new Map();
    Object.keys(ranks).map(Number).sort((a, b) => a - b).forEach(rank => {
      ranks[rank].forEach((n, i) => {
        pos.set(n.id, { ...n, x: rank * (NODE_W + GAP_X), y: i * (NODE_H + GAP_Y) });
      });
    });

    // pull dependency nodes (rank ≥ 3) toward the average Y of what points at them
    const incoming = new Map();
    edges.forEach(e => {
      if (!incoming.has(e.target)) incoming.set(e.target, []);
      incoming.get(e.target).push(e.source);
    });
    Object.keys(ranks).map(Number).filter(r => r >= 3).sort((a, b) => a - b).forEach(rank => {
      ranks[rank].forEach(n => {
        const srcYs = (incoming.get(n.id) || []).map(s => pos.get(s)?.y).filter(v => v != null);
        if (srcYs.length) pos.get(n.id).y = srcYs.reduce((a, b) => a + b, 0) / srcYs.length;
      });
      // de-overlap within the rank
      const col = ranks[rank].map(n => pos.get(n.id)).sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) {
        const minY = col[i - 1].y + NODE_H + GAP_Y;
        if (col[i].y < minY) col[i].y = minY;
      }
    });

    const positioned = Array.from(pos.values());
    const links = edges
      .map(e => {
        const s = pos.get(e.source);
        const t = pos.get(e.target);
        if (!s || !t) return null;
        return { ...e, s, t };
      })
      .filter(Boolean);

    const width = Math.max(...positioned.map(n => n.x + NODE_W), 400);
    const height = Math.max(...positioned.map(n => n.y + NODE_H), 300);
    return { positioned, links, width, height };
  }, [filtered]);

  const onMouseDown = (e) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
  };
  const onMouseMove = useCallback((e) => {
    if (!dragRef.current) return;
    setPan({
      x: dragRef.current.panX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.panY + (e.clientY - dragRef.current.startY)
    });
  }, []);
  const onMouseUp = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const onWheel = (e) => {
    const delta = e.deltaY < 0 ? 0.12 : -0.12;
    setZoom(z => Math.min(2, Math.max(0.3, +(z + delta).toFixed(2))));
  };

  const edgePath = (l) => {
    const sx = l.s.x + NODE_W;
    const sy = l.s.y + NODE_H / 2;
    const tx = l.t.x;
    const ty = l.t.y + NODE_H / 2;
    const dx = Math.max(30, (tx - sx) * 0.5);
    return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  };

  return (
    <div className="topology-view">
      <div className="topology-header">
        <h2>
          <Icon name="topology" size={18} />
          Topology
        </h2>
        <div className="resource-controls">
          <select
            className="nav-context-selector"
            style={{ width: 200 }}
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
          >
            {realNamespaces.map(ns => (
              <option key={ns} value={ns}>{ns}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="topo-filterbar">
        <span className="topo-filter-label">Show</span>
        <span className="topo-filter-chip workload static">
          <span className="topo-legend-swatch" style={{ background: '#58a6ff' }} />
          Workloads<span className="topo-filter-count">{catCounts.workload || 0}</span>
        </span>
        {CATEGORIES.map(c => (
          <button
            key={c.key}
            className={`topo-filter-chip ${cats[c.key] ? 'on' : 'off'}`}
            onClick={() => setCats(prev => ({ ...prev, [c.key]: !prev[c.key] }))}
          >
            <span className="topo-legend-swatch" style={{ background: c.color, opacity: cats[c.key] ? 1 : 0.3 }} />
            {c.label}<span className="topo-filter-count">{catCounts[c.key] || 0}</span>
          </button>
        ))}
      </div>

      <div
        className={`topology-canvas ${dragging ? 'dragging' : ''}`}
        onMouseDown={onMouseDown}
        onWheel={onWheel}
      >
        {loading && <div className="topo-empty"><Loader label="Building topology…" /></div>}
        {!loading && error && <div className="topo-empty" style={{ color: 'var(--red)' }}>{error}</div>}
        {!loading && !error && positioned.length === 0 && (
          <div className="topo-empty">No resources in this namespace</div>
        )}

        {!loading && positioned.length > 0 && (
          <svg>
            <defs>
              {Object.entries(EDGE_COLOR).map(([type, color]) => (
                <marker key={type} id={`arrow-${type}`} viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                </marker>
              ))}
            </defs>
            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              {links.map((l, i) => (
                <path
                  key={i}
                  className="topo-edge"
                  d={edgePath(l)}
                  style={{ stroke: EDGE_COLOR[l.type] || '#6e7681' }}
                  strokeDasharray={l.type === 'owns' ? '' : '5 4'}
                  markerEnd={`url(#arrow-${l.type in EDGE_COLOR ? l.type : 'owns'})`}
                />
              ))}
              {positioned.map(n => {
                const color = KIND_COLOR[n.kind] || '#58a6ff';
                return (
                  <foreignObject key={n.id} x={n.x} y={n.y} width={NODE_W} height={NODE_H}>
                    <div className="topo-node-card" title={`${n.kind}: ${n.name}`}>
                      <div className="tn-icon" style={{ background: color + '26', color }}>
                        <Icon name={KIND_ICON[n.kind] || 'box'} size={18} />
                      </div>
                      <div className="tn-body">
                        <span className="tn-name">{n.name}</span>
                        <span className="tn-kind">{n.kind}</span>
                      </div>
                      {statusClass(n.status) && <span className={`status-dot ${statusClass(n.status)} tn-status`} />}
                    </div>
                  </foreignObject>
                );
              })}
            </g>
          </svg>
        )}

        <div className="topo-controls">
          <button className="topo-ctrl-btn" title="Zoom in" onClick={() => setZoom(z => Math.min(2, +(z + 0.15).toFixed(2)))}>
            <Icon name="plus" size={16} />
          </button>
          <button className="topo-ctrl-btn" title="Zoom out" onClick={() => setZoom(z => Math.max(0.3, +(z - 0.15).toFixed(2)))}>
            <Icon name="minus" size={16} />
          </button>
          <button className="topo-ctrl-btn" title="Reset view" onClick={() => { setZoom(1); setPan({ x: 40, y: 40 }); }}>
            <Icon name="refresh" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
