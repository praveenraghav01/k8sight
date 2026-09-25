import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

// CLI-free GKE import dialog. Two sign-in methods, mirroring the Azure/AWS
// flows: a Google service-account key (works out of the box) or browser OAuth
// (when a Google OAuth client is configured). Reuses the .azure-* modal styles.
const keyOf = (c) => `${c.project}/${c.location}/${c.name}`;

export default function GkeIntegration({ onClose, onImported }) {
  const [phase, setPhase] = useState('checking'); // checking | choose | key | browser | listing | list | importing | done
  const [oauthConfigured, setOauth] = useState(false);
  const [adcAvailable, setAdcAvailable] = useState(false);
  const [adcAccount, setAdcAccount] = useState(null);
  const [keyText, setKeyText] = useState('');
  const [clusters, setClusters] = useState([]);
  const [sel, setSel] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => () => { clearInterval(pollRef.current); }, []);

  const checkStatus = async () => {
    setError(null); setPhase('checking');
    try {
      const { data } = await axios.get('/api/gke/status');
      setOauth(!!data.oauthConfigured);
      setAdcAvailable(!!data.adcAvailable);
      setAdcAccount(data.account || null);
      if (data.loggedIn) return listClusters();
      setPhase('choose');
    } catch (e) { setError(e.response?.data?.error || e.message); setPhase('choose'); }
  };
  useEffect(() => { checkStatus(); }, []); // eslint-disable-line

  const listClusters = async () => {
    setPhase('listing'); setError(null);
    try {
      const { data } = await axios.get('/api/gke/clusters');
      setClusters(data.clusters || []); setPhase('list');
    } catch (e) { setError(e.response?.data?.error || e.message); setPhase('choose'); }
  };

  const submitKey = async () => {
    setError(null); setPhase('listing');
    try {
      const { data } = await axios.post('/api/gke/service-account', { key: keyText });
      setClusters(data.clusters || []); setPhase('list');
    } catch (e) { setError(e.response?.data?.error || e.message); setPhase('key'); }
  };

  const onFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => setKeyText(String(r.result || ''));
    r.readAsText(f);
  };

  const startBrowser = async () => {
    setError(null); setPhase('browser');
    try {
      const { data } = await axios.post('/api/gke/browser/login');
      if (data.authUrl) window.open(data.authUrl, '_blank', 'noopener');
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const { data: s } = await axios.get('/api/gke/browser/status');
          if (s.status === 'done') { clearInterval(pollRef.current); listClusters(); }
          else if (s.status === 'error') { clearInterval(pollRef.current); setError(s.error || 'Sign-in failed'); setPhase('choose'); }
        } catch { /* keep polling */ }
      }, 1500);
    } catch (e) { setError(e.response?.data?.error || e.message); setPhase('choose'); }
  };

  const doImport = async () => {
    setPhase('importing'); setError(null);
    const chosen = clusters.filter((c) => sel.has(keyOf(c)));
    try {
      const { data } = await axios.post('/api/gke/import', { clusters: chosen });
      setResult(data); setPhase('done'); onImported?.(data.contexts);
    } catch (e) { setError(e.response?.data?.error || e.message); setPhase('list'); }
  };

  const cancelAndClose = () => { if (phase === 'browser') axios.post('/api/gke/browser/cancel').catch(() => {}); clearInterval(pollRef.current); onClose(); };

  const q = filter.toLowerCase();
  const visible = clusters.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.project || '').toLowerCase().includes(q) || (c.location || '').toLowerCase().includes(q));
  const allVisibleSelected = visible.length > 0 && visible.every((c) => sel.has(keyOf(c)));
  const toggle = (c) => setSel((s) => { const n = new Set(s); const k = keyOf(c); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleAll = () => setSel((s) => { const n = new Set(s); if (allVisibleSelected) visible.forEach((c) => n.delete(keyOf(c))); else visible.forEach((c) => n.add(keyOf(c))); return n; });
  const selCount = sel.size;

  return (
    <div className="action-modal-backdrop" onClick={cancelAndClose}>
      <div className="action-modal azure-modal" onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: '94vw' }}>
        <div className="azure-head">
          <h3 className="action-modal-title" style={{ margin: 0 }}><Icon name="gcp" size={18} /> Add Google GKE clusters</h3>
          <button className="azure-x" onClick={cancelAndClose} title="Close"><Icon name="close" size={16} /></button>
        </div>

        {error && <div className="azure-error"><Icon name="warning" size={14} /> {error}</div>}

        {phase === 'checking' && <div className="azure-center"><Loader label="Connecting to Google Cloud…" /></div>}

        {phase === 'choose' && (
          <div className="azure-center azure-msg">
            <Icon name="gcp" size={28} />
            <p>Sign in to Google Cloud to discover the GKE clusters you can access.</p>
            {adcAvailable && (
              <>
                <button className="action-modal-btn primary" onClick={listClusters}>Use your gcloud credentials</button>
                <p className="azure-dim" style={{ marginTop: -4 }}>
                  {adcAccount ? `Signed in as ${adcAccount} via gcloud` : 'Detected gcloud credentials on this machine'} — no setup needed
                </p>
              </>
            )}
            {oauthConfigured && <button className={`action-modal-btn ${adcAvailable ? '' : 'primary'}`} onClick={startBrowser}>Sign in with browser</button>}
            <button className={`action-modal-btn ${oauthConfigured || adcAvailable ? '' : 'primary'}`} onClick={() => setPhase('key')}>Use a service-account key</button>
            <p className="azure-dim" style={{ marginTop: 8 }}>
              {oauthConfigured
                ? 'Browser sign-in uses your Google account. A service-account key works without an OAuth client.'
                : 'Provide a service-account key (JSON) with Kubernetes Engine + resource-viewer access. No gcloud required.'}
            </p>
          </div>
        )}

        {phase === 'key' && (
          <div className="azure-center azure-msg" style={{ alignItems: 'stretch' }}>
            <p style={{ textAlign: 'center' }}>Paste a Google <b>service-account key</b> (JSON), or choose the file.</p>
            <textarea
              className="azure-search" style={{ width: '100%', minHeight: 150, fontFamily: 'var(--mono, monospace)', fontSize: 12, resize: 'vertical' }}
              placeholder='{ "type": "service_account", "project_id": "...", "private_key": "...", "client_email": "..." }'
              value={keyText} onChange={(e) => setKeyText(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', marginTop: 6 }}>
              <label className="action-modal-btn" style={{ cursor: 'pointer' }}>
                Choose file…<input type="file" accept="application/json,.json" onChange={onFile} style={{ display: 'none' }} />
              </label>
            </div>
            <div className="action-modal-actions">
              <button className="action-modal-btn" onClick={() => setPhase('choose')}>Back</button>
              <button className="action-modal-btn primary" disabled={!keyText.trim()} onClick={submitKey}>Continue</button>
            </div>
          </div>
        )}

        {phase === 'browser' && (
          <div className="azure-center azure-msg">
            <Icon name="gcp" size={28} />
            <p>A browser window opened for Google sign-in — pick your account and complete it there.</p>
            <div className="azure-waiting"><Loader label="Waiting for sign-in to complete…" /></div>
          </div>
        )}

        {phase === 'listing' && <div className="azure-center"><Loader label="Discovering GKE clusters across your projects…" /></div>}

        {phase === 'list' && (
          <>
            <div className="azure-toolbar">
              <input className="azure-search" placeholder="Filter by name, project or location…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <span className="azure-count">{clusters.length} cluster{clusters.length === 1 ? '' : 's'}</span>
            </div>
            <div className="azure-list">
              {visible.length === 0 ? (
                <div className="azure-empty">{clusters.length === 0 ? 'No GKE clusters found for this account.' : 'No clusters match your filter.'}</div>
              ) : (
                <>
                  <label className="azure-row azure-selall">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} />
                    <span className="azure-selall-label">Select all</span>
                  </label>
                  {visible.map((c) => (
                    <label key={keyOf(c)} className="azure-row">
                      <input type="checkbox" checked={sel.has(keyOf(c))} onChange={() => toggle(c)} />
                      <span className="azure-cluster">
                        <span className="azure-cname">{c.name}</span>
                        <span className="azure-cmeta">{c.project} · {c.location}{c.version ? ` · v${c.version}` : ''}</span>
                      </span>
                      {c.status && c.status !== 'RUNNING' ? <span className="azure-badge muted">{c.status}</span> : null}
                    </label>
                  ))}
                </>
              )}
            </div>
            <div className="action-modal-actions">
              <button className="action-modal-btn" onClick={cancelAndClose}>Cancel</button>
              <button className="action-modal-btn primary" disabled={selCount === 0} onClick={doImport}>
                Add {selCount} cluster{selCount === 1 ? '' : 's'}
              </button>
            </div>
          </>
        )}

        {phase === 'importing' && <div className="azure-center"><Loader label="Adding clusters to your kubeconfig…" /></div>}

        {phase === 'done' && (
          <div className="azure-center azure-msg">
            <div className="azure-done-icon"><Icon name="check" size={26} strokeWidth={2.6} /></div>
            <p><b>{result?.imported?.length || 0}</b> cluster{(result?.imported?.length || 0) === 1 ? '' : 's'} added to your kubeconfig.</p>
            {result?.failed?.length > 0 && (
              <div className="azure-failed">{result.failed.map((f) => <div key={f.name}><b>{f.name}</b>: {f.error}</div>)}</div>
            )}
            {result?.replaced?.length > 0 && (
              <div className="azure-warn">
                <b>{result.replaced.length}</b> context{result.replaced.length === 1 ? '' : 's'} already existed and now authenticate{result.replaced.length === 1 ? 's' : ''} through k8sight.
              </div>
            )}
            <p className="azure-dim">They're now available in the context selector.</p>
            <button className="action-modal-btn primary" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
