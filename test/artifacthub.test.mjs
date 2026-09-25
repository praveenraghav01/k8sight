// Unit tests for the Artifact Hub response normalizers (lib/artifacthub.mjs).
// These are pure functions over the raw API payloads, so they need no network:
// they lock in the small, stable shape the Helm chart search/install UI relies
// on (name/version/repo/badges) and the safe handling of missing fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearch, normalizeVersions, logoUrl } from '../lib/artifacthub.mjs';

test('normalizeSearch maps the fields the UI uses', () => {
  const [c] = normalizeSearch({
    packages: [{
      package_id: 'abc',
      name: 'nginx',
      normalized_name: 'nginx',
      display_name: 'NGINX',
      version: '18.2.0',
      app_version: '1.27.3',
      description: 'A web server',
      logo_image_id: 'logo123',
      stars: 106,
      official: true,
      repository: { name: 'bitnami', url: 'https://charts.bitnami.com/bitnami', verified_publisher: true },
    }],
  });
  assert.equal(c.id, 'abc');
  assert.equal(c.name, 'nginx');
  assert.equal(c.displayName, 'NGINX');
  assert.equal(c.version, '18.2.0');
  assert.equal(c.appVersion, '1.27.3');
  assert.equal(c.stars, 106);
  assert.equal(c.repository.name, 'bitnami');
  assert.equal(c.repository.url, 'https://charts.bitnami.com/bitnami');
  assert.equal(c.repository.official, true);
  assert.equal(c.repository.verified, true);
  assert.equal(c.logo, 'https://artifacthub.io/image/logo123');
});

test('normalizeSearch treats a verified publisher separately from official', () => {
  const [c] = normalizeSearch({
    packages: [{ name: 'grafana', version: '8.5.1', repository: { name: 'grafana', url: 'https://x', verified_publisher: true } }],
  });
  assert.equal(c.repository.official, false);
  assert.equal(c.repository.verified, true);
});

test('normalizeSearch is safe on empty / malformed input', () => {
  assert.deepEqual(normalizeSearch(null), []);
  assert.deepEqual(normalizeSearch({}), []);
  assert.deepEqual(normalizeSearch({ packages: 'nope' }), []);
  const [c] = normalizeSearch({ packages: [{}] });
  assert.equal(c.name, '');
  assert.equal(c.stars, 0);
  assert.equal(c.logo, null);
  assert.equal(c.repository.name, '');
});

test('normalizeVersions filters, sorts newest-first, and tolerates gaps', () => {
  const v = normalizeVersions({
    available_versions: [
      { version: '1.0.0', ts: 100 },
      { version: '', ts: 999 },        // dropped (no version)
      { version: '2.0.0', app_version: 'v2', ts: 300 },
      { version: '1.5.0', ts: 200 },
    ],
  });
  assert.deepEqual(v.map((x) => x.version), ['2.0.0', '1.5.0', '1.0.0']);
  assert.equal(v[0].appVersion, 'v2');
  assert.deepEqual(normalizeVersions({}), []);
});

test('logoUrl builds an absolute URL and handles nullish ids', () => {
  assert.equal(logoUrl('xyz'), 'https://artifacthub.io/image/xyz');
  assert.equal(logoUrl(null), null);
  assert.equal(logoUrl(''), null);
});
