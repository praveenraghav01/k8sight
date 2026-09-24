import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import MetricsChart from './MetricsChart';
import ContextMenu from './ContextMenu';
import Loader from './Loader';

const fmtCpuM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${Math.round(m)}m`);
const fmtGi = (gi) => `${gi.toFixed(1)} Gi`;

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

export default function Nodes({ focusNode, onFocusHandled, onNavigate, refreshSignal = 0 }) {
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

  useEffect(() => {
    fetchNodes();
  }, []);

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
    if (!focusNode || !nodes.length) return;
    const match = nodes.find(n => n.name === focusNode);
    if (match) {
      setSelectedNode(match);
      setActiveTab('details');
    }
    onFocusHandled?.();
  }, [focusNode, nodes]);

  // Live node metrics polling for the detail graphs. Keyed on the node *name*:
  // a refresh swaps in a new node object for the same node, and re-running this
  // would wipe the collected history.
  const selectedNodeName = selectedNode?.name;
  useEffect(() => {
    if (!selectedNodeName) return;
    let active = true;
    setNcpuHist([]);
    setNmemHist([]);
    setNMetricsNow(null);
    setNMetricsAvail(true);
    const poll = async () => {
      try {
        const res = await axios.get(`/api/metrics/node/${selectedNodeName}`);
        if (!active) return;
        if (res.data?.available === false) { setNMetricsAvail(false); return; }
        setNMetricsNow(res.data);
        setNcpuHist(h => [...h, res.data.cpuMilli].slice(-40));
        setNmemHist(h => [...h, res.data.memBytes].slice(-40));
      } catch (e) {
        if (active) setNMetricsAvail(false);
      }
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { active = false; clearInterval(iv); };
  }, [selectedNodeName]);

  useEffect(() => {
    if (selectedNodeName && activeTab === 'pods') {
      fetchNodePods(selectedNodeName);
    }
  }, [selectedNodeName, activeTab]);

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

  const selectNode = (node) => {
    setSelectedNode(node);
    setActiveTab('details');
  };

  const getStatusColor = (status) => {
    if (status === 'Ready' || status === 'Running') return '#5eb575';
    if (status === 'Pending') return '#f5a623';
    return '#ff6b6b';
  };

  const nodeMenuItems = (node) => [
    { icon: 'details', label: 'Details', onClick: () => { setSelectedNode(node); setActiveTab('details'); } },
    { icon: 'pod', label: 'Pods on node', onClick: () => { setSelectedNode(node); setActiveTab('pods'); } }
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
                <th>Name</th>
                <th>Status</th>
                <th>Roles</th>
                <th>Version</th>
                <th>Internal IP</th>
                <th>CPU</th>
                <th>Memory</th>
                <th>Age</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node, idx) => (
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
            <button className="bottom-panel-toggle" onClick={() => setSelectedNode(null)} title="Close">
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="bottom-panel-content">
            {activeTab === 'details' && (
              <div className="details-tab-content">
                <div className="cluster-info-container" style={{ padding: '16px' }}>
                  <div className="cluster-info-card" style={{ gridColumn: '1 / -1' }}>
                    <h3><Icon name="activity" size={15} /> Resource Usage</h3>
                    {!nMetricsAvail ? (
                      <div className="drawer-dim">Metrics not available</div>
                    ) : (
                      <div className="metric-charts" style={{ flexDirection: 'row' }}>
                        <div style={{ flex: 1 }}>
                          <MetricsChart
                            id="node-cpu"
                            label="CPU"
                            data={ncpuHist}
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
                            data={nmemHist.map(b => b / 1024 ** 3)}
                            limit={nMetricsNow ? nMetricsNow.memCapacityBytes / 1024 ** 3 : null}
                            thresholdLabel="capacity"
                            format={fmtGi}
                            fallbackColor="#bc8cff"
                          />
                        </div>
                      </div>
                    )}
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
    </div>
  );
}
