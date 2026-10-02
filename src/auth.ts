import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError } from './http';
import { adminEmails, siteOrigin } from './config';
import type { Env, Identity } from './types';
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export function clearIdentityKeyCache(): void { keySets.clear(); }
export async function requireIdentity(request: Request, env: Env): Promise<Identity> {
  const url = new URL(request.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (local && env.APP_ENV === 'development' && env.DEV_AUTH_TOKEN && request.headers.get('authorization') === 'Bearer ' + env.DEV_AUTH_TOKEN) {
    const email = [...adminEmails(env)][0];
    return { email, subject: 'local-development' };
  }
  const domain = env.ACCESS_TEAM_DOMAIN ?? '';
  const audience = (env.ACCESS_AUD ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || domain.startsWith('replace.') || !audience.length || audience.some((value) => value.startsWith('replace-'))) throw new ApiError(503, 'CONFIGURATION_REQUIRED', 'Cloudflare Access must be configured before using the management API.');
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 16384) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in through Cloudflare Access.');
  const issuer = 'https://' + domain;
  let keys = keySets.get(issuer);
  if (!keys) { keys = createRemoteJWKSet(new URL(issuer + '/cdn-cgi/access/certs'), { timeoutDuration: 5000, cooldownDuration: 30000 }); keySets.set(issuer, keys); }
  let payload;
  try { ({ payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email'] })); }
  catch { throw new ApiError(401, 'INVALID_SESSION', 'The login session is invalid or expired. Sign in again.'); }
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub || !adminEmails(env).has(email)) throw new ApiError(403, 'FORBIDDEN', 'This account is not permitted to manage the blog.');
  return { email, subject: payload.sub };
}
export function requireWriteOrigin(request: Request, env: Env): void {
  if (request.headers.get('origin') !== siteOrigin(env) || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'ORIGIN_REJECTED', 'Management writes must originate from the configured site.');
}
