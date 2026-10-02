import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The production infrastructure CLI intentionally uses native JavaScript without TypeScript declarations.
import { makePlan, synchronize } from '../scripts/cloudflare-sync.mjs';

const accountId = 'a'.repeat(32); const aud = 'd'.repeat(64); const tag = 'b'.repeat(32);
const tokenId = '12345678-1234-4234-8234-123456789abc';
const connectionId = '12345678-1234-4234-8234-123456789abd'; const appId = '12345678-1234-4234-8234-123456789abe'; const policyId = '12345678-1234-4234-8234-123456789abf'; const triggerId = '12345678-1234-4234-8234-123456789ab0';
function configuration() {
  return {
    config: { schemaVersion: 1, accountId, access: { enabled: true, name: 'mob-admin', sessionDuration: '8h', paths: ['/admin', '/admin/*', '/api/admin', '/api/admin/*'] }, builds: { enabled: true, triggerName: 'mob-main', buildCommand: 'npm run check && npm test', deployCommand: 'npm run deploy', rootDirectory: '/', branchIncludes: ['main'], branchExcludes: [], pathIncludes: ['*'], pathExcludes: [], buildTokenUuid: '' } },
    wrangler: { name: 'mob', r2_buckets: [{ binding: 'MEDIA', bucket_name: 'mob-media' }], vars: { SITE_ORIGIN: 'https://blog.real-domain.dev', ADMIN_EMAILS: 'owner@real-domain.dev', ACCESS_TEAM_DOMAIN: 'my-team.cloudflareaccess.com', ACCESS_AUD: 'replace-with-access-aud', GITHUB_OWNER: 'owner', GITHUB_REPO: 'mob' } },
    mob: { schemaVersion: 1, frontend: { mode: 'auto', installCommand: ['npm', 'ci'], buildCommand: ['npm', 'run', 'build'], outputDirectory: 'dist' } },
  };
}
function fixture(options: { publicManaged?: boolean; publicCustom?: boolean; noWorker?: boolean; tokenCount?: number; existingWrongHost?: boolean; managedOnOtherHost?: boolean; appUnauthorized?: boolean } = {}) {
  const cfg = configuration();
  let app: Record<string, any> | null = options.existingWrongHost || options.managedOnOtherHost ? { id: appId, name: 'mob-admin', type: 'self_hosted', domain: 'other.real-domain.dev/admin', destinations: [{ type: 'public', uri: 'other.real-domain.dev/admin', overrides: [] }] } : null;
  let policies: Record<string, any>[] = options.managedOnOtherHost ? [{ id: policyId, name: 'mob-admin-emails', decision: 'allow', precedence: 1, include: [{ email: { email: 'old@real-domain.dev' } }], exclude: [], require: [] }] : [];
  let trigger: Record<string, any> | null = null;
  const connection = { repo_connection_uuid: connectionId, provider_type: 'github', provider_account_id: '1', provider_account_name: 'owner', repo_id: '2', repo_name: 'mob' };
  const writes: any[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const endpoint = url.pathname.split(`/accounts/${accountId}`)[1]; const method = init?.method ?? 'GET';
    const payload = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.hostname === 'api.github.com') return new Response(JSON.stringify(url.pathname.startsWith('/users/') ? { id: 1 } : { id: 2, full_name: 'owner/mob', owner: { id: 1 } }), { status: 200 });
    let result: any;
    if (method !== 'GET') writes.push({ endpoint, method, payload });
    if (endpoint === '/workers/scripts') result = options.noWorker ? [] : [{ id: 'mob', tag }];
    else if (endpoint === '/builds/tokens') result = Array.from({ length: options.tokenCount ?? 1 }, (_, index) => ({ build_token_uuid: index ? appId : tokenId, build_token_name: index ? 'other-build-token' : 'BLOG自用' }));
    else if (endpoint === `/builds/workers/${tag}/triggers`) result = trigger ? [trigger] : [];
    else if (endpoint?.endsWith('/config_autofill')) { if (options.appUnauthorized) return new Response(JSON.stringify({ success: false, errors: [{ message: 'TOP_SECRET' }] }), { status: 403 }); result = {}; }
    else if (endpoint === '/builds/repos/connections') result = connection;
    else if (endpoint === '/builds/triggers') { trigger = { ...payload, trigger_uuid: triggerId, repo_connection: connection }; result = trigger; }
    else if (endpoint === `/builds/triggers/${triggerId}`) { trigger = { ...trigger, ...payload }; result = trigger; }
    else if (endpoint === '/r2/buckets/mob-media') result = { name: 'mob-media' };
    else if (endpoint === '/r2/buckets/mob-media/domains/managed') result = { enabled: options.publicManaged ?? false };
    else if (endpoint === '/r2/buckets/mob-media/domains/custom') result = { domains: options.publicCustom ? [{ domain: 'media.real-domain.dev', enabled: true }] : [] };
    else if (endpoint === '/access/apps' && method === 'GET') result = app ? [app] : [];
    else if (endpoint === `/access/apps/${appId}/policies`) result = policies;
    else if (endpoint === '/access/apps' || endpoint === `/access/apps/${appId}`) { app = { ...payload, id: appId, aud }; policies = payload.policies.map((policy: any) => ({ ...policy, id: policyId })); result = app; }
    else throw new Error('Unexpected mock endpoint ' + method + ' ' + endpoint);
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  });
  return { ...cfg, writes, fetcher, environment: { CLOUDFLARE_API_TOKEN: 'TOP_SECRET' }, log: vi.fn(), writeWrangler: vi.fn(async (_value: unknown) => {}) };
}

describe('Declarative Cloudflare synchronization', () => {
  it('dry runs locally without credentials, network access, or mutation', async () => {
    const f = fixture(); f.config.accountId = 'replace-with-account-id'; f.wrangler.vars.SITE_ORIGIN = 'https://blog.example.com';
    const result = await synchronize({ ...f, environment: {} });
    expect(result.applied).toBe(false); expect(result.plan.missing).toHaveLength(2);
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.writeWrangler).not.toHaveBeenCalled();
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('TOP_SECRET');
  });
  it('rejects placeholders before remote calls, even when apply credentials are supplied', async () => {
    const f = fixture(); f.wrangler.vars.ADMIN_EMAILS = 'replace@example.com';
    await expect(synchronize({ ...f, apply: true })).rejects.toMatchObject({ code: 'CONFIGURATION_REQUIRED' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects unsafe frontend paths and overly broad admin authorization declarations', () => {
    const f = fixture(); f.mob.frontend.outputDirectory = '../content'; expect(() => makePlan(f.config, f.wrangler, f.mob)).toThrow();
    const g = fixture(); g.config.access.paths = ['/*']; expect(() => makePlan(g.config, g.wrangler, g.mob)).toThrow();
    const h = fixture(); h.wrangler.vars.ADMIN_EMAILS = '*@real-domain.dev'; expect(makePlan(h.config, h.wrangler, h.mob).missing).toContain('wrangler.vars.ADMIN_EMAILS (exact administrator email addresses)');
  });
  it('creates exactly scoped Access and Builds declarations and becomes idempotent', async () => {
    const f = fixture(); const first = await synchronize({ ...f, apply: true });
    expect(first.applied).toBe(true); expect(first.accessAudience).toBe(aud); expect(first.updatedWrangler.vars.ACCESS_AUD).toBe(aud); expect(first.updatedWrangler.account_id).toBe(accountId);
    const appWrite = f.writes.find((entry) => entry.endpoint === '/access/apps');
    expect(appWrite.payload.destinations.map((destination: any) => destination.uri)).toEqual(['blog.real-domain.dev/admin', 'blog.real-domain.dev/admin/*', 'blog.real-domain.dev/api/admin', 'blog.real-domain.dev/api/admin/*']);
    expect(appWrite.payload.policies[0].include).toEqual([{ email: { email: 'owner@real-domain.dev' } }]);
    const buildWrite = f.writes.find((entry) => entry.endpoint === '/builds/triggers');
    expect(buildWrite.payload).toMatchObject({ external_script_id: tag, repo_connection_uuid: connectionId, build_token_uuid: tokenId, build_command: 'npm run check && npm test', deploy_command: 'npm run deploy', branch_includes: ['main'], path_includes: ['*'] });
    f.writes.length = 0;
    const second = await synchronize({ ...f, wrangler: first.updatedWrangler, apply: true });
    expect(second.actions).toEqual([]); expect(second.wranglerChanged).toBe(false); expect(f.writes).toEqual([]);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('TOP_SECRET');
  });
  it('disables the declared trigger without deleting it and can reactivate it idempotently', async () => {
    const f = fixture(); const active = await synchronize({ ...f, apply: true }); f.writes.length = 0;
    f.config.builds.enabled = false;
    const disabled = await synchronize({ ...f, wrangler: active.updatedWrangler, apply: true });
    expect(disabled.actions).toEqual(['disable Builds trigger']);
    expect(f.writes).toEqual([{ endpoint: `/builds/triggers/${triggerId}`, method: 'PATCH', payload: { branch_includes: [], branch_excludes: ['*'] } }]);
    f.writes.length = 0;
    expect((await synchronize({ ...f, wrangler: active.updatedWrangler, apply: true })).actions).toEqual([]); expect(f.writes).toEqual([]);
    f.config.builds.enabled = true;
    expect((await synchronize({ ...f, wrangler: active.updatedWrangler, apply: true })).actions).toEqual(['update Builds trigger']);
    expect(f.writes.every((entry) => entry.method !== 'DELETE')).toBe(true);
  });
  it('allows Builds to remain disabled before the Worker is created without requiring a build token', async () => {
    const f = fixture({ noWorker: true, tokenCount: 0 }); f.config.builds.enabled = false;
    expect((await synchronize({ ...f, apply: true })).applied).toBe(true);
    expect(f.fetcher.mock.calls.every(([url]) => !String(url).includes('/builds/tokens') && !String(url).includes('api.github.com'))).toBe(true);
  });
  it('prefers the external private-repository bootstrap token without logging either credential', async () => {
    const f = fixture();
    await synchronize({ ...f, apply: true, environment: { ...f.environment, GITHUB_BOOTSTRAP_TOKEN: 'BOOTSTRAP_SECRET', GITHUB_TOKEN: 'RUNTIME_SECRET' } });
    const githubCalls = f.fetcher.mock.calls.filter(([url]) => String(url).includes('api.github.com'));
    expect(githubCalls).toHaveLength(2);
    for (const [, init] of githubCalls) expect(init?.headers).toMatchObject({ Authorization: 'Bearer BOOTSTRAP_SECRET' });
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('BOOTSTRAP_SECRET'); expect(JSON.stringify(f.log.mock.calls)).not.toContain('RUNTIME_SECRET');
  });
  it('supports initial resources-only setup before a Worker or build token exists', async () => {
    const f = fixture({ noWorker: true, tokenCount: 0 });
    await expect(synchronize({ ...f, apply: true, resourcesOnly: true })).resolves.toMatchObject({ applied: true, accessAudience: aud });
    expect(f.fetcher.mock.calls.every(([url]) => !String(url).includes('/builds/') && !String(url).includes('/workers/scripts'))).toBe(true);
  });
  it('requires full Builds bootstrap conditions before mutating resources', async () => {
    for (const options of [{ noWorker: true }, { tokenCount: 0 }, { tokenCount: 2 }, { appUnauthorized: true }]) {
      const f = fixture(options);
      await expect(synchronize({ ...f, apply: true })).rejects.toBeInstanceOf(Error);
      expect(f.writes).toEqual([]);
    }
  });
  it('selects one build token by BUILDS_TOKEN_NAME when several exist', async () => {
    const f = fixture({ tokenCount: 2 });
    const result = await synchronize({ ...f, apply: true, environment: { ...f.environment, BUILDS_TOKEN_NAME: 'BLOG自用' } });
    expect(result.applied).toBe(true);
    expect(f.writes.find((entry) => entry.endpoint === '/builds/triggers').payload.build_token_uuid).toBe(tokenId);
  });
  it('does not guess a build token when the name is missing or ambiguous', async () => {
    const missing = fixture({ tokenCount: 2 });
    await expect(synchronize({ ...missing, apply: true, environment: { ...missing.environment, BUILDS_TOKEN_NAME: 'missing' } })).rejects.toMatchObject({ code: 'BUILD_TOKEN_REQUIRED' });
    expect(missing.writes).toEqual([]);
    const named = fixture({ tokenCount: 2 });
    named.config.builds.buildTokenUuid = appId;
    const chosen = await synchronize({ ...named, apply: true, environment: { ...named.environment, BUILDS_TOKEN_NAME: 'BLOG自用' } });
    expect(chosen.applied).toBe(true);
    expect(named.writes.find((entry) => entry.endpoint === '/builds/triggers').payload.build_token_uuid).toBe(appId);
  });
  it('refuses public managed or custom R2 access without automatically deleting anything', async () => {
    for (const options of [{ publicManaged: true }, { publicCustom: true }]) {
      const f = fixture(options);
      await expect(synchronize({ ...f, apply: true })).rejects.toMatchObject({ code: 'R2_PUBLIC_BUCKET' });
      expect(f.writes).toEqual([]);
    }
  });
  it('does not fail a connected build when GitHub autofill is rejected', async () => {
    const options: { appUnauthorized?: boolean } = {};
    const f = fixture(options);
    const first = await synchronize({ ...f, apply: true });
    options.appUnauthorized = true;
    f.writes.length = 0;
    const second = await synchronize({ ...f, wrangler: first.updatedWrangler, apply: true });
    expect(second.applied).toBe(true);
    expect(second.actions).toEqual([]);
  });
  it('does not claim or modify a similarly named Access application on another hostname', async () => {
    const f = fixture({ existingWrongHost: true });
    await expect(synchronize({ ...f, apply: true })).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_MISMATCH' }); expect(f.writes).toEqual([]);
  });
  it('retargets the managed Access application when the site hostname changes', async () => {
    const f = fixture({ managedOnOtherHost: true });
    const result = await synchronize({ ...f, apply: true });
    expect(result.actions).toContain('upsert Access application');
    const update = f.writes.find((entry) => entry.endpoint === `/access/apps/${appId}` && entry.method === 'PUT');
    expect(update.payload.domain).toBe('blog.real-domain.dev/admin');
    expect(update.payload.destinations.map((destination: any) => destination.uri)).toEqual(['blog.real-domain.dev/admin', 'blog.real-domain.dev/admin/*', 'blog.real-domain.dev/api/admin', 'blog.real-domain.dev/api/admin/*']);
    expect(f.writes.some((entry) => entry.method === 'DELETE')).toBe(false);
  });
  it('does not disclose upstream response bodies, authorization headers, or credentials', async () => {
    const f = fixture(); const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'TOP_SECRET private details' }] }), { status: 403 }));
    try { await synchronize({ ...f, fetcher, apply: true }); throw new Error('Expected failure'); }
    catch (error) { expect(String(error)).not.toContain('TOP_SECRET'); expect(String(error)).not.toContain('private details'); }
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('TOP_SECRET');
  });
});

it('reuses the sole owned dashboard trigger for cloud bootstrap without creating a duplicate', async () => {
  const f = fixture();
  await synchronize({ ...f, apply: true });
  f.config.builds.triggerName = 'mob-renamed';
  await synchronize({ ...f, environment: { ...f.environment, WORKERS_CI: '1' }, apply: true });
  expect(f.writes.filter(write => write.endpoint === '/builds/triggers' && write.method === 'POST')).toHaveLength(1);
  expect(f.writes.some(write => write.method === 'PATCH' && write.payload?.trigger_name === 'mob-renamed')).toBe(true);
});
