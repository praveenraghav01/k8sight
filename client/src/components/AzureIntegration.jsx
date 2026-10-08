import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

const keyOf = (c) => `${c.subscriptionId}/${c.name}`;

// One-click Azure AKS integration: sign in with `az`, discover every AKS cluster
// across all subscriptions, and merge the chosen ones into the kubeconfig.
export default function AzureIntegration({ onClose, onImported, initialLogin }) {
  const [phase, setPhase] = useState('checking'); // checking | not-installed | login | listing | list | importing | done
  const [signingIn, setSigningIn] = useState(false);
  const [azInstalled, setAzInstalled] = useState(false);
  const [authUrl, setAuthUrl] = useState(null);
  const [device, setDevice] = useState(null);      // { userCode, verificationUrl } — device-code fallback
  const [clusters, setClusters] = useState([]);
  const [subs, setSubs] = useState(0);
  const [sel, setSel] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => { checkStatus(); return () => clearInterval(pollRef.current); }, []);

  const checkStatus = async () => {
    setPhase('checking'); setError(null);
    try {
      const { data } = await axios.get('/api/azure/status');
      setAzInstalled(!!data.azInstalled);
      if (!data.installed) setPhase('not-installed');
      // Opened to fix a kubelogin/azurecli cluster: force an `az login` so the
      // Azure CLI token kubelogin reads is actually refreshed (a browser sign-in,
      // or a still-valid ARM session, would not touch it).
      else if (initialLogin === 'az' && data.azInstalled) { setPhase('login'); startLogin('az'); }
      else if (!data.loggedIn) setPhase('login');
      else loadClusters();
    } catch (e) { setError(e.message); setPhase('not-installed'); }
  };

  const startLogin = async (method = 'browser', deviceCode = false) => {
    setError(null); setDevice(null); setAuthUrl(null); setSigningIn(true);
    try {
      const { data } = await axios.post('/api/azure/login', { method, deviceCode });
      if (data.error) { setError(data.error); setSigningIn(false); return; }
      // Browser flow: open the Azure sign-in page in the system browser.
      if (data.authUrl) { setAuthUrl(data.authUrl); try { window.open(data.authUrl, '_blank', 'noopener'); } catch { /* user can click the link */ } }
      if (data.userCode) setDevice({ userCode: data.userCode, verificationUrl: data.verificationUrl });
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const { data: s } = await axios.get('/api/azure/login/status');
          if (s.userCode) setDevice((d) => d || { userCode: s.userCode, verificationUrl: s.verificationUrl });
          if (s.status === 'done') { clearInterval(pollRef.current); loadClusters(); }
          else if (s.status === 'error' || s.status === 'cancelled') { clearInterval(pollRef.current); setSigningIn(false); setError(s.error || 'Sign-in failed or was cancelled.'); }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e) { setSigningIn(false); setError(e.response?.data?.error || e.message); }
  };

  const loadClusters = async () => {
    setPhase('listing'); setError(null); setDevice(null); setSigningIn(false);
    try {
      const { data } = await axios.get('/api/azure/clusters');
      const list = data.clusters || [];
      setClusters(list);
      setSubs(data.subscriptions || 0);
      setSel(new Set(list.filter((c) => !c.imported).map(keyOf)));
      setPhase('list');
    } catch (e) { setError(e.response?.data?.error || e.message); setPhase('list'); }
  };

  const doImport = async () => {
    const chosen = clusters.filter((c) => sel.has(keyOf(c)));
    if (!chosen.length) return;
    setPhase('importing'); setError(null);
    try {
      const { data } = await axios.post('/api/azure/import', {
        clusters: chosen.map((c) => ({ name: c.name, resourceGroup: c.resourceGroup, subscriptionId: c.subscriptionId })),
        admin,
      });
      setResult(data);
      setPhase('done');
      onImported?.(data.contexts);
    } catch (e) { setError(e.response?.data?.error || e.message); setPhase('list'); }
  };

  const cancelAndClose = () => {
    clearInterval(pollRef.current);
    if (phase === 'login') axios.post('/api/azure/login/cancel').catch(() => {});
    onClose();
  };

  // Signed in but not importing anything — e.g. the user only needed to refresh
  // an expired Azure token to fix the current cluster. Re-check auth (so the
  // fresh token takes effect) and close.
  const skip = () => {
    clearInterval(pollRef.current);
    onImported?.();
    onClose();
  };

  const q = filter.toLowerCase();
  const visible = clusters.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.subscriptionName || '').toLowerCase().includes(q) || (c.location || '').toLowerCase().includes(q));
  const selectableVisible = visible.filter((c) => !c.imported);
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((c) => sel.has(keyOf(c)));
  const toggle = (c) => setSel((s) => { const n = new Set(s); const k = keyOf(c); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleAll = () => setSel((s) => {
    const n = new Set(s);
    if (allVisibleSelected) selectableVisible.forEach((c) => n.delete(keyOf(c)));
    else selectableVisible.forEach((c) => n.add(keyOf(c)));
    return n;
  });
  const selCount = sel.size;

  return (
    <div className="action-modal-backdrop" onClick={cancelAndClose}>
      <div className="action-modal azure-modal" onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: '94vw' }}>
        <div className="azure-head">
          <h3 className="action-modal-title" style={{ margin: 0 }}>
            <Icon name="azure" size={18} /> Add Azure AKS clusters
          </h3>
          <button className="azure-x" onClick={cancelAndClose} title="Close"><Icon name="close" size={16} /></button>
        </div>

        {error && <div className="azure-error"><Icon name="warning" size={14} /> {error}</div>}

        {phase === 'checking' && <div className="azure-center"><Loader label="Connecting to Azure…" /></div>}

        {phase === 'not-installed' && (
          <div className="azure-center azure-msg">
            <Icon name="warning" size={22} />
            <p>Couldn't reach the Azure integration.</p>
            <p className="azure-dim">Check your network connection and try again.</p>
            <button className="action-modal-btn" onClick={checkStatus}>Retry</button>
          </div>
        )}

        {phase === 'login' && (
          <div className="azure-center azure-msg">
            {!signingIn ? (
              <>
                <Icon name="azure" size={28} />
                <p>Sign in to your Azure account to discover the AKS clusters you can access.</p>
                <button className="action-modal-btn primary" onClick={() => startLogin('browser')}>Sign in with browser</button>
                {azInstalled && <button className="azure-alt" onClick={() => startLogin('az')}>Use the Azure CLI (<code>az</code>) instead</button>}
                <p className="azure-dim" style={{ marginTop: 8 }}>Browser sign-in works with managed-device policies. Use the CLI if the browser flow is blocked.</p>
              </>
            ) : device ? (
              <>
                <p>To sign in, open the device-login page and enter this code:</p>
                <div className="azure-code">{device.userCode}</div>
                <a className="action-modal-btn primary" href={device.verificationUrl} target="_blank" rel="noreferrer">
                  <Icon name="externalLink" size={14} /> Open {device.verificationUrl.replace(/^https?:\/\//, '')}
                </a>
                <div className="azure-waiting"><Loader label="Waiting for sign-in to complete…" /></div>
              </>
            ) : (
              <>
                <Icon name="azure" size={28} />
                <p>A browser window opened for Azure sign-in. Pick your account and finish signing in there.</p>
                {authUrl && <a className="azure-alt" href={authUrl} target="_blank" rel="noreferrer"><Icon name="externalLink" size={13} /> No window opened? Open the sign-in page</a>}
                <div className="azure-waiting"><Loader label="Waiting for sign-in to complete…" /></div>
              </>
            )}
          </div>
        )}

        {phase === 'listing' && <div className="azure-center"><Loader label="Discovering AKS clusters across your subscriptions…" /></div>}

        {phase === 'list' && (
          <>
            <div className="azure-toolbar">
              <input className="azure-search" placeholder="Filter by name, subscription or region…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <span className="azure-count">{clusters.length} cluster{clusters.length === 1 ? '' : 's'} · {subs} subscription{subs === 1 ? '' : 's'}</span>
            </div>
            <div className="azure-list">
              {visible.length === 0 ? (
                <div className="azure-empty">{clusters.length === 0 ? 'No AKS clusters found for your account.' : 'No clusters match your filter.'}</div>
              ) : (
                <>
                  <label className="azure-row azure-selall">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} disabled={selectableVisible.length === 0} />
                    <span className="azure-selall-label">Select all</span>
                  </label>
                  {visible.map((c) => (
                    <label key={keyOf(c)} className={`azure-row ${c.imported ? 'imported' : ''}`}>
                      <input type="checkbox" checked={c.imported || sel.has(keyOf(c))} disabled={c.imported} onChange={() => toggle(c)} />
                      <span className="azure-cluster">
                        <span className="azure-cname">{c.name}</span>
                        <span className="azure-cmeta">{c.subscriptionName} · {c.location}{c.kubernetesVersion ? ` · v${c.kubernetesVersion}` : ''}</span>
                      </span>
                      {c.imported
                        ? <span className="azure-badge added"><Icon name="check" size={12} strokeWidth={2.6} /> Added</span>
                        : c.powerState && c.powerState !== 'Running' && c.powerState !== 'Succeeded'
                          ? <span className="azure-badge muted">{c.powerState}</span> : null}
                    </label>
                  ))}
                </>
              )}
            </div>
            <label className="azure-admin">
              <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
              Use admin credentials (<code>--admin</code>): cluster-admin certs that bypass Azure AD
            </label>
            <div className="action-modal-actions">
              <button className="action-modal-btn ghost" style={{ marginRight: 'auto' }} onClick={skip} title="Continue without adding clusters">
                Skip
              </button>
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
              <div className="azure-failed">
                {result.failed.map((f) => <div key={f.name}><b>{f.name}</b>: {f.error}</div>)}
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
