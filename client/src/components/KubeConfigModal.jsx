import React, { useState, useEffect } from 'react';
import Icon from './Icons';

export default function KubeConfigModal({ defaultPath, exists, onSubmit, onDemo, onClose }) {
  const [path, setPath] = useState(defaultPath || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Dismiss on Escape when the modal is closable (there's a cluster behind it).
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const submit = async (e) => {
    e.preventDefault();
    const p = path.trim();
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    const err = await onSubmit(p);
    // on success the parent unmounts this modal
    if (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose ? (e) => { if (e.target === e.currentTarget && !busy) onClose(); } : undefined}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-icon"><Icon name="cluster" size={20} /></span>
          <h2>Load kubeconfig</h2>
          {onClose && (
            <button className="modal-close" onClick={onClose} disabled={busy} title="Close" aria-label="Close">
              <Icon name="close" size={16} />
            </button>
          )}
        </div>

        <p className="modal-desc">
          {exists
            ? <>A kubeconfig was found at <code>{defaultPath}</code> but couldn't be loaded. Enter a valid kubeconfig file path.</>
            : <>No kubeconfig was found{defaultPath ? <> at <code>{defaultPath}</code></> : ''}. Enter the full path to your kubeconfig file.</>}
        </p>

        <form onSubmit={submit}>
          <label className="modal-label">Kubeconfig file path</label>
          <input
            className="modal-input"
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/.kube/config"
            spellCheck={false}
            autoFocus
          />

          {error && (
            <div className="modal-error">
              <Icon name="details" size={14} /> {error}
            </div>
          )}

          <div className="modal-actions">
            <button type="submit" className="modal-btn primary" disabled={busy || !path.trim()}>
              {busy ? 'Loading…' : 'Load kubeconfig'}
            </button>
          </div>
        </form>

        {onDemo && (
          <div className="modal-demo">
            <div className="modal-or"><span>or</span></div>
            <button type="button" className="modal-btn" onClick={() => onDemo()} disabled={busy}>
              <Icon name="sparkles" size={14} /> Explore the demo (no cluster needed)
            </button>
            <p className="modal-hint" style={{ marginTop: 8 }}>
              A synthetic cluster with sample workloads, metrics, logs, Argo CD and security scans, so you can try every feature.
            </p>
          </div>
        )}

        <p className="modal-hint">
          Tip: you can also set the <code>KUBECONFIG</code> environment variable and restart the server.
        </p>
      </div>
    </div>
  );
}
