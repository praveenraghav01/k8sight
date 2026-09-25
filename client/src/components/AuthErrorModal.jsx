import React, { useState, useEffect, useRef } from 'react';
import Icon from './Icons';
import ContextSelector from './ContextSelector';

// Blocking popup shown before the app loads when the kubeconfig parses but the
// cluster credentials don't actually work (expired token, unreachable API
// server, untrusted TLS, missing exec auth plugin, …).
//
// Cloud providers return enormous, jargon-heavy error strings (Azure alone
// returns Trace IDs, Correlation IDs and a full `az login …` command mashed into
// prose). Rather than dump that on the user, we classify the common cases into a
// one-line summary + a concrete, often one-click fix, and tuck the raw error
// behind a "Technical details" disclosure.

const TITLES = {
  'no-config': 'No kubeconfig loaded',
  unauthorized: 'Cluster authentication failed',
  unreachable: 'Cluster unreachable',
  tls: 'TLS certificate error',
  'exec-plugin': 'Auth plugin failed',
  error: 'Could not connect to the cluster',
};

// Pull a runnable re-login command out of a provider error string when present.
const extractAzLogin = (raw) => (raw.match(/az login\b[^\n]*?--scope\s+"[^"]*"/i) || raw.match(/az login\b[^\n."]*/i) || [])[0]?.trim() || null;
const extractAwsSso = (raw) => (raw.match(/aws sso login(?:\s+--profile\s+\S+)?/i) || [])[0]?.trim() || null;

// Classify the failure into { title, summary, fix } where fix describes the
// remediation (a one-click cloud sign-in and/or a copyable CLI command).
function classify(auth) {
  const reason = auth?.reason || 'error';
  const raw = auth?.message || '';
  const s = raw.toLowerCase();
  const server = (auth?.server || '').toLowerCase();
  const provider = /azmk8s\.io|\.azure/.test(server) ? 'azure'
    : /eks\.amazonaws|\.eks\./.test(server) ? 'aws'
    : /gke|container\.googleapis/.test(server) ? 'gcp' : null;

  // Azure CLI token expiry (AADSTS70043 etc.)
  if (/aadsts|azureclicredential|az login\b/.test(s) || (provider === 'azure' && /token|expired|credential|refresh/.test(s))) {
    // kubelogin/azurecli clusters read the Azure CLI token cache, so the fix is
    // `az login` specifically (a browser sign-in won't refresh it).
    const cli = /azurecli|kubelogin/.test(s);
    return {
      title: 'Azure sign-in expired',
      summary: 'Your Azure sign-in has expired, so the cluster token could not be refreshed. Sign in to Azure again, then retry.',
      fix: { kind: 'azure', cli, command: extractAzLogin(raw) || 'az login' },
    };
  }
  // AWS SSO / STS token expiry
  if (/aws sso login|sso.*expired|expiredtoken|token has expired|ssotokenprovider/.test(s) || (provider === 'aws' && /token|expired|credential/.test(s))) {
    return {
      title: 'AWS session expired',
      summary: 'Your AWS session has expired. Sign in again to refresh your credentials, then retry.',
      fix: { kind: 'aws', command: extractAwsSso(raw) || 'aws sso login' },
    };
  }
  // Missing exec-credential helper (kubelogin, aws-iam-authenticator, …).
  // If we know the cloud provider, offer the in-app sign-in too: re-adding the
  // cluster through the app's own flow replaces the broken exec-plugin entry
  // with a working one, so it fixes this without installing anything.
  if (reason === 'exec-plugin' || /executable\s+\S+\s+not found|exec:.*not found|kubelogin|no such file/.test(s)) {
    const note = 'Or install the helper this cluster needs (e.g. kubelogin, aws-iam-authenticator, or gke-gcloud-auth-plugin) and make sure it is on your PATH, then retry.';
    return {
      title: 'Auth helper not found',
      summary: "A credential helper CLI referenced by your kubeconfig isn't installed or isn't on PATH.",
      fix: (provider === 'aws' || provider === 'azure' || provider === 'gcp') ? { kind: provider, note } : { kind: 'note', note },
    };
  }
  // TLS / certificate
  if (reason === 'tls' || /x509|certificate|tls handshake/.test(s)) {
    return {
      title: 'TLS certificate error',
      summary: "The API server's TLS certificate could not be verified. Check that your kubeconfig trusts the right CA.",
      fix: null,
    };
  }
  // Network / unreachable
  if (reason === 'unreachable' || /dial tcp|no such host|i\/o timeout|connection refused|network is unreachable|timeout/.test(s)) {
    return {
      title: 'Cluster unreachable',
      summary: "The cluster's API server can't be reached. Check your VPN and network, and that the cluster is running.",
      fix: null,
    };
  }
  // RBAC / forbidden
  if (/forbidden|is not allowed|cannot list|\b403\b/.test(s)) {
    return {
      title: 'Access denied',
      summary: 'Your credentials are valid, but they lack permission on this cluster. Ask for access or switch to a context that has it.',
      fix: null,
    };
  }
  // Fallback: show the server's message as-is (it may already be short).
  return {
    title: TITLES[reason] || TITLES.error,
    summary: raw || 'The cluster could not be reached with the current kubeconfig.',
    fix: null,
    unmatched: true,
  };
}

// Providers we can re-authenticate from inside the app. Re-adding a cluster
// through its own flow rewrites the broken exec entry, which is what actually
// fixes both the expired-token and the missing-helper cases.
const SIGN_IN = {
  azure: { icon: 'azure', label: 'Azure' },
  aws: { icon: 'aws', label: 'AWS' },
  gcp: { icon: 'gcp', label: 'GKE' },
};

export default function AuthErrorModal({ auth, onRetry, onChangeConfig, retrying, contexts = [], contextsInfo, currentContext, onSwitchContext, onAddAzure, onAddAws, onAddGke, onDemo }) {
  const raw = auth?.message || '';
  const { title, summary, fix, unmatched } = classify(auth);
  // Map the classified provider to its in-app sign-in handler.
  const signInHandlers = { azure: onAddAzure, aws: onAddAws, gcp: onAddGke };
  const signIn = fix && SIGN_IN[fix.kind]
    ? { ...SIGN_IN[fix.kind], handler: signInHandlers[fix.kind] }
    : null;
  const [copied, setCopied] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef(null);

  // Close the "Add cluster" menu on outside click / Escape.
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e) => { if (addRef.current && !addRef.current.contains(e.target)) setAddOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setAddOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [addOpen]);

  const canAdd = onChangeConfig || onAddAzure || onAddAws || onAddGke;

  // Only surface the raw error separately when it isn't already the summary.
  const showRaw = !!raw && (!unmatched || raw.length > 160);

  const copy = (text) => {
    try { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  return (
    <div className="modal-overlay">
      <div className="modal auth-modal">
        <div className="modal-header">
          <span className="modal-icon danger"><Icon name="warning" size={20} /></span>
          <h2>{title}</h2>
          <button
            className={`auth-retry-icon ${retrying ? 'spinning' : ''}`}
            onClick={onRetry}
            disabled={retrying}
            title={retrying ? 'Retrying…' : 'Retry'}
            aria-label={retrying ? 'Retrying' : 'Retry'}
          >
            <Icon name="refresh" size={16} />
          </button>
        </div>

        <p className="modal-desc auth-summary">{summary}</p>

        {fix && (
          <div className="auth-fix">
            {signIn && (
              <button
                className="auth-fix-btn"
                onClick={() => (fix.kind === 'azure' ? signIn.handler?.(fix.cli ? 'az' : undefined) : signIn.handler?.())}
                disabled={retrying || !signIn.handler}
              >
                <Icon name={signIn.icon} size={15} />
                Sign in to {signIn.label}
              </button>
            )}
            {fix.command && (
              <div className="auth-fix-cmd">
                <span className="auth-fix-cmd-label">or run</span>
                <code title={fix.command}>{fix.command}</code>
                <button className="auth-copy" onClick={() => copy(fix.command)} title="Copy command">
                  <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
            {fix.note && <p className="auth-fix-note">{fix.note}</p>}
          </div>
        )}

        <div className="auth-detail">
          {auth?.currentContext && (
            <div className="auth-detail-row">
              <span className="auth-detail-key">Context</span>
              <code>{auth.currentContext}</code>
            </div>
          )}
          {auth?.server && (
            <div className="auth-detail-row">
              <span className="auth-detail-key">API server</span>
              <code>{auth.server}</code>
            </div>
          )}
        </div>

        {showRaw && (
          <details className="auth-details">
            <summary><Icon name="chevronRight" size={13} className="auth-details-caret" /> Technical details</summary>
            <div className="auth-raw-wrap">
              <button className="auth-copy auth-raw-copy" onClick={() => copy(raw)} title="Copy error">
                <Icon name={copied ? 'check' : 'copy'} size={12} />
              </button>
              <pre className="auth-raw">{raw}</pre>
            </div>
          </details>
        )}

        {onSwitchContext && contexts.length > 1 && (
          <div className="auth-switch">
            <span className="auth-switch-label">Switch to another cluster</span>
            <ContextSelector
              contexts={contexts}
              contextsInfo={contextsInfo}
              currentContext={currentContext || auth?.currentContext}
              onChange={onSwitchContext}
              onAddAzure={onAddAzure}
              onAddAws={onAddAws}
              onAddGke={onAddGke}
            />
          </div>
        )}

        <div className="modal-actions auth-actions">
          {onDemo && (
            <button className="modal-btn btn-demo" onClick={onDemo} disabled={retrying} title="Explore a synthetic cluster — no real cluster needed">
              <Icon name="sparkles" size={14} /> Demo
            </button>
          )}
          {canAdd && (
            <div className="auth-add" ref={addRef}>
              <button
                className="modal-btn btn-add"
                onClick={() => setAddOpen((o) => !o)}
                disabled={retrying}
                aria-haspopup="menu"
                aria-expanded={addOpen}
              >
                <Icon name="plus" size={14} /> Add cluster
                <Icon name={addOpen ? 'chevronUp' : 'chevronDown'} size={12} style={{ marginLeft: 2 }} />
              </button>
              {addOpen && (
                <div className="auth-add-menu" role="menu">
                  {onAddAws && (
                    <button className="auth-add-item" role="menuitem" onClick={() => { setAddOpen(false); onAddAws(); }}>
                      <Icon name="aws" size={16} /> AWS EKS
                    </button>
                  )}
                  {onAddAzure && (
                    <button className="auth-add-item" role="menuitem" onClick={() => { setAddOpen(false); onAddAzure(); }}>
                      <Icon name="azure" size={16} /> Azure AKS
                    </button>
                  )}
                  {onAddGke && (
                    <button className="auth-add-item" role="menuitem" onClick={() => { setAddOpen(false); onAddGke(); }}>
                      <Icon name="gcp" size={16} /> Google GKE
                    </button>
                  )}
                  {onChangeConfig && (
                    <button className="auth-add-item" role="menuitem" onClick={() => { setAddOpen(false); onChangeConfig(); }}>
                      <Icon name="box" size={16} /> Local — load kubeconfig
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
