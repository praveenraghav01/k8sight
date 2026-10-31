import React, { useEffect, useState } from 'react';
import Icon from './Icons';
import { getAiConfig, isExternalAgent, aiToolName, aiToolIcon } from '../aiConfig';

// Native-style global top toolbar. Spans the full window width, doubles as the
// window drag region (macOS traffic lights sit at its left), and holds
// back/forward history plus the right-side AI launcher and notifications.
// In a tab window (`compact`) it shows the tab's title in the middle and
// `actions` (Demote as Tab) instead of the AI launcher and notifications.
export default function TopBar({ onBack, onForward, canBack, canForward, onNotifications, onConfigureAi, onRefresh, refreshing, compact = false, title = null, actions = null }) {
  const [cfg, setCfg] = useState(getAiConfig);
  useEffect(() => {
    const onChange = () => setCfg(getAiConfig());
    window.addEventListener('aiconfig:change', onChange);
    return () => window.removeEventListener('aiconfig:change', onChange);
  }, []);

  const launchAi = () => {
    if (isExternalAgent(cfg)) {
      window.dispatchEvent(new CustomEvent('agent:open', { detail: { agentId: cfg.id || 'custom', command: cfg.command, agentName: cfg.name } }));
    } else if (cfg.mode === 'none') {
      onConfigureAi?.();
    } else {
      window.dispatchEvent(new CustomEvent('assistant:open'));
    }
  };
  const aiTitle = isExternalAgent(cfg) ? `Open ${aiToolName(cfg)}` : cfg.mode === 'none' ? 'Configure AI tool' : 'Open AI chat';
  // Show the chosen tool's own icon + name (compact label for the built-in/none modes).
  const aiLabel = cfg.mode === 'builtin' ? 'AI' : cfg.mode === 'none' ? 'No AI' : aiToolName(cfg);

  return (
    <header className="topbar">
      <div className="topbar-nav">
        <button className="topbar-btn" disabled={!canBack} onClick={onBack} title="Back" aria-label="Back"><Icon name="arrowLeft" size={17} /></button>
        <button className="topbar-btn" disabled={!canForward} onClick={onForward} title="Forward" aria-label="Forward"><Icon name="arrowRight" size={17} /></button>
      </div>
      <div className="topbar-spacer">{title}</div>
      <div className="topbar-actions">
        {actions}
        {!compact && (<>
        <div className="topbar-ai" title={aiTitle}>
          <button className="topbar-ai-main" onClick={launchAi} aria-label={aiTitle}>
            <Icon name={aiToolIcon(cfg)} size={15} /> <span>{aiLabel}</span>
          </button>
          <button className="topbar-ai-caret" onClick={onConfigureAi} title="AI settings" aria-label="AI settings">
            <Icon name="chevronDown" size={13} />
          </button>
        </div>
        <button className="topbar-btn" onClick={onNotifications} title="Events &amp; alerts" aria-label="Notifications">
          <Icon name="bell" size={17} />
        </button>
        </>)}
        {onRefresh && (
          <button
            className={`topbar-btn ${refreshing ? 'spinning' : ''}`}
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh"
            aria-label="Refresh"
          >
            <Icon name="refresh" size={17} />
          </button>
        )}
      </div>
    </header>
  );
}
