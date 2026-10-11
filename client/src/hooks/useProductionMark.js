import { useState, useCallback } from 'react';
import { loadMarks, saveMarks, toggleMark, resolveProd, loadPrefs, savePrefs } from '../lib/prodMark';

// Shared production-mark state: the manual overrides, the display preferences,
// and helpers to query and toggle. Lives once at the app root and is passed to
// the header, the context switcher and the window-edge overlay.
export default function useProductionMark() {
  const [marks, setMarks] = useState(loadMarks);
  const [prefs, setPrefsState] = useState(loadPrefs);

  const isProd = useCallback((name) => resolveProd(name, marks), [marks]);

  const toggle = useCallback((name) => {
    setMarks((cur) => { const next = toggleMark(cur, name); saveMarks(next); return next; });
  }, []);

  const setPrefs = useCallback((patch) => {
    setPrefsState((cur) => { const next = { ...cur, ...patch }; savePrefs(next); return next; });
  }, []);

  return { marks, prefs, isProd, toggle, setPrefs };
}
