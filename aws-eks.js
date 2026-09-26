// CLI-free AWS EKS integration, built on the AWS SDK for JavaScript v3.
// No `aws` binary and no reliance on the local credential chain beyond what the
// SDK reads itself. Handles the three sign-in methods (SSO / access keys /
// assume-role), discovers EKS clusters across accounts and regions, and writes
// kubeconfig entries whose auth execs our native eks-token.js helper.
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { SSOOIDCClient, RegisterClientCommand, StartDeviceAuthorizationCommand, CreateTokenCommand } from '@aws-sdk/client-sso-oidc';
import { SSOClient, ListAccountsCommand, ListAccountRolesCommand, GetRoleCredentialsCommand } from '@aws-sdk/client-sso';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';

import { tokenHelperPath } from './lib/resource-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Bundled, dependency-free helper (see scripts/bundle-token-helpers.mjs); resolved
// to its unpacked location so the kubeconfig exec-plugin can spawn it under asar.
export const EKS_TOKEN_HELPER = tokenHelperPath(import.meta.url, 'eks-token');

// Static AWS region list. We deliberately do NOT call EC2 DescribeRegions —
// that pulls in @aws-sdk/client-ec2 (~26 MB / 3k+ files), which bloated the
// installer just to list regions. Listing EKS clusters in a region with none is
// a cheap no-op (and unavailable/opt-out regions just error and are skipped), so
// searching a broad static list is fine.
const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ca-central-1', 'ca-west-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2',
  'eu-north-1', 'eu-south-1', 'eu-south-2',
  'ap-south-1', 'ap-south-2',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-east-1',
  'sa-east-1',
  'me-south-1', 'me-central-1', 'af-south-1', 'il-central-1',
];
const awsDir = () => path.join(process.env.HOME || os.homedir(), '.aws');
const kubeconfigPath = () => process.env.KUBECONFIG || path.join(process.env.HOME || os.homedir(), '.kube', 'config');

// ---- shared config (profiles) -------------------------------------------
export async function listProfiles() {
  try {
    const { configFile = {}, credentialsFile = {} } = await loadSharedConfigFiles();
    const names = new Set([...Object.keys(configFile), ...Object.keys(credentialsFile)]);
    return [...names].map((name) => {
      const c = { ...(configFile[name] || {}), ...(credentialsFile[name] || {}) };
      const type = c.sso_start_url || c.sso_session ? 'sso' : c.role_arn ? 'role' : c.aws_access_key_id ? 'access-key' : 'other';
      return { name, type, ssoStartUrl: c.sso_start_url, ssoRegion: c.sso_region, region: c.region };
    }).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

// ---- credential resolution ----------------------------------------------
// Returns { credentials, region, profile? } for a concrete set of static creds.
export async function resolveCredentials(method, opts = {}) {
  if (method === 'access-key') {
    const { accessKeyId, secretAccessKey, sessionToken } = opts;
    if (!accessKeyId || !secretAccessKey) throw new Error('Access Key ID and Secret Access Key are required');
    return { credentials: { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined }, region: opts.region };
  }
  if (method === 'role') {
    const { roleArn, sessionName, region } = opts;
    if (!roleArn) throw new Error('Role ARN is required');
    // Base credentials come from the ambient chain / source profile.
    const sts = new STSClient({ region: region || 'us-east-1', ...(opts.sourceProfile ? { profile: opts.sourceProfile } : {}) });
    const out = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName || 'k8s-manager', DurationSeconds: 3600 }));
    const c = out.Credentials;
    return { credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken }, region };
  }
  throw new Error(`Unsupported credential method: ${method}`);
}

export async function validateCredentials(credentials, region) {
  const sts = new STSClient({ region: region || 'us-east-1', credentials });
  const id = await sts.send(new GetCallerIdentityCommand({}));
  return { account: id.Account, arn: id.Arn, userId: id.UserId };
}

// ---- region + cluster discovery -----------------------------------------
function regionsFor(region) {
  // Ensure the caller's own region is searched even if it's not in the list.
  return region && !AWS_REGIONS.includes(region) ? [region, ...AWS_REGIONS] : AWS_REGIONS;
}

export async function discoverClusters({ credentials, region, account, accountName }) {
  const regions = regionsFor(region);
  const perRegion = await Promise.all(regions.map(async (r) => {
    try {
      const eks = new EKSClient({ region: r, credentials });
      const out = await eks.send(new ListClustersCommand({}));
      return (out.clusters || []).map((name) => ({ name, region: r, account, accountName }));
    } catch { return []; }
  }));
  return { clusters: perRegion.flat(), regions: regions.length };
}

// ---- AWS SSO (IAM Identity Center) device flow --------------------------
// Returns a session used to poll for the token, then to enumerate accounts.
// IAM Identity Center is regional, but the user only gives us a start URL. When
// the region isn't known, probe the common regions and use the one that accepts
// the start URL (StartDeviceAuthorization throws for the wrong region).
const SSO_PROBE_REGIONS = ['us-east-1', 'eu-west-1', 'us-west-2', 'eu-central-1', 'us-east-2', 'eu-west-2', 'ap-southeast-1', 'ap-south-1', 'ap-northeast-1', 'eu-north-1', 'sa-east-1', 'ca-central-1', 'eu-west-3', 'ap-southeast-2', 'us-west-1', 'il-central-1'];

export async function ssoStartDeviceFlow({ startUrl, ssoRegion }) {
  if (!startUrl) throw new Error('An SSO start URL is required');
  const regions = ssoRegion ? [ssoRegion] : SSO_PROBE_REGIONS;
  let lastErr;
  for (const region of regions) {
    try {
      const oidc = new SSOOIDCClient({ region });
      const reg = await oidc.send(new RegisterClientCommand({ clientName: 'kubernetes-manager-ui', clientType: 'public' }));
      const auth = await oidc.send(new StartDeviceAuthorizationCommand({ clientId: reg.clientId, clientSecret: reg.clientSecret, startUrl }));
      return {
        ssoRegion: region, startUrl,
        clientId: reg.clientId, clientSecret: reg.clientSecret,
        deviceCode: auth.deviceCode, userCode: auth.userCode,
        verificationUri: auth.verificationUriComplete || auth.verificationUri,
        interval: auth.interval || 5, expiresIn: auth.expiresIn || 600,
      };
    } catch (e) { lastErr = e; /* wrong region → try the next */ }
  }
  throw new Error(`Could not start AWS SSO sign-in for ${startUrl} — check the start URL. (${lastErr?.name || lastErr?.message || 'no region matched'})`);
}

// Poll once for the SSO access token. Returns { pending } or { accessToken }.
export async function ssoPollToken(session) {
  const oidc = new SSOOIDCClient({ region: session.ssoRegion });
  try {
    const out = await oidc.send(new CreateTokenCommand({ clientId: session.clientId, clientSecret: session.clientSecret, grantType: 'urn:ietf:params:oauth:grant-type:device_code', deviceCode: session.deviceCode }));
    return { accessToken: out.accessToken, expiresIn: out.expiresIn };
  } catch (e) {
    const name = e.name || '';
    if (name === 'AuthorizationPendingException' || name === 'SlowDownException') return { pending: true };
    throw e;
  }
}

// Granular SSO steps (guided account → role → clusters flow).
export async function ssoListAccounts({ accessToken, ssoRegion }) {
  const sso = new SSOClient({ region: ssoRegion });
  const accounts = []; let nextToken;
  do { const out = await sso.send(new ListAccountsCommand({ accessToken, nextToken })); accounts.push(...(out.accountList || [])); nextToken = out.nextToken; } while (nextToken);
  return accounts.map((a) => ({ accountId: a.accountId, accountName: a.accountName, email: a.emailAddress })).sort((a, b) => (a.accountName || '').localeCompare(b.accountName || ''));
}
export async function ssoListRoles({ accessToken, ssoRegion }, accountId) {
  const sso = new SSOClient({ region: ssoRegion });
  const roles = []; let nextToken;
  do { const out = await sso.send(new ListAccountRolesCommand({ accessToken, accountId, nextToken })); roles.push(...(out.roleList || [])); nextToken = out.nextToken; } while (nextToken);
  return roles.map((r) => r.roleName);
}
export async function ssoRoleCredentials({ accessToken, ssoRegion }, accountId, roleName) {
  const sso = new SSOClient({ region: ssoRegion });
  const rc = await sso.send(new GetRoleCredentialsCommand({ accessToken, accountId, roleName }));
  return { accessKeyId: rc.roleCredentials.accessKeyId, secretAccessKey: rc.roleCredentials.secretAccessKey, sessionToken: rc.roleCredentials.sessionToken };
}

// Enumerate every account + role the SSO user can access and list EKS clusters
// in each — this is the "multiple accounts" discovery.
export async function ssoDiscover({ accessToken, ssoRegion }) {
  const sso = new SSOClient({ region: ssoRegion });
  const accounts = [];
  let nextToken;
  do {
    const out = await sso.send(new ListAccountsCommand({ accessToken, nextToken }));
    accounts.push(...(out.accountList || []));
    nextToken = out.nextToken;
  } while (nextToken);

  const all = [];
  for (const acct of accounts) {
    let role;
    try {
      const roles = await sso.send(new ListAccountRolesCommand({ accessToken, accountId: acct.accountId }));
      role = (roles.roleList || [])[0]; // first role the user has in the account
    } catch { role = null; }
    if (!role) continue;
    let creds;
    try {
      const rc = await sso.send(new GetRoleCredentialsCommand({ accessToken, accountId: acct.accountId, roleName: role.roleName }));
      creds = { accessKeyId: rc.roleCredentials.accessKeyId, secretAccessKey: rc.roleCredentials.secretAccessKey, sessionToken: rc.roleCredentials.sessionToken };
    } catch { continue; }
    const { clusters } = await discoverClusters({ credentials: creds, account: acct.accountId, accountName: acct.accountName });
    // remember which SSO account/role each cluster came from, for import time.
    all.push(...clusters.map((c) => ({ ...c, roleName: role.roleName })));
  }
  return { clusters: all, accounts: accounts.length };
}

// ---- kubeconfig writing (native, no `aws` binary) -----------------------
function loadKube() {
  const p = kubeconfigPath();
  let doc = { apiVersion: 'v1', kind: 'Config', clusters: [], users: [], contexts: [], 'current-context': '' };
  if (fs.existsSync(p)) { try { doc = yaml.load(fs.readFileSync(p, 'utf8')) || doc; } catch { /* keep default */ } }
  doc.clusters = doc.clusters || []; doc.users = doc.users || []; doc.contexts = doc.contexts || [];
  return { p, doc };
}
function upsert(arr, name, entry) {
  const i = arr.findIndex((x) => x.name === name);
  if (i >= 0) arr[i] = entry; else arr.push(entry);
}

// Write a cluster/user/context for one EKS cluster. `credsRef` is either
// { profile } (access-key / role saved as a profile) or nothing (helper falls
// back to the ambient environment / instance role).
export async function writeCluster({ credentials, region, name, alias, profile }) {
  const eks = new EKSClient({ region, credentials });
  const d = await eks.send(new DescribeClusterCommand({ name }));
  const c = d.cluster;
  const server = c.endpoint;
  const caData = c.certificateAuthority?.data;
  const ctxName = alias || name;

  const { p, doc } = loadKube();
  upsert(doc.clusters, ctxName, { name: ctxName, cluster: { server, 'certificate-authority-data': caData } });
  upsert(doc.users, ctxName, {
    name: ctxName,
    user: {
      exec: {
        apiVersion: 'client.authentication.k8s.io/v1beta1',
        command: process.execPath, // node
        args: [EKS_TOKEN_HELPER, '--cluster', name, '--region', region, ...(profile ? ['--profile', profile] : [])],
        interactiveMode: 'Never',
        provideClusterInfo: false,
      },
    },
  });
  upsert(doc.contexts, ctxName, { name: ctxName, context: { cluster: ctxName, user: ctxName } });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, yaml.dump(doc), 'utf8');
  return ctxName;
}

// Persist static credentials as an ~/.aws profile so eks-token.js can read them
// at runtime (for access-key / assume-role sign-ins).
export function saveProfile(name, { accessKeyId, secretAccessKey, sessionToken, roleArn, sourceProfile, sessionName, region }) {
  const dir = awsDir();
  fs.mkdirSync(dir, { recursive: true });
  const credFile = path.join(dir, 'credentials');
  const cfgFile = path.join(dir, 'config');
  const setBlock = (file, header, lines) => {
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const re = new RegExp(`\\[${header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\][^\\[]*`, 'm');
    const block = `[${header}]\n${lines.filter(Boolean).join('\n')}\n`;
    text = re.test(text) ? text.replace(re, block) : (text.trim() ? `${text.trim()}\n\n${block}` : block);
    fs.writeFileSync(file, text, 'utf8');
  };
  if (accessKeyId) {
    setBlock(credFile, name, [`aws_access_key_id = ${accessKeyId}`, `aws_secret_access_key = ${secretAccessKey}`, sessionToken ? `aws_session_token = ${sessionToken}` : '']);
  }
  const cfgLines = [];
  if (roleArn) { cfgLines.push(`role_arn = ${roleArn}`); cfgLines.push(`source_profile = ${sourceProfile}`); if (sessionName) cfgLines.push(`role_session_name = ${sessionName}`); }
  if (region) cfgLines.push(`region = ${region}`);
  if (cfgLines.length) setBlock(cfgFile, name === 'default' ? 'default' : `profile ${name}`, cfgLines);
  return name;
}
