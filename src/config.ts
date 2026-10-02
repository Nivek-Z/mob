import { ApiError } from './http';
import type { Env } from './types';
export function siteOrigin(env: Env): string {
  try {
    const url = new URL(env.SITE_ORIGIN);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    if (env.APP_ENV !== 'development' && url.protocol !== 'https:') throw new Error();
    return url.origin;
  } catch { throw new ApiError(503, 'CONFIGURATION_REQUIRED', 'SITE_ORIGIN must be configured as the canonical site origin.'); }
}
export function adminEmails(env: Env): Set<string> {
  const emails = (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!emails.length || emails.some((s) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) || s.startsWith('replace@'))) throw new ApiError(503, 'CONFIGURATION_REQUIRED', 'Administrator emails must be configured.');
  return new Set(emails);
}
