import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

// Per-container accent colours (used for the [container] prefix), monochrome bg.
const CONTAINER_COLORS = ['#58a6ff', '#3fb950', '#bc8cff', '#39c5cf', '#d29922', '#f85149', '#ff9f0a', '#79c0ff'];
const colorFor = (name, list) => CONTAINER_COLORS[Math.max(0, list.indexOf(name)) % CONTAINER_COLORS.length];

// Local ISO timestamp with offset, e.g. 2026-09-08T17:33:29.058+05:30.
const fmtTs = (d) => {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
};

// Light log-level colouring when not searching.
const LEVEL_RX = /\b(ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL|PANIC)\b/g;
const LEVEL_CLASS = { ERROR: 'err', ERR: 'err', FATAL: 'err', PANIC: 'err', WARN: 'warn', WARNING: 'warn', INFO: 'info', DEBUG: 'dbg', TRACE: 'dbg' };
const writeClipboard = async (text) => {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    let copied = false;
    try {
      textarea.focus();
      textarea.select();
      copied = document.execCommand('copy');
    } finally {
      textarea.remove();
    }
    if (!copied) throw new Error('Could not copy logs');
  }
};

function colorLevels(msg) {
  const segs = []; let last = 0; let m; LEVEL_RX.lastIndex = 0;
  while ((m = LEVEL_RX.exec(msg)) !== null) {
    if (m.index > last) segs.push({ t: msg.slice(last, m.index) });
    segs.push({ t: m[0], cls: LEVEL_CLASS[m[0].toUpperCase()] });
    last = m.index + m[0].length;
  }
  if (last < msg.length) segs.push({ t: msg.slice(last) });
  return segs.map((s, k) => (s.cls ? <span key={k} className={`logs-lvl ${s.cls}`}>{s.t}</span> : <span key={k}>{s.t}</span>));
}

export default function LogsViewer({ resource, namespace, searchQuery = '', onSearchChange, initialContainer }) {
  const containerNames = resource?.containerNames || [];
  const ns = resource?.namespace || namespace;

  const [container, setContainer] = useState(initialContainer || ''); // '' → all containers
  const [lines, setLines] = useState([]);                             // { ts:Date|null, msg, container }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [tail, setTail] = useState(1000);
  const [showTs, setShowTs] = useState(false);
  const [showNames, setShowNames] = useState(containerNames.length > 1);
  const [wrap, setWrap] = useState(true);
  const [q, setQ] = useState(searchQuery || '');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [active, setActive] = useState(0);
  const [copyState, setCopyState] = useState('idle');
  const bodyRef = useRef(null);
  const endRef = useRef(null);
  const copyTimerRef = useRef(null);

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  useEffect(() => { setContainer(initialContainer || ''); setShowNames(containerNames.length > 1); }, [resource?.name, initialContainer]); // eslint-disable-line

  const parseLog = (text, cname) => {
    const out = [];
    for (const raw of String(text).split('\n')) {
      if (!raw) continue;
      const sp = raw.indexOf(' ');
      let ts = null, msg = raw;
      if (sp > 0) {
        const cand = raw.slice(0, sp);
        if (/^\d{4}-\d\d-\d\dT/.test(cand)) { const d = new Date(cand); if (!isNaN(d.getTime())) { ts = d; msg = raw.slice(sp + 1); } }
      }
      out.push({ ts, msg, container: cname });
    }
    return out;
  };

  const fetchLogs = useCallback(async () => {
    if (!resource?.name) return;
    setLoading(true); setError(null);
    try {
      const targets = container ? [container] : (containerNames.length ? containerNames : ['']);
      const results = await Promise.all(targets.map(async (c) => {
        const { data } = await axios.get(`/api/logs/${ns}/${resource.name}`, {
          params: { ...(c ? { container: c } : {}), timestamps: true, ...(tail ? { tail } : {}) },
        });
        return parseLog(data?.logs || '', c || containerNames[0] || '');
      }));
      let merged = results.flat().map((l, i) => ({ ...l, _i: i }));
      // Chronological merge across containers when timestamps are present (stable otherwise).
      merged.sort((a, b) => (a.ts && b.ts ? a.ts - b.ts || a._i - b._i : a._i - b._i));
      setLines(merged);
      setFetchedAt(new Date());
    } catch (e) {
      setError(`Failed to load logs: ${e.response?.data?.error || e.message}`);
      setLines([]);
    } finally { setLoading(false); }
  }, [resource?.name, ns, container, tail, containerNames.join(',')]); // eslint-disable-line

  useEffect(() => { fetchLogs(); }, [fetchLogs]);
  useEffect(() => { if (!q) endRef.current?.scrollIntoView(); }, [lines, q]);

  const rx = useMemo(() => {
    if (!q) return null;
    try {
      const src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(src, caseSensitive ? 'g' : 'gi');
    } catch { return null; }
  }, [q, regex, caseSensitive]);

  // Flat list of match line-indexes (one entry per occurrence) + first-global-index per line.
  const { matchLines, lineBase } = useMemo(() => {
    const ml = []; const base = new Map();
    if (rx) lines.forEach((l, i) => {
      rx.lastIndex = 0; let m; let had = false;
      while ((m = rx.exec(l.msg)) !== null) {
        if (!had) { base.set(i, ml.length); had = true; }
        ml.push(i);
        if (m.index === rx.lastIndex) rx.lastIndex++;
      }
    });
    return { matchLines: ml, lineBase: base };
  }, [rx, lines]);

  useEffect(() => { setActive(0); }, [q, regex, caseSensitive]);
  useEffect(() => {
    if (!matchLines.length || !bodyRef.current) return;
    const li = matchLines[Math.min(active, matchLines.length - 1)];
    bodyRef.current.querySelector(`[data-line="${li}"]`)?.scrollIntoView({ block: 'center' });
  }, [active, matchLines]);

  const nav = (dir) => { if (matchLines.length) setActive((a) => (a + dir + matchLines.length) % matchLines.length); };
  const onSearch = (v) => { setQ(v); onSearchChange?.(v); };

  const renderMsg = (msg, lineIdx) => {
    if (!rx) return colorLevels(msg);
    const segs = []; let last = 0; let m; let occ = 0; const gBase = lineBase.get(lineIdx) ?? 0;
    rx.lastIndex = 0;
    while ((m = rx.exec(msg)) !== null) {
      if (m.index > last) segs.push({ t: msg.slice(last, m.index) });
      segs.push({ t: m[0], hl: true, active: gBase + occ === active });
      last = m.index + m[0].length; occ++;
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
    if (last < msg.length) segs.push({ t: msg.slice(last) });
    return segs.map((s, k) => (s.hl ? <mark key={k} className={`logs-hl${s.active ? ' active' : ''}`}>{s.t}</mark> : <span key={k}>{s.t}</span>));
  };

  const getLogText = () => lines.map((l) => `${l.ts ? fmtTs(l.ts) + ' ' : ''}${l.container ? `[${l.container}] ` : ''}${l.msg}`).join('\n');

  const handleDownload = () => {
    const text = getLogText();
    const a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    a.download = `${resource?.name || 'pod'}.log`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const handleCopy = async () => {
    try {
      await writeClipboard(getLogText());
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState('idle'), 1600);
  };

  const count = matchLines.length ? `${Math.min(active + 1, matchLines.length)} / ${matchLines.length}` : '0 / 0';

  return (
    <div className="logs-viewer">
      <div className="logs-toolbar">
        <button className="logs-icon-btn" onClick={fetchLogs} title="Reload logs"><Icon name="refresh" size={15} /></button>

        <div className="logs-select">
          <Icon name="pod" size={13} />
          <select value={container} onChange={(e) => setContainer(e.target.value)} title="Container">
            <option value="">All Containers</option>
            {containerNames.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <Icon name="chevronDown" size={13} className="logs-select-caret" />
        </div>

        <div className="logs-search">
          <Icon name="filter" size={13} className="logs-search-lead" />
          <button className={`logs-search-toggle${caseSensitive ? ' on' : ''}`} onClick={() => setCaseSensitive((v) => !v)} title="Case sensitive">Aa</button>
          <button className={`logs-search-toggle mono${regex ? ' on' : ''}`} onClick={() => setRegex((v) => !v)} title="Regular expression">.*</button>
          <input
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search in logs"
            onKeyDown={(e) => { if (e.key === 'Enter') nav(e.shiftKey ? -1 : 1); }}
          />
          <span className="logs-search-count">{count}</span>
          <button className="logs-icon-btn sm" onClick={() => nav(-1)} disabled={!matchLines.length} title="Previous match"><Icon name="chevronUp" size={14} /></button>
          <button className="logs-icon-btn sm" onClick={() => nav(1)} disabled={!matchLines.length} title="Next match"><Icon name="chevronDown" size={14} /></button>
        </div>

        <div className="logs-spacer" />

        <button className={`logs-icon-btn${showTs ? ' on' : ''}`} onClick={() => setShowTs((v) => !v)} title="Show timestamps"><Icon name="timer" size={15} /></button>
        <button className={`logs-icon-btn${showNames ? ' on' : ''}`} onClick={() => setShowNames((v) => !v)} title="Show resource names"><Icon name="tag" size={15} /></button>
        <button className={`logs-icon-btn${wrap ? ' on' : ''}`} onClick={() => setWrap((v) => !v)} title="Wrap lines"><Icon name="wrapText" size={15} /></button>
        <button className="logs-icon-btn" onClick={handleDownload} title="Download logs"><Icon name="download" size={15} /></button>
        <button
          className={`logs-icon-btn${copyState === 'copied' ? ' on' : ''}`}
          onClick={handleCopy}
          title={copyState === 'copied' ? 'Logs copied' : copyState === 'error' ? 'Copy failed' : 'Copy logs'}
          aria-label={copyState === 'copied' ? 'Logs copied' : copyState === 'error' ? 'Copy failed' : 'Copy logs'}
          disabled={!lines.length}
        >
          <Icon name={copyState === 'copied' ? 'check' : copyState === 'error' ? 'warning' : 'copy'} size={15} />
        </button>
        <div className="logs-select tail">
          <select value={tail} onChange={(e) => setTail(Number(e.target.value))} title="Lines to show">
            <option value={100}>Last 100</option>
            <option value={500}>Last 500</option>
            <option value={1000}>Last 1000</option>
            <option value={5000}>Last 5000</option>
            <option value={0}>All</option>
          </select>
          <Icon name="chevronDown" size={13} className="logs-select-caret" />
        </div>
      </div>

      <div className="logs-info">
        Displaying logs from Namespace: <b>{ns}</b> for Pod: <b>{resource?.name}</b>
        {container ? <> · Container: <b>{container}</b></> : null}
        {fetchedAt ? <> · Logs from {fetchedAt.toLocaleString()}</> : null}
      </div>

      <div className={`logs-body${wrap ? ' wrap' : ''}`} ref={bodyRef}>
        {loading && <div className="logs-center"><Loader label="Loading logs…" inline /></div>}
        {error && <div className="logs-error">{error}</div>}
        {!loading && !error && (lines.length === 0 ? (
          <div className="logs-center logs-empty">No logs to display</div>
        ) : (
          <>
            {lines.map((l, i) => (
              <div className="logs-row" data-line={i} key={i}>
                {showTs && l.ts && <span className="logs-ts">{fmtTs(l.ts)}</span>}
                {showNames && l.container && <span className="logs-cname" style={{ color: colorFor(l.container, containerNames) }}>[{l.container}]</span>}
                <span className="logs-msg">{renderMsg(l.msg, i)}</span>
                <span className="logs-lineno">{i + 1}</span>
              </div>
            ))}
            <div ref={endRef} />
          </>
        ))}
      </div>
    </div>
  );
}
