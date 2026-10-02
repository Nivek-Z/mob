import { ApiError, json, object, readJson, requireId } from './http';
import { requireIdentity, requireWriteOrigin } from './auth';
import { siteOrigin } from './config';
import { GithubPosts, validateSavePostInput, validateSlug } from './posts';
import { MediaService } from './media';
import type { Env, Identity, Post, SavePostInput } from './types';
export interface AppServices {
  posts: (env: Env) => GithubPosts;
  media: (env: Env) => MediaService;
  authenticate: (request: Request, env: Env) => Promise<Identity>;
}
const defaults: AppServices = { posts: (env) => new GithubPosts(env), media: (env) => new MediaService(env), authenticate: requireIdentity };
const readMethods = ['GET', 'HEAD'];
function method(request: Request, allowed: string[]): void {
  if (!allowed.includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed methods: ' + allowed.join(', '), { allowed });
}
function publicPost(post: Post): Omit<Post, 'sha'> { const { sha: _, ...visible } = post; return visible; }
function metadata(post: Post): Omit<Post, 'markdown' | 'sha'> { const { markdown: _, sha: __, ...visible } = post; return visible; }
function integer(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new ApiError(400, 'INVALID_QUERY', 'Invalid pagination value.');
  return Number(value);
}
function filterPosts(posts: Post[], url: URL): { items: Omit<Post, 'markdown' | 'sha'>[]; total: number; limit: number; offset: number } {
  const limit = integer(url.searchParams.get('limit'), 20, 1, 100);
  const offset = integer(url.searchParams.get('offset'), 0, 0, 500);
  const tag = url.searchParams.get('tag');
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  if (query.length > 200) throw new ApiError(400, 'INVALID_QUERY', 'Search query is too long.');
  const visible = posts.filter((post) => post.status === 'published' && (!tag || post.tags.includes(tag)) && (!query || (post.title + '\n' + post.description + '\n' + post.markdown).toLowerCase().includes(query)));
  visible.sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt) || a.slug.localeCompare(b.slug));
  return { items: visible.slice(offset, offset + limit).map(metadata), total: visible.length, limit, offset };
}
function decodeFilename(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new ApiError(400, 'INVALID_MEDIA_URL', 'The media filename is not valid URL encoding.'); }
}
function managedMedia(input: SavePostInput, env: Env): { ids: string[]; filenames: Map<string, Set<string>> } {
  const origin = siteOrigin(env);
  const text = input.markdown + '\n' + (input.cover ?? '');
  if (/\/api\/admin\/media\/[0-9a-f-]+\/file/.test(text)) throw new ApiError(422, 'PRIVATE_PREVIEW_LINK', 'Use the stable media URL in article content, not the private preview URL.');
  const ids = new Set(input.mediaIds ?? []);
  const filenames = new Map<string, Set<string>>();
  const links = text.match(/https?:\/\/[^\s<>"')\]]+|\/media\/[^\s<>"')\]]+/g) ?? [];
  for (const link of links) {
    let url: URL;
    try { url = new URL(link, origin); } catch { continue; }
    if (url.origin !== origin || !url.pathname.startsWith('/media/')) continue;
    const match = /^\/media\/([0-9a-f-]{36})\/([^/]+)$/.exec(url.pathname);
    if (!match) throw new ApiError(422, 'INVALID_MEDIA_URL', 'Use the complete stable media URL returned by the upload API.');
    requireId(match[1]); ids.add(match[1]);
    const names = filenames.get(match[1]) ?? new Set<string>();
    names.add(decodeFilename(match[2])); filenames.set(match[1], names);
  }
  if (ids.size > 200) throw new ApiError(422, 'TOO_MANY_MEDIA_REFERENCES', 'An article may reference at most 200 managed media files.');
  return { ids: [...ids], filenames };
}
async function verifyMedia(references: ReturnType<typeof managedMedia>, media: MediaService): Promise<void> {
  for (let i = 0; i < references.ids.length; i += 5) {
    const ids = references.ids.slice(i, i + 5);
    const records = await Promise.all(ids.map((id) => media.getMedia(id)));
    for (let j = 0; j < records.length; j++) {
      const record = records[j];
      if (!record) throw new ApiError(422, 'MEDIA_NOT_READY', 'Complete all referenced media uploads before saving the article.');
      const names = references.filenames.get(ids[j]);
      if (names && [...names].some((name) => name !== record.filename)) throw new ApiError(422, 'INVALID_MEDIA_URL', 'The media filename must match the stable URL returned by the upload API.');
    }
  }
}
function needsCoordinator(path: string, verb: string): boolean {
  return /^\/api\/admin\/posts\/[^/]+$/.test(path) && ['PUT', 'DELETE'].includes(verb)
    || /^\/api\/admin\/media\/[^/]+$/.test(path) && verb === 'DELETE';
}
function decorate(response: Response, requestId: string, privateResponse: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  if (privateResponse) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export function createApp(overrides: Partial<AppServices> = {}, options: { coordinateMutations?: boolean } = {}) {
  const services = { ...defaults, ...overrides };
  return {
    async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
      const requestId = crypto.randomUUID();
      const url = new URL(request.url);
      const path = url.pathname;
      const admin = path === '/admin' || path.startsWith('/admin/') || path === '/api/admin' || path.startsWith('/api/admin/');
      try {
        let identity: Identity | undefined;
        if (admin) {
          identity = await services.authenticate(request, env);
          if (!readMethods.includes(request.method)) requireWriteOrigin(request, env);
        }
        if (options.coordinateMutations !== false && needsCoordinator(path, request.method)) {
          if (!env.MUTATIONS) throw new ApiError(503, 'COORDINATOR_NOT_CONFIGURED', 'The mutation coordinator is not configured.');
          const coordinator = env.MUTATIONS.get(env.MUTATIONS.idFromName('blog-writes'));
          return decorate(await coordinator.fetch(request), requestId, true);
        }
        if (path === '/api/health') { method(request, ['GET']); return decorate(json({ status: 'ok' }), requestId, false); }
        if (path === '/api/posts') {
          method(request, ['GET']);
          return decorate(json(filterPosts(await services.posts(env).listPosts(), url)), requestId, false);
        }
        let match = /^\/api\/posts\/([^/]+)$/.exec(path);
        if (match) {
          method(request, ['GET']); validateSlug(match[1]);
          const post = (await services.posts(env).listPosts()).find((item) => item.slug === match![1] && item.status === 'published');
          if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Article not found.');
          return decorate(json(publicPost(post)), requestId, false);
        }
        match = /^\/media\/([^/]+)\/([^/]+)$/.exec(path);
        if (match) {
          method(request, readMethods); requireId(match[1]);
          const record = await services.media(env).getMedia(match[1]);
          if (!record || record.filename !== decodeFilename(match[2])) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found.');
          const published = (await services.posts(env).listPosts()).some((post) => post.status === 'published' && post.mediaIds.includes(match![1]));
          if (!published) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found.');
          return decorate(await services.media(env).readMedia(match[1], request), requestId, true);
        }
        if (path === '/api/admin/session') { method(request, ['GET']); return decorate(json(identity!), requestId, true); }
        if (path === '/api/admin/posts') {
          method(request, ['GET']);
          const posts = await services.posts(env).listPosts(true);
          return decorate(json({ items: posts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }), requestId, true);
        }
        match = /^\/api\/admin\/posts\/([^/]+)$/.exec(path);
        if (match) {
          method(request, ['GET', 'PUT', 'DELETE']); validateSlug(match[1]);
          const posts = services.posts(env);
          if (request.method === 'GET') {
            const post = await posts.getPost(match[1]);
            if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Article not found.');
            return decorate(json(post), requestId, true);
          }
          if (request.method === 'DELETE') {
            const input = object(await readJson(request));
            if (Object.keys(input).some((key) => key !== 'sha') || typeof input.sha !== 'string') throw new ApiError(400, 'INVALID_INPUT', 'The current article sha is required.');
            return decorate(json(await posts.deletePost(match[1], input.sha)), requestId, true);
          }
          const input = validateSavePostInput(await readJson(request));
          const references = managedMedia(input, env);
          input.mediaIds = references.ids;
          await verifyMedia(references, services.media(env));
          return decorate(json(await posts.savePost(match[1], input), input.sha === null ? 201 : 200), requestId, true);
        }
        const media = services.media(env);
        if (path === '/api/admin/uploads') {
          method(request, ['POST']);
          return decorate(json(await media.createUpload(object(await readJson(request)) as unknown as { filename: string; contentType: string; size: number }, identity!), 201), requestId, true);
        }
        match = /^\/api\/admin\/uploads\/([^/]+)$/.exec(path);
        if (match) {
          method(request, ['GET', 'DELETE']); requireId(match[1]);
          if (request.method === 'GET') return decorate(json(await media.getUpload(match[1], identity!)), requestId, true);
          await media.abortUpload(match[1], identity!);
          return decorate(json({ aborted: true }), requestId, true);
        }
        match = /^\/api\/admin\/uploads\/([^/]+)\/body$/.exec(path);
        if (match) { method(request, ['PUT']); requireId(match[1]); return decorate(json(await media.uploadSingle(match[1], request, identity!)), requestId, true); }
        match = /^\/api\/admin\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(path);
        if (match) { method(request, ['PUT']); requireId(match[1]); return decorate(json(await media.uploadPart(match[1], Number(match[2]), request, identity!)), requestId, true); }
        match = /^\/api\/admin\/uploads\/([^/]+)\/complete$/.exec(path);
        if (match) {
          method(request, ['POST']); requireId(match[1]);
          const input = object(await readJson(request));
          if (Object.keys(input).length) throw new ApiError(400, 'INVALID_INPUT', 'Completion body must be an empty object.');
          return decorate(json(await media.completeUpload(match[1], identity!)), requestId, true);
        }
        if (path === '/api/admin/media') { method(request, ['GET']); return decorate(json(await media.listMedia(url.searchParams.get('cursor') ?? undefined)), requestId, true); }
        match = /^\/api\/admin\/media\/([^/]+)\/file$/.exec(path);
        if (match) { method(request, readMethods); requireId(match[1]); return decorate(await media.readMedia(match[1], request), requestId, true); }
        match = /^\/api\/admin\/media\/([^/]+)$/.exec(path);
        if (match) {
          method(request, ['DELETE']); requireId(match[1]);
          const references = (await services.posts(env).listPosts(true)).filter((post) => post.mediaIds.includes(match![1])).map((post) => post.slug);
          if (references.length) throw new ApiError(409, 'MEDIA_IN_USE', 'Remove this media from all articles before deleting it.', { articles: references });
          await media.deleteMedia(match[1]);
          return decorate(json({ deleted: true }), requestId, true);
        }
        if (path === '/api' || path.startsWith('/api/') || path === '/media' || path.startsWith('/media/')) throw new ApiError(404, 'NOT_FOUND', 'API route not found.');
        method(request, readMethods);
        if (!env.ASSETS) throw new ApiError(404, 'FRONTEND_NOT_INSTALLED', 'Place frontend files in frontend/ and deploy.');
        const asset = await env.ASSETS.fetch(request);
        return decorate(request.method === 'HEAD' ? new Response(null, asset) : asset, requestId, admin);
      } catch (error) {
        const known = error instanceof ApiError;
        const status = known ? error.status : 500;
        if (!known) console.error(JSON.stringify({ requestId, code: 'INTERNAL_ERROR', name: error instanceof Error ? error.name : 'UnknownError' }));
        const payload = { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'An internal error occurred.', ...(known && error.details !== undefined ? { details: error.details } : {}) }, requestId };
        const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
        if (known && status === 405) headers.Allow = ((error.details as { allowed?: string[] })?.allowed ?? []).join(', ');
        return decorate(new Response(request.method === 'HEAD' ? null : JSON.stringify(payload), { status, headers }), requestId, true);
      }
    }
  };
}
export { BlogMutations } from './coordinator';
export default createApp();
