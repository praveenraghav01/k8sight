import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';
import ResourceDrawer from './ResourceDrawer';
import YamlViewer from './YamlViewer';

const formatAge = (createdAt) => {
  if (!createdAt) return '-';
  const s = Math.floor((new Date() - new Date(createdAt)) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const TABS = [
  { key: 'serviceAccounts', label: 'Service Accounts', kind: 'ServiceAccount', rt: 'serviceAccount', cols: ['Name', 'Namespace', 'Secrets', 'Age'] },
  { key: 'roles', label: 'Roles', kind: 'Role', rt: 'role', cols: ['Name', 'Namespace', 'Rules', 'Age'] },
  { key: 'roleBindings', label: 'Role Bindings', kind: 'RoleBinding', rt: 'roleBinding', cols: ['Name', 'Namespace', 'Role', 'Subjects', 'Age'] },
  { key: 'clusterRoles', label: 'Cluster Roles', kind: 'ClusterRole', rt: 'clusterRole', cols: ['Name', 'Rules', 'Age'] },
  { key: 'clusterRoleBindings', label: 'Cluster Role Bindings', kind: 'ClusterRoleBinding', rt: 'clusterRoleBinding', cols: ['Name', 'Role', 'Subjects', 'Age'] }
];

export default function AccessControl({ onNavigate, refreshSignal = 0 }) {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('serviceAccounts');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null); // { name, namespace, kind, resourceType }
  const [yamlTarget, setYamlTarget] = useState(null);

  // Later refreshes reload in place, so the active tab, search and open drawer
  // survive and the table isn't replaced by a loader.
  const didMount = useRef(false);
  useEffect(() => {
    fetchRbac({ silent: didMount.current });
    didMount.current = true;
  }, [refreshSignal]);

  const fetchRbac = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await axios.get('/api/rbac');
      setData(res.data || {});
      setError(null);
    } catch (err) {
      if (!silent) setError(`Failed to load RBAC: ${err.response?.data?.error || err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const active = TABS.find(t => t.key === tab);
  const items = (data[tab] || []).filter(
    r => !search || r.name.toLowerCase().includes(search.toLowerCase()) || (r.namespace || '').toLowerCase().includes(search.toLowerCase())
  );

  const cell = (r, col) => {
    switch (col) {
      case 'Name':
        return (
          <span
            className="xlink resource-name-cell"
            onClick={() => setSelected({ name: r.name, namespace: r.namespace, kind: active.kind, resourceType: active.rt })}
          >
            <Icon name="accessControl" size={15} className="rn-icon" />
            <span className="rn-text">{r.name}</span>
          </span>
        );
      case 'Namespace':
        return r.namespace && r.namespace !== '-'
          ? <span className="xlink" onClick={() => onNavigate?.toNamespace(r.namespace)}>{r.namespace}</span>
          : <span className="drawer-dim">cluster</span>;
      case 'Secrets': return r.secrets != null ? r.secrets : 0;
      case 'Rules': return r.rules != null ? r.rules : 0;
      case 'Subjects': return r.subjects != null ? r.subjects : 0;
      case 'Role': return r.roleRef || '-';
      case 'Age': return formatAge(r.createdAt);
      default: return '-';
    }
  };

  return (
    <div className="resource-viewer">
      <div className="resource-tabs">
        {TABS.map(t => (
          <button key={t.key} className={`resource-tab ${tab === t.key ? 'active' : ''}`} onClick={() => { setTab(t.key); setSelected(null); }}>
            <Icon name="accessControl" size={15} />
            {t.label}
          </button>
        ))}
      </div>

      <div className="resource-header">
        <div>
          <h3><Icon name="accessControl" size={18} /> {active.label}</h3>
          <span className="resource-count">{items.length} items</span>
        </div>
        <div className="resource-controls">
          <div className="search-box">
            <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="search-input" />
            <span className="search-icon"><Icon name="search" size={15} /></span>
          </div>
        </div>
      </div>

      <div className="resource-table-wrapper">
        {loading ? (
          <Loader label="Loading access control…" />
        ) : error ? (
          <div className="loading-indicator" style={{ color: '#ff6b6b' }}>{error}</div>
        ) : items.length === 0 ? (
          <div className="loading-indicator">No {active.label.toLowerCase()} found</div>
        ) : (
          <table className="resource-table">
            <thead>
              <tr>{active.cols.map(c => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {items.map((r, i) => (
                <tr
                  key={`${r.namespace}/${r.name}-${i}`}
                  className={`resource-table-row ${selected?.name === r.name && selected?.namespace === r.namespace ? 'active' : ''}`}
                  onClick={() => setSelected({ name: r.name, namespace: r.namespace, kind: active.kind, resourceType: active.rt })}
                >
                  {active.cols.map(col => <td key={col}>{cell(r, col)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {yamlTarget && (
        <div className="bottom-panel">
          <div className="bottom-panel-tabs">
            <button className="bottom-tab active"><Icon name="configuration" size={15} /> YAML</button>
            <button className="bottom-panel-toggle" onClick={() => setYamlTarget(null)} title="Close"><Icon name="close" size={16} /></button>
          </div>
          <div className="bottom-panel-content">
            <YamlViewer resource={yamlTarget} namespace={yamlTarget.namespace} resourceType={yamlTarget.resourceType} />
          </div>
        </div>
      )}

      {selected && (
        <ResourceDrawer
          resource={selected}
          namespace={selected.namespace}
          resourceType={selected.resourceType}
          onClose={() => setSelected(null)}
          onOpenTab={() => setYamlTarget(selected)}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}
