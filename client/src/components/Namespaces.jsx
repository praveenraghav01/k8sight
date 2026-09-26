import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';
import { useToast } from './Toast';

const formatAge = (createdAt) => {
  if (!createdAt) return '-';
  const seconds = Math.floor((new Date() - new Date(createdAt)) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

const statusClass = (s) => (s === 'Active' ? 'running' : s === 'Terminating' ? 'pending' : 'failed');

export default function Namespaces({ onNavigate, onNamespaceDeleted, refreshSignal = 0 }) {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [deleteDialog, setDeleteDialog] = useState(null);

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
      const nextItems = res.data.details || (res.data.namespaces || []).map(n => ({ name: n, status: 'Active' }));
      setItems((previous) => {
        const terminating = new Set(previous.filter((item) => item.status === 'Terminating').map((item) => item.name));
        return nextItems.map((item) => terminating.has(item.name) && item.status !== 'Terminating'
          ? { ...item, status: 'Terminating' }
          : item);
      });
      setError(null);
    } catch (err) {
      if (!silent) setError(`Failed to fetch namespaces: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const filtered = items.filter(n => !search || n.name.toLowerCase().includes(search.toLowerCase()));

  const requestDelete = (namespace) => setDeleteDialog({ namespace, step: 1, confirmText: '', busy: false, error: '' });

  const deleteNamespace = async () => {
    if (!deleteDialog || deleteDialog.busy || deleteDialog.confirmText !== deleteDialog.namespace) return;
    const { namespace } = deleteDialog;
    setDeleteDialog((current) => ({ ...current, busy: true, error: '' }));
    try {
      await axios.delete(`/api/resource/-/namespace/${encodeURIComponent(namespace)}`);
      setItems((current) => current.map((item) => item.name === namespace ? { ...item, status: 'Terminating' } : item));
      setDeleteDialog(null);
      onNamespaceDeleted?.(namespace);
      toast.success(`Deletion requested for namespace ${namespace}.`, { title: 'Delete namespace' });
      await fetchNamespaces({ silent: true });
    } catch (err) {
      setDeleteDialog((current) => current && ({
        ...current,
        busy: false,
        error: err.response?.data?.error || err.message || 'Failed to delete namespace.',
      }));
    }
  };

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
                <th className="namespace-action-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((ns) => (
                <tr key={ns.name} className="resource-table-row">
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
                  <td className="namespace-action-col">
                    <button
                      type="button"
                      className="namespace-delete-btn"
                      aria-label={`Delete namespace ${ns.name}`}
                      title={`Delete namespace ${ns.name}`}
                      onClick={(event) => { event.stopPropagation(); requestDelete(ns.name); }}
                      disabled={ns.status === 'Terminating'}
                    >
                      <Icon name="delete" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {deleteDialog && (
        <div
          className="action-modal-backdrop"
          onClick={() => !deleteDialog.busy && setDeleteDialog(null)}
        >
          <div
            className="action-modal namespace-delete-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="namespace-delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="namespace-delete-title" className="action-modal-title danger">
              <Icon name="delete" size={16} /> Delete namespace
            </h3>
            {deleteDialog.step === 1 ? (
              <>
                <p className="action-modal-body">
                  Deleting <b>{deleteDialog.namespace}</b> also deletes the resources inside it. This cannot be undone.
                </p>
                <div className="action-modal-actions">
                  <button className="action-modal-btn" onClick={() => setDeleteDialog(null)}>Cancel</button>
                  <button className="action-modal-btn primary danger" onClick={() => setDeleteDialog((current) => ({ ...current, step: 2 }))}>Continue</button>
                </div>
              </>
            ) : (
              <>
                <p className="action-modal-body">
                  To confirm, type the exact namespace name <b>{deleteDialog.namespace}</b>.
                </p>
                <label className="action-modal-label" htmlFor="namespace-delete-confirmation">Namespace name</label>
                <input
                  id="namespace-delete-confirmation"
                  className="action-modal-input"
                  autoFocus
                  autoComplete="off"
                  spellCheck="false"
                  value={deleteDialog.confirmText}
                  onChange={(event) => setDeleteDialog((current) => ({ ...current, confirmText: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === 'Enter') deleteNamespace(); }}
                  disabled={deleteDialog.busy}
                />
                {deleteDialog.error && <div className="namespace-delete-error" role="alert">{deleteDialog.error}</div>}
                <div className="action-modal-actions">
                  <button className="action-modal-btn" onClick={() => setDeleteDialog(null)} disabled={deleteDialog.busy}>Cancel</button>
                  <button className="action-modal-btn" onClick={() => setDeleteDialog((current) => ({ ...current, step: 1, error: '' }))} disabled={deleteDialog.busy}>Back</button>
                  <button
                    className="action-modal-btn primary danger"
                    onClick={deleteNamespace}
                    disabled={deleteDialog.busy || deleteDialog.confirmText !== deleteDialog.namespace}
                  >
                    {deleteDialog.busy ? 'Deleting…' : 'Delete namespace'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
