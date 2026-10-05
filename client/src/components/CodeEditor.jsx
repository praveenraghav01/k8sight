import React, { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import '../monaco-setup';

// Resolve the app's effective theme to a Monaco theme, and follow live changes.
// App.jsx sets data-theme="light|dark" on <html>.
function useEditorTheme() {
  const read = () => {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'light') return 'light';
    if (t === 'dark') return 'vs-dark';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'light';
  };
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const el = document.documentElement;
    const mo = new MutationObserver(() => setTheme(read()));
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

// A VSCode-grade editor (Monaco) with the app's theme, sensible defaults and an
// optional ⌘S/Ctrl+S save binding. `onSave` should be a stable callback that
// reads the latest value (pass one that calls a ref) so the shortcut isn't stale.
export default function CodeEditor({ value, onChange, language = 'yaml', readOnly = false, onSave, height = '100%' }) {
  const theme = useEditorTheme();
  return (
    <Editor
      height={height}
      language={language}
      theme={theme}
      value={value}
      onChange={(v) => onChange && onChange(v ?? '')}
      loading={<div className="yaml-editor-loading">Loading editor…</div>}
      options={{
        readOnly,
        domReadOnly: readOnly,
        minimap: { enabled: !readOnly },
        fontSize: 12.5,
        lineHeight: 19,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        renderWhitespace: 'selection',
        wordWrap: 'off',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        padding: { top: 10, bottom: 10 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        fixedOverflowWidgets: true,
        stickyScroll: { enabled: false },
        guides: { indentation: true },
      }}
      onMount={(editor, monaco) => {
        if (onSave) editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
      }}
    />
  );
}
