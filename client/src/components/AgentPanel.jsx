import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import axios from 'axios';
import Icon from './Icons';
import { getAiConfig, isExternalAgent, getAiExternalTerminal } from '../aiConfig';

const THEME_DARK = { background: '#0a0a0a', foreground: '#cdd6e4', cursor: '#3fb950', cursorAccent: '#0a0a0a', selectionBackground: 'rgba(180,180,190,0.3)', black: '#0a0a0a', red: '#f85149', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#cdd6e4', brightBlack: '#6b7684', brightRed: '#ff8785', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79b8ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#e6edf3' };
const THEME_LIGHT = { ...THEME_DARK, background: '#ffffff', foreground: '#1f2328', cursor: '#1a7f37', cursorAccent: '#ffffff', black: '#24292f', white: '#1f2328', brightBlack: '#57606a' };
const currentTheme = () => (document.documentElement.getAttribute('data-theme') === 'light' || (!document.documentElement.getAttribute('data-theme') && window.matchMedia?.('(prefers-color-scheme: light)').matches) ? THEME_LIGHT : THEME_DARK);

// A global terminal panel that runs the configured CLI AI agent with the app's
// cluster context loaded. Opens on a window `agent:open` event { agentId,
// agentName, prompt } (dispatched by the "Ask <agent>" actions).
export default function AgentPanel({ context, onOpenChange }) {
  const [session, setSession] = useState(null); // { agentId, agentName, prompt }
  const [status, setStatus] = useState('connecting');
  const [height, setHeight] = useState(() => { const v = parseInt(localStorage.getItem('agentPanelHeight'), 10); return v >= 160 && v <= 900 ? v : 340; });
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);

  // Tell the app when the docked terminal is open, so it can lift/hide the
  // floating AI buttons that would otherwise sit over it.
  useEffect(() => { onOpenChange?.(!!session); }, [session, onOpenChange]);

  // Refit the terminal whenever the docked height changes.
  useEffect(() => { try { fitRef.current?.fit(); } catch { /* ignore */ } }, [height]);
  // Drag the top edge to resize the docked terminal.
  const startResize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let lastH = startH;
    const onMove = (ev) => { lastH = Math.min(900, Math.max(160, startH + (startY - ev.clientY))); setHeight(lastH); };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; try { localStorage.setItem('agentPanelHeight', String(Math.round(lastH))); } catch { /* ignore */ } };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
  };

  useEffect(() => {
    // If the "external terminal" preference is on, launch in a native OS terminal
    // window instead of the in-app panel.
    const launchExternal = (s) => {
      axios.post('/api/ai-agents/launch-external', { agentId: s.agentId, command: s.command, prompt: s.prompt })
        .catch((err) => { window.dispatchEvent(new CustomEvent('toast', { detail: { type: 'error', message: err.response?.data?.error || 'Could not open external terminal' } })); });
    };
    // Direct open (Configure AI → open terminal) and routed "Ask AI" actions.
    const onOpen = (e) => {
      const s = { ...e.detail };
      if (getAiExternalTerminal()) return launchExternal(s);
      setSession({ ...s, key: Date.now() });
    };
    const onAsk = (e) => {
      const cfg = getAiConfig();
      if (!isExternalAgent(cfg)) return; // built-in assistant handles it
      const s = { agentId: cfg.id || 'custom', command: cfg.command, agentName: cfg.name, prompt: e.detail?.prompt };
      if (getAiExternalTerminal()) return launchExternal(s);
      setSession({ ...s, key: Date.now() });
    };
    window.addEventListener('agent:open', onOpen);
    window.addEventListener('assistant:ask', onAsk);
    return () => { window.removeEventListener('agent:open', onOpen); window.removeEventListener('assistant:ask', onAsk); };
  }, []);

  useEffect(() => {
    if (!session || !containerRef.current) return;
    const term = new Terminal({ fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace", fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, theme: currentTheme(), scrollback: 8000, allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* ignore */ }
    termRef.current = term; fitRef.current = fit;

    term.onData((data) => { const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data })); });
    const ro = new ResizeObserver(() => { try { fit.fit(); const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch { /* ignore */ } });
    ro.observe(containerRef.current);
    const themeObs = new MutationObserver(() => { try { term.options.theme = currentTheme(); term.refresh(0, term.rows - 1); } catch { /* ignore */ } });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    connect(term, fit);

    return () => { try { ro.disconnect(); } catch { /* ignore */ } try { themeObs.disconnect(); } catch { /* ignore */ } try { wsRef.current?.close(); } catch { /* ignore */ } try { term.dispose(); } catch { /* ignore */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.key]);

  const connect = (term, fit) => {
    setStatus('connecting');
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ agent: session.agentId });
    if (session.command) params.set('command', session.command);
    if (session.prompt) params.set('prompt', session.prompt);
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/exec?${params.toString()}`);
    wsRef.current = ws;
    ws.onopen = () => { setStatus('connected'); try { fit.fit(); } catch { /* ignore */ } ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); term.focus(); };
    ws.onmessage = (e) => term.write(e.data);
    ws.onclose = () => { setStatus('closed'); term.write('\r\n\x1b[90m[agent session ended]\x1b[0m\r\n'); };
    ws.onerror = () => setStatus('closed');
  };

  const reconnect = () => { try { wsRef.current?.close(); } catch { /* ignore */ } termRef.current?.clear(); connect(termRef.current, fitRef.current); };
  const close = () => { try { wsRef.current?.close(); } catch { /* ignore */ } setSession(null); };

  if (!session) return null;

  return (
    <div className="agent-panel" style={{ height }}>
      <div className="agent-panel-resize" onMouseDown={startResize} title="Drag to resize" />
      <div className="agent-panel-head">
        <span className="agent-panel-title"><Icon name="sparkles" size={14} /> {session.agentName || 'AI agent'}</span>
        <span className={`agent-panel-status ${status}`}>{status === 'connected' ? `cluster: ${context?.currentContext || 'loaded'}` : status === 'connecting' ? 'starting…' : 'ended'}</span>
        <div className="agent-panel-actions">
          {status === 'closed' && <button className="agent-panel-btn" onClick={reconnect} title="Reconnect"><Icon name="refresh" size={13} /></button>}
          <button className="agent-panel-btn" onClick={close} title="Close"><Icon name="close" size={15} /></button>
        </div>
      </div>
      <div className="agent-panel-term" ref={containerRef} />
    </div>
  );
}
