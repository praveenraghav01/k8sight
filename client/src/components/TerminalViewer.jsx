import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import Icon from './Icons';

const THEME_DARK = {
  background: '#0a0a0a',
  foreground: '#cdd6e4',
  cursor: '#3fb950',
  cursorAccent: '#0a0a0a',
  selectionBackground: 'rgba(180,180,190,0.3)',
  black: '#0a0a0a',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#cdd6e4',
  brightBlack: '#6b7684',
  brightRed: '#ff8785',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79b8ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#e6edf3'
};

const THEME_LIGHT = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(9,105,218,0.20)',
  black: '#24292f',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#0969da',
  brightMagenta: '#8250df',
  brightCyan: '#1b7c83',
  brightWhite: '#24292f'
};

const currentTheme = () =>
  document.documentElement.getAttribute('data-theme') === 'light' ? THEME_LIGHT : THEME_DARK;

export default function TerminalViewer({ resource, namespace }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const roRef = useRef(null);
  const [status, setStatus] = useState('connecting'); // connecting | connected | closed

  const ns = resource?.namespace || namespace;
  const container = resource?.container;
  const isNode = resource?.kind === 'Node';

  const connect = () => {
    const term = termRef.current;
    if (!term) return;
    setStatus('connecting');

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const params = isNode
      ? new URLSearchParams({ node: resource.name })
      : new URLSearchParams({ namespace: ns, pod: resource.name });
    if (!isNode && container) params.set('container', container);
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/exec?${params.toString()}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      try { fitRef.current?.fit(); } catch (e) {}
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      term.focus();
    };
    ws.onmessage = (e) => { term.write(e.data); };
    ws.onclose = () => {
      setStatus('closed');
      term.write('\r\n\x1b[90m[session closed, press Reconnect]\x1b[0m\r\n');
    };
    ws.onerror = () => { setStatus('closed'); };
  };

  const reconnect = () => {
    try { wsRef.current?.close(); } catch (e) {}
    termRef.current?.clear();
    connect();
  };

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: currentTheme(),
      scrollback: 5000,
      allowProposedApi: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try { fit.fit(); } catch (e) {}
    termRef.current = term;
    fitRef.current = fit;

    // keystrokes → server
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

    // container resize → refit + notify server
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch (e) {}
    });
    ro.observe(containerRef.current);
    roRef.current = ro;

    // re-theme xterm when the app theme toggles
    const themeObserver = new MutationObserver(() => {
      try { term.options.theme = currentTheme(); term.refresh(0, term.rows - 1); } catch (e) {}
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    connect();

    return () => {
      try { roRef.current?.disconnect(); } catch (e) {}
      try { themeObserver.disconnect(); } catch (e) {}
      try { wsRef.current?.close(); } catch (e) {}
      try { term.dispose(); } catch (e) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource?.name, resource?.kind]);

  const statusText = status === 'connected' ? `${isNode ? 'node' : 'pod'}/${resource?.name}`
    : status === 'connecting' ? 'connecting…' : 'disconnected';
  const dotClass = status === 'connected' ? 'running' : status === 'connecting' ? 'pending' : 'failed';

  return (
    <div className="terminal-viewer">
      <div className="terminal-toolbar">
        <span className="terminal-status">
          <span className={`status-dot ${dotClass}`} />
          {statusText}
        </span>
        {isNode && <span title="A privileged debug pod mounts the node root at /host; cleanup is requested when the terminal closes." style={{ fontSize: 11, color: 'var(--text-muted)' }}>temporary privileged node session</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="terminal-btn" onClick={reconnect} title="Reconnect">
            <Icon name="refresh" size={14} /> Reconnect
          </button>
          <button className="terminal-btn" onClick={() => termRef.current?.clear()} title="Clear">
            <Icon name="close" size={14} /> Clear
          </button>
        </div>
      </div>
      <div className="xterm-host" ref={containerRef} />
    </div>
  );
}
