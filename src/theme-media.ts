import { ApiError, readBytes } from './http';
import { registry, themePath } from './themes';
import type { Env } from './types';

/** Deployment bundles are seeds only. Public decorative media is read from R2. */
export async function themeMedia(request: Request, env: Env, themeId: string, filename: string): Promise<Response> {
  const origin = new URL(request.url).origin;
  const registrationResponse = await env.ASSETS.fetch(new Request(origin + '/themes.json'));
  if (!registrationResponse.ok) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Theme media not found.');
  const theme = registry(await registrationResponse.json()).themes.find(theme => theme.id === themeId);
  if (!theme) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Theme media not found.');
  const declarationResponse = await env.ASSETS.fetch(new Request(origin + `/${theme.root}/theme.json`));
  const declaration = await declarationResponse.json() as { bundledMedia?: { filename: string; path: string; sha256: string; contentType: string }[] };
  const asset = declaration.bundledMedia?.find(asset => asset.filename === filename);
  if (!asset || !themePath(asset.path) || !asset.path.startsWith('assets/images/') || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^image\/(jpeg|png|gif|webp|avif)$/.test(asset.contentType)) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Theme media not found.');
  const key = `theme-media/${theme.id}/${asset.sha256}/${filename}`;
  let stored = await env.MEDIA.get(key);
  if (!stored) {
    const seed = await env.ASSETS.fetch(new Request(origin + `/${theme.root}/${asset.path}`));
    if (!seed.ok || !seed.body) throw new ApiError(503, 'THEME_MEDIA_MISSING', 'The theme media seed is unavailable.');
    const bytes = await readBytes(new Request(origin, { method: 'POST', body: seed.body }), 16 * 1024 * 1024);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== asset.sha256) throw new ApiError(503, 'THEME_MEDIA_MISMATCH', 'The deployed seed does not match the theme declaration.');
    await env.MEDIA.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: asset.contentType } });
    stored = await env.MEDIA.get(key);
  }
  if (!stored) throw new ApiError(503, 'MEDIA_STORAGE_ERROR', 'The theme media could not be stored.');
  const headers = new Headers({ 'Content-Type': asset.contentType, 'Cache-Control': 'public, max-age=3600', 'ETag': stored.httpEtag, 'Content-Length': String(stored.size) });
  if (request.headers.get('If-None-Match') === stored.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : stored.body, { headers });
}
