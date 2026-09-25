import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

// Split a Helm "chart" label like "kube-prometheus-stack-58.1.0" into its chart
// name and version (the version starts at the last dash before a v?<digit>).
function parseChart(label) {
  const m = /^(.*)-(v?\d+(?:\.\d+)*[A-Za-z0-9.+-]*)$/.exec(String(label || ''));
  return m ? { name: m[1], version: m[2] } : { name: String(label || ''), version: '' };
}

// Search Artifact Hub for a Helm chart and install it — or, when `upgradeRelease`
// is given, upgrade/downgrade that existing release to a different version and/or
// values. Two views share one modal: a search list and a deploy form.
export default function HelmChartSearch({ onClose, onInstalled, upgradeRelease }) {
  const upgrading = !!upgradeRelease;
  const [view, setView] = useState('search'); // 'search' | 'install'
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [searched, setSearched] = useState(false);
  const [resolving, setResolving] = useState(upgrading); // auto-resolving the chart to upgrade

  const [helm, setHelm] = useState({ checked: false, installed: false, version: null });

  const [chart, setChart] = useState(null);
  const [versions, setVersions] = useState([]);
  const [form, setForm] = useState({ releaseName: '', namespace: 'default', version: '', values: '' });
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(null);

  const debounce = useRef(null);

  // Is helm available on the backend? Drives the deploy-disabled hint.
  useEffect(() => {
    let alive = true;
    axios.get('/api/helm/available')
      .then((r) => alive && setHelm({ checked: true, installed: !!r.data.installed, version: r.data.version }))
      .catch(() => alive && setHelm({ checked: true, installed: false, version: null }));
    return () => { alive = false; };
  }, []);

  // Escape closes the modal (unless we're mid-deploy).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !installing) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, installing]);

  const loadVersions = useCallback(async (repoName, chartName) => {
    try {
      const r = await axios.get('/api/helm/charts/versions', { params: { repo: repoName, chart: chartName } });
      setVersions(r.data.versions || []);
    } catch { /* keep the single default version */ }
  }, []);

  // Upgrade mode: resolve the release's chart on Artifact Hub, prefill the form
  // with the current version + values, and jump straight to the deploy form.
  useEffect(() => {
    if (!upgrading) return;
    let alive = true;
    (async () => {
      const { name: chartName, version: currentVersion } = parseChart(upgradeRelease.chart);
      // Pull the release's current user values so an upgrade doesn't reset them.
      let currentValues = '';
      try {
        const vr = await axios.get(`/api/helm/releases/${encodeURIComponent(upgradeRelease.namespace)}/${encodeURIComponent(upgradeRelease.name)}/values`);
        const y = (vr.data.yaml || '').trim();
        if (y && y !== '{}') currentValues = vr.data.yaml;
      } catch { /* no values / not readable */ }

      // Find the chart on Artifact Hub to learn its repo + available versions.
      let match = null;
      try {
        const sr = await axios.get('/api/helm/charts/search', { params: { q: chartName, limit: 20 } });
        const list = sr.data.charts || [];
        match = list.find((c) => c.name === chartName && (c.repository.official || c.repository.verified))
          || list.find((c) => c.name === chartName)
          || null;
      } catch { /* fall back to manual search */ }

      if (!alive) return;
      if (match) {
        setChart(match);
        setForm({ releaseName: upgradeRelease.name, namespace: upgradeRelease.namespace, version: currentVersion || match.version, values: currentValues });
        setView('install');
        setResolving(false);
        loadVersions(match.repository.name, match.name);
      } else {
        // Couldn't auto-resolve — let the user find the right repo. Keep the
        // release name/namespace pinned; prime the search with the chart name.
        setQuery(chartName);
        setResolving(false);
      }
    })();
    return () => { alive = false; };
  }, [upgrading, upgradeRelease, loadVersions]);

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
    if (resolving) return; // don't search until upgrade auto-resolve settles
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => runSearch(query), 350);
    return () => debounce.current && clearTimeout(debounce.current);
  }, [query, runSearch, resolving]);

  const pickChart = async (c) => {
    setChart(c);
    setForm((f) => ({
      releaseName: upgrading ? upgradeRelease.name : c.name,
      namespace: upgrading ? upgradeRelease.namespace : 'default',
      version: c.version,
      values: upgrading ? f.values : '',
    }));
    setInstallError(null);
    setVersions([]);
    setView('install');
    loadVersions(c.repository.name, c.name);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (installing) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const payload = {
        repoName: chart.repository.name,
        repoUrl: chart.repository.url,
        chart: chart.name,
        version: form.version || undefined,
        releaseName: form.releaseName.trim(),
        namespace: form.namespace.trim() || 'default',
        values: form.values,
      };
      let res;
      if (upgrading) {
        res = await axios.post('/api/helm/upgrade', { ...payload, reuseValues: true });
      } else {
        res = await axios.post('/api/helm/install', payload);
      }
      onInstalled?.(res.data);
      onClose();
    } catch (err) {
      setInstallError(err.response?.data?.error || err.message);
      setInstalling(false);
    }
  };

  const validName = (s) => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(s);
  const canDeploy = helm.installed && validName(form.releaseName.trim()) && validName(form.namespace.trim() || 'default') && !installing;
  const title = upgrading
    ? `Upgrade / downgrade ${upgradeRelease.name}`
    : (view === 'search' ? 'Install a Helm chart' : chart?.displayName || chart?.name);

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !installing) onClose(); }}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <span className="modal-icon"><Icon name="helm" size={20} /></span>
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} disabled={installing} title="Close" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {resolving ? (
          <div style={{ padding: '48px 0' }}><Loader label={`Looking up ${parseChart(upgradeRelease.chart).name} on Artifact Hub…`} inline /></div>
        ) : view === 'search' ? (
          <>
            {upgrading && (
              <div className="chart-warn" style={{ color: 'var(--text-secondary)', background: 'var(--bg-base)', borderColor: 'var(--border)' }}>
                <Icon name="details" size={14} /> Couldn’t auto-match “{parseChart(upgradeRelease.chart).name}”. Pick its repository below — it’ll upgrade <b>{upgradeRelease.name}</b> in <b>{upgradeRelease.namespace}</b>.
              </div>
            )}
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
          <form onSubmit={submit} className="chart-install-form">
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
                  {upgrading && <span>current: {parseChart(upgradeRelease.chart).version || '—'}</span>}
                </div>
              </div>
            </div>

            <div className="chart-form-grid">
              <div>
                <label className="modal-label">Release name</label>
                <input className="modal-input" value={form.releaseName} spellCheck={false} readOnly={upgrading}
                  onChange={(e) => setForm((f) => ({ ...f, releaseName: e.target.value }))} autoFocus={!upgrading} />
              </div>
              <div>
                <label className="modal-label">Namespace</label>
                <input className="modal-input" value={form.namespace} spellCheck={false} readOnly={upgrading}
                  onChange={(e) => setForm((f) => ({ ...f, namespace: e.target.value }))} placeholder="default" />
              </div>
              <div>
                <label className="modal-label">Version {upgrading && <span className="chart-ver-hint">(upgrade or downgrade)</span>}</label>
                <select className="modal-input" value={form.version} autoFocus={upgrading}
                  onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}>
                  {(versions.length ? versions : [{ version: form.version, appVersion: chart.appVersion }]).map((v) => (
                    <option key={v.version} value={v.version}>
                      {v.version}{v.appVersion ? ` (app ${v.appVersion})` : ''}{upgrading && v.version === parseChart(upgradeRelease.chart).version ? ' — current' : ''}
                    </option>
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
              {upgrading ? (
                <>Runs <code>helm upgrade</code> on <code>{form.releaseName}</code> in <code>{form.namespace}</code>. Existing values are reused unless you edit them above.</>
              ) : (
                <>Installs into <code>{form.namespace.trim() || 'default'}</code> (created if missing) with <code>helm upgrade --install</code>.</>
              )}
            </p>

            {installError && (
              <div className="modal-error"><Icon name="details" size={14} /> {installError}</div>
            )}

            <div className="chart-install-actions">
              <button type="button" className="modal-btn" onClick={() => setView('search')} disabled={installing || upgrading}
                style={upgrading ? { visibility: 'hidden' } : undefined}>
                <Icon name="arrowLeft" size={14} /> Back
              </button>
              <button type="submit" className="modal-btn primary" disabled={!canDeploy}
                title={!helm.installed ? 'Helm is not available on the server' : undefined}>
                {installing ? (upgrading ? 'Applying…' : 'Installing…') : <><Icon name="download" size={14} /> {upgrading ? 'Apply' : 'Install'}</>}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
