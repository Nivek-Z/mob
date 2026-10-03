import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import type { SettingsService } from '../src/settings';
import type { GalleryService } from '../src/gallery';
import { ApiError } from '../src/http';
import type { Env, Post } from '../src/types';
import type { GithubPosts } from '../src/posts';
import type { MediaService } from '../src/media';
const id = '11111111-1111-4111-8111-111111111111';
const origin = 'https://blog.example.com';
const env = { SITE_ORIGIN: origin, APP_ENV: 'production', ASSETS: { fetch: vi.fn(async () => new Response('frontend')) } } as unknown as Env;
function post(slug: string, status: 'draft' | 'published'): Post {
  return { slug, status, sha: 'a'.repeat(40), title: slug, markdown: '正文', description: '', tags: ['tag'], createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', publishedAt: status === 'published' ? '2026-10-02T00:00:00.000Z' : null, mediaIds: [id], cover: null };
}
function setup(items: Post[] = [post('public', 'published'), post('private', 'draft')]) {
  const posts = {
    listPosts: vi.fn(async () => items), getPost: vi.fn(async (slug: string) => items.find((p) => p.slug === slug) ?? null),
    savePost: vi.fn(async (slug: string, input: Record<string, unknown>) => ({ post: { ...post(slug, 'draft'), ...input }, commitSha: 'b'.repeat(40) })),
    deletePost: vi.fn(async () => ({ commitSha: 'b'.repeat(40) })),
  };
  const media = {
    getMedia: vi.fn(async () => ({ id, filename: 'photo.png' })),
    readMedia: vi.fn(async () => new Response('image-bytes', { headers: { 'Content-Type': 'image/png' } })),
    deleteMedia: vi.fn(async () => {}),
  };
  const authenticate = vi.fn(async () => ({ email: 'owner@example.com', subject: 'owner-id' }));
  return { app: createApp({ settings: () => ({ usage: async () => [] }) as unknown as SettingsService, gallery: () => ({ grants: async () => false, document: async () => ({ items: [] }) }) as unknown as GalleryService, posts: () => posts as unknown as GithubPosts, media: () => media as unknown as MediaService, authenticate }, { coordinateMutations: false }), posts, media, authenticate };
}
function req(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Request(origin + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
describe('API visibility and authorization', () => {
  it('lists only published metadata, omitting draft body and GitHub SHA', async () => {
    const { app, authenticate } = setup();
    const response = await app.fetch(req('/api/posts'), env);
    const result = await response.json() as any;
    expect(result.data.total).toBe(1);
    expect(result.data.items[0]).toMatchObject({ slug: 'public' });
    expect(result.data.items[0].sha).toBeUndefined();
    expect(result.data.items[0].markdown).toBeUndefined();
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('returns 404 for an unpublished article', async () => {
    const { app } = setup();
    expect((await app.fetch(req('/api/posts/private'), env)).status).toBe(404);
  });
  it('exposes an authenticated draft with its editing SHA', async () => {
    const { app, authenticate } = setup();
    const response = await app.fetch(req('/api/admin/posts/private'), env);
    expect((await response.json() as any).data.sha).toBe('a'.repeat(40));
    expect(authenticate).toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('authenticates the static management frontend too', async () => {
    const { app, authenticate } = setup();
    authenticate.mockRejectedValue(new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in.'));
    expect((await app.fetch(req('/admin/index.html'), env)).status).toBe(401);
  });
  it('rejects a cross-origin save before touching GitHub', async () => {
    const { app, posts } = setup();
    const response = await app.fetch(req('/api/admin/posts/new', 'PUT', { sha: null, title: '标题', markdown: '正文', status: 'draft' }, { Origin: 'https://evil.example' }), env);
    expect(response.status).toBe(403);
    expect(posts.savePost).not.toHaveBeenCalled();
  });
  it('collects media references automatically and commits only completed uploads', async () => {
    const { app, posts, media } = setup();
    const markdown = '![图](' + origin + '/media/' + id + '/photo.png)';
    const response = await app.fetch(req('/api/admin/posts/new', 'PUT', { sha: null, title: '标题', markdown, status: 'published' }, { Origin: origin }), env);
    expect(response.status).toBe(201);
    expect(media.getMedia).toHaveBeenCalledWith(id);
    expect(posts.savePost.mock.calls[0][1].mediaIds).toEqual([id]);
  });
  it('does not save an article referencing an unfinished media upload', async () => {
    const { app, posts, media } = setup();
    media.getMedia.mockResolvedValue(null as any);
    expect((await app.fetch(req('/api/admin/posts/new', 'PUT', { sha: null, title: '标题', markdown: '正文', status: 'draft', mediaIds: [id] }, { Origin: origin }), env)).status).toBe(422);
    expect(posts.savePost).not.toHaveBeenCalled();
  });
  it('rejects private preview URLs in saved content', async () => {
    const { app } = setup();
    expect((await app.fetch(req('/api/admin/posts/new', 'PUT', { sha: null, title: '标题', markdown: '/api/admin/media/' + id + '/file', status: 'draft' }, { Origin: origin }), env)).status).toBe(422);
  });
  it('does not publish a media file referenced only by a draft', async () => {
    const { app, media } = setup([post('private', 'draft')]);
    expect((await app.fetch(req('/media/' + id + '/photo.png'), env)).status).toBe(404);
    expect(media.readMedia).not.toHaveBeenCalled();
  });
  it('allows media referenced by a published article', async () => {
    const { app } = setup();
    const response = await app.fetch(req('/media/' + id + '/photo.png'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rejects deleting media referenced by a draft or published article', async () => {
    const { app, media } = setup();
    const response = await app.fetch(req('/api/admin/media/' + id, 'DELETE', undefined, { Origin: origin }), env);
    expect(response.status).toBe(409);
    expect(media.deleteMedia).not.toHaveBeenCalled();
  });
  it('allows deleting unreferenced media', async () => {
    const { app, media } = setup([]);
    expect((await app.fetch(req('/api/admin/media/' + id, 'DELETE', undefined, { Origin: origin }), env)).status).toBe(200);
    expect(media.deleteMedia).toHaveBeenCalledWith(id);
  });
  it.each(['https://external.example', '//external.example'])('leaves external media links from %s unchanged', async external => {
    const { app, posts, media } = setup();
    const markdown = '![图](' + external + '/media/' + id + '/photo.png)';
    expect((await app.fetch(req('/api/admin/posts/new', 'PUT', { sha: null, title: 't', markdown, status: 'draft' }, { Origin: origin }), env)).status).toBe(201);
    expect(posts.savePost.mock.calls[0][1].markdown).toBe(markdown);
    expect(media.getMedia).not.toHaveBeenCalled();
  });
  it('does not forward unknown API endpoints to the frontend', async () => {
    const { app } = setup();
    expect((await app.fetch(req('/api/unknown'), env)).status).toBe(404);
  });
  it('returns Allow and rejects unsupported methods', async () => {
    const { app } = setup();
    const response = await app.fetch(req('/api/posts', 'POST'), env);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });
  it('redacts unexpected upstream exceptions', async () => {
    const { app, posts } = setup();
    posts.listPosts.mockRejectedValue(new Error('secret-token-goes-here'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await app.fetch(req('/api/posts'), env);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret-token');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token');
  });
});

describe('managed media link validation', () => {
  it('rejects a stable URL with the wrong filename before committing', async () => {
    const { app, posts } = setup();
    const markdown = '![图](/media/' + id + '/wrong.png)';
    const response = await app.fetch(req('/api/admin/posts/new', 'PUT', { sha: null, title: 't', markdown, status: 'draft' }, { Origin: origin }), env);
    expect(response.status).toBe(422);
    expect((await response.json() as any).error.code).toBe('INVALID_MEDIA_URL');
    expect(posts.savePost).not.toHaveBeenCalled();
  });
  it('bounds automatically detected IDs before performing any R2 reads', async () => {
    const { app, posts, media } = setup();
    const markdown = Array.from({ length: 201 }, (_, n) => '/media/' + n.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111/photo.png').join('\n');
    const response = await app.fetch(req('/api/admin/posts/new', 'PUT', { sha: null, title: 't', markdown, status: 'draft' }, { Origin: origin }), env);
    expect(response.status).toBe(422);
    expect((await response.json() as any).error.code).toBe('TOO_MANY_MEDIA_REFERENCES');
    expect(media.getMedia).not.toHaveBeenCalled();
    expect(posts.savePost).not.toHaveBeenCalled();
  });
  it('returns a client error for malformed percent encoding in a public filename', async () => {
    const { app } = setup();
    expect((await app.fetch(req('/media/' + id + '/bad%ZZ.png'), env)).status).toBe(400);
  });
});

describe('mutation coordination routing', () => {
  it('forwards validated mutations to the same coordinator with the body intact', async () => {
    const authenticate = vi.fn(async () => ({ email: 'owner@example.com', subject: 'owner-id' }));
    const forwarded: Request[] = [];
    const fetch = vi.fn(async (request: Request) => { forwarded.push(request); return new Response('coordinated'); });
    const idFromName = vi.fn(() => 'one-object');
    const get = vi.fn(() => ({ fetch }));
    const bound = { ...env, MUTATIONS: { idFromName, get } } as unknown as Env;
    const app = createApp({ authenticate });
    const payload = { sha: null, title: 't', markdown: '', status: 'draft' };
    expect((await app.fetch(req('/api/admin/posts/new', 'PUT', payload, { Origin: origin, 'X-Mob-Coordinated': 'true' }), bound)).status).toBe(200);
    expect((await app.fetch(req('/api/admin/media/' + id, 'DELETE', undefined, { Origin: origin }), bound)).status).toBe(200);
    expect(idFromName.mock.calls).toEqual([['blog-writes'], ['blog-writes']]);
    expect(await forwarded[0].json()).toEqual(payload);
    expect(authenticate).toHaveBeenCalledTimes(2);
  });
  it('rejects unauthorized and cross-origin requests before contacting the coordinator', async () => {
    const fetch = vi.fn();
    const app = createApp({ authenticate: async () => { throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in.'); } });
    const bound = { ...env, MUTATIONS: { idFromName: () => 'id', get: () => ({ fetch }) } } as unknown as Env;
    expect((await app.fetch(req('/api/admin/posts/new', 'DELETE', { sha: 'a'.repeat(40) }, { Origin: origin }), bound)).status).toBe(401);
    const signedIn = createApp({ authenticate: async () => ({ email: 'owner@example.com', subject: 'owner-id' }) });
    expect((await signedIn.fetch(req('/api/admin/media/' + id, 'DELETE', undefined, { Origin: 'https://evil.example' }), bound)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed when the coordinator binding is missing', async () => {
    const app = createApp({ authenticate: async () => ({ email: 'owner@example.com', subject: 'owner-id' }) });
    const response = await app.fetch(req('/api/admin/media/' + id, 'DELETE', undefined, { Origin: origin }), env);
    expect(response.status).toBe(503);
    expect((await response.json() as any).error.code).toBe('COORDINATOR_NOT_CONFIGURED');
  });
});
