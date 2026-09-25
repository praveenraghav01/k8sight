import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';
import Icon from './Icons';
import Loader from './Loader';

const formatAge = (dateStr) => {
  if (!dateStr) return '-';
  const date = new Date(dateStr.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z'));
  if (isNaN(date.getTime())) return dateStr;
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 0) return '-';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

export default function Helm({ refreshSignal = 0 }) {
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedRelease, setSelectedRelease] = useState(null);
  const [activeTab, setActiveTab] = useState('values');
  const [yamlContent, setYamlContent] = useState('');
  const [yamlLoading, setYamlLoading] = useState(false);
  const [yamlError, setYamlError] = useState(null);

  useEffect(() => {
    fetchReleases();
  }, []);

  // Global/auto refresh: reload the list in place, keeping the open release and
  // its YAML tab — no remount, no loader flash.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    fetchReleases({ silent: true });
  }, [refreshSignal]);

  useEffect(() => {
    if (selectedRelease) {
      fetchYaml(selectedRelease, activeTab);
    }
  }, [selectedRelease, activeTab]);

  const fetchReleases = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await axios.get('/api/helm/releases');
      setReleases(response.data.releases || []);
      setError(null);
    } catch (err) {
      if (!silent) {
        setError(`Failed to fetch helm releases: ${err.response?.data?.error || err.message}`);
        setReleases([]);
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchYaml = async (release, tab) => {
    setYamlLoading(true);
    try {
      const endpoint = tab === 'manifest' ? 'manifest' : 'values';
      const response = await axios.get(
        `/api/helm/releases/${release.namespace}/${release.name}/${endpoint}`
      );
      setYamlContent(response.data.yaml || '');
      setYamlError(null);
    } catch (err) {
      setYamlError(`Failed to load ${tab}: ${err.message}`);
      setYamlContent('');
    } finally {
      setYamlLoading(false);
    }
  };

  const selectRelease = (release) => {
    setSelectedRelease(release);
    setActiveTab('values');
  };

  const getStatusColor = (status) => {
    if (status === 'deployed') return '#5eb575';
    if (status?.startsWith('pending')) return '#f5a623';
    if (status === 'failed') return '#ff6b6b';
    return '#999999';
  };

  const getHighlightedYaml = () => {
    if (!yamlContent) return '';
    try {
      return hljs.highlight(yamlContent, { language: 'yaml' }).value;
    } catch (err) {
      // Escape on the error path — this feeds dangerouslySetInnerHTML and the
      // YAML can contain arbitrary cluster-supplied strings (XSS otherwise).
      return String(yamlContent).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    }
  };

  return (
    <div className="resource-viewer">
      <div className="resource-header">
        <div>
          <h3>
            <Icon name="helm" size={18} />
            Helm Releases
          </h3>
          <span className="resource-count">{releases.length} items</span>
        </div>
        <div className="resource-controls" />
      </div>

      <div className="resource-table-wrapper">
        {loading ? (
          <Loader label="Loading Helm releases…" />
        ) : error ? (
          <div className="loading-indicator" style={{ color: '#ff6b6b' }}>{error}</div>
        ) : releases.length === 0 ? (
          <div className="loading-indicator">No helm releases found</div>
        ) : (
          <table className="resource-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Namespace</th>
                <th>Chart</th>
                <th>App Version</th>
                <th>Revision</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {releases.map((release, idx) => (
                <tr
                  key={`${release.namespace}-${release.name}-${idx}`}
                  className={`resource-table-row ${selectedRelease?.name === release.name && selectedRelease?.namespace === release.namespace ? 'active' : ''}`}
                  onClick={() => selectRelease(release)}
                >
                  <td><span className="resource-name-cell">{release.name}</span></td>
                  <td><span style={{ color: '#0e90d4' }}>{release.namespace}</span></td>
                  <td>{release.chart}</td>
                  <td>{release.appVersion || '-'}</td>
                  <td>{release.revision}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          backgroundColor: getStatusColor(release.status),
                          flexShrink: 0
                        }}
                      />
                      <span style={{ color: getStatusColor(release.status), fontSize: '12px', fontWeight: 500 }}>
                        {release.status}
                      </span>
                    </div>
                  </td>
                  <td>{formatAge(release.updated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedRelease && (
        <div className="bottom-panel">
          <div className="bottom-panel-tabs">
            <button
              className={`bottom-tab ${activeTab === 'values' ? 'active' : ''}`}
              onClick={() => setActiveTab('values')}
            >
              <Icon name="values" size={15} /> Values
            </button>
            <button
              className={`bottom-tab ${activeTab === 'manifest' ? 'active' : ''}`}
              onClick={() => setActiveTab('manifest')}
            >
              <Icon name="manifest" size={15} /> Manifest
            </button>
            <button className="bottom-panel-toggle" onClick={() => setSelectedRelease(null)} title="Close">
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="bottom-panel-content">
            <div className="yaml-viewer">
              <div className="yaml-content">
                {yamlLoading ? (
                  <Loader label={`Loading ${activeTab}…`} inline />
                ) : yamlError ? (
                  <div className="yaml-error">{yamlError}</div>
                ) : (
                  <pre className="yaml-code">
                    <code
                      className="hljs language-yaml"
                      dangerouslySetInnerHTML={{ __html: getHighlightedYaml() }}
                    />
                  </pre>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
