import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

const keyOf = (c) => `${c.region}/${c.name}`;

// One-click AWS EKS integration: sign in (SSO / access keys / assume-role),
// discover every EKS cluster across all regions, and merge chosen ones into the
// kubeconfig. Mirrors the Azure AKS modal.
export default function AwsIntegration({ onClose, onImported }) {
  const [phase, setPhase] = useState('checking'); // checking|not-installed|method|sso-login|listing|list|importing|done
  const [profiles, setProfiles] = useState([]);
  const [method, setMethod] = useState('sso'); // sso | access-key | role
  const [advanced, setAdvanced] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [ssoProfile, setSsoProfile] = useState('');
  const [ssoStartUrl, setSsoStartUrl] = useState('');
  const [ssoRegionField, setSsoRegionField] = useState('');
  const [existingProfile, setExistingProfile] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [region, setRegion] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [sourceProfile, setSourceProfile] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [device, setDevice] = useState(null);
  const [ssoAccounts, setSsoAccounts] = useState([]);
  const [ssoRoles, setSsoRoles] = useState([]);
  const [chosenAccount, setChosenAccount] = useState('');
  const [chosenRole, setChosenRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeProfile, setActiveProfile] = useState(null);
  const [clusters, setClusters] = useState([]);
  const [regionsScanned, setRegionsScanned] = useState(0);
  const [sel, setSel] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => { checkStatus(); return () => clearInterval(pollRef.current); }, []);

  const checkStatus = async () => {
    setPhase('checking'); setError(null);
    try {
      const { data } = await axios.get('/api/aws/status');
      if (!data.installed) return setPhase('not-installed');
      const ps = data.profiles || [];
      setProfiles(ps);
      if (ps.length) { setSsoProfile(ps[0]); setSourceProfile(ps[0]); setExistingProfile(ps[0]); }
      setPhase('method');
    } catch (e) { setError(e.message); setPhase('not-installed'); }
  };

  const startSsoLogin = async (profile) => {
    setError(null); setDevice(null); setSigningIn(true); setPhase('sso-login');
    try {
      const { data } = await axios.post('/api/aws/sso-login', { profile: profile || undefined, startUrl: ssoStartUrl || undefined, ssoRegion: ssoRegionField || undefined });
      if (data.error) { setError(data.error); setSigningIn(false); setPhase('method'); return; }
      if (data.userCode) setDevice({ userCode: data.userCode, verificationUrl: data.verificationUrl });
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const { data: s } = await axios.get('/api/aws/sso-login/status');
          if (s.userCode) setDevice((d) => d || { userCode: s.userCode, verificationUrl: s.verificationUrl });
          if (s.status === 'done') { clearInterval(pollRef.current); loadAccounts(); }
          else if (s.status === 'error') { clearInterval(pollRef.current); setSigningIn(false); setPhase('method'); setError(s.error || 'SSO sign-in failed or was cancelled.'); }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e) { setSigningIn(false); setPhase('method'); setError(e.response?.data?.error || e.message); }
  };

  const loadAccounts = async () => {
    setSigningIn(false); setDevice(null); setError(null); setBusy(true); setPhase('sso-account');
    try {
      const { data } = await axios.get('/api/aws/sso-accounts');
      const accts = data.accounts || [];
      setSsoAccounts(accts);
      if (accts.length) setChosenAccount(accts[0].accountId);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const loadRoles = async (accountId) => {
    setError(null); setBusy(true); setPhase('sso-role');
    try {
      const { data } = await axios.get('/api/aws/sso-roles', { params: { account: accountId } });
      const roles = data.roles || [];
      setSsoRoles(roles);
      setChosenRole(roles[0] || '');
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const discoverSso = async (account, role) => {
    setActiveProfile(null);
    setPhase('listing'); setError(null);
    try {
      const { data } = await axios.post('/api/aws/clusters', { account, role });
      const list = data.clusters || [];
      setClusters(list);
      setRegionsScanned(data.regions || 0);
      setSel(new Set(list.filter((c) => !c.imported).map(keyOf)));
      setPhase('list');
    } catch (e) { setError(e.response?.data?.error || e.message); setPhase('list'); }
  };

  const configureAndDiscover = async () => {
    setError(null);
    try {
      const body = method === 'access-key'
        ? { method, name: profileName, accessKeyId, secretAccessKey: secretKey, sessionToken, region }
        : { method: 'role', name: profileName, roleArn, sourceProfile, sessionName, region };
      const { data } = await axios.post('/api/aws/configure', body);
      discover(data.profile);
    } catch (e) { setError(e.response?.data?.error || e.message); }
  };

  const discover = async (profile) => {
    setActiveProfile(profile || null);
    setPhase('listing'); setError(null); setDevice(null); setSigningIn(false);
    try {
      const { data } = await axios.post('/api/aws/clusters', { profile: profile || undefined });
      const list = data.clusters || [];
      setClusters(list);
      setRegionsScanned(data.regions || 0);
      setSel(new Set(list.filter((c) => !c.imported).map(keyOf)));
      setPhase('list');
    } catch (e) { setError(e.response?.data?.error || e.message); setPhase('list'); }
  };

  const doImport = async () => {
    const chosen = clusters.filter((c) => sel.has(keyOf(c)));
    if (!chosen.length) return;
    setPhase('importing'); setError(null);
    try {
      const { data } = await axios.post('/api/aws/import', {
        clusters: chosen.map((c) => ({ name: c.name, region: c.region })),
        profile: activeProfile || undefined,
      });
      setResult(data); setPhase('done'); onImported?.(data.contexts);
    } catch (e) { setError(e.response?.data?.error || e.message); setPhase('list'); }
  };

  const cancelAndClose = () => {
    clearInterval(pollRef.current);
    if (phase === 'sso-login') axios.post('/api/aws/sso-login/cancel').catch(() => {});
    onClose();
  };

  // Signed in but not importing — e.g. the user only needed to refresh expired
  // AWS credentials to fix the current cluster. Re-check auth and close.
  const skip = () => {
    clearInterval(pollRef.current);
    onImported?.();
    onClose();
  };

  const q = filter.toLowerCase();
  const visible = clusters.filter((c) => !q || c.name.toLowerCase().includes(q) || c.region.toLowerCase().includes(q));
  const selectable = visible.filter((c) => !c.imported);
  const allSelected = selectable.length > 0 && selectable.every((c) => sel.has(keyOf(c)));
  const toggle = (c) => setSel((s) => { const n = new Set(s); const k = keyOf(c); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleAll = () => setSel((s) => { const n = new Set(s); allSelected ? selectable.forEach((c) => n.delete(keyOf(c))) : selectable.forEach((c) => n.add(keyOf(c))); return n; });

  const field = (label, node) => (
    <label className="aws-field"><span>{label}</span>{node}</label>
  );

  return (
    <div className="action-modal-backdrop" onClick={cancelAndClose}>
      <div className="action-modal azure-modal" onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: '94vw' }}>
        <div className="azure-head">
          <h3 className="action-modal-title" style={{ margin: 0 }}><Icon name="aws" size={18} /> Add AWS EKS clusters</h3>
          <button className="azure-x" onClick={cancelAndClose} title="Close"><Icon name="close" size={16} /></button>
        </div>

        {error && <div className="azure-error"><Icon name="warning" size={14} /> {error}</div>}

        {phase === 'checking' && <div className="azure-center"><Loader label="Checking AWS CLI…" /></div>}

        {phase === 'not-installed' && (
          <div className="azure-center azure-msg">
            <Icon name="warning" size={22} />
            <p>The AWS CLI (<code>aws</code>) isn't installed or isn't on this server's PATH.</p>
            <p className="azure-dim">Install it, then reopen this dialog. See <span className="azure-link">https://aws.amazon.com/cli/</span></p>
            <button className="action-modal-btn" onClick={checkStatus}>Retry</button>
          </div>
        )}

        {phase === 'method' && (
          <>
            {/* Primary: AWS SSO (IAM Identity Center) — the recommended flow. */}
            <div className="aws-sso-primary">
              <div className="aws-sso-head">
                <span className="aws-sso-icon"><Icon name="aws" size={20} /></span>
                <div>
                  <div className="aws-sso-title">Sign in with AWS SSO <span className="aws-rec">Recommended</span></div>
                  <div className="azure-dim">IAM Identity Center. Sign in in the browser and authorize access.</div>
                </div>
              </div>
              {profiles.length > 0 && field('SSO profile (optional)', <select className="aws-input" value={ssoProfile} onChange={(e) => setSsoProfile(e.target.value)}><option value="">Enter a start URL below</option>{profiles.map((p) => <option key={p} value={p}>{p}</option>)}</select>)}
              {!ssoProfile && field('AWS SSO start URL', <input className="aws-input" placeholder="https://my-org.awsapps.com/start" value={ssoStartUrl} onChange={(e) => setSsoStartUrl(e.target.value)} />)}
              <div className="aws-sso-actions">
                <button className="action-modal-btn primary" onClick={() => startSsoLogin(ssoProfile)} disabled={!ssoProfile && !ssoStartUrl.trim()}>Sign in with AWS SSO</button>
                {profiles.length > 0 && <button className="azure-alt" onClick={() => discover(existingProfile)}>Skip, I'm already signed in. Just discover clusters</button>}
              </div>
            </div>

            {/* Advanced options: access keys / assume-role. */}
            <button className="aws-advanced-toggle" onClick={() => { setAdvanced((a) => !a); if (method === 'sso') setMethod('access-key'); }}>
              <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={13} strokeWidth={2.2} /> Advanced options
            </button>
            {advanced && (
              <div className="aws-advanced">
                <div className="aws-tabs">
                  <button className={`aws-tab ${method === 'access-key' ? 'on' : ''}`} onClick={() => setMethod('access-key')}>Access key<span>IAM user</span></button>
                  <button className={`aws-tab ${method === 'role' ? 'on' : ''}`} onClick={() => setMethod('role')}>IAM role<span>Assume role</span></button>
                </div>

                {method === 'access-key' && (
                  <div className="aws-form">
                    {field('Profile name', <input className="aws-input" placeholder="e.g. my-eks" value={profileName} onChange={(e) => setProfileName(e.target.value)} />)}
                    {field('Access Key ID', <input className="aws-input" autoComplete="off" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />)}
                    {field('Secret Access Key', <input className="aws-input" type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />)}
                    {field('Session Token (optional)', <input className="aws-input" type="password" autoComplete="off" value={sessionToken} onChange={(e) => setSessionToken(e.target.value)} />)}
                    {field('Default region (optional)', <input className="aws-input" placeholder="e.g. us-east-1" value={region} onChange={(e) => setRegion(e.target.value)} />)}
                  </div>
                )}

                {method === 'role' && (
                  <div className="aws-form">
                    {field('Profile name', <input className="aws-input" placeholder="e.g. eks-role" value={profileName} onChange={(e) => setProfileName(e.target.value)} />)}
                    {field('Source profile', profiles.length ? <select className="aws-input" value={sourceProfile} onChange={(e) => setSourceProfile(e.target.value)}>{profiles.map((p) => <option key={p} value={p}>{p}</option>)}</select> : <input className="aws-input" placeholder="e.g. default" value={sourceProfile} onChange={(e) => setSourceProfile(e.target.value)} />)}
                    {field('Role ARN', <input className="aws-input" placeholder="arn:aws:iam::123456789012:role/EKSAccess" value={roleArn} onChange={(e) => setRoleArn(e.target.value)} />)}
                    {field('Session name (optional)', <input className="aws-input" value={sessionName} onChange={(e) => setSessionName(e.target.value)} />)}
                    {field('Default region (optional)', <input className="aws-input" placeholder="e.g. us-east-1" value={region} onChange={(e) => setRegion(e.target.value)} />)}
                  </div>
                )}
              </div>
            )}

            <div className="action-modal-actions">
              <button className="action-modal-btn" onClick={cancelAndClose}>Cancel</button>
              {advanced && (
                <button
                  className="action-modal-btn primary"
                  disabled={method === 'access-key' ? (!profileName || !accessKeyId || !secretKey) : (!profileName || !roleArn || !sourceProfile)}
                  onClick={configureAndDiscover}
                >Connect</button>
              )}
            </div>
          </>
        )}

        {phase === 'sso-login' && (
          <div className="azure-center azure-msg">
            <div className="aws-step-label">AWS SSO Authorization</div>
            {device ? (
              <>
                <p>Open the link in your browser and make sure that the code matches, or enter the code below to authorize the application.</p>
                <div className="azure-code">{device.userCode}</div>
                {device.verificationUrl && <a className="action-modal-btn primary" href={device.verificationUrl} target="_blank" rel="noreferrer"><Icon name="externalLink" size={14} /> Open in browser</a>}
                <div className="azure-waiting"><Loader label="Waiting for authorization…" /></div>
              </>
            ) : (
              <div className="azure-waiting"><Loader label="Starting AWS SSO sign-in…" /></div>
            )}
          </div>
        )}

        {phase === 'sso-account' && (
          <div className="aws-form">
            <div className="aws-step-label">Choose AWS account</div>
            {busy ? <div className="azure-center"><Loader label="Loading accounts…" /></div> : (
              ssoAccounts.length === 0 ? <div className="azure-empty">No accounts available for this SSO user.</div> :
              field('AWS account', <select className="aws-input" value={chosenAccount} onChange={(e) => setChosenAccount(e.target.value)}>{ssoAccounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.accountName} ({a.accountId})</option>)}</select>)
            )}
            <div className="action-modal-actions">
              <button className="action-modal-btn" onClick={cancelAndClose}>Cancel</button>
              <button className="action-modal-btn primary" disabled={!chosenAccount || busy} onClick={() => loadRoles(chosenAccount)}>Next</button>
            </div>
          </div>
        )}

        {phase === 'sso-role' && (
          <div className="aws-form">
            <div className="aws-step-label">Choose AWS role for account</div>
            <div className="azure-dim" style={{ marginTop: -4 }}>{ssoAccounts.find((a) => a.accountId === chosenAccount)?.accountName} ({chosenAccount})</div>
            {busy ? <div className="azure-center"><Loader label="Loading roles…" /></div> : (
              ssoRoles.length === 0 ? <div className="azure-empty">No roles available in this account.</div> :
              field('Role', <select className="aws-input" value={chosenRole} onChange={(e) => setChosenRole(e.target.value)}>{ssoRoles.map((r) => <option key={r} value={r}>{r}</option>)}</select>)
            )}
            <div className="action-modal-actions">
              <button className="action-modal-btn" onClick={() => setPhase('sso-account')}>Back</button>
              <button className="action-modal-btn primary" disabled={!chosenRole || busy} onClick={() => discoverSso(chosenAccount, chosenRole)}>Next</button>
            </div>
          </div>
        )}

        {phase === 'listing' && <div className="azure-center"><Loader label="Discovering EKS clusters across all regions…" /></div>}

        {phase === 'list' && (
          <>
            <div className="azure-toolbar">
              <input className="azure-search" placeholder="Filter by name or region…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <span className="azure-count">{clusters.length} cluster{clusters.length === 1 ? '' : 's'} · {regionsScanned} region{regionsScanned === 1 ? '' : 's'}{activeProfile ? ` · ${activeProfile}` : ''}</span>
            </div>
            <div className="azure-list">
              {visible.length === 0 ? (
                <div className="azure-empty">{clusters.length === 0 ? 'No EKS clusters found for this account.' : 'No clusters match your filter.'}</div>
              ) : (
                <>
                  <label className="azure-row azure-selall">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={selectable.length === 0} />
                    <span className="azure-selall-label">Select all</span>
                  </label>
                  {visible.map((c) => (
                    <label key={keyOf(c)} className={`azure-row ${c.imported ? 'imported' : ''}`}>
                      <input type="checkbox" checked={c.imported || sel.has(keyOf(c))} disabled={c.imported} onChange={() => toggle(c)} />
                      <span className="azure-cluster">
                        <span className="azure-cname">{c.name}</span>
                        <span className="azure-cmeta">{c.region}</span>
                      </span>
                      {c.imported && <span className="azure-badge added"><Icon name="check" size={12} strokeWidth={2.6} /> Added</span>}
                    </label>
                  ))}
                </>
              )}
            </div>
            <div className="action-modal-actions">
              <button className="action-modal-btn ghost" style={{ marginRight: 'auto' }} onClick={skip} title="Continue without adding clusters">Skip</button>
              <button className="action-modal-btn" onClick={cancelAndClose}>Cancel</button>
              <button className="action-modal-btn primary" disabled={sel.size === 0} onClick={doImport}>Add {sel.size} cluster{sel.size === 1 ? '' : 's'}</button>
            </div>
          </>
        )}

        {phase === 'importing' && <div className="azure-center"><Loader label="Adding clusters to your kubeconfig…" /></div>}

        {phase === 'done' && (
          <div className="azure-center azure-msg">
            <div className="azure-done-icon"><Icon name="check" size={26} strokeWidth={2.6} /></div>
            <p><b>{result?.imported?.length || 0}</b> cluster{(result?.imported?.length || 0) === 1 ? '' : 's'} added to your kubeconfig.</p>
            {result?.failed?.length > 0 && <div className="azure-failed">{result.failed.map((f) => <div key={f.name}><b>{f.name}</b>: {f.error}</div>)}</div>}
            <p className="azure-dim">They're now available in the context selector.</p>
            <button className="action-modal-btn primary" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
