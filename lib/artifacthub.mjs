// Artifact Hub client — powers the "search for a Helm chart and install it"
// flow. Artifact Hub (artifacthub.io) indexes ~15k charts across every public
// Helm repository, so we query it directly over HTTPS (no API key needed) and
// normalize the results into a small, stable shape the UI and demo mode share.
//
// The parsing is split from the fetching so the normalizers stay pure and unit
// testable (see test/artifacthub.test.mjs).

const API = 'https://artifacthub.io/api/v1';
const KIND_HELM = 0; // Artifact Hub package kind for Helm charts.

// Build an absolute logo URL from a package's logo_image_id.
export const logoUrl = (id) => (id ? `${API.replace('/api/v1', '')}/image/${id}` : null);

// Normalize a raw Artifact Hub search payload into our chart shape. Pure.
export function normalizeSearch(payload) {
  const packages = Array.isArray(payload?.packages) ? payload.packages : [];
  return packages.map((p) => {
    const repo = p.repository || {};
    return {
      id: p.package_id || `${repo.name}/${p.normalized_name || p.name}`,
      name: p.normalized_name || p.name || '',
      displayName: p.display_name || p.name || p.normalized_name || '',
      version: p.version || '',
      appVersion: p.app_version || '',
      description: p.description || '',
      logo: logoUrl(p.logo_image_id),
      stars: Number(p.stars) || 0,
      deprecated: !!p.deprecated,
      repository: {
        name: repo.name || '',
        url: repo.url || '',
        official: !!(p.official || repo.official),
        verified: !!repo.verified_publisher,
      },
    };
  });
}

// Normalize the available-versions list from a package-detail payload. Pure.
export function normalizeVersions(payload) {
  const versions = Array.isArray(payload?.available_versions) ? payload.available_versions : [];
  return versions
    .map((v) => ({ version: v.version || '', appVersion: v.app_version || '', ts: Number(v.ts) || 0 }))
    .filter((v) => v.version)
    .sort((a, b) => b.ts - a.ts); // newest first
}

// Search Helm charts by free-text query. Returns [] on any failure so the UI
// degrades to "no results" rather than erroring.
export async function searchCharts(query, { limit = 24, signal } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const params = new URLSearchParams({
    kind: String(KIND_HELM),
    ts_query_web: q,
    limit: String(Math.min(Math.max(limit, 1), 60)),
    facets: 'false',
    sort: 'relevance',
  });
  const res = await fetch(`${API}/packages/search?${params}`, {
    headers: { accept: 'application/json', 'user-agent': 'k8sight' },
    signal,
  });
  if (!res.ok) throw new Error(`Artifact Hub search failed (${res.status})`);
  return normalizeSearch(await res.json());
}

// List available versions for a chart identified by its Artifact Hub repo name
// + chart name (both from a search result).
export async function chartVersions(repoName, chartName, { signal } = {}) {
  const repo = encodeURIComponent(String(repoName || '').trim());
  const chart = encodeURIComponent(String(chartName || '').trim());
  if (!repo || !chart) return [];
  const res = await fetch(`${API}/packages/helm/${repo}/${chart}`, {
    headers: { accept: 'application/json', 'user-agent': 'k8sight' },
    signal,
  });
  if (!res.ok) throw new Error(`Artifact Hub lookup failed (${res.status})`);
  return normalizeVersions(await res.json());
}
