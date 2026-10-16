import React, { useState, useEffect } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';
import ResizableBottomPanel from './ResizableBottomPanel';

const formatAge = (createdAt) => {
  if (!createdAt) return '-';
  const seconds = Math.floor((new Date() - new Date(createdAt)) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

export default function CustomResources() {
  const [crds, setCrds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCrd, setSelectedCrd] = useState(null);
  const [instances, setInstances] = useState([]);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [instancesError, setInstancesError] = useState(null);

  useEffect(() => {
    fetchCrds();
  }, []);

  useEffect(() => {
    if (selectedCrd) {
      fetchInstances(selectedCrd);
    }
  }, [selectedCrd]);

  const fetchCrds = async () => {
    setLoading(true);
    try {
      const response = await axios.get('/api/customresources');
      setCrds(response.data.crds || []);
      setError(null);
    } catch (err) {
      setError(`Failed to fetch custom resources: ${err.message}`);
      setCrds([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchInstances = async (crd) => {
    setInstancesLoading(true);
    try {
      const response = await axios.get(
        `/api/customresources/${crd.group}/${crd.version}/${crd.plural}`
      );
      setInstances(response.data.items || []);
      setInstancesError(response.data.error || null);
    } catch (err) {
      setInstancesError(`Failed to fetch instances: ${err.message}`);
      setInstances([]);
    } finally {
      setInstancesLoading(false);
    }
  };

  const filteredCrds = crds.filter(crd =>
    !searchQuery ||
    crd.kind?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    crd.group?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="resource-viewer">
      <div className="resource-header">
        <div>
          <h3>
            <Icon name="customResources" size={18} />
            Custom Resources
          </h3>
          <span className="resource-count">{filteredCrds.length} items</span>
        </div>
        <div className="resource-controls">
          <div className="search-box">
            <input
              type="text"
              placeholder="Search by kind or group..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
            <span className="search-icon"><Icon name="search" size={15} /></span>
          </div>
        </div>
      </div>

      <div className="resource-table-wrapper">
        {loading ? (
          <Loader label="Loading custom resources…" />
        ) : error ? (
          <div className="loading-indicator" style={{ color: '#ff6b6b' }}>{error}</div>
        ) : filteredCrds.length === 0 ? (
          <div className="loading-indicator">No custom resources found</div>
        ) : (
          <table className="resource-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Group</th>
                <th>Version</th>
                <th>Scope</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {filteredCrds.map((crd, idx) => (
                <tr
                  key={`${crd.name}-${idx}`}
                  className={`resource-table-row ${selectedCrd?.name === crd.name ? 'active' : ''}`}
                  onClick={() => setSelectedCrd(crd)}
                >
                  <td><span className="resource-name-cell">{crd.kind}</span></td>
                  <td><span style={{ color: '#0e90d4' }}>{crd.group}</span></td>
                  <td>{crd.version}</td>
                  <td>{crd.scope}</td>
                  <td>{formatAge(crd.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedCrd && (
        <ResizableBottomPanel label="Resize custom resource instances panel">
          <div className="bottom-panel-tabs">
            <button className="bottom-tab active">
              <Icon name="logs" size={15} /> {selectedCrd.kind} Instances
            </button>
            <button className="bottom-panel-toggle" onClick={() => setSelectedCrd(null)} title="Close">
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="bottom-panel-content">
            <div className="details-tab-content" style={{ padding: 0 }}>
              <div className="resource-header" style={{ padding: '10px 16px' }}>
                <div>
                  <h3 style={{ fontSize: '13px' }}>{selectedCrd.name}</h3>
                  <span className="resource-count">{instances.length} items</span>
                </div>
                <div className="resource-controls">
                  <button
                    className="cluster-refresh-btn"
                    onClick={() => fetchInstances(selectedCrd)}
                    disabled={instancesLoading}
                  >
                    <Icon name="refresh" size={14} /> Refresh
                  </button>
                </div>
              </div>
              {instancesLoading ? (
                <Loader label="Loading instances…" inline />
              ) : instancesError ? (
                <div className="loading-indicator" style={{ color: '#ff6b6b' }}>{instancesError}</div>
              ) : instances.length === 0 ? (
                <div className="loading-indicator">No instances found</div>
              ) : (
                <table className="resource-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Namespace</th>
                      <th>Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instances.map((item, idx) => (
                      <tr key={`${item.namespace}-${item.name}-${idx}`} className="resource-table-row">
                        <td><span className="resource-name-cell">{item.name}</span></td>
                        <td><span style={{ color: '#0e90d4' }}>{item.namespace}</span></td>
                        <td>{formatAge(item.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </ResizableBottomPanel>
      )}
    </div>
  );
}
