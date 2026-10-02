import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED_PATHS = ['/admin', '/admin/*', '/api/admin', '/api/admin/*'];
export class SyncError extends Error {
  constructor(code, message, status) { super(message); this.name = 'SyncError'; this.code = code; this.status = status; }
}
function fail(code, message) { throw new SyncError(code, message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CONFIG', label + ' must be an object.');
  return value;
}
function string(value, label, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail('INVALID_CONFIG', label + ' must be a non-empty string without control characters.');
  return value;
}
function strings(value, label, allowEmpty = true) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 100) fail('INVALID_CONFIG', label + ' must be an array of at most 100 strings.');
  return value.map((item) => string(item, label, 512));
}
function placeholder(value) { return typeof value !== 'string' || !value || /replace-with|^replace[.@-]|placeholder|example\.(com|net|org)|待定|[<>]/i.test(value); }
function assertKeys(value, keys, label) {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail('INVALID_CONFIG', label + ' contains unsupported fields. Keep secrets in environment variables.');
}
function validateFrontend(mob) {
  object(mob, 'mob.config.json'); if (mob.schemaVersion !== 1) fail('INVALID_CONFIG', 'mob.config.json requires schemaVersion: 1.');
  const frontend = object(mob.frontend, 'frontend');
  if (!['auto', 'raw', 'build'].includes(frontend.mode ?? 'auto')) fail('INVALID_CONFIG', 'frontend.mode must be auto, raw, or build.');
  for (const name of ['installCommand', 'buildCommand']) {
    const command = frontend[name];
    if (command === null || command === undefined) continue;
    strings(command, 'frontend.' + name, false);
  }
  const output = string(frontend.outputDirectory ?? 'dist', 'frontend.outputDirectory');
  if (path.posix.isAbsolute(output) || path.win32.isAbsolute(output) || output.split(/[\\/]/).includes('..')) fail('INVALID_CONFIG', 'Frontend output must stay inside frontend/.');
  return { mode: frontend.mode ?? 'auto', installCommand: frontend.installCommand ?? null, buildCommand: frontend.buildCommand ?? null, outputDirectory: output };
}

/** Produce a local declaration only. No credentials or remote access are needed. */
export function makePlan(config, wrangler, mob, { resourcesOnly = false } = {}) {
  object(config, 'config/cloudflare.json'); object(wrangler, 'wrangler.jsonc');
  assertKeys(config, ['schemaVersion', 'accountId', 'access', 'builds'], 'Cloudflare configuration');
  if (config.schemaVersion !== 1) fail('INVALID_CONFIG', 'Cloudflare configuration requires schemaVersion: 1.');
  const missing = [];
  if (typeof config.accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(config.accountId)) missing.push('config/cloudflare.json accountId (32-character Cloudflare account ID)');
  if (wrangler.account_id && wrangler.account_id !== config.accountId) fail('INVALID_CONFIG', 'wrangler.account_id disagrees with config/cloudflare.json accountId.');
  const workerName = string(wrangler.name, 'wrangler.name', 63);
  if (!/^[a-z0-9_-]+$/.test(workerName)) fail('INVALID_CONFIG', 'wrangler.name must be a valid Worker name.');
  const vars = object(wrangler.vars, 'wrangler.vars');
  let hostname = '';
  try {
    const origin = new URL(vars.SITE_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash || placeholder(origin.hostname)) throw new Error();
    hostname = origin.hostname;
  } catch { missing.push('wrangler.vars.SITE_ORIGIN (real HTTPS origin)'); }
  const access = object(config.access, 'Cloudflare access'); const builds = object(config.builds, 'Cloudflare builds');
  assertKeys(access, ['enabled', 'name', 'sessionDuration', 'paths'], 'Cloudflare access');
  assertKeys(builds, ['enabled', 'triggerName', 'buildCommand', 'deployCommand', 'rootDirectory', 'branchIncludes', 'branchExcludes', 'pathIncludes', 'pathExcludes', 'buildTokenUuid'], 'Cloudflare builds');
  if (access.enabled !== true) fail('INVALID_CONFIG', 'Access must remain enabled for the administration paths.');
  if (typeof builds.enabled !== 'boolean') fail('INVALID_CONFIG', 'builds.enabled must be a boolean.');
  const paths = strings(access.paths, 'access.paths', false);
  if (paths.some((item) => !/^\/(?:admin|api\/admin)(?:\/\*)?$/.test(item)) || REQUIRED_PATHS.some((item) => !paths.includes(item)) || new Set(paths).size !== paths.length) fail('INVALID_CONFIG', 'Access paths must cover exactly /admin, /admin/*, /api/admin, and /api/admin/*.');
  const emails = [...new Set(String(vars.ADMIN_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length || emails.some((email) => !/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email) || placeholder(email))) missing.push('wrangler.vars.ADMIN_EMAILS (exact administrator email addresses)');
  if (placeholder(vars.ACCESS_TEAM_DOMAIN) || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(vars.ACCESS_TEAM_DOMAIN ?? '')) missing.push('wrangler.vars.ACCESS_TEAM_DOMAIN (your Zero Trust team domain)');
  const sessionDuration = string(access.sessionDuration, 'access.sessionDuration', 32);
  if (!/^\d+(?:h|m|s)$/.test(sessionDuration)) fail('INVALID_CONFIG', 'access.sessionDuration must use h, m, or s.');
  const r2 = wrangler.r2_buckets;
  if (!Array.isArray(r2) || !r2.length || !r2.some((bucket) => bucket.binding === 'MEDIA')) fail('INVALID_CONFIG', 'wrangler.r2_buckets must bind a private MEDIA bucket.');
  const buckets = [...new Set(r2.map((bucket) => {
    object(bucket, 'R2 binding'); const name = string(bucket.bucket_name, 'R2 bucket_name', 63);
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) fail('INVALID_CONFIG', 'R2 bucket_name must contain 3 to 63 lowercase letters, digits, or hyphens.');
    if (bucket.jurisdiction) fail('INVALID_CONFIG', 'Cloudflare sync currently supports default-jurisdiction R2 buckets only.');
    return name;
  }))];
  const owner = string(vars.GITHUB_OWNER, 'GITHUB_OWNER', 100); const repo = string(vars.GITHUB_REPO, 'GITHUB_REPO', 100);
  if (![owner, repo].every((value) => /^[a-zA-Z0-9_.-]+$/.test(value) && value !== '.' && value !== '..')) fail('INVALID_CONFIG', 'Invalid configured GitHub repository.');
  let buildPlan = null;
  if (!resourcesOnly) {
    const rootDirectory = string(builds.rootDirectory, 'builds.rootDirectory', 512);
    if (!rootDirectory.startsWith('/') || rootDirectory.split('/').includes('..') || rootDirectory.includes('\\')) fail('INVALID_CONFIG', 'builds.rootDirectory must be an absolute repository directory without traversal.');
    if (builds.buildTokenUuid && !UUID.test(builds.buildTokenUuid)) fail('INVALID_CONFIG', 'builds.buildTokenUuid must be empty or a UUID.');
    buildPlan = { enabled: builds.enabled, triggerName: string(builds.triggerName, 'builds.triggerName', 128), buildCommand: string(builds.buildCommand, 'builds.buildCommand'), deployCommand: string(builds.deployCommand, 'builds.deployCommand'), rootDirectory, branchIncludes: strings(builds.branchIncludes, 'builds.branchIncludes', false), branchExcludes: strings(builds.branchExcludes, 'builds.branchExcludes'), pathIncludes: strings(builds.pathIncludes, 'builds.pathIncludes', false), pathExcludes: strings(builds.pathExcludes, 'builds.pathExcludes'), buildTokenUuid: builds.buildTokenUuid ?? '' };
  }
  return { accountId: config.accountId, workerName, repository: { owner, repo }, buckets, frontend: validateFrontend(mob), access: { name: string(access.name, 'access.name', 128), hostname, paths, emails, sessionDuration, teamDomain: vars.ACCESS_TEAM_DOMAIN }, builds: buildPlan, missing };
}

class CloudflareClient {
  constructor(accountId, token, fetcher) { this.base = `${API_BASE}/accounts/${accountId}`; this.token = token; this.fetcher = fetcher; }
  async request(endpoint, method = 'GET', body, allowMissing = false) {
    let response;
    try { response = await this.fetcher(this.base + endpoint, { method, headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
    catch { throw new SyncError('CLOUDFLARE_UNAVAILABLE', 'Cloudflare API is unavailable. No credentials or upstream details are logged.'); }
    if (allowMissing && response.status === 404) return null;
    let data;
    try { data = await response.json(); } catch { throw new SyncError('CLOUDFLARE_API_ERROR', `Cloudflare ${method} ${endpoint.split('?')[0]} returned an invalid response (HTTP ${response.status}).`, response.status); }
    if (!response.ok || data?.success !== true) throw new SyncError('CLOUDFLARE_API_ERROR', `Cloudflare ${method} ${endpoint.split('?')[0]} failed (HTTP ${response.status}). Check account permissions and bootstrap requirements.`, response.status);
    return data;
  }
  async get(endpoint, allowMissing = false) { const data = await this.request(endpoint, 'GET', undefined, allowMissing); return data?.result ?? null; }
  async list(endpoint, paginated = false) {
    const output = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.request(endpoint + (paginated ? `?page=${page}&per_page=100` : ''));
      if (!Array.isArray(data.result)) fail('CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare returned an unexpected resource list.');
      output.push(...data.result);
      const total = data.result_info?.total_pages ?? 1;
      if (!paginated || page >= total) return output;
    }
    fail('CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare resource list exceeded the supported pagination limit.');
  }
  async mutate(endpoint, method, body) { return (await this.request(endpoint, method, body)).result; }
}
async function githubJson(fetcher, environment, endpoint) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mob-cloudflare-sync' };
  const githubToken = environment.GITHUB_BOOTSTRAP_TOKEN || environment.GITHUB_TOKEN;
  if (githubToken) headers.Authorization = 'Bearer ' + githubToken;
  let response;
  try { response = await fetcher('https://api.github.com' + endpoint, { headers, signal: AbortSignal.timeout(20000) }); }
  catch { fail('GITHUB_UNAVAILABLE', 'GitHub repository metadata is unavailable.'); }
  if (!response.ok) fail('GITHUB_BOOTSTRAP_REQUIRED', `GitHub repository metadata is unavailable (HTTP ${response.status}). Private repositories require an external GITHUB_BOOTSTRAP_TOKEN with repository access; SSH credentials do not authorize REST API calls.`);
  try { return await response.json(); } catch { fail('GITHUB_INVALID_RESPONSE', 'GitHub returned invalid repository metadata.'); }
}
function matches(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => matches(actual[index], value));
  if (expected && typeof expected === 'object') return actual && typeof actual === 'object' && Object.keys(expected).every((key) => matches(actual[key], expected[key]));
  return actual === expected;
}
function publicHost(app) {
  const uris = Array.isArray(app.destinations) ? app.destinations.filter((item) => item.type === 'public').map((item) => item.uri) : [];
  if (app.domain) uris.push(app.domain);
  return [...new Set(uris.map((uri) => String(uri).replace(/^https?:\/\//, '').split('/')[0]))];
}
function policyFor(plan, id) {
  return { ...(id ? { id } : {}), name: plan.workerName + '-admin-emails', decision: 'allow', precedence: 1, include: plan.access.emails.map((email) => ({ email: { email } })), exclude: [], require: [] };
}
function appFor(plan, policy) {
  return { name: plan.access.name, type: 'self_hosted', domain: plan.access.hostname + '/admin', destinations: plan.access.paths.map((pathname) => ({ type: 'public', uri: plan.access.hostname + pathname, overrides: [] })), session_duration: plan.access.sessionDuration, app_launcher_visible: false, options_preflight_bypass: false, policies: [policy] };
}
function buildFor(plan, token) {
  const builds = plan.builds;
  return { trigger_name: builds.triggerName, build_token_uuid: token, build_command: builds.buildCommand, deploy_command: builds.deployCommand, root_directory: builds.rootDirectory, branch_includes: builds.branchIncludes, branch_excludes: builds.branchExcludes, path_includes: builds.pathIncludes, path_excludes: builds.pathExcludes };
}
async function preflightBuilds(client, plan, fetcher, environment) {
  if (!plan.builds) return null;
  if (!plan.builds.enabled) {
    const workers = await client.list('/workers/scripts');
    const worker = workers.find((item) => item.id === plan.workerName);
    if (!worker) return { enabled: false, existing: null };
    if (!worker.tag || !/^[a-f0-9]{32}$/i.test(worker.tag)) fail('CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare returned an invalid Worker tag.');
    const triggers = await client.list(`/builds/workers/${worker.tag}/triggers`);
    const matching = triggers.filter((item) => item.trigger_name === plan.builds.triggerName);
    if (matching.length > 1) fail('AMBIGUOUS_TRIGGER', 'Multiple Builds triggers share the configured name. Resolve this manually before syncing.');
    const existing = matching[0] ?? null;
    if (existing && (existing.external_script_id !== worker.tag || existing.repo_connection?.provider_type !== 'github' || String(existing.repo_connection.repo_name).toLowerCase() !== plan.repository.repo.toLowerCase() || String(existing.repo_connection.provider_account_name).toLowerCase() !== plan.repository.owner.toLowerCase())) fail('TRIGGER_OWNERSHIP_MISMATCH', 'The named Builds trigger belongs to another repository or Worker. Existing resources will not be modified.');
    return { enabled: false, worker, existing };
  }
  const [workers, tokens, ownerInfo, repoInfo] = await Promise.all([
    client.list('/workers/scripts'), client.list('/builds/tokens'),
    githubJson(fetcher, environment, `/users/${encodeURIComponent(plan.repository.owner)}`),
    githubJson(fetcher, environment, `/repos/${encodeURIComponent(plan.repository.owner)}/${encodeURIComponent(plan.repository.repo)}`),
  ]);
  const worker = workers.find((item) => item.id === plan.workerName);
  if (!worker?.tag || !/^[a-f0-9]{32}$/i.test(worker.tag)) fail('WORKER_BOOTSTRAP_REQUIRED', 'Deploy the Worker once before syncing Builds. Run --apply --resources-only, then npm run deploy, then --apply.');
  const token = plan.builds.buildTokenUuid ? tokens.find((item) => item.build_token_uuid === plan.builds.buildTokenUuid) : tokens.length === 1 ? tokens[0] : null;
  if (!token?.build_token_uuid || !UUID.test(token.build_token_uuid)) fail('BUILD_TOKEN_REQUIRED', 'Select or create a build deployment token once in Worker Settings > Builds > API token. If multiple tokens exist, set builds.buildTokenUuid explicitly.');
  if (!Number.isSafeInteger(ownerInfo.id) || !Number.isSafeInteger(repoInfo.id) || repoInfo.owner?.id !== ownerInfo.id || String(repoInfo.full_name).toLowerCase() !== `${plan.repository.owner}/${plan.repository.repo}`.toLowerCase()) fail('GITHUB_INVALID_RESPONSE', 'GitHub returned mismatched repository metadata.');
  const triggers = await client.list(`/builds/workers/${worker.tag}/triggers`);
  const matching = triggers.filter((item) => item.trigger_name === plan.builds.triggerName);
  if (matching.length > 1) fail('AMBIGUOUS_TRIGGER', 'Multiple Builds triggers share the configured name. Resolve this manually before syncing.');
  const existing = matching[0] ?? (environment.WORKERS_CI && triggers.length === 1 ? triggers[0] : null);
  if (existing && (existing.external_script_id !== worker.tag || existing.repo_connection?.provider_type !== 'github' || String(existing.repo_connection.repo_id) !== String(repoInfo.id) || String(existing.repo_connection.provider_account_id) !== String(ownerInfo.id))) fail('TRIGGER_OWNERSHIP_MISMATCH', 'The named Builds trigger belongs to another repository or Worker. Choose a different triggerName; existing resources will not be deleted.');
  if (!existing && triggers.length >= 2) fail('BUILDS_TRIGGER_LIMIT', 'This Worker already has two Builds triggers. Choose an existing matching trigger or adjust the dashboard manually.');
  // This supported read verifies that Cloudflare's GitHub App can access the repository before any mutation.
  try { await client.get(`/builds/repos/github/${ownerInfo.id}/${repoInfo.id}/config_autofill`); }
  catch (error) { throw new SyncError('GITHUB_APP_BOOTSTRAP_REQUIRED', `Authorize the Cloudflare GitHub App for this repository once via Worker Settings > Builds > Connect, and verify Builds API permissions (HTTP ${error.status ?? 'unavailable'}).`); }
  return { enabled: true, worker, token: token.build_token_uuid, ownerInfo, repoInfo, existing, triggers };
}
async function privateBucket(client, name, exists) {
  if (!exists) return;
  const [managed, custom] = await Promise.all([client.get(`/r2/buckets/${name}/domains/managed`), client.get(`/r2/buckets/${name}/domains/custom`)]);
  if (managed?.enabled === true) fail('R2_PUBLIC_BUCKET', 'R2 bucket ' + name + ' has public r2.dev access. Disable it manually before syncing; the bucket contains draft article caches.');
  if (managed?.enabled !== false || !Array.isArray(custom?.domains)) fail('R2_PRIVACY_UNVERIFIED', 'Cannot verify private access for R2 bucket ' + name + '.');
  if (custom.domains.some((domain) => domain.enabled !== false)) fail('R2_PUBLIC_BUCKET', 'R2 bucket ' + name + ' has a public custom domain. Disable public access manually before syncing; it contains draft article caches.');
}

/** Apply only explicitly owned resources; credentials remain outside configuration and output. */
export async function synchronize({ config, wrangler, mob, apply = false, resourcesOnly = false, fetcher = fetch, environment = process.env, log = console.log, writeWrangler } = {}) {
  const plan = makePlan(config, wrangler, mob, { resourcesOnly });
  log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...plan }, null, 2));
  if (!apply) return { plan, applied: false, actions: [] };
  if (plan.missing.length) fail('CONFIGURATION_REQUIRED', 'Fill all configuration placeholders before applying: ' + plan.missing.join('; '));
  if (!environment.CLOUDFLARE_API_TOKEN) fail('CLOUDFLARE_TOKEN_REQUIRED', 'Set an external user-scoped CLOUDFLARE_API_TOKEN. Do not put its value in repository files.');
  const client = new CloudflareClient(plan.accountId, environment.CLOUDFLARE_API_TOKEN, fetcher);
  const [builds, apps, bucketStates] = await Promise.all([
    preflightBuilds(client, plan, fetcher, environment), client.list('/access/apps', true),
    Promise.all(plan.buckets.map(async (name) => { const existing = await client.get(`/r2/buckets/${name}`, true); await privateBucket(client, name, existing !== null); return { name, existing }; })),
  ]);
  const matchingApps = apps.filter((app) => app.name === plan.access.name);
  if (matchingApps.length > 1) fail('AMBIGUOUS_ACCESS_APP', 'Multiple Access applications share the configured name. Resolve this manually.');
  let app = matchingApps[0] ?? null;
  if (app && app.type !== 'self_hosted') fail('ACCESS_OWNERSHIP_MISMATCH', 'The named Access application belongs to another hostname. Choose another access.name; existing resources will not be modified.');
  const policies = app ? await client.list(`/access/apps/${app.id}/policies`, true) : [];
  if (policies.length && (policies.length !== 1 || policies[0].name !== plan.workerName + '-admin-emails')) fail('ACCESS_POLICY_MISMATCH', 'The existing Access application has unmanaged policies. Resolve them manually or choose a new access.name.');
  const hosts = app ? publicHost(app) : [];
  // The managed email policy identifies an app this script created. A later hostname change retargets that same app; unrelated apps are left untouched.
  if (app && (hosts.length !== 1 || hosts[0] !== plan.access.hostname) && policies.length !== 1) fail('ACCESS_OWNERSHIP_MISMATCH', 'The named Access application belongs to another hostname. Choose another access.name; existing resources will not be modified.');
  const desiredPolicy = policyFor(plan, policies[0]?.id);
  const desiredApp = appFor(plan, desiredPolicy);
  const actions = [];
  // Establish the GitHub App connection first. Failure here leaves R2 and Access untouched.
  let connection = builds?.existing?.repo_connection;
  if (builds?.enabled && !connection?.repo_connection_uuid) {
    try { connection = await client.mutate('/builds/repos/connections', 'PUT', { provider_type: 'github', provider_account_id: String(builds.ownerInfo.id), provider_account_name: plan.repository.owner, repo_id: String(builds.repoInfo.id), repo_name: plan.repository.repo }); }
    catch (error) { throw new SyncError('GITHUB_APP_BOOTSTRAP_REQUIRED', `Cloudflare could not connect the repository. Authorize its GitHub App once and verify Builds permissions (HTTP ${error.status ?? 'unavailable'}).`); }
    if (!UUID.test(connection?.repo_connection_uuid ?? '')) fail('CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare returned an invalid repository connection ID.');
    actions.push('upsert GitHub repository connection');
  }
  for (const bucket of bucketStates) {
    if (!bucket.existing) { await client.mutate('/r2/buckets', 'POST', { name: bucket.name }); await privateBucket(client, bucket.name, true); actions.push('create private R2 bucket ' + bucket.name); }
  }
  const appComparable = app ? { ...app, destinations: (app.destinations ?? []).map((destination) => ({ ...destination, type: destination.type ?? 'public', overrides: destination.overrides ?? [] })), options_preflight_bypass: app.options_preflight_bypass ?? false, app_launcher_visible: app.app_launcher_visible ?? false, policies: policies.map((policy) => ({ ...policy, exclude: policy.exclude ?? [], require: policy.require ?? [] })) } : null;
  if (!app || !matches(appComparable, desiredApp)) {
    app = await client.mutate(app ? `/access/apps/${app.id}` : '/access/apps', app ? 'PUT' : 'POST', desiredApp);
    actions.push('upsert Access application');
  }
  if (typeof app?.aud !== 'string' || !/^[a-f0-9]{64}$/i.test(app.aud)) fail('CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare returned an invalid Access audience.');
  if (builds && !builds.enabled) {
    // Pause only the declared trigger. Empty includes plus wildcard exclusion matches no branch.
    const disabled = { branch_includes: [], branch_excludes: ['*'] };
    if (builds.existing && !matches(builds.existing, disabled)) {
      await client.mutate(`/builds/triggers/${builds.existing.trigger_uuid}`, 'PATCH', disabled);
      actions.push('disable Builds trigger');
    }
  } else if (builds) {
    const payload = buildFor(plan, builds.token);
    if (!builds.existing) {
      await client.mutate('/builds/triggers', 'POST', { external_script_id: builds.worker.tag, repo_connection_uuid: connection.repo_connection_uuid, ...payload });
      actions.push('create Builds trigger');
    } else if (!matches(builds.existing, payload)) {
      await client.mutate(`/builds/triggers/${builds.existing.trigger_uuid}`, 'PATCH', payload);
      actions.push('update Builds trigger');
    }
  }
  const updatedWrangler = { ...wrangler, account_id: plan.accountId, vars: { ...wrangler.vars, ACCESS_AUD: app.aud } };
  const wranglerChanged = wrangler.account_id !== plan.accountId || wrangler.vars.ACCESS_AUD !== app.aud;
  if (wranglerChanged && writeWrangler) await writeWrangler(updatedWrangler);
  log(JSON.stringify({ applied: true, actions, accessAudience: app.aud, wranglerChanged, nextStep: wranglerChanged ? 'Commit the non-secret wrangler.jsonc change and deploy it so Worker JWT validation uses this audience.' : 'Repository configuration is already in sync.' }, null, 2));
  return { plan, applied: true, actions, accessAudience: app.aud, updatedWrangler, wranglerChanged };
}
async function readJson(filename) {
  try { return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { fail('INVALID_CONFIG_FILE', 'Cannot read ' + path.basename(filename) + '. Use valid JSON (wrangler.jsonc currently uses JSON without comments).'); }
}
export async function main(args = process.argv.slice(2), { rootDirectory = DEFAULT_ROOT, fetcher = fetch, environment = process.env, log = console.log } = {}) {
  if (args.includes('--help')) { log('Usage: node scripts/cloudflare-sync.mjs [--dry-run | --apply] [--resources-only]\nDefault is a local dry run. --resources-only skips Builds for initial R2/Access setup.'); return; }
  if (args.some((arg) => !['--dry-run', '--apply', '--resources-only'].includes(arg)) || (args.includes('--dry-run') && args.includes('--apply'))) fail('INVALID_ARGUMENT', 'Use --dry-run or --apply, optionally with --resources-only.');
  const [config, wrangler, mob] = await Promise.all([readJson(path.join(rootDirectory, 'config/cloudflare.json')), readJson(path.join(rootDirectory, 'wrangler.jsonc')), readJson(path.join(rootDirectory, 'mob.config.json'))]);
  return synchronize({ config, wrangler, mob, apply: args.includes('--apply'), resourcesOnly: args.includes('--resources-only'), fetcher, environment, log, writeWrangler: (value) => writeFile(path.join(rootDirectory, 'wrangler.jsonc'), JSON.stringify(value, null, 2) + '\n', 'utf8') });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof SyncError ? `[${error.code}] ${error.message}` : '[LOCAL_ERROR] Synchronization stopped because of a local error. Check configuration and write access.'); process.exitCode = 1; });
}
