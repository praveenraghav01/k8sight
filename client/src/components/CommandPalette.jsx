import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icons';

// Spotlight-style command palette (⌘K). Navigate to any view, switch context,
// or run a quick action — keyboard-first, with backdrop vibrancy.
const NAV_GROUPS = [
  { group: 'Cluster', items: [
    { key: 'overview', label: 'Overview', icon: 'overview' },
    { key: 'cluster', label: 'Cluster', icon: 'cluster' },
    { key: 'nodes', label: 'Nodes', icon: 'nodes' },
    { key: 'namespaces', label: 'Namespaces', icon: 'namespace' },
    { key: 'topology', label: 'Topology', icon: 'topology' },
    { key: 'events', label: 'Events', icon: 'events' },
    { key: 'helm', label: 'Helm', icon: 'helm' },
    { key: 'accessControl', label: 'Access Control', icon: 'accessControl' },
    { key: 'costs', label: 'Costs', icon: 'costs' },
    { key: 'argocd', label: 'Argo CD', icon: 'argocd' },
  ] },
  { group: 'Workloads', items: [
    { key: 'pod', label: 'Pods', icon: 'pod' },
    { key: 'deployment', label: 'Deployments', icon: 'deployment' },
    { key: 'statefulSet', label: 'StatefulSets', icon: 'statefulSet' },
    { key: 'daemonSet', label: 'DaemonSets', icon: 'daemonSet' },
    { key: 'replicaSet', label: 'Replica Sets', icon: 'replicaSet' },
    { key: 'job', label: 'Jobs', icon: 'job' },
    { key: 'cronJob', label: 'Cron Jobs', icon: 'cronJob' },
  ] },
  { group: 'Network', items: [
    { key: 'service', label: 'Services', icon: 'service' },
    { key: 'ingress', label: 'Ingress', icon: 'ingress' },
    { key: 'networkPolicy', label: 'Network Policies', icon: 'networkPolicy' },
  ] },
  { group: 'Config & Storage', items: [
    { key: 'configMap', label: 'ConfigMaps', icon: 'configMap' },
    { key: 'secret', label: 'Secrets', icon: 'secret' },
    { key: 'serviceAccount', label: 'ServiceAccounts', icon: 'serviceAccount' },
    { key: 'persistentVolume', label: 'PersistentVolumes', icon: 'persistentVolume' },
    { key: 'persistentVolumeClaim', label: 'PersistentVolumeClaims', icon: 'persistentVolumeClaim' },
    { key: 'storageClass', label: 'StorageClasses', icon: 'storageClass' },
  ] },
];

export default function CommandPalette({ open, onClose, onNavigate, contexts = [], currentContext, onSwitchContext, onOpenPreferences, onRefresh, onSetTheme }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Build the full command set (nav destinations + contexts + actions).
  const commands = useMemo(() => {
    const cmds = [];
    for (const g of NAV_GROUPS) for (const it of g.items) cmds.push({ id: `nav:${it.key}`, group: g.group, label: it.label, icon: it.icon, run: () => onNavigate(it.key) });
    for (const ctx of contexts) cmds.push({ id: `ctx:${ctx}`, group: 'Switch context', label: ctx, icon: 'cluster', hint: ctx === currentContext ? 'current' : '', run: () => onSwitchContext(ctx) });
    cmds.push(
      { id: 'act:refresh', group: 'Actions', label: 'Refresh', icon: 'refresh', run: () => onRefresh?.() },
      { id: 'act:prefs', group: 'Actions', label: 'Open Preferences', icon: 'settings', run: () => onOpenPreferences?.() },
      { id: 'act:theme-dark', group: 'Actions', label: 'Theme: Dark', icon: 'moon', run: () => onSetTheme?.('dark') },
      { id: 'act:theme-light', group: 'Actions', label: 'Theme: Light', icon: 'sun', run: () => onSetTheme?.('light') },
      { id: 'act:theme-system', group: 'Actions', label: 'Theme: System', icon: 'settings', run: () => onSetTheme?.('system') },
    );
    return cmds;
  }, [contexts, currentContext, onNavigate, onSwitchContext, onOpenPreferences, onRefresh, onSetTheme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => (c.label + ' ' + c.group).toLowerCase().includes(q));
  }, [query, commands]);

  // Reset on open; focus the input.
  useEffect(() => { if (open) { setQuery(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => { setSel(0); }, [query]);
  // Keep the selected row in view.
  useEffect(() => { listRef.current?.querySelector('.cmdk-item.sel')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  if (!open) return null;

  const exec = (c) => { if (!c) return; onClose(); c.run(); };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(filtered.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); exec(filtered[sel]); }
  };

  // Render with group headers.
  let lastGroup = null;
  return (
    <div className="cmdk-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk-panel" role="dialog" aria-label="Command palette">
        <div className="cmdk-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Search views, contexts, actions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="cmdk-kbd">esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {filtered.length === 0 && <div className="cmdk-empty">No matches</div>}
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <React.Fragment key={c.id}>
                {header && <div className="cmdk-group">{header}</div>}
                <div
                  className={`cmdk-item${i === sel ? ' sel' : ''}`}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => { e.preventDefault(); exec(c); }}
                >
                  <Icon name={c.icon} size={15} />
                  <span className="cmdk-label">{c.label}</span>
                  {c.hint && <span className="cmdk-hint">{c.hint}</span>}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div className="cmdk-foot">
          <span><kbd className="cmdk-kbd">↑</kbd><kbd className="cmdk-kbd">↓</kbd> navigate</span>
          <span><kbd className="cmdk-kbd">↵</kbd> open</span>
        </div>
      </div>
    </div>
  );
}
