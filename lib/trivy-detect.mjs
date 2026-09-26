// Trivy operator detection helpers for the Security Center.
//
// k8sight integrates with the official Aqua Security Trivy Operator, whose
// report CRDs (vulnerabilityreports, configauditreports, rbacassessmentreports,
// …) live under the API group `aquasecurity.github.io`. Several unrelated
// projects also ship a "trivy operator" under a different group and a different,
// incompatible CRD schema — most notably devopstales/trivy-operator. When the
// official operator is absent but one of those is present, the UI should say so
// specifically instead of a generic "not installed".

export const OFFICIAL_TRIVY_GROUP = 'aquasecurity.github.io';

// Friendly labels for known third-party operators, keyed by their CRD API group.
export const KNOWN_FOREIGN_TRIVY = {
  'trivy-operator.devopstales.io': 'devopstales/trivy-operator',
};

// Given the CRD names present on the cluster (each "<plural>.<group>"), detect a
// non-official Trivy operator. Returns { group, name } or null. `names` may be a
// Set or any iterable of strings.
export function detectForeignTrivy(names, officialGroup = OFFICIAL_TRIVY_GROUP) {
  const groups = new Set();
  for (const n of names || []) {
    if (!n || n.endsWith(`.${officialGroup}`)) continue;
    // A foreign Trivy operator's CRD mentions "trivy" or ships vulnerabilityreports.
    if (/trivy|vulnerabilityreport/i.test(n)) {
      const dot = n.indexOf('.');
      if (dot > 0) groups.add(n.slice(dot + 1));
    }
  }
  if (groups.size === 0) return null;
  // Prefer a known operator; otherwise report the first group we found.
  const known = [...groups].find((g) => KNOWN_FOREIGN_TRIVY[g]);
  const group = known || [...groups][0];
  return { group, name: KNOWN_FOREIGN_TRIVY[group] || group };
}
