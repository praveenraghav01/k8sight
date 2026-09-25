import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

const formatAge = (createdAt) => {
  if (!createdAt) return '-';
  const seconds = Math.floor((new Date() - new Date(createdAt)) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

const statusClass = (s) => (s === 'Active' ? 'running' : s === 'Terminating' ? 'pending' : 'failed');

export default function Namespaces({ onNavigate, refreshSignal = 0 }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  // Later refreshes reload in place — the table stays, only the values change.
  const didMount = useRef(false);
  useEffect(() => {
    fetchNamespaces({ silent: didMount.current });
    didMount.current = true;
  }, [refreshSignal]);

  const fetchNamespaces = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await axios.get('/api/namespaces');
      setItems(res.data.details || (res.data.namespaces || []).map(n => ({ name: n, status: 'Active' })));
      setError(null);
    } catch (err) {
      if (!silent) setError(`Failed to fetch namespaces: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const filtered = items.filter(n => !search || n.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="resource-viewer">
      <div className="resource-header">
        <div>
          <h3>
            <Icon name="namespace" size={18} />
            Namespaces
          </h3>
          <span className="resource-count">{filtered.length} items</span>
        </div>
        <div className="resource-controls">
          <div className="search-box">
            <input
              type="text"
              placeholder="Search namespaces..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="search-input"
            />
            <span className="search-icon"><Icon name="search" size={15} /></span>
          </div>
        </div>
      </div>

      <div className="resource-table-wrapper">
        {loading ? (
          <Loader label="Loading namespaces…" />
        ) : error ? (
          <div className="loading-indicator" style={{ color: '#ff6b6b' }}>{error}</div>
        ) : filtered.length === 0 ? (
          <div className="loading-indicator">No namespaces found</div>
        ) : (
          <table className="resource-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Labels</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((ns, idx) => (
                <tr key={`${ns.name}-${idx}`} className="resource-table-row">
                  <td>
                    <span
                      className="xlink resource-name-cell"
                      onClick={() => onNavigate?.toNamespace(ns.name)}
                      title={`View ${ns.name} workloads`}
                    >
                      {ns.name}
                    </span>
                  </td>
                  <td>
                    <span className="status-cell">
                      <span className={`status-dot ${statusClass(ns.status)}`} />
                      <span style={{ color: 'var(--text-secondary)' }}>{ns.status}</span>
                    </span>
                  </td>
                  <td>
                    <span className="drawer-chips">
                      {Object.entries(ns.labels || {}).slice(0, 3).map(([k, v]) => (
                        <span key={k} className="drawer-chip">{k}{v ? `=${v}` : ''}</span>
                      ))}
                      {Object.keys(ns.labels || {}).length > 3 && (
                        <span className="drawer-chip muted">+{Object.keys(ns.labels).length - 3}</span>
                      )}
                    </span>
                  </td>
                  <td>{formatAge(ns.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
