// Must run first: attaches the API token to axios, fetch and WebSockets.
import { hasApiToken, onAuthFailure } from './lib/auth.js'
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { ToastProvider } from './components/Toast.jsx'

// Browser / Docker mode: the backend only answers requests that carry the
// per-launch token from the startup link. Explain that instead of failing.
function TokenRequired() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, fontFamily: 'system-ui, sans-serif', background: '#0b0b0d', color: '#e8e8ea' }}>
      <div style={{ maxWidth: 520, lineHeight: 1.55 }}>
        <h1 style={{ fontSize: 22, margin: '0 0 12px' }}>Open k8sight with its access link</h1>
        <p style={{ margin: '0 0 10px', color: '#b4b4bb' }}>
          For security, k8sight only accepts requests that carry the access token created when it started.
          Open the link printed in the terminal where k8sight is running. It looks like
        </p>
        <code style={{ display: 'block', padding: '10px 12px', background: '#16161a', borderRadius: 8, color: '#9ecbff' }}>http://localhost:3001/?token=…</code>
        <p style={{ margin: '12px 0 0', color: '#8a8a92', fontSize: 14 }}>If k8sight was restarted, the old link stops working; use the new one.</p>
      </div>
    </div>
  );
}

function Root() {
  const [blocked, setBlocked] = useState(!hasApiToken);
  useEffect(() => onAuthFailure(() => setBlocked(true)), []);
  if (blocked) return <TokenRequired />;
  return (
    <ToastProvider>
      <App />
    </ToastProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
