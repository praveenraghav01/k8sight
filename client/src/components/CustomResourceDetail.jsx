import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';
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

function InstanceView({ sel, onSelect, refreshSignal = 0 }) {
  const [yaml, setYaml] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // A refresh re-reads the YAML in place: the pane keeps the current content
  // (and its scroll position) until the new text arrives.
  const loadedFor = useRef(null);
  useEffect(() => {
    const target = `${sel.group}/${sel.version}/${sel.plural}/${sel.namespace || ''}/${sel.name}`;
    const silent = loadedFor.current === target;
    loadedFor.current = target;
    let active = true;
    if (!silent) { setLoading(true); setError(null); }
    const ns = sel.namespace && sel.namespace !== '-' ? `?namespace=${encodeURIComponent(sel.namespace)}` : '';
    axios.get(`/api/customresource/${sel.group}/${sel.version}/${sel.plural}/${encodeURIComponent(sel.name)}${ns}`)
      .then(res => { if (active) { setYaml(res.data.yaml || ''); setError(null); } })
      .catch(err => { if (active && !silent) setError(err.response?.data?.error || err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sel.group, sel.version, sel.plural, sel.name, sel.namespace, refreshSignal]);

  const highlighted = () => {
    // hljs.highlight() HTML-escapes its output. On the error path, escape the raw
    // YAML too — it goes into dangerouslySetInnerHTML and can contain arbitrary
    // cluster-supplied strings, so returning it unescaped would be an XSS sink.
    try { return hljs.highlight(yaml, { language: 'yaml' }).value; }
    catch { return String(yaml || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  };

  return (
    <div className="cr-detail">
      <div className="cr-detail-head">
        <div>
          <h3><Icon name="customResources" size={17} /> {sel.name}</h3>
          <div className="cr-detail-meta">
            <span>{sel.kind}</span>
            <span className="drawer-dim">{sel.group}/{sel.version}</span>
            {sel.namespace && sel.namespace !== '-' && <span className="drawer-dim">ns: {sel.namespace}</span>}
          </div>
        </div>
        {onSelect && (
          <button className="cr-detail-close" title="Close" onClick={() => onSelect(null)}>
            <Icon name="close" size={17} />
          </button>
        )}
      </div>
      <div className="cr-detail-body">
        {loading ? <Loader label="Loading resource…" inline /> : error ? (
          <div className="loading-indicator" style={{ color: '#ff6b6b' }}>{error}</div>
        ) : (
          <pre className="yaml-code"><code className="hljs language-yaml" dangerouslySetInnerHTML={{ __html: highlighted() }} /></pre>
        )}
      </div>
    </div>
  );
}

function KindView({ sel, onSelect, refreshSignal = 0 }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Same kind as last time (i.e. a refresh, not a new selection) → reload the
  // instances quietly underneath the table.
  const loadedFor = useRef(null);
  useEffect(() => {
    const target = `${sel.group}/${sel.version}/${sel.plural}`;
    const silent = loadedFor.current === target;
    loadedFor.current = target;
    let active = true;
    if (!silent) { setLoading(true); setError(null); }
    axios.get(`/api/customresources/${sel.group}/${sel.version}/${sel.plural}`)
      .then(res => { if (active) { setItems(res.data.items || []); setError(res.data.error || null); } })
      .catch(err => { if (active && !silent) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sel.group, sel.version, sel.plural, refreshSignal]);

  return (
    <div className="cr-detail">
      <div className="cr-detail-head">
        <div>
          <h3><Icon name="customResources" size={17} /> {sel.kind}</h3>
          <div className="cr-detail-meta">
            <span className="drawer-dim">{sel.group}/{sel.version}</span>
            <span className="drawer-chip">{sel.scope}</span>
            <span className="resource-count">{items.length} instances</span>
          </div>
        </div>
        {onSelect && (
          <button className="cr-detail-close" title="Close" onClick={() => onSelect(null)}>
            <Icon name="close" size={17} />
          </button>
        )}
      </div>
      <div className="resource-table-wrapper">
        {loading ? <Loader label="Loading instances…" /> : error ? (
          <div className="loading-indicator" style={{ color: '#ff6b6b' }}>{error}</div>
        ) : items.length === 0 ? (
          <div className="loading-indicator">No instances found</div>
        ) : (
          <table className="resource-table">
            <thead>
              <tr><th>Name</th><th>Namespace</th><th>Age</th></tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr
                  key={`${it.namespace}/${it.name}-${i}`}
                  className="resource-table-row"
                  onClick={() => onSelect({ ...sel, level: 'instance', name: it.name, namespace: it.namespace })}
                >
                  <td><span className="xlink resource-name-cell">{it.name}</span></td>
                  <td>{it.namespace}</td>
                  <td>{formatAge(it.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function CustomResourceDetail({ selection, onSelect, refreshSignal = 0 }) {
  if (!selection) {
    return (
      <div className="resource-viewer">
        <div className="cr-empty">
          <Icon name="customResources" size={40} />
          <p>Select a custom resource from the tree in the sidebar.</p>
          <span>Expand <b>Custom Resources</b> → group → kind → instance.</span>
        </div>
      </div>
    );
  }
  return (
    <div className="resource-viewer">
      {selection.level === 'instance'
        ? <InstanceView sel={selection} onSelect={onSelect} refreshSignal={refreshSignal} />
        : <KindView sel={selection} onSelect={onSelect} refreshSignal={refreshSignal} />}
    </div>
  );
}
