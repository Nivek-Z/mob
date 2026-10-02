import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { clearIdentityKeyCache, requireIdentity, requireWriteOrigin } from '../src/auth';
import type { Env } from '../src/types';
let privateKey: CryptoKey;
let jwk: Record<string, unknown>;
const env = {
  ACCESS_TEAM_DOMAIN: 'mob-test.cloudflareaccess.com', ACCESS_AUD: 'mob-audience',
  ADMIN_EMAILS: 'owner@example.com', SITE_ORIGIN: 'https://blog.example.com', APP_ENV: 'production',
} as Env;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
});
beforeEach(() => {
  clearIdentityKeyCache();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { vi.unstubAllGlobals(); });
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ email: 'owner@example.com', type: 'app', sub: 'owner-id', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, aud: 'mob-audience', iss: 'https://mob-test.cloudflareaccess.com', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
}
function request(jwt?: string, extra: Record<string, string> = {}) {
  return new Request('https://blog.example.com/api/admin/session', { headers: { ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}), ...extra } });
}
describe('Access identity verification', () => {
  it('accepts a signed, unexpired, allowed identity', async () => {
    await expect(requireIdentity(request(await token()), env)).resolves.toEqual({ email: 'owner@example.com', subject: 'owner-id' });
  });
  it('does not trust an unsigned email header', async () => {
    await expect(requireIdentity(request(undefined, { 'cf-access-authenticated-user-email': 'owner@example.com' }), env)).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { aud: 'another-application' }, { iss: 'https://another.cloudflareaccess.com' },
    { exp: Math.floor(Date.now() / 1000) - 100 }, { nbf: Math.floor(Date.now() / 1000) + 600 },
    { sub: undefined }, { email: undefined },
  ])('rejects invalid claims %j', async (claims) => {
    await expect(requireIdentity(request(await token(claims)), env)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a signed user outside the administrator list', async () => {
    await expect(requireIdentity(request(await token({ email: 'reader@example.com' })), env)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects service tokens as administrator identities', async () => {
    await expect(requireIdentity(request(await token({ type: 'service' })), env)).rejects.toMatchObject({ status: 403 });
  });
  it('normalizes a verified email and an explicit allowlist', async () => {
    await expect(requireIdentity(request(await token({ email: 'OWNER@EXAMPLE.COM' })), { ...env, ADMIN_EMAILS: ' owner@example.com, second@example.com ' })).resolves.toMatchObject({ email: 'owner@example.com' });
  });
  it('rejects a modified signed token', async () => {
    const jwt = await token();
    const parts = jwt.split('.');
    parts[1] = btoa(JSON.stringify({ email: 'owner@example.com', sub: 'x', aud: 'mob-audience' })).replaceAll('=', '');
    await expect(requireIdentity(request(parts.join('.')), env)).rejects.toMatchObject({ status: 401 });
  });
  it('fails closed when production authentication is unconfigured', async () => {
    await expect(requireIdentity(request(), { ...env, ACCESS_AUD: 'replace-with-access-aud' })).rejects.toMatchObject({ status: 503 });
  });
  it('allows explicit development credentials only on a loopback origin', async () => {
    const development = { ...env, APP_ENV: 'development', DEV_AUTH_TOKEN: 'dev-only-key' };
    const local = new Request('http://localhost:8787/api/admin/session', { headers: { Authorization: 'Bearer dev-only-key' } });
    await expect(requireIdentity(local, development)).resolves.toMatchObject({ subject: 'local-development' });
    await expect(requireIdentity(request(undefined, { Authorization: 'Bearer dev-only-key' }), development)).rejects.toMatchObject({ status: 401 });
    await expect(requireIdentity(local, { ...development, APP_ENV: 'production' })).rejects.toMatchObject({ status: 401 });
  });
});
describe('write CSRF protection', () => {
  it('accepts same-origin writes', () => {
    expect(() => requireWriteOrigin(new Request('https://blog.example.com/api/admin/posts/test', { headers: { Origin: env.SITE_ORIGIN } }), env)).not.toThrow();
  });
  it.each([undefined, 'https://evil.example', 'https://blog.example.com.evil.example', 'null'])('rejects missing or foreign origin %s', (origin) => {
    expect(() => requireWriteOrigin(new Request('https://blog.example.com/api/admin/posts/test', { headers: origin ? { Origin: origin } : {} }), env)).toThrow();
  });
});
