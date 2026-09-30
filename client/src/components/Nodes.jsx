import React, { useState, useEffect, useRef, useMemo } from 'react';
import axios from 'axios';
import Icon from './Icons';
import MetricsChart from './MetricsChart';
import MetricHistoryControls from './MetricHistoryControls';
import ContextMenu from './ContextMenu';
import Loader from './Loader';
import TerminalViewer from './TerminalViewer';
import { useToast } from './Toast';
import useMetricHistory from '../hooks/useMetricHistory';

const fmtCpuM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${Math.round(m)}m`);
const fmtGi = (gi) => `${gi.toFixed(1)} Gi`;
const fmtCpuValue = (m) => (m == null ? '—' : fmtCpuM(m));
const fmtMemValue = (bytes) => (bytes == null ? '—' : fmtGi(bytes / 1024 ** 3));

const formatAge = (createdAt) => {
  if (!createdAt) return '-';
  const seconds = Math.floor((new Date() - new Date(createdAt)) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

const formatMemory = (mem) => {
  if (!mem || mem === '-') return '-';
  const match = mem.match(/^(\d+)Ki$/);
  if (match) {
    return `${(parseInt(match[1]) / (1024 * 1024)).toFixed(1)}GiB`;
  }
  return mem;
};

const cpuCores = (value) => {
  if (!value || value === '-') return -1;
  const s = String(value);
  if (s.endsWith('m')) return Number.parseFloat(s) / 1000;
  if (s.endsWith('u')) return Number.parseFloat(s) / 1e6;
  if (s.endsWith('n')) return Number.parseFloat(s) / 1e9;
  return Number.parseFloat(s) || -1;
};

const memoryBytes = (value) => {
  if (!value || value === '-') return -1;
  const match = String(value).match(/^([\d.]+)\s*(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/);
  if (!match) return -1;
  const multipliers = {
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
    K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18
  };
  return Number.parseFloat(match[1]) * (multipliers[match[2]] || 1);
};

export default function Nodes({ active = true, focusNode, onFocusHandled, onNavigate, refreshSignal = 0 }) {
  const toast = useToast();
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [activeTab, setActiveTab] = useState('details');
  const [nodePods, setNodePods] = useState([]);
  const [podsLoading, setPodsLoading] = useState(false);
  const [podsError, setPodsError] = useState(null);
  const [ncpuHist, setNcpuHist] = useState([]);
  const [nmemHist, setNmemHist] = useState([]);
  const [nMetricsNow, setNMetricsNow] = useState(null);
  const [nMetricsAvail, setNMetricsAvail] = useState(true);
  const [menu, setMenu] = useState(null);
  const [sort, setSort] = useState(null);
  const [nodeBusy, setNodeBusy] = useState(false);
  const [nodeAction, setNodeAction] = useState(null);

  useEffect(() => {
    fetchNodes();
  }, []);

  useEffect(() => {
    if (active) return;
    setMenu(null);
    setNodeAction(null);
  }, [active]);

  // Global/auto refresh: re-fetch in place (no remount), so the selected node,
  // the open tab and the metrics history stay put and no loader flashes.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    fetchNodes({ silent: true });
    if (selectedNode && activeTab === 'pods') fetchNodePods(selectedNode.name, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // Auto-select a node when navigated here via a cross-link
  useEffect(() => {
    if (!active || !focusNode || !nodes.length) return;
    const match = nodes.find(n => n.name === focusNode);
    if (match) {
      setSelectedNode(match);
      setActiveTab('details');
    }
    onFocusHandled?.();
  }, [active, focusNode, nodes]);

  // Live node metrics polling for the detail graphs. Keyed on the node *name*:
  // a refresh swaps in a new node object for the same node, and re-running this
  // would wipe the collected history.
  const selectedNodeName = selectedNode?.name;
  const metricHistory = useMetricHistory({
    kind: 'node',
    name: selectedNodeName,
    enabled: Boolean(active && selectedNodeName && activeTab === 'details')
  });
  const metricsNodeRef = useRef(null);
  useEffect(() => {
    if (metricsNodeRef.current === selectedNodeName) return;
    metricsNodeRef.current = selectedNodeName || null;
    setNcpuHist([]);
    setNmemHist([]);
    setNMetricsNow(null);
    setNMetricsAvail(true);
  }, [selectedNodeName]);

  useEffect(() => {
    if (!active || !selectedNodeName || activeTab !== 'details') return;
    let live = true;
    let pollTimer;
    const poll = async () => {
      let nextPollDelay = 5000;
      try {
        const res = await axios.get(`/api/metrics/node/${encodeURIComponent(selectedNodeName)}`);
        if (!live) return;
        if (res.data?.refreshing) nextPollDelay = 750;
        setNMetricsNow(res.data);
        setNMetricsAvail(res.data?.available !== false);
        if (!res.data?.refreshing && !res.data?.stale) {
          if (Number.isFinite(res.data?.cpuMilli)) setNcpuHist(h => [...h, res.data.cpuMilli].slice(-40));
          if (Number.isFinite(res.data?.memBytes)) setNmemHist(h => [...h, res.data.memBytes].slice(-40));
        }
      } catch (e) {
        if (live) setNMetricsAvail(false);
      } finally {
        if (live) pollTimer = setTimeout(poll, nextPollDelay);
      }
    };
    poll();
    return () => { live = false; clearTimeout(pollTimer); };
  }, [active, activeTab, selectedNodeName]);

  useEffect(() => {
    if (active && selectedNodeName && activeTab === 'pods') {
      fetchNodePods(selectedNodeName);
    }
  }, [active, selectedNodeName, activeTab]);

  const fetchNodes = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await axios.get('/api/nodes');
      const list = response.data.nodes || [];
      setNodes(list);
      // Keep the detail panel pointed at the fresh copy of the selected node so
      // its values refresh too (matched by name — the object identity changes).
      setSelectedNode(prev => (prev ? list.find(n => n.name === prev.name) || prev : prev));
      setError(null);
    } catch (err) {
      // Background reload: keep the current rows instead of flipping to an error.
      if (!silent) { setError(`Failed to fetch nodes: ${err.message}`); setNodes([]); }
    } finally {
      setLoading(false);
    }
  };

  const fetchNodePods = async (nodeName, { silent = false } = {}) => {
    if (!silent) setPodsLoading(true);
    try {
      const response = await axios.get(`/api/nodes/${nodeName}/pods`);
      setNodePods(response.data.pods || []);
      setPodsError(null);
    } catch (err) {
      if (!silent) { setPodsError(`Failed to fetch pods: ${err.message}`); setNodePods([]); }
    } finally {
      setPodsLoading(false);
    }
  };

  const runNodeOperation = async (operation, node, options = {}) => {
    if (nodeBusy) return;
    setNodeBusy(true);
    if (operation === 'drain') setNodeAction((current) => current ? { ...current, busy: true, error: null } : current);
    try {
      const { data } = await axios.post(`/api/nodes/${encodeURIComponent(node.name)}/${operation}`, options);
      if (operation === 'drain') setNodeAction(null);
      toast.success(operation === 'drain' ? `Node ${node.name} drained` : (data.message || `Node ${node.name}: ${operation}`), { title: 'Node' });
    } catch (err) {
      const message = err.response?.data?.error || err.message || `Failed to ${operation} node ${node.name}`;
      if (operation === 'drain') setNodeAction((current) => current ? { ...current, busy: false, error: message } : current);
      toast.error(message, { title: `Node ${operation}` });
    } finally {
      setNodeBusy(false);
      // A drain may cordon the node before failing, so refresh after either
      // outcome. Refresh the open pod list too when this node is selected.
      await fetchNodes({ silent: true });
      if (selectedNode?.name === node.name && activeTab === 'pods') {
        await fetchNodePods(node.name, { silent: true });
      }
    }
  };

  const selectNode = (node) => {
    setSelectedNode(node);
    setActiveTab('details');
  };

  const getStatusColor = (status) => {
    if (status === 'Ready' || status === 'Running') return '#5eb575';
    if (status === 'Pending') return '#f5a623';
    return '#ff6b6b';
  };

  const sortValue = (node, column) => {
    switch (column) {
      case 'Name': return node.name || '';
      case 'Status': return node.status || '';
      case 'Scheduling': return node.unschedulable ? 1 : 0;
      case 'Roles': return node.roles || '';
      case 'Version': return node.version || '';
      case 'Internal IP': return node.internalIp || '';
      case 'CPU': return cpuCores(node.cpuCapacity);
      case 'Memory': return memoryBytes(node.memoryCapacity);
      // Match the Pods table: ascending age order shows the newest first.
      case 'Age': return node.createdAt ? -new Date(node.createdAt).getTime() : Infinity;
      default: return '';
    }
  };

  const toggleSort = (column) => setSort((previous) => {
    if (!previous || previous.col !== column) return { col: column, dir: 'asc' };
    return previous.dir === 'asc' ? { col: column, dir: 'desc' } : null;
  });

  const sortedNodes = useMemo(() => {
    if (!sort) return nodes;
    const direction = sort.dir === 'asc' ? 1 : -1;
    return [...nodes].sort((a, b) => {
      const va = sortValue(a, sort.col);
      const vb = sortValue(b, sort.col);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * direction;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * direction;
    });
  }, [nodes, sort]);

  const nodeMenuItems = (node) => [
    { icon: 'details', label: 'Details', onClick: () => { setSelectedNode(node); setActiveTab('details'); } },
    { icon: 'pod', label: 'Pods on node', onClick: () => { setSelectedNode(node); setActiveTab('pods'); } },
    { icon: 'terminal', label: 'Open node terminal', onClick: () => { setSelectedNode(node); setActiveTab('terminal'); } },
    { divider: true },
    {
      icon: 'refresh',
      label: node.unschedulable ? 'Uncordon' : 'Cordon',
      onClick: () => runNodeOperation(node.unschedulable ? 'uncordon' : 'cordon', node)
    },
    {
      icon: 'delete', label: 'Drain node…', danger: true,
      onClick: () => setNodeAction({ type: 'drain', node, deleteEmptyDirData: false, busy: false, error: null })
    }
  ];

  return (
    <div className="resource-viewer">
      <div className="resource-header">
        <div>
          <h3>
            <Icon name="nodes" size={18} />
            Nodes
          </h3>
          <span className="resource-count">{nodes.length} items</span>
        </div>
        <div className="resource-controls" />
      </div>

      <div className="resource-table-wrapper">
        {loading ? (
          <Loader label="Loading nodes…" />
        ) : error ? (
          <div className="loading-indicator" style={{ color: '#ff6b6b' }}>{error}</div>
        ) : nodes.length === 0 ? (
          <div className="loading-indicator">No nodes found</div>
        ) : (
          <table className="resource-table">
            <thead>
              <tr>
                {['Name', 'Status', 'Scheduling', 'Roles', 'Version', 'Internal IP', 'CPU', 'Memory', 'Age'].map((column) => {
                  const isSorted = sort?.col === column;
                  return (
                    <th
                      key={column}
                      className={`sortable ${isSorted ? 'sorted' : ''}`}
                      onClick={() => toggleSort(column)}
                      title={`Sort by ${column}`}
                      aria-sort={isSorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      {column}
                      <span className="sort-arrow">{isSorted ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
                    </th>
                  );
                })}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedNodes.map((node, idx) => (
                <tr
                  key={`${node.name}-${idx}`}
                  className={`resource-table-row ${selectedNode?.name === node.name ? 'active' : ''}`}
                  onClick={() => selectNode(node)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, node }); }}
                >
                  <td>
                    <span className="resource-name-cell">{node.name}</span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: '90px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          backgroundColor: getStatusColor(node.status),
                          flexShrink: 0
                        }}
                      />
                      <span style={{ color: getStatusColor(node.status), fontSize: '12px', fontWeight: 500 }}>
                        {node.status}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span style={{ color: node.unschedulable ? '#d29922' : '#5eb575', fontSize: '12px', fontWeight: 500 }}>
                      {node.unschedulable ? 'Cordoned' : 'Schedulable'}
                    </span>
                  </td>
                  <td>{node.roles}</td>
                  <td>{node.version}</td>
                  <td>{node.internalIp}</td>
                  <td>{node.cpuCapacity}</td>
                  <td>{formatMemory(node.memoryCapacity)}</td>
                  <td>{formatAge(node.createdAt)}</td>
                  <td
                    className="actions"
                    onClick={(e) => { e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, node }); }}
                  >
                    <Icon name="more" size={16} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedNode && (
        <div className="bottom-panel">
          <div className="bottom-panel-tabs">
            <button
              className={`bottom-tab ${activeTab === 'details' ? 'active' : ''}`}
              onClick={() => setActiveTab('details')}
            >
              <Icon name="details" size={15} /> Details
            </button>
            <button
              className={`bottom-tab ${activeTab === 'pods' ? 'active' : ''}`}
              onClick={() => setActiveTab('pods')}
            >
              <Icon name="pod" size={15} /> Pods
            </button>
            <button
              className={`bottom-tab ${activeTab === 'terminal' ? 'active' : ''}`}
              onClick={() => setActiveTab('terminal')}
            >
              <Icon name="terminal" size={15} /> Terminal
            </button>
            <button className="bottom-panel-toggle" onClick={() => setSelectedNode(null)} title="Close">
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="bottom-panel-content">
            {activeTab === 'details' && (
              <div className="details-tab-content">
                <div className="cluster-info-container" style={{ padding: '16px' }}>
                  <div className="cluster-info-card" style={{ gridColumn: '1 / -1' }}>
                    <h3>
                      <Icon name="activity" size={15} /> Requests, Limits & Usage
                      {nMetricsNow?.source && <span className="resource-metric-source">{nMetricsNow.source}{nMetricsNow.refreshing ? ' · refreshing' : nMetricsNow.stale ? ' · last known' : ''}</span>}
                    </h3>
                    <table className="resource-usage-table node-resource-usage-table">
                      <thead><tr><th>Resource</th><th>Requests</th><th>Limits (declared sum)</th><th>Usage</th></tr></thead>
                      <tbody>
                        <tr>
                          <th>CPU</th>
                          <td>{fmtCpuValue(nMetricsNow?.cpuRequestsMilli)}</td>
                          <td>{fmtCpuValue(nMetricsNow?.cpuLimitsMilli)}</td>
                          <td>{fmtCpuValue(nMetricsNow?.cpuMilli)}</td>
                        </tr>
                        <tr>
                          <th>Memory</th>
                          <td>{fmtMemValue(nMetricsNow?.memRequestsBytes)}</td>
                          <td>{fmtMemValue(nMetricsNow?.memLimitsBytes)}</td>
                          <td>{fmtMemValue(nMetricsNow?.memBytes)}</td>
                        </tr>
                      </tbody>
                    </table>
                    {nMetricsNow?.scheduledPods != null && (
                      <p className="node-resource-usage-note">
                        Requests and limits are summed from {nMetricsNow.scheduledPods} scheduled pods. Limits include only values declared by pods.
                      </p>
                    )}
                    <MetricHistoryControls
                      period={metricHistory.period}
                      onChange={metricHistory.setPeriod}
                      loading={metricHistory.loading}
                      available={metricHistory.available}
                      message={metricHistory.message}
                      source={metricHistory.source}
                      pointCount={metricHistory.points.length}
                    />
                    {!nMetricsAvail && <div className="drawer-dim">Current metrics unavailable.</div>}
                    <div className="metric-charts" style={{ flexDirection: 'row' }}>
                      <div style={{ flex: 1 }}>
                        <MetricsChart
                          id="node-cpu"
                          label="CPU"
                          data={metricHistory.available
                            ? metricHistory.points.map((point) => ({ timestamp: point.timestamp, value: point.cpuMilli }))
                            : ncpuHist}
                          limit={nMetricsNow?.cpuCapacityMilli}
                          thresholdLabel="capacity"
                          format={fmtCpuM}
                          fallbackColor="#58a6ff"
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <MetricsChart
                          id="node-mem"
                          label="Memory"
                          data={metricHistory.available
                            ? metricHistory.points.map((point) => ({ timestamp: point.timestamp, value: point.memBytes == null ? null : point.memBytes / 1024 ** 3 }))
                            : nmemHist.map(b => b / 1024 ** 3)}
                          limit={nMetricsNow ? nMetricsNow.memCapacityBytes / 1024 ** 3 : null}
                          thresholdLabel="capacity"
                          format={fmtGi}
                          fallbackColor="#bc8cff"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="cluster-info-card">
                    <h3><Icon name="nodes" size={15} /> Node Info</h3>
                    <div className="info-item"><label>Name:</label><span className="context-value">{selectedNode.name}</span></div>
                    <div className="info-item"><label>Status:</label><span className="context-value">{selectedNode.status}</span></div>
                    <div className="info-item"><label>Roles:</label><span className="context-value">{selectedNode.roles}</span></div>
                    <div className="info-item"><label>Unschedulable:</label><span className="context-value">{selectedNode.unschedulable ? 'Yes' : 'No'}</span></div>
                    <div className="info-item"><label>Taints:</label><span className="context-value">{selectedNode.taints}</span></div>
                  </div>
                  <div className="cluster-info-card">
                    <h3><Icon name="box" size={15} /> System</h3>
                    <div className="info-item"><label>Kubelet Version:</label><span className="context-value">{selectedNode.version}</span></div>
                    <div className="info-item"><label>OS Image:</label><span className="context-value">{selectedNode.os}</span></div>
                    <div className="info-item"><label>Kernel Version:</label><span className="context-value">{selectedNode.kernelVersion}</span></div>
                    <div className="info-item"><label>Container Runtime:</label><span className="context-value">{selectedNode.containerRuntime}</span></div>
                  </div>
                  <div className="cluster-info-card">
                    <h3><Icon name="service" size={15} /> Network</h3>
                    <div className="info-item"><label>Internal IP:</label><span className="context-value">{selectedNode.internalIp}</span></div>
                    <div className="info-item"><label>External IP:</label><span className="context-value">{selectedNode.externalIp}</span></div>
                  </div>
                  <div className="cluster-info-card">
                    <h3><Icon name="overview" size={15} /> Resources</h3>
                    <div className="info-item"><label>CPU Capacity:</label><span className="context-value">{selectedNode.cpuCapacity}</span></div>
                    <div className="info-item"><label>CPU Allocatable:</label><span className="context-value">{selectedNode.cpuAllocatable}</span></div>
                    <div className="info-item"><label>Memory Capacity:</label><span className="context-value">{formatMemory(selectedNode.memoryCapacity)}</span></div>
                    <div className="info-item"><label>Memory Allocatable:</label><span className="context-value">{formatMemory(selectedNode.memoryAllocatable)}</span></div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'pods' && (
              <div className="details-tab-content" style={{ padding: 0 }}>
                <div className="resource-header" style={{ padding: '10px 16px' }}>
                  <div>
                    <h3 style={{ fontSize: '13px' }}>
                      Pods on {selectedNode.name}
                    </h3>
                    <span className="resource-count">{nodePods.length} items</span>
                  </div>
                  <div className="resource-controls">
                    <button
                      className="cluster-refresh-btn"
                      onClick={() => fetchNodePods(selectedNode.name)}
                      disabled={podsLoading}
                    >
                      <Icon name="refresh" size={14} /> Refresh
                    </button>
                  </div>
                </div>
                {podsLoading ? (
                  <Loader label="Loading pods…" inline />
                ) : podsError ? (
                  <div className="loading-indicator" style={{ color: '#ff6b6b' }}>{podsError}</div>
                ) : nodePods.length === 0 ? (
                  <div className="loading-indicator">No pods scheduled on this node</div>
                ) : (
                  <table className="resource-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Namespace</th>
                        <th>Ready</th>
                        <th>Status</th>
                        <th>Restarts</th>
                        <th>Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nodePods.map((pod, idx) => (
                        <tr key={`${pod.namespace}-${pod.name}-${idx}`} className="resource-table-row">
                          <td>
                            <span
                              className="xlink resource-name-cell"
                              onClick={() => onNavigate?.toResource({ type: 'pod', namespace: pod.namespace, name: pod.name })}
                              title={`Open pod ${pod.name}`}
                            >
                              {pod.name}
                            </span>
                          </td>
                          <td>
                            <span className="xlink" onClick={() => onNavigate?.toNamespace(pod.namespace)}>
                              {pod.namespace}
                            </span>
                          </td>
                          <td>{pod.ready}</td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span
                                style={{
                                  display: 'inline-block',
                                  width: '8px',
                                  height: '8px',
                                  borderRadius: '50%',
                                  backgroundColor: getStatusColor(pod.status),
                                  flexShrink: 0
                                }}
                              />
                              <span style={{ color: getStatusColor(pod.status), fontSize: '12px', fontWeight: 500 }}>
                                {pod.status}
                              </span>
                            </div>
                          </td>
                          <td>{pod.restarts}</td>
                          <td>{formatAge(pod.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {activeTab === 'terminal' && (
              <div className="details-tab-content" style={{ padding: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
                {active
                  ? <TerminalViewer resource={{ kind: 'Node', name: selectedNode.name }} />
                  : <div className="loading-indicator">The node terminal closes when you leave the Nodes page.</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={nodeMenuItems(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}

      {nodeAction?.type === 'drain' && (
        <div className="action-modal-backdrop" onClick={() => !nodeAction.busy && setNodeAction(null)}>
          <div className="action-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="action-modal-title danger"><Icon name="delete" size={16} /> Drain node</h3>
            <p className="action-modal-body">
              Evict regular pods from <b>{nodeAction.node.name}</b>. DaemonSet pods stay on the node, and eviction respects PodDisruptionBudgets.
              The node is cordoned as part of the drain and stays unschedulable until you uncordon it.
            </p>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.45 }}>
              <input
                type="checkbox"
                checked={nodeAction.deleteEmptyDirData}
                disabled={nodeAction.busy}
                onChange={(e) => setNodeAction((current) => ({ ...current, deleteEmptyDirData: e.target.checked }))}
              />
              <span>Allow deleting local data stored in <code>emptyDir</code> volumes</span>
            </label>
            {nodeAction.error && <div className="namespace-delete-error">{nodeAction.error}</div>}
            <div className="action-modal-actions">
              <button className="action-modal-btn" onClick={() => setNodeAction(null)} disabled={nodeAction.busy}>Cancel</button>
              <button
                className="action-modal-btn primary danger"
                onClick={() => runNodeOperation('drain', nodeAction.node, { deleteEmptyDirData: nodeAction.deleteEmptyDirData })}
                disabled={nodeAction.busy || nodeBusy}
              >
                {nodeAction.busy ? 'Draining…' : 'Drain node'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
