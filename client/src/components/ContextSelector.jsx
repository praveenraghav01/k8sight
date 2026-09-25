import React, { useState, useRef, useEffect, useMemo } from 'react';
import Icon from './Icons';

const PROVIDERS = {
  demo: { label: 'Demo', icon: 'sparkles', color: '#af52de' },
  aws: { label: 'AWS EKS', icon: 'aws', color: '#ff9900' },
  azure: { label: 'Azure AKS', icon: 'azure', color: '#3b96f0' },
  gcp: { label: 'Google GKE', icon: 'gcp', color: '#4285f4' },
  local: { label: 'Local', icon: 'box', color: '#8b949e' },
  other: { label: 'Other clusters', icon: 'cluster', color: '#8b8fa3' },
};
const ORDER = ['demo', 'aws', 'azure', 'gcp', 'local', 'other'];

export default function ContextSelector({ contexts = [], contextsInfo, currentContext, onChange, onAddAzure, onAddAws, onAddGke, onAddLocal }) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, []);

  useEffect(() => { if (open) setTimeout(() => searchRef.current?.focus(), 0); else { setQuery(''); setAddOpen(false); } }, [open]);

  const providerByName = useMemo(() => {
    const m = new Map();
    (contextsInfo || []).forEach((c) => m.set(c.name, c.provider));
    return m;
  }, [contextsInfo]);
  const providerOf = (name) => providerByName.get(name) || 'other';
  const currentP = PROVIDERS[providerOf(currentContext)] || PROVIDERS.other;

  const q = query.toLowerCase();
  const visible = useMemo(() => contexts.filter((c) => !q || c.toLowerCase().includes(q)), [contexts, q]);
  const grouped = useMemo(() => {
    const g = {};
    visible.forEach((c) => { const p = providerOf(c); (g[p] = g[p] || []).push(c); });
    Object.values(g).forEach((arr) => arr.sort((a, b) => a.localeCompare(b)));
    return g;
  }, [visible, providerByName]);
  const groupKeys = ORDER.filter((k) => grouped[k]?.length);

  const pick = (ctx) => { setOpen(false); if (ctx !== currentContext) onChange(ctx); };

  return (
    <div className="ctx-select" ref={ref}>
      <button className={`ctx-trigger ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} title={currentContext}>
        <Icon name={currentP.icon} size={15} className="ctx-trigger-icon" style={{ color: currentP.color }} />
        <span className="ctx-trigger-label">{currentContext || 'Select context'}</span>
        <span className="ctx-trigger-arrow"><Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} strokeWidth={2.2} /></span>
      </button>

      {open && (
        <div className="ctx-dropdown">
          <div className="ctx-search">
            <Icon name="search" size={14} />
            <input ref={searchRef} type="text" placeholder={`Search ${contexts.length} contexts…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="ctx-list">
            {visible.length === 0 && <div className="ctx-empty">No matches</div>}
            {groupKeys.map((k) => (
              <div key={k} className="ctx-group">
                <div className="ctx-group-head">
                  <Icon name={PROVIDERS[k].icon} size={13} style={{ color: PROVIDERS[k].color }} />
                  <span>{PROVIDERS[k].label}</span>
                  <span className="ctx-group-count">{grouped[k].length}</span>
                </div>
                {grouped[k].map((ctx) => (
                  <button key={ctx} className={`ctx-option ${ctx === currentContext ? 'active' : ''}`} onClick={() => pick(ctx)} title={ctx}>
                    <span className="ctx-option-check">{ctx === currentContext && <Icon name="check" size={14} strokeWidth={2.4} />}</span>
                    <span className="ctx-dot" style={{ background: PROVIDERS[k].color }} />
                    <span className="ctx-option-label">{ctx}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          {(onAddAzure || onAddAws || onAddGke || onAddLocal) && (
            <div className="ctx-add-row">
              <button className={`ctx-add-cluster ${addOpen ? 'open' : ''}`} onClick={() => setAddOpen((o) => !o)}>
                <Icon name="plus" size={14} /> <span>Add cluster</span>
                <Icon name={addOpen ? 'chevronUp' : 'chevronDown'} size={12} className="ctx-add-caret" />
              </button>
              {addOpen && (
                <div className="ctx-add-menu">
                  {onAddAws && (
                    <button className="ctx-add-item" onClick={() => { setOpen(false); onAddAws(); }}>
                      <Icon name="aws" size={15} style={{ color: PROVIDERS.aws.color }} /> AWS EKS
                    </button>
                  )}
                  {onAddAzure && (
                    <button className="ctx-add-item" onClick={() => { setOpen(false); onAddAzure(); }}>
                      <Icon name="azure" size={15} style={{ color: PROVIDERS.azure.color }} /> Azure AKS
                    </button>
                  )}
                  {onAddGke && (
                    <button className="ctx-add-item" onClick={() => { setOpen(false); onAddGke(); }}>
                      <Icon name="gcp" size={15} style={{ color: PROVIDERS.gcp.color }} /> Google GKE
                    </button>
                  )}
                  {onAddLocal && (
                    <button className="ctx-add-item" onClick={() => { setOpen(false); onAddLocal(); }}>
                      <Icon name="box" size={15} style={{ color: PROVIDERS.local.color }} /> Local — load kubeconfig
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
