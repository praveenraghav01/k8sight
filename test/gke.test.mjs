// Regression tests for the CLI-free GKE integration (gke.js).
//
// gke.js resolves CONFIG_DIR / CREDS_FILE / ADC_FILE from process.env.HOME at
// module load, and kubeconfigPath() reads process.env.KUBECONFIG on every
// call. Setting both to a scratch directory *before* importing the module
// isolates every test from the developer's real gcloud state and real
// kubeconfig. Because Node's ESM cache keys on the resolved specifier, each
// test that needs a different on-disk starting point (no creds / ADC present
// / own creds present) imports the module via a distinct `?case=` query
// string so it gets re-evaluated against the HOME set just before the import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const GKE_JS = new URL('../gke.js', import.meta.url).pathname;
const OAUTH_FILE_EXISTS = fs.existsSync(new URL('../gke-oauth.json', import.meta.url));

const tmpDirs = [];
function mkTmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gke-test-'));
  tmpDirs.push(dir);
  return dir;
}

// Point HOME/KUBECONFIG at a fresh scratch dir and import a fresh copy of
// gke.js (via a unique query string) so its module-load-time constants pick
// up the new HOME.
let caseCounter = 0;
async function freshGke({ home = mkTmpHome(), kubeconfig } = {}) {
  process.env.HOME = home;
  process.env.KUBECONFIG = kubeconfig || path.join(home, 'config');
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  caseCounter += 1;
  const mod = await import(`${GKE_JS}?case=${caseCounter}`);
  return { mod, home, kubeconfigPath: process.env.KUBECONFIG };
}

function writeAdc(home, extra = {}) {
  const dir = path.join(home, '.config', 'gcloud');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'application_default_credentials.json');
  fs.writeFileSync(file, JSON.stringify({
    type: 'authorized_user',
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    refresh_token: 'test-refresh-token',
    account: 'someone@example.com',
    ...extra,
  }));
  return file;
}

test.after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Rule 1: writeCluster names the context gke_<project>_<location>_<name> and
// writes matching clusters/users/contexts entries pointing at the endpoint.
test('writeCluster names the context gke_<project>_<location>_<name> and writes matching entries', async () => {
  const { mod, kubeconfigPath } = await freshGke();
  const { context: ctxName } = mod.writeCluster({
    name: 'my-cluster', location: 'us-central1', project: 'my-project',
    endpoint: '1.2.3.4', ca: 'ZmFrZS1jYQ==',
  });
  assert.equal(ctxName, 'gke_my-project_us-central1_my-cluster');

  const doc = yaml.load(fs.readFileSync(kubeconfigPath, 'utf8'));
  assert.equal(doc.clusters.length, 1);
  assert.equal(doc.clusters[0].name, ctxName);
  assert.equal(doc.clusters[0].cluster.server, 'https://1.2.3.4');
  assert.equal(doc.users.length, 1);
  assert.equal(doc.users[0].name, ctxName);
  assert.equal(doc.contexts.length, 1);
  assert.equal(doc.contexts[0].name, ctxName);
  assert.deepEqual(doc.contexts[0].context, { cluster: ctxName, user: ctxName });
});

// Rule 2: re-importing the same cluster upserts rather than duplicating. A
// non-idempotent merge would grow the user's kubeconfig on every re-import.
test('re-importing the same cluster upserts instead of duplicating entries', async () => {
  const { mod, kubeconfigPath } = await freshGke();
  const clusterArgs = {
    name: 'dup-cluster', location: 'europe-west1', project: 'proj-a',
    endpoint: '5.6.7.8', ca: 'Y2E=',
  };
  mod.writeCluster(clusterArgs);
  mod.writeCluster({ ...clusterArgs, endpoint: '9.9.9.9' }); // re-import, changed endpoint

  const doc = yaml.load(fs.readFileSync(kubeconfigPath, 'utf8'));
  assert.equal(doc.clusters.length, 1);
  assert.equal(doc.users.length, 1);
  assert.equal(doc.contexts.length, 1);
  // The upsert should reflect the latest write.
  assert.equal(doc.clusters[0].cluster.server, 'https://9.9.9.9');
});

// Rule 3: the exec entry runs the bundled gke-token.js through node and never
// invokes a Google CLI — the entire promise of the feature.
//
// This asserts on the BINARY, not on the absence of the string "gcloud". An
// ADC-based import legitimately points its --credentials argument at
// ~/.config/gcloud/application_default_credentials.json, so a naive string
// check would reject the very flow this feature is built around while still
// passing on every other case — a test that looks strict and proves nothing.
const GOOGLE_CLIS = ['gcloud', 'gke-gcloud-auth-plugin'];
const execBinary = (exec) => path.basename(exec.command || '');

test('the exec entry runs gke-token.js through node, not a Google CLI', async () => {
  const { mod, kubeconfigPath } = await freshGke();
  mod.writeCluster({
    name: 'c', location: 'l', project: 'p', endpoint: 'e', ca: 'Y2E=',
  });

  const exec = yaml.load(fs.readFileSync(kubeconfigPath, 'utf8')).users[0].user.exec;
  assert.ok(
    !GOOGLE_CLIS.includes(execBinary(exec)),
    `exec must not invoke a Google CLI, got "${execBinary(exec)}"`,
  );
  assert.ok(exec.args.some((a) => a.endsWith('gke-token.js')));
});

// The same guarantee on the ADC path, which is the common case. The
// credentials argument points into gcloud's config directory; nothing runs
// gcloud. This is the case the previous string-based assertion would have
// wrongly failed.
test('an ADC-based import still invokes no Google CLI', async () => {
  const home = mkTmpHome();
  const adcFile = writeAdc(home);
  const { mod, kubeconfigPath } = await freshGke({ home });
  mod.writeCluster({
    name: 'c', location: 'l', project: 'p', endpoint: 'e', ca: 'Y2E=',
  });

  const exec = yaml.load(fs.readFileSync(kubeconfigPath, 'utf8')).users[0].user.exec;
  assert.ok(!GOOGLE_CLIS.includes(execBinary(exec)));
  assert.equal(
    exec.args[exec.args.indexOf('--credentials') + 1],
    adcFile,
    'an ADC import must point the exec entry at the ADC file itself',
  );
});

// Rule 4: an alias overrides the generated context name.
test('an alias overrides the generated context name', async () => {
  const { mod, kubeconfigPath } = await freshGke();
  const { context: ctxName } = mod.writeCluster({
    name: 'c', location: 'l', project: 'p', endpoint: 'e', ca: 'Y2E=', alias: 'my-alias',
  });
  assert.equal(ctxName, 'my-alias');
  const doc = yaml.load(fs.readFileSync(kubeconfigPath, 'utf8'));
  assert.equal(doc.clusters[0].name, 'my-alias');
  assert.equal(doc.contexts[0].name, 'my-alias');
});

// Rule 4b: gcloud names its kubeconfig entries exactly gke_<project>_<location>_
// <cluster>, so importing a cluster the user already has via `gcloud container
// clusters get-credentials` silently replaces that entry's auth. writeCluster
// must report this (replacedExternalAuth: true) so the caller can tell the
// user, but must NOT report it when re-importing a cluster k8sight itself
// wrote (replacedExternalAuth: false) — that overwrite is just our own upsert.
test('reports replacedExternalAuth when overwriting a gcloud-style entry, not when overwriting our own', async () => {
  const { mod, kubeconfigPath } = await freshGke();
  const clusterArgs = { name: 'my-cluster', location: 'us-central1', project: 'my-project', endpoint: '1.2.3.4', ca: 'Y2E=' };
  const ctxName = `gke_${clusterArgs.project}_${clusterArgs.location}_${clusterArgs.name}`;

  // Seed the kubeconfig as gcloud itself would: a context/cluster/user already
  // authenticating via gke-gcloud-auth-plugin, at the exact name gcloud uses.
  const gcloudDoc = {
    apiVersion: 'v1', kind: 'Config',
    clusters: [{ name: ctxName, cluster: { server: `https://${clusterArgs.endpoint}` } }],
    users: [{ name: ctxName, user: { exec: { apiVersion: 'client.authentication.k8s.io/v1beta1', command: 'gke-gcloud-auth-plugin', args: [] } } }],
    contexts: [{ name: ctxName, context: { cluster: ctxName, user: ctxName } }],
    'current-context': ctxName,
  };
  fs.writeFileSync(kubeconfigPath, yaml.dump(gcloudDoc), 'utf8');

  const first = mod.writeCluster(clusterArgs);
  assert.equal(first.context, ctxName);
  assert.equal(first.replacedExternalAuth, true, 'overwriting a gcloud-authenticated entry must be reported');

  // Re-importing the same cluster now overwrites the entry k8sight itself
  // just wrote, which is not worth reporting.
  const second = mod.writeCluster(clusterArgs);
  assert.equal(second.replacedExternalAuth, false, 'overwriting our own entry must not be reported');
});

// Rule 5: a cluster with no public endpoint throws instead of writing a
// broken context. Private GKE clusters (no public endpoint) are a known,
// documented limitation.
test('a cluster missing endpoint/CA throws and writes nothing', async () => {
  const { mod, kubeconfigPath } = await freshGke();
  assert.throws(
    () => mod.writeCluster({ name: 'c', location: 'l', project: 'p', endpoint: '', ca: 'Y2E=' }),
    /missing endpoint\/CA/,
  );
  assert.throws(
    () => mod.writeCluster({ name: 'c', location: 'l', project: 'p', endpoint: 'e', ca: '' }),
    /missing endpoint\/CA/,
  );
  assert.equal(fs.existsSync(kubeconfigPath), false);
});

// Rule 6: with no stored credentials and no ADC, getStatus() reports a
// signed-out state.
test('getStatus reports signed-out state with no stored creds and no ADC', async () => {
  const { mod } = await freshGke();
  const status = mod.getStatus();
  assert.equal(status.loggedIn, false);
  assert.equal(status.method, null);
  assert.equal(status.adcAvailable, false);
});

// oauthConfigured depends on GOOGLE_CLIENT_ID/SECRET (deleted above) and on a
// gitignored gke-oauth.json sitting next to gke.js. A developer who baked in
// their own OAuth client must not see a red CI, so this assertion is skipped
// when that file exists locally.
test('getStatus reports oauthConfigured false with no env vars and no oauth file', { skip: OAUTH_FILE_EXISTS ? 'gke-oauth.json present locally' : false }, async () => {
  const { mod } = await freshGke();
  assert.equal(mod.getStatus().oauthConfigured, false);
});

// Rule 7: with an ADC file present (and no stored k8sight credentials),
// getStatus() reports the adc method and treats the user as logged in.
test('getStatus reports method adc when only ADC is present', async () => {
  const home = mkTmpHome();
  writeAdc(home);
  const { mod } = await freshGke({ home });
  const status = mod.getStatus();
  assert.equal(status.method, 'adc');
  assert.equal(status.adcAvailable, true);
  assert.equal(status.loggedIn, true);
  assert.equal(status.account, 'someone@example.com');
});

// Rule 8: activeCredsFile() points at the ADC when there are no stored
// credentials, and at the module's own credentials file once k8sight has
// stored its own. This is what keeps an ADC-based import working after the
// app closes — if it returned the wrong path, kubectl would break on a file
// that was never written.
test('activeCredsFile prefers ADC when no own creds, and its own file once stored', async () => {
  const home = mkTmpHome();
  const adcFile = writeAdc(home);
  const { mod } = await freshGke({ home });

  assert.equal(mod.activeCredsFile(), adcFile);

  // Simulate k8sight having stored its own credentials (as loginWithServiceAccount
  // / the browser flow would via saveCreds()) without touching the network.
  const ownFile = path.join(home, '.config', 'k8s-manager', 'gke', 'credentials.json');
  fs.mkdirSync(path.dirname(ownFile), { recursive: true });
  fs.writeFileSync(ownFile, JSON.stringify({ type: 'service_account', client_email: 'sa@p.iam.gserviceaccount.com' }));

  assert.equal(mod.activeCredsFile(), ownFile);
});

// Rule 9: signOut() removes only the module's own credentials file and
// leaves the ADC alone — the ADC belongs to gcloud, not to k8sight.
test('signOut removes only own credentials, leaving the ADC untouched', async () => {
  const home = mkTmpHome();
  const adcFile = writeAdc(home);
  const { mod } = await freshGke({ home });

  const ownFile = path.join(home, '.config', 'k8s-manager', 'gke', 'credentials.json');
  fs.mkdirSync(path.dirname(ownFile), { recursive: true });
  fs.writeFileSync(ownFile, JSON.stringify({ type: 'service_account', client_email: 'sa@p.iam.gserviceaccount.com' }));

  mod.signOut();

  assert.equal(fs.existsSync(ownFile), false);
  assert.equal(fs.existsSync(adcFile), true);
});
