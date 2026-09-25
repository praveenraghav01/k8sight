import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

// Search Artifact Hub for a Helm chart and install it into the current cluster.
// Two views share one modal: a search list, and an install form for the chart
// the user picks. Installing shells out to `helm` on the backend.
export default function HelmChartSearch({ onClose, onInstalled }) {
  const [view, setView] = useState('search'); // 'search' | 'install'
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [searched, setSearched] = useState(false);

  const [helm, setHelm] = useState({ checked: false, installed: false, version: null });

  const [chart, setChart] = useState(null);
  const [versions, setVersions] = useState([]);
  const [form, setForm] = useState({ releaseName: '', namespace: 'default', version: '', values: '' });
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(null);

  const debounce = useRef(null);

  // Is helm available on the backend? Drives the install-disabled hint.
  useEffect(() => {
    let alive = true;
    axios.get('/api/helm/available')
      .then((r) => alive && setHelm({ checked: true, installed: !!r.data.installed, version: r.data.version }))
      .catch(() => alive && setHelm({ checked: true, installed: false, version: null }));
    return () => { alive = false; };
  }, []);

  // Escape closes the modal (unless we're mid-install).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !installing) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, installing]);

  const runSearch = useCallback(async (q) => {
    if (!q.trim()) { setResults([]); setSearched(false); return; }
    setSearching(true);
    setSearchError(null);
    try {
      const r = await axios.get('/api/helm/charts/search', { params: { q } });
      setResults(r.data.charts || []);
    } catch (err) {
      setSearchError(err.response?.data?.error || err.message);
      setResults([]);
    } finally {
      setSearching(false);
      setSearched(true);
    }
  }, []);

  // Debounce the query so we don't hammer Artifact Hub on every keystroke.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => runSearch(query), 350);
    return () => debounce.current && clearTimeout(debounce.current);
  }, [query, runSearch]);

  const pickChart = async (c) => {
    setChart(c);
    setForm({ releaseName: c.name, namespace: 'default', version: c.version, values: '' });
    setInstallError(null);
    setVersions([]);
    setView('install');
    try {
      const r = await axios.get('/api/helm/charts/versions', { params: { repo: c.repository.name, chart: c.name } });
      setVersions(r.data.versions || []);
    } catch { /* keep the single default version */ }
  };

  const install = async (e) => {
    e.preventDefault();
    if (installing) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const res = await axios.post('/api/helm/install', {
        repoName: chart.repository.name,
        repoUrl: chart.repository.url,
        chart: chart.name,
        version: form.version || undefined,
        releaseName: form.releaseName.trim(),
        namespace: form.namespace.trim() || 'default',
        values: form.values,
      });
      onInstalled?.(res.data);
      onClose();
    } catch (err) {
      setInstallError(err.response?.data?.error || err.message);
      setInstalling(false);
    }
  };

  const validName = (s) => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(s);
  const canInstall = helm.installed && validName(form.releaseName.trim()) && validName(form.namespace.trim() || 'default') && !installing;

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !installing) onClose(); }}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <span className="modal-icon"><Icon name="helm" size={20} /></span>
          <h2>{view === 'search' ? 'Install a Helm chart' : chart?.displayName || chart?.name}</h2>
          <button className="modal-close" onClick={onClose} disabled={installing} title="Close" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {view === 'search' ? (
          <>
            <div className="chart-search-box">
              <span className="chart-search-icon"><Icon name="search" size={16} /></span>
              <input
                className="chart-search-input"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search charts on Artifact Hub — nginx, prometheus, redis…"
                spellCheck={false}
                autoFocus
              />
              {searching && <span className="chart-search-spin"><Icon name="refresh" size={14} /></span>}
            </div>

            {!helm.installed && helm.checked && (
              <div className="chart-warn">
                <Icon name="warning" size={14} /> Helm isn’t available on the server — you can browse charts, but installing is disabled.
              </div>
            )}

            <div className="chart-results">
              {searchError ? (
                <div className="chart-empty" style={{ color: 'var(--red)' }}>{searchError}</div>
              ) : !query.trim() ? (
                <div className="chart-empty">Start typing to search thousands of charts from every public Helm repository.</div>
              ) : searching && results.length === 0 ? (
                <Loader label="Searching Artifact Hub…" inline />
              ) : searched && results.length === 0 ? (
                <div className="chart-empty">No charts match “{query}”.</div>
              ) : (
                results.map((c) => (
                  <button key={c.id} className="chart-result" onClick={() => pickChart(c)}>
                    <div className="chart-result-logo">
                      {c.logo ? <img src={c.logo} alt="" onError={(e) => { e.target.style.display = 'none'; }} /> : <Icon name="box" size={20} />}
                    </div>
                    <div className="chart-result-main">
                      <div className="chart-result-title">
                        <span className="chart-result-name">{c.displayName || c.name}</span>
                        {c.repository.official && <span className="chart-badge official">official</span>}
                        {!c.repository.official && c.repository.verified && <span className="chart-badge verified">verified</span>}
                        {c.deprecated && <span className="chart-badge deprecated">deprecated</span>}
                      </div>
                      <div className="chart-result-desc">{c.description}</div>
                      <div className="chart-result-meta">
                        <span>{c.repository.name}</span>
                        <span>v{c.version}</span>
                        {c.appVersion && <span>app {c.appVersion}</span>}
                        <span>★ {c.stars}</span>
                      </div>
                    </div>
                    <span className="chart-result-go"><Icon name="chevronRight" size={16} /></span>
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <form onSubmit={install} className="chart-install-form">
            <div className="chart-install-summary">
              <div className="chart-result-logo">
                {chart.logo ? <img src={chart.logo} alt="" onError={(e) => { e.target.style.display = 'none'; }} /> : <Icon name="box" size={20} />}
              </div>
              <div>
                <div className="chart-result-desc" style={{ marginTop: 0 }}>{chart.description}</div>
                <div className="chart-result-meta">
                  <a href={`https://artifacthub.io/packages/helm/${chart.repository.name}/${chart.name}`} target="_blank" rel="noreferrer" className="chart-link">
                    {chart.repository.name}/{chart.name} <Icon name="externalLink" size={11} />
                  </a>
                </div>
              </div>
            </div>

            <div className="chart-form-grid">
              <div>
                <label className="modal-label">Release name</label>
                <input className="modal-input" value={form.releaseName} spellCheck={false}
                  onChange={(e) => setForm((f) => ({ ...f, releaseName: e.target.value }))} autoFocus />
              </div>
              <div>
                <label className="modal-label">Namespace</label>
                <input className="modal-input" value={form.namespace} spellCheck={false}
                  onChange={(e) => setForm((f) => ({ ...f, namespace: e.target.value }))} placeholder="default" />
              </div>
              <div>
                <label className="modal-label">Version</label>
                <select className="modal-input" value={form.version}
                  onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}>
                  {(versions.length ? versions : [{ version: form.version, appVersion: chart.appVersion }]).map((v) => (
                    <option key={v.version} value={v.version}>{v.version}{v.appVersion ? ` (app ${v.appVersion})` : ''}</option>
                  ))}
                </select>
              </div>
            </div>

            <label className="modal-label">Values (YAML, optional)</label>
            <textarea
              className="modal-input chart-values"
              value={form.values}
              onChange={(e) => setForm((f) => ({ ...f, values: e.target.value }))}
              placeholder={'# Override chart defaults, e.g.\nreplicaCount: 2\nservice:\n  type: LoadBalancer'}
              spellCheck={false}
              rows={7}
            />

            <p className="modal-hint">
              Installs into <code>{form.namespace.trim() || 'default'}</code> (created if missing) with
              <code> helm upgrade --install</code>. The namespace is created automatically.
            </p>

            {installError && (
              <div className="modal-error"><Icon name="details" size={14} /> {installError}</div>
            )}

            <div className="chart-install-actions">
              <button type="button" className="modal-btn" onClick={() => setView('search')} disabled={installing}>
                <Icon name="arrowLeft" size={14} /> Back
              </button>
              <button type="submit" className="modal-btn primary" disabled={!canInstall}
                title={!helm.installed ? 'Helm is not available on the server' : undefined}>
                {installing ? 'Installing…' : <><Icon name="download" size={14} /> Install</>}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
