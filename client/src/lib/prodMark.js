// Production-cluster marking.
//
// Makes it obvious when the active context is a production cluster, so you are
// less likely to act on the wrong environment. A context is production when:
//   1. it has an explicit manual mark (true/false), which wins, or
//   2. its name contains `prod`, `production` or `prd` as a separate word
//      (prod-eu, k8s_production, prd01) — but not preprod / nonprod.
//
// Manual marks and the display preferences persist in localStorage.

const MARKS_KEY = 'k8sight.prodMarks';   // { [contextName]: boolean } explicit overrides
const PREFS_KEY = 'k8sight.prodMarkPrefs';

// `prod` / `production` / `prd` delimited by a non-letter on each side (start,
// end, separators or digits all count). "preprod" and "nonprod" are letters on
// the left, so they are excluded.
const NAME_RE = /(^|[^a-z])(production|prod|prd)([^a-z]|$)/;

export function isProductionByName(name) {
  return NAME_RE.test(String(name || '').toLowerCase());
}

// Explicit mark wins over the name rule; otherwise fall back to the name.
export function resolveProd(name, marks) {
  if (marks && Object.prototype.hasOwnProperty.call(marks, name)) return !!marks[name];
  return isProductionByName(name);
}

export function loadMarks() {
  try { return JSON.parse(localStorage.getItem(MARKS_KEY)) || {}; } catch { return {}; }
}

export function saveMarks(marks) {
  try { localStorage.setItem(MARKS_KEY, JSON.stringify(marks)); } catch { /* storage blocked */ }
}

// Toggle a context between marked and unmarked. Setting the mark to the value
// the name rule already implies clears the override, so the name rule resumes.
export function toggleMark(marks, name) {
  const next = { ...marks };
  const target = !resolveProd(name, marks);
  if (target === isProductionByName(name)) delete next[name];
  else next[name] = target;
  return next;
}

export const DEFAULT_PREFS = {
  edge: true,          // red edge around the window
  edgeThickness: 4,    // px
  badge: true,         // PRODUCTION label in the header
  navRow: true,        // PRODUCTION indicator in the context switcher
  color: '#ff3b30',    // Apple red
};

export function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY)) || {}) }; }
  catch { return { ...DEFAULT_PREFS }; }
}

export function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage blocked */ }
}
