import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import axios from 'axios';
import Loader from './Loader';
import Icon from './Icons';
import { useToast } from './Toast';

// Monaco is heavy, so load it only when a YAML editor is actually opened.
const CodeEditor = lazy(() => import('./CodeEditor'));

// Editable YAML editor: fetches the resource, lets the user edit it in a Monaco
// (VSCode) editor, and applies changes back to the cluster via `kubectl apply`.
export default function YamlViewer({ resource, namespace, resourceType, onApplied }) {
  const toast = useToast();
  const [yaml, setYaml] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState(null);
  const saveRef = useRef(() => {});

  const resourceNamespace = resource?.namespace || namespace;

  useEffect(() => { if (resource) fetchYaml(); /* eslint-disable-next-line */ }, [resource, namespace, resourceType]);

  const fetchYaml = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`/api/yaml/${resourceNamespace}/${resourceType}/${resource.name}`);
      const y = response.data.yaml || '';
      setYaml(y); setOriginal(y); setError(null);
    } catch (err) {
      setError('Failed to load YAML'); setYaml('');
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (applying || yaml === original) return;
    setApplying(true);
    try {
      const { data } = await axios.put(`/api/yaml/${resourceNamespace}/${resourceType}/${resource.name}`, { yaml });
      toast.success(data.message || 'Applied', { title: resource.name });
      setOriginal(yaml);
      onApplied && onApplied();
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Apply failed', { title: 'Apply' });
    } finally {
      setApplying(false);
    }
  };

  // Keep the ⌘S handler pointed at the latest apply (Monaco binds it once).
  saveRef.current = apply;

  if (!resource) return null;
  const dirty = yaml !== original;

  return (
    <div className="yaml-viewer">
      <div className="yaml-toolbar">
        <span className="yaml-title">
          <Icon name="configuration" size={14} /> {resource.name}
          {dirty && <span className="yaml-dirty" title="Unsaved changes">●</span>}
        </span>
        <div className="yaml-toolbar-actions">
          <button className="yaml-btn" onClick={fetchYaml} disabled={loading || applying} title="Reload from cluster">
            <Icon name="refresh" size={13} /> Reload
          </button>
          <button className="yaml-btn primary" onClick={apply} disabled={!dirty || applying || loading} title="Apply changes (⌘S)">
            <Icon name="check" size={14} /> {applying ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
      <div className="yaml-content">
        {loading ? (
          <Loader label="Loading YAML…" inline />
        ) : error ? (
          <div className="yaml-error">{error}</div>
        ) : (
          <Suspense fallback={<Loader label="Loading editor…" inline />}>
            <CodeEditor value={yaml} onChange={setYaml} language="yaml" onSave={() => saveRef.current()} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
