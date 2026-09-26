import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';
import useClickOutside from '../hooks/useClickOutside';
import { kindType, KIND_TYPE } from '../lib/kind';

// Security Center — image CVEs, resource best-practice (config-audit) and RBAC
// risk, read from the Trivy Operator's report CRDs. Overview / Images /
// Resources / Roles tabs with donut summaries, a critical-vuln table, and a
// right-side detail drawer (modelled on Lens's Security Center).

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const SEV_COLOR = { CRITICAL: '#e5484d', HIGH: '#f5a623', MEDIUM: '#e3b341', LOW: '#4c9be8', UNKNOWN: '#8b949e' };

const sevTotal = (s = {}) => SEVERITIES.reduce((n, k) => n + (s[k] || 0), 0);
const SevPill = ({ s }) => <span className="sec-pill" style={{ color: SEV_COLOR[s], background: `${SEV_COLOR[s]}22` }}>{s}</span>;

const rel = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  return `${Math.floor(s / 86400)} days ago`;
};

/* ---------- Donut ---------- */
function Donut({ title, segments, size = 130, onSegmentClick, activeKey }) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const sw = 15, cr = (size - sw) / 2, circ = 2 * Math.PI * cr;
  let acc = 0;
  const clickable = !!onSegmentClick;
  return (
    <div className="sec-donut">
      <div className="sec-donut-title">{title}</div>
      <div className="sec-donut-row">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="sec-donut-svg">
          <circle cx={size / 2} cy={size / 2} r={cr} fill="none" stroke="var(--bg-surface-2)" strokeWidth={sw} />
          {total > 0 && segments.filter((s) => s.value > 0).map((s, i) => {
            const frac = s.value / total, dash = frac * circ;
            const dim = activeKey && s.key && activeKey !== s.key;
            const el = (
              <circle key={i} cx={size / 2} cy={size / 2} r={cr} fill="none" stroke={s.color} strokeWidth={sw}
                strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={-acc * circ}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                opacity={dim ? 0.28 : 1}
                style={clickable && s.key ? { cursor: 'pointer' } : undefined}
                onClick={clickable && s.key ? () => onSegmentClick(s.key) : undefined}>
                <title>{`${s.label}: ${s.value}`}</title>
              </circle>
            );
            acc += frac; return el;
          })}
          {total === 0 && <text x="50%" y="52%" textAnchor="middle" className="sec-donut-empty">no data</text>}
        </svg>
        <div className="sec-donut-legend">
          {segments.map((s) => {
            const isClickable = clickable && s.key;
            const active = activeKey && s.key === activeKey;
            return (
              <span
                key={s.label}
                className={`sec-legend ${isClickable ? 'clickable' : ''} ${active ? 'active' : ''}`}
                onClick={isClickable ? () => onSegmentClick(s.key) : undefined}
              >
                <i style={{ background: s.color }} /> {s.label}{s.value ? ` (${s.value})` : ''}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function SecurityCenter({ namespaces = [], onNavigate, view, onViewChange, refreshSignal = 0 }) {
  const [status, setStatus] = useState(null);
  // Tab is controlled by the sidebar (view/onViewChange) when provided; the
  // in-view tab bar stays in sync and also works standalone.
  const [localTab, setLocalTab] = useState('overview');
  const tab = view || localTab;
  const setTab = (k) => { setLocalTab(k); onViewChange?.(k); };
  const [ns, setNs] = useState('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [vuln, setVuln] = useState(null);
  const [config, setConfig] = useState(null);
  const [rbac, setRbac] = useState(null);
  const [detail, setDetail] = useState(null); // { type:'image'|'checks', data }
  const [scan, setScan] = useState(null);     // built-in scan state/result
  const [scanAvail, setScanAvail] = useState(null); // { available, version }
  const [scanChecked, setScanChecked] = useState(false); // loaded prior/persisted scan?
  const pollRef = useRef(null);

  const operatorMode = !!status?.installed;
  const scanMode = !operatorMode;

  useEffect(() => {
    axios.get('/api/security/status').then((r) => setStatus(r.data)).catch(() => setStatus({ installed: false }));
    return () => clearInterval(pollRef.current);
  }, []);

  const get = (path, extra = {}) => axios.get(path, { params: { ...(ns !== 'all' ? { namespace: ns } : {}), ...extra } }).then((r) => r.data);

  // Operator mode: read the report CRDs.
  const loadReports = ({ silent = false } = {}) => {
    if (!operatorMode) return;
    if (!silent) { setDetail(null); setLoading(true); }
    const done = () => setLoading(false);
    if (tab === 'overview' || tab === 'images') { get('/api/security/vulnerabilities').then(setVuln).catch(() => {}).finally(done); }
    else if (tab === 'resources') { get('/api/security/checks', { kind: 'config' }).then(setConfig).catch(() => {}).finally(done); }
    else if (tab === 'roles') { get('/api/security/checks', { kind: 'rbac' }).then(setRbac).catch(() => {}).finally(done); }
  };

  useEffect(() => {
    loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, ns, operatorMode]);

  // Global/auto refresh: re-read the reports quietly, keeping the open detail
  // pane. Scan mode is left alone — scans are expensive and user-triggered.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    loadReports({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // Scan mode: check trivy availability + load any prior/persisted scan result.
  useEffect(() => {
    if (status == null || operatorMode) return;
    setScanChecked(false);
    Promise.all([
      axios.get('/api/security/scan/status').then((r) => setScanAvail(r.data)).catch(() => setScanAvail({ available: false })),
      axios.get('/api/security/scan').then((r) => { if (r.data.images?.length || r.data.running) { setScan(r.data); setVuln(r.data); if (r.data.running) poll(); } }).catch(() => {}),
    ]).finally(() => setScanChecked(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, operatorMode]);

  const poll = () => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await axios.get('/api/security/scan');
        setScan(data); setVuln(data);
        if (!data.running) { clearInterval(pollRef.current); }
      } catch { clearInterval(pollRef.current); }
    }, 2000);
  };
  const runScan = async () => {
    setScan({ running: true, scanned: 0, total: 0 });
    try { const { data } = await axios.post('/api/security/scan', { namespace: ns !== 'all' ? ns : undefined }); setScan(data); setVuln(data); poll(); }
    catch (e) { setScan({ running: false, error: e.response?.data?.error || 'Scan failed to start' }); }
  };

  if (!status) return <div className="sec-center"><Loader label="Checking Security Center…" /></div>;
  // No operator, and no scan run yet → the setup / run-scan screen. Wait for the
  // prior/persisted scan to load first so a cached result doesn't flash setup.
  if (scanMode && !scan?.images?.length && !scan?.running) {
    if (!scanChecked) return <div className="sec-center"><Loader label="Loading security…" /></div>;
    return <SetupState error={status.error} scanAvail={scanAvail} onScan={runScan} scanError={scan?.error} />;
  }
  // While scanning, the header + tabs stay visible (below) so you can switch
  // tabs and watch partial results stream in — the scan keeps running server-side.

  const nsList = namespaces.filter((n) => n !== 'all');
  // Plain expression (NOT a hook) — this runs after the early returns above, so a
  // useMemo here would break the Rules of Hooks and blank the page.
  const countList = tab === 'resources' ? (config?.resources || [])
    : tab === 'roles' ? (rbac?.resources || []) : (vuln?.images || []);
  const count = (ns === 'all' ? countList
    : countList.filter((r) => r.namespace === ns || (r.workloads || []).some((w) => w.namespace === ns))).length;

  return (
    <div className="sec-view">
      <div className="sec-head">
        <div className="sec-title"><Icon name="shieldCheck" size={20} /> <h1>Security</h1></div>
        <div className="sec-controls">
          <select className="sec-nssel" value={ns} onChange={(e) => setNs(e.target.value)}>
            <option value="all">All namespaces</option>
            {nsList.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <div className="sec-search">
            <Icon name="search" size={14} />
            <input placeholder={`Search ${tab}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <span className="sec-count">{count} items</span>
        </div>
      </div>

      <div className="sec-tabs">
        {[['overview', 'Overview'], ['images', 'Images'], ['resources', 'Resources'], ['roles', 'Roles']].map(([k, label]) => (
          <button key={k} className={`sec-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      <div className="sec-main">
        <div className="sec-body">
          {scanMode && scan?.phase === 'preparing' ? (
            <ScanProgress scan={scan} />
          ) : (
            <>
              {scanMode && scan && <ScanBanner scan={scan} onRescan={runScan} />}
              {loading ? <div className="sec-center"><Loader label="Loading reports…" /></div> : (
                <>
                  {tab === 'overview' && <ImagesView vuln={vuln} ns={ns} q={q} onSelect={(d) => setDetail({ type: 'image', data: d })} selected={detail?.data} criticalOnly />}
                  {tab === 'images' && <ImagesView vuln={vuln} ns={ns} q={q} onSelect={(d) => setDetail({ type: 'image', data: d })} selected={detail?.data} />}
                  {tab === 'resources' && (scanMode ? <OperatorNote feature="Resource best-practice checks" foreign={status?.foreignOperator} /> : <ChecksView data={config} ns={ns} q={q} onSelect={(d) => setDetail({ type: 'checks', data: d })} selected={detail?.data} label="resource" />)}
                  {tab === 'roles' && (scanMode ? <OperatorNote feature="RBAC risk analysis" foreign={status?.foreignOperator} /> : <ChecksView data={rbac} ns={ns} q={q} onSelect={(d) => setDetail({ type: 'checks', data: d })} selected={detail?.data} label="role" />)}
                </>
              )}
            </>
          )}
        </div>
        {detail && <Drawer detail={detail} onClose={() => setDetail(null)} onNavigate={onNavigate} />}
      </div>
    </div>
  );
}

/* ---------- Images / Overview (shared) ---------- */
function ImagesView({ vuln, ns, q, onSelect, selected, criticalOnly }) {
  const ql = q.toLowerCase();
  const all = vuln?.images || [];
  const rows = useMemo(() => {
    let list = criticalOnly ? all.filter((im) => im.summary.CRITICAL > 0) : all;
    if (ns && ns !== 'all') list = list.filter((im) => im.namespace === ns || (im.workloads || []).some((w) => w.namespace === ns));
    if (ql) list = list.filter((im) => im.image.toLowerCase().includes(ql) || (im.namespace || '').toLowerCase().includes(ql) || im.vulnerabilities.some((v) => v.id.toLowerCase().includes(ql)));
    return criticalOnly ? [...list].sort((a, b) => new Date(b.scannedAt) - new Date(a.scannedAt)) : list;
  }, [all, ns, ql, criticalOnly]);

  const statusSeg = [
    { label: 'Scanned', value: vuln?.scanned || 0, color: '#8b949e' },
    { label: 'Not Scanned', value: vuln?.notScanned ?? 0, color: '#4c9be8' },
  ];
  const resultSeg = [
    { label: 'Ok', value: vuln?.results?.ok || 0, color: '#3fb950' },
    { label: 'Vulnerable', value: vuln?.results?.vulnerable || 0, color: '#e5484d' },
  ];
  const vulnSeg = SEVERITIES.filter((k) => k !== 'UNKNOWN').map((k) => ({ label: k[0] + k.slice(1).toLowerCase(), value: vuln?.summary?.[k] || 0, color: SEV_COLOR[k] }));
  const exposed = all.filter((im) => (im.secrets || 0) > 0).length;
  const secretSeg = [{ label: 'Clean', value: all.length - exposed, color: '#3fb950' }, { label: 'Exposed', value: exposed, color: '#e5484d' }];

  return (
    <>
      <div className="sec-donuts">
        <Donut title="Status" segments={statusSeg} />
        <Donut title="Results" segments={resultSeg} />
        <Donut title="Vulnerabilities" segments={vulnSeg} />
        {!criticalOnly && <Donut title="Exposed Secrets" segments={secretSeg} />}
      </div>
      {criticalOnly && <div className="sec-section-title">Latest critical vulnerabilities</div>}
      {rows.length === 0 ? (
        <div className="sec-empty"><Icon name="shieldCheck" size={28} /><p>No {criticalOnly ? 'critical ' : ''}image findings{q ? ' match your search' : ''}.</p></div>
      ) : criticalOnly ? (
        <div className="sec-table">
          <div className="sec-tr sec-th img"><span>Name</span><span>Namespace</span><span>Kind</span><span>Critical</span><span>Scan Date</span></div>
          {rows.map((im) => (
            <button key={im.image} className={`sec-tr img row ${selected === im ? 'sel' : ''}`} onClick={() => onSelect(im)}>
              <span className="sec-mono sec-ellip" title={im.image}>{im.image}</span>
              <span>{im.namespace || '—'}</span>
              <span className="sec-kind">OciImage</span>
              <span className={im.summary.CRITICAL ? 'sec-crit' : ''}>{im.summary.CRITICAL || 0}</span>
              <span className="sec-dim">{rel(im.scannedAt)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="sec-table">
          <div className="sec-tr sec-th imgfull"><span>Name</span><span>Platforms</span><span>Pods</span><span>Vulnerabilities</span><span>Exposed Secrets</span><span>Status</span></div>
          {rows.map((im) => {
            const pods = new Set((im.workloads || []).map((w) => `${w.namespace}/${w.name}`)).size;
            const scanned = im.status === 'Scanned' || im.status === 'Failed';
            return (
              <button key={im.image} className={`sec-tr imgfull row ${selected === im ? 'sel' : ''}`} onClick={() => onSelect(im)}>
                <span className="sec-mono sec-ellip" title={im.image}>{im.image}</span>
                <span className="sec-dim">{im.platform || im.os || '—'}</span>
                <span>{pods}</span>
                <span>{sevTotal(im.summary) ? <SevMini summary={im.summary} /> : <span className="sec-dim">{scanned ? '—' : '?'}</span>}</span>
                <span>{scanned ? (im.secrets ? <span className="sec-secretnum">{im.secrets}</span> : <span className="sec-dim">—</span>) : <span className="sec-dim">?</span>}</span>
                <span className={im.status === 'Failed' ? 'sec-crit' : 'sec-dim'}>{im.status || 'Not Scanned'}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ---------- Resources / Roles ---------- */
function ChecksView({ data, ns, q, onSelect, selected, label }) {
  const ql = q.toLowerCase();
  const rows = (data?.resources || [])
    .filter((r) => !ns || ns === 'all' || r.namespace === ns)
    .filter((r) => !ql || (r.name || '').toLowerCase().includes(ql) || r.checks.some((c) => (c.id + c.title).toLowerCase().includes(ql)));
  if (!rows.length) return <div className="sec-empty"><Icon name="shieldCheck" size={28} /><p>No {label} issues{q ? ' match your search' : ''}.</p></div>;
  return (
    <div className="sec-table">
      <div className="sec-tr chk sec-th"><span>{label === 'role' ? 'Role Name' : 'Name'}</span><span>Kind</span><span>Namespace</span><span>Vulnerabilities</span></div>
      {rows.map((r, i) => (
        <button key={`${r.kind}/${r.namespace}/${r.name}/${i}`} className={`sec-tr chk row ${selected === r ? 'sel' : ''}`} onClick={() => onSelect(r)}>
          <span className="sec-strong sec-ellip">{r.name}</span>
          <span className="sec-kind">{r.kind}</span>
          <span className="sec-dim">{r.namespace || '—'}</span>
          <span><SevMini summary={r.summary} /></span>
        </button>
      ))}
    </div>
  );
}

const SevMini = ({ summary = {} }) => (
  <span className="sec-sevmini">
    {SEVERITIES.filter((k) => summary[k]).map((k) => <span key={k} style={{ color: SEV_COLOR[k], background: `${SEV_COLOR[k]}22` }}>{summary[k]}</span>)}
  </span>
);

/* ---------- Detail drawer ---------- */
function Drawer({ detail, onClose, onNavigate }) {
  const isImage = detail.type === 'image';
  const d = detail.data;
  const drawerRef = useRef(null);
  useClickOutside(drawerRef, onClose);
  return (
    <aside className="sec-drawer" ref={drawerRef}>
      <div className="sec-drawer-head">
        <span className="sec-drawer-title">{isImage ? <><span className="sec-kind">OciImage</span> {d.image}</> : <><span className="sec-kind">{d.kind}</span> {d.name}</>}</span>
        <button className="sec-drawer-x" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <div className="sec-drawer-body">
        {isImage ? <ImageDetail key={d.image} d={d} onNavigate={onNavigate} /> : <ChecksDetail key={`${d.kind}/${d.namespace}/${d.name}`} d={d} onNavigate={onNavigate} />}
      </div>
    </aside>
  );
}

function Prop({ k, children }) { return <div className="sec-prop"><span className="sec-prop-k">{k}</span><span className="sec-prop-v">{children}</span></div>; }

function ImageDetail({ d, onNavigate }) {
  const [sevFilter, setSevFilter] = useState(null);
  const controlledBy = d.workloads[0];
  const donutSeg = SEVERITIES.filter((k) => k !== 'UNKNOWN').map((k) => ({ key: k, label: k[0] + k.slice(1).toLowerCase(), value: d.summary[k] || 0, color: SEV_COLOR[k] }));
  const worst = SEVERITIES.find((k) => d.summary[k]) || 'LOW';
  const toggleSev = (k) => setSevFilter((f) => (f === k ? null : k));
  const shownVulns = sevFilter ? d.vulnerabilities.filter((v) => v.severity === sevFilter) : d.vulnerabilities;
  return (
    <>
      <div className="sec-drawer-section">Properties</div>
      <Prop k="Name"><span className="sec-mono">{d.image}</span></Prop>
      <Prop k="Namespace">{d.namespace ? <a onClick={() => onNavigate?.toNamespace?.(d.namespace)}>{d.namespace}</a> : '—'}</Prop>
      {controlledBy && <Prop k="Controlled By">{controlledBy.kind} <a onClick={() => onNavigate?.toResource?.({ type: kindType(controlledBy.kind), namespace: controlledBy.namespace, name: controlledBy.name })}>{controlledBy.name}</a></Prop>}
      {d.tag && <Prop k="Tag">{d.tag}</Prop>}
      {d.digest && <Prop k="Image Digest"><span className="sec-mono sec-break">{d.digest}</span></Prop>}
      <Prop k="Status">{d.status}</Prop>
      <Prop k="Used By Pods">
        <span className="sec-podlinks">
          {d.workloads.slice(0, 30).map((w, i) => (
            <span className="sec-podlink" key={i}>
              <a onClick={() => onNavigate?.toNamespace?.(w.namespace)}>{w.namespace}</a>
              <span className="sec-podlink-sep">/</span>
              <a onClick={() => onNavigate?.toPods?.(w.namespace, w.name)}>{w.name}</a>
            </span>
          ))}
        </span>
      </Prop>

      <div className="sec-drawer-section">Vulnerabilities</div>
      <div className="sec-drawer-donut"><Donut title="" segments={donutSeg} size={120} onSegmentClick={toggleSev} activeKey={sevFilter} /></div>
      <div className="sec-sevfilter">
        {SEVERITIES.filter((k) => d.summary[k]).map((k) => (
          <button
            key={k}
            className={`sec-sevfilter-pill ${sevFilter === k ? 'active' : ''}`}
            style={{ '--sev': SEV_COLOR[k] }}
            onClick={() => toggleSev(k)}
            title={`Show only ${k[0] + k.slice(1).toLowerCase()} vulnerabilities`}
          >
            <i style={{ background: SEV_COLOR[k] }} />
            {k[0] + k.slice(1).toLowerCase()}
            <b>{d.summary[k]}</b>
          </button>
        ))}
        {sevFilter && (
          <button className="sec-sevfilter-clear" onClick={() => setSevFilter(null)}>Clear</button>
        )}
      </div>
      <Prop k="Severity"><SevPill s={worst} /></Prop>
      <Prop k="Scanned">{rel(d.scannedAt)}</Prop>
      {d.scanner && <Prop k="Scan Result Source">{d.scanner}</Prop>}
      <Prop k="Exposed Secrets">{d.secrets ? <span className="sec-secretnum">{d.secrets}</span> : <span className="sec-dim">None</span>}</Prop>

      {d.secretsList?.length > 0 && (
        <div className="sec-checks" style={{ marginTop: 6, marginBottom: 6 }}>
          {d.secretsList.map((s, i) => (
            <div className="sec-checkitem" key={i}>
              <SevPill s={s.severity} />
              <div className="sec-check-main">
                <div className="sec-check-title">{s.title || s.ruleID} <code>{s.ruleID}</code></div>
                <div className="sec-check-msg">{s.target}{s.line ? `:${s.line}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="sec-table" style={{ marginTop: 12 }}>
        <div className="sec-tr vt sec-th"><span>ID</span><span>Severity</span><span>Package</span><span>Fixed in</span><span>Installed</span></div>
        {shownVulns.map((v, i) => (
          <div className="sec-vitem" key={v.id + i}>
            <div className="sec-tr vt">
              <span>{v.link ? <a href={v.link} target="_blank" rel="noreferrer" className="sec-cve">{v.id}</a> : v.id}</span>
              <span><SevPill s={v.severity} /></span>
              <span className="sec-mono sec-ellip" title={v.pkg}>{v.pkg}</span>
              <span className="sec-mono">{v.fixedVersion || <em className="sec-dim">—</em>}</span>
              <span className="sec-mono sec-ellip" title={v.installedVersion}>{v.installedVersion}</span>
            </div>
            {v.title && <div className="sec-vdesc">{v.title}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

function ChecksDetail({ d, onNavigate }) {
  const [sevFilter, setSevFilter] = useState(null);
  const summary = d.summary || {};
  const donutSeg = SEVERITIES.filter((k) => k !== 'UNKNOWN').map((k) => ({ key: k, label: k[0] + k.slice(1).toLowerCase(), value: summary[k] || 0, color: SEV_COLOR[k] }));
  const worst = SEVERITIES.find((k) => summary[k]) || 'LOW';
  const navType = KIND_TYPE[d.kind];
  const toggleSev = (k) => setSevFilter((f) => (f === k ? null : k));
  const shownChecks = sevFilter ? d.checks.filter((c) => c.severity === sevFilter) : d.checks;
  return (
    <>
      <div className="sec-drawer-section">Properties</div>
      {d.createdAt && <Prop k="Created">{rel(d.createdAt)}</Prop>}
      <Prop k="Name"><span className="sec-strong">{d.name}</span></Prop>
      <Prop k="Namespace">{d.namespace ? <a onClick={() => onNavigate?.toNamespace?.(d.namespace)}>{d.namespace}</a> : '—'}</Prop>
      {d.labels ? <Prop k="Labels">{d.labels} Labels</Prop> : null}
      <Prop k="Controlled By">{d.kind} {navType ? <a onClick={() => onNavigate?.toResource?.({ type: navType, namespace: d.namespace, name: d.name })}>{d.name}</a> : d.name}</Prop>
      <Prop k="Status">Scanned</Prop>

      <div className="sec-drawer-section">Vulnerabilities</div>
      <div className="sec-drawer-donut"><Donut title="" segments={donutSeg} size={120} onSegmentClick={toggleSev} activeKey={sevFilter} /></div>
      <div className="sec-sevfilter">
        {SEVERITIES.filter((k) => summary[k]).map((k) => (
          <button
            key={k}
            className={`sec-sevfilter-pill ${sevFilter === k ? 'active' : ''}`}
            style={{ '--sev': SEV_COLOR[k] }}
            onClick={() => toggleSev(k)}
            title={`Show only ${k[0] + k.slice(1).toLowerCase()} checks`}
          >
            <i style={{ background: SEV_COLOR[k] }} />
            {k[0] + k.slice(1).toLowerCase()}
            <b>{summary[k]}</b>
          </button>
        ))}
        {sevFilter && <button className="sec-sevfilter-clear" onClick={() => setSevFilter(null)}>Clear</button>}
      </div>
      <Prop k="Severity"><SevPill s={worst} /></Prop>
      {d.scannedAt && <Prop k="Scanned">{rel(d.scannedAt)}</Prop>}
      {d.scanner && <Prop k="Scan Result Source">{d.scanner}</Prop>}

      <div className="sec-drawer-section">Checks ({shownChecks.length}{sevFilter ? ` of ${d.checks.length}` : ''})</div>
      <div className="sec-checks">
        {shownChecks.map((c, i) => (
          <div className="sec-checkitem" key={c.id + i}>
            <SevPill s={c.severity} />
            <div className="sec-check-main">
              <div className="sec-check-title">{c.title || c.id} <code>{c.id}</code></div>
              {c.message && <div className="sec-check-msg">{c.message}</div>}
              {c.remediation && <div className="sec-check-fix"><strong>Fix:</strong> {c.remediation}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------- Setup / run-scan ---------- */
function SetupState({ error, scanAvail, onScan, scanError }) {
  return (
    <div className="sec-view">
      <div className="sec-head"><div className="sec-title"><Icon name="shield" size={20} /> <h1>Security</h1></div></div>
      <div className="sec-setup">
        <div className="sec-setup-icon"><Icon name="shield" size={40} /></div>
        <h2>Scan your cluster for vulnerabilities</h2>
        {(scanAvail?.available || scanAvail?.installable) ? (
          <>
            <p>Run a <strong>built-in image scan</strong> right now — k8sight scans every image your cluster is running with Trivy{scanAvail.version ? ` (${scanAvail.version})` : ''}. <strong>Nothing to install in your cluster.</strong>{!scanAvail.available ? ' The first run downloads the Trivy binary (~60 MB) and its vulnerability database, so it may take a few minutes.' : ' The first scan downloads Trivy\'s vulnerability database and may take a few minutes.'}</p>
            <button className="sec-run-btn" onClick={onScan}><Icon name="shieldCheck" size={16} /> {scanAvail.available ? 'Run built-in scan' : 'Download Trivy & scan'}</button>
            {scanError && <div className="sec-dim" style={{ marginTop: 12, color: 'var(--red)' }}>{scanError}</div>}
            <p className="sec-dim" style={{ marginTop: 18 }}>For continuous scanning plus resource best-practice and RBAC checks, install the Trivy Operator in-cluster (below).</p>
          </>
        ) : (
          <p>The Security Center reads image-CVE, best-practice and RBAC reports from the <strong>Trivy Operator</strong> in your cluster. Install the operator once and its scans light up this view automatically.</p>
        )}
        <div className="sec-setup-cmd">
          <pre><code>helm repo add aqua https://aquasecurity.github.io/helm-charts/
helm install trivy-operator aqua/trivy-operator \
  --namespace trivy-system --create-namespace</code></pre>
        </div>
        <a className="sec-link" href="https://aquasecurity.github.io/trivy-operator/latest/getting-started/installation/helm/" target="_blank" rel="noreferrer">Trivy Operator install guide <Icon name="externalLink" size={12} /></a>
        {error && <div className="sec-dim" style={{ marginTop: 14 }}>Note: {error}</div>}
      </div>
    </div>
  );
}

// Shown in-body during the one-time Trivy download (the scan itself streams into
// the tabs). Header + tabs stay visible above, so tabs remain switchable.
function ScanProgress() {
  return (
    <div className="sec-setup">
      <div className="sec-setup-icon scanning"><Icon name="shieldCheck" size={40} /></div>
      <h2>Preparing Trivy…</h2>
      <p>Downloading the Trivy scanner and its vulnerability database. This happens once — nothing is installed in your cluster. You can switch tabs or views; the scan runs in the background.</p>
    </div>
  );
}

function ScanBanner({ scan, onRescan }) {
  const pct = scan.total ? Math.round((scan.scanned / scan.total) * 100) : 0;
  return (
    <div className="sec-banner">
      <Icon name="shieldCheck" size={15} className={scan.running ? 'sec-spin' : ''} />
      <span className="sec-banner-text">
        {scan.running ? `Scanning images… ${scan.scanned}/${scan.total || '…'}` : `Built-in Trivy scan · ${(scan.images || []).length} images`}
        {scan.finishedAt && !scan.running ? ` · ${scan.cached ? 'last scan ' : ''}${rel(scan.finishedAt)}` : ''}
      </span>
      {scan.running && (
        <span className="sec-banner-progress"><span className="sec-banner-progress-bar" style={{ width: `${pct}%` }} /></span>
      )}
      <button className="sec-banner-btn" onClick={onRescan} disabled={scan.running}><Icon name="refresh" size={13} /> {scan.running ? `${pct}%` : 'Re-scan'}</button>
    </div>
  );
}

function OperatorNote({ feature, foreign }) {
  const installCmd = 'helm repo add aqua https://aquasecurity.github.io/helm-charts/\n'
    + 'helm repo update\n'
    + 'helm install trivy-operator aqua/trivy-operator \\\n'
    + '  --namespace trivy-system --create-namespace';
  return (
    <div className="sec-empty">
      <Icon name="shield" size={28} />
      {foreign ? (
        <>
          <p><strong>{feature}</strong> needs the official Aqua Trivy Operator.</p>
          <p className="sec-dim" style={{ maxWidth: 460, textAlign: 'center' }}>
            A different Trivy operator (<strong>{foreign.name}</strong>) is installed — its CRDs live under{' '}
            <code>{foreign.group}</code> and don’t include the config-audit or RBAC reports k8sight reads. Install the
            official Aqua operator (group <code>aquasecurity.github.io</code>) for resource best-practice and RBAC checks:
          </p>
          <pre className="sec-install-cmd">{installCmd}</pre>
        </>
      ) : (
        <>
          <p><strong>{feature}</strong> needs the Trivy Operator.</p>
          <p className="sec-dim" style={{ maxWidth: 420, textAlign: 'center' }}>The built-in scan covers image vulnerabilities. Install the Trivy Operator in-cluster to also get resource best-practice and RBAC checks.</p>
          <pre className="sec-install-cmd">{installCmd}</pre>
        </>
      )}
    </div>
  );
}
