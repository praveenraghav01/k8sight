import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import Markdown from './Markdown';
import { isExternalAgent } from '../aiConfig';

// Floating AI assistant. Streams a read-only, tool-using debugging session from
// /api/assistant/chat (SSE) and renders tokens + tool-call chips live.

const SUGGESTIONS = [
  'Why is this pod not ready?',
  'Any warning events in this namespace?',
  'Summarize the health of my workloads',
];

export default function Assistant({ context }) {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [enabled, setEnabled] = useState(null); // null = unknown, false = no key
  const [model, setModel] = useState('');
  const [source, setSource] = useState(null); // 'env' | 'stored' | null
  const [editable, setEditable] = useState(true);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([]); // {role, text, tools:[]}
  // LLM connection form
  const [urlInput, setUrlInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);

  const refreshStatus = () =>
    fetch('/api/assistant/status')
      .then((r) => r.json())
      .then((d) => {
        setEnabled(d.enabled); setModel(d.model || ''); setSource(d.source || null); setEditable(d.editable !== false);
        // Prefill the form so editing an existing connection is easy.
        if (d.baseUrl) setUrlInput((v) => v || d.baseUrl);
        if (d.model) setModelInput((v) => v || d.model);
        return d;
      })
      .catch(() => { setEnabled(false); });

  useEffect(() => { refreshStatus(); }, []);

  const saveConfig = async () => {
    const baseUrl = urlInput.trim();
    const model = modelInput.trim();
    const apiKey = keyInput.trim();
    if (!baseUrl || !model || !apiKey || savingKey) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      const resp = await fetch('/api/assistant/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, model, apiKey }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `Failed (${resp.status})`);
      await refreshStatus();
    } catch (err) {
      setKeyError(err.message || 'Could not save the connection');
    } finally {
      // Clear the key from React state/memory as soon as the request settles,
      // whether it succeeded or failed, to minimize the time it lingers in the browser.
      setKeyInput('');
      setSavingKey(false);
    }
  };

  const forget = async () => {
    try {
      await fetch('/api/assistant/config', { method: 'DELETE' });
      setMessages([]);
      setKeyInput('');
      await refreshStatus();
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open]);

  const send = async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput('');

    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    history.push({ role: 'user', text: q });
    setMessages((prev) => [...prev, { role: 'user', text: q }, { role: 'assistant', text: '', tools: [] }]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // Update the last (assistant) message immutably.
    const patchLast = (fn) => setMessages((prev) => {
      const next = prev.slice();
      next[next.length - 1] = fn(next[next.length - 1]);
      return next;
    });

    try {
      const resp = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, context }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`Request failed (${resp.status})`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split('\n\n');
        buf = chunks.pop() || '';
        for (const chunk of chunks) {
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (evt.type === 'token') patchLast((m) => ({ ...m, text: m.text + evt.text }));
          else if (evt.type === 'tool') patchLast((m) => ({ ...m, tools: [...(m.tools || []), { name: evt.name, input: evt.input }] }));
          else if (evt.type === 'error') patchLast((m) => ({ ...m, error: evt.message }));
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') patchLast((m) => ({ ...m, error: err.message || 'Request failed' }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => { abortRef.current?.abort(); };

  // Other views (e.g. the ArgoCD "Summarize" action) can ask the assistant a
  // question by dispatching a window `assistant:ask` event with { prompt }.
  useEffect(() => {
    const onAsk = (e) => {
      const prompt = e.detail?.prompt;
      if (!prompt) return;
      if (isExternalAgent()) return; // an external CLI agent handles it instead
      setOpen(true);
      setMinimized(false);
      if (enabled) send(prompt);
      else setInput(prompt);
    };
    // The AI-tool button opens the chat window directly (no prompt) when the
    // built-in assistant is the chosen tool.
    const onOpen = () => { setOpen(true); setMinimized(false); };
    window.addEventListener('assistant:ask', onAsk);
    window.addEventListener('assistant:open', onOpen);
    return () => { window.removeEventListener('assistant:ask', onAsk); window.removeEventListener('assistant:open', onOpen); };
  }); // no deps: always use the latest send/enabled closures

  const toolLabel = (t) => {
    const i = t.input || {};
    const detail = i.pod ? `${i.namespace}/${i.pod}` : i.name ? `${i.namespace ? i.namespace + '/' : ''}${i.name}` : i.kind ? `${i.kind} in ${i.namespace}` : i.namespace || '';
    return `${t.name}${detail ? ` · ${detail}` : ''}`;
  };

  return (
    <>
      {/* The built-in chat opens from the AI-tool launcher (AiToolButton) via the
          `assistant:open` event — no separate floating button of its own. */}

      {open && (
        <div className={`assistant-panel ${minimized ? 'minimized' : ''}`}>
          <div
            className="assistant-header"
            onClick={() => minimized && setMinimized(false)}
            style={minimized ? { cursor: 'pointer' } : undefined}
            title={minimized ? 'Click to expand' : undefined}
          >
            <span className="assistant-title"><Icon name="sparkles" size={16} /> AI Assistant</span>
            {model && <span className="assistant-model">{model}</span>}
            <button
              className="assistant-x"
              onClick={(e) => { e.stopPropagation(); setMinimized((m) => !m); }}
              aria-label={minimized ? 'Expand' : 'Minimize'}
              title={minimized ? 'Expand' : 'Minimize'}
            >
              <Icon name={minimized ? 'chevronUp' : 'minus'} size={15} />
            </button>
            <button className="assistant-x" onClick={(e) => { e.stopPropagation(); setOpen(false); }} aria-label="Close"><Icon name="close" size={15} /></button>
          </div>

          <div className="assistant-body" ref={scrollRef}>
            {enabled === false && editable && (
              <div className="assistant-empty">
                <p><strong>Connect an LLM API</strong> to enable the assistant. Any OpenAI-compatible endpoint works (TrueFoundry, OpenAI, Azure, LiteLLM, …). Stored on this machine for next time.</p>
                <form className="assistant-key-form" onSubmit={(e) => { e.preventDefault(); saveConfig(); }}>
                  <label className="assistant-field-label">API base URL</label>
                  <input type="text" value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="https://<org>.truefoundry.cloud/api/llm/api/inference/openai" autoComplete="off" spellCheck={false} autoFocus />
                  <label className="assistant-field-label">Model</label>
                  <input type="text" value={modelInput} onChange={(e) => setModelInput(e.target.value)} placeholder="e.g. openai-main/gpt-4o" autoComplete="off" spellCheck={false} />
                  <label className="assistant-field-label">API key</label>
                  <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="API token" autoComplete="off" spellCheck={false} />
                  <button type="submit" className="modal-btn primary" disabled={!urlInput.trim() || !modelInput.trim() || !keyInput.trim() || savingKey}>
                    {savingKey ? 'Validating…' : 'Connect'}
                  </button>
                </form>
                {keyError && <div className="assistant-error"><Icon name="warning" size={13} /> {keyError}</div>}
                <p className="assistant-hint">The base URL is everything before <code>/chat/completions</code>. Stored in <code>~/.config/k8s-manager/config.json</code>.</p>
              </div>
            )}

            {enabled === false && !editable && (
              <div className="assistant-empty">
                <p><strong>AI assistant isn't configured.</strong></p>
                <p>Set <code>LLM_BASE_URL</code>, <code>LLM_API_KEY</code>, and <code>LLM_MODEL</code> in the server environment and restart.</p>
              </div>
            )}

            {enabled && messages.length === 0 && (
              <div className="assistant-empty">
                <p>Ask about your cluster — I can read logs, events, and resource specs to help debug. I can't make changes.</p>
                <div className="assistant-suggest">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send(s)} disabled={busy}>{s}</button>
                  ))}
                </div>
                {source === 'stored' && (
                  <button className="assistant-forget" onClick={forget}>Forget saved LLM connection</button>
                )}
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`assistant-msg ${m.role}`}>
                {m.role === 'assistant' && (
                  <span className="assistant-avatar" aria-hidden="true"><Icon name="sparkles" size={13} /></span>
                )}
                <div className="assistant-msg-content">
                  {(m.tools || []).length > 0 && (
                    <div className="assistant-tools">
                      {m.tools.map((t, j) => (
                        <span key={j} className="assistant-tool-chip"><Icon name="search" size={11} /> {toolLabel(t)}</span>
                      ))}
                    </div>
                  )}
                  {m.text && (
                    <div className="assistant-text">
                      {m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}
                    </div>
                  )}
                  {m.role === 'assistant' && !m.text && !m.error && busy && i === messages.length - 1 && (
                    <div className="assistant-thinking"><span></span><span></span><span></span></div>
                  )}
                  {m.error && <div className="assistant-error"><Icon name="warning" size={13} /> {m.error}</div>}
                </div>
              </div>
            ))}
          </div>

          <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={enabled === false ? 'Add an API key above to enable' : 'Ask about your cluster…'}
              disabled={enabled === false || busy}
              autoFocus
            />
            {busy ? (
              <button type="button" onClick={stop} className="assistant-send stop" title="Stop"><Icon name="close" size={16} /></button>
            ) : (
              <button type="submit" className="assistant-send" disabled={!input.trim() || enabled === false} title="Send"><Icon name="send" size={16} /></button>
            )}
          </form>
        </div>
      )}
    </>
  );
}
