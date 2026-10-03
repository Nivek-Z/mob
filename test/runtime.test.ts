import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { serializePost } from '../src/posts';
import type { Post } from '../src/types';
import { PLATFORM_FIXTURE_PATHS, readPlatformFixture } from './platform-fixtures';

// Exercise the production entrypoint, native fetch, R2 and the mutation Durable Object.
// Every outbound request is handled locally; no GitHub/Cloudflare credentials are used.
const origin = 'https://blog.example.com';
const issuer = 'https://runtime-test.cloudflareaccess.com';
const partSize = 8 * 1024 * 1024;
const files = new Map<string, { sha: string; content: string }>();
const digest = (text: string) => createHash('sha1').update(text).digest('hex');
let revision = 0;
let head = '';
let rejectRef = false;
const pendingTrees = new Map<string, Map<string, { sha: string; content: string }>>();
const pendingCommits = new Map<string, { parent: string; tree: string }>();
const blobDigest = (text: string) => createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex');
function storeFile(filename: string, content: string) { files.set(filename, { sha: blobDigest(content), content }); }
let upstreamStatus = 0;
let commitStatus = 0;
let commitRequests = 0;
let githubRequests = 0;
let mf: Miniflare;
let jwt: string;

function storePost(slug: string, status: 'draft' | 'published') {
  const post: Post = {
    slug, sha: '', title: slug, markdown: '# 正文\n\n中文文章 😀', description: 'A runtime fixture',
    tags: ['Cloudflare'], status, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    publishedAt: status === 'published' ? '2026-10-02T00:00:00.000Z' : null, cover: null, mediaIds: [],
  };
  const content = serializePost(post);
  storeFile(`content/posts/${slug}.md`, content);
}
function upstream(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new RuntimeResponse(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
async function dispatchRequest(...args: Parameters<Miniflare['dispatchFetch']>) {
  const response = await mf.dispatchFetch(...args);
  // Even status-only assertions must finish the network response, otherwise
  // Miniflare's dispatcher can wait on unread streams during dispose().
  const body = response.body === null ? null : await response.arrayBuffer();
  return new RuntimeResponse(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
function request(path: string, method = 'GET', body?: unknown, admin = false, headers: Record<string, string> = {}) {
  return dispatchRequest(origin + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(admin ? { 'cf-access-jwt-assertion': jwt, Origin: origin } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function data(response: Awaited<ReturnType<typeof request>>) {
  const payload = await response.json() as { data?: any; error?: { code: string } };
  return payload;
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'runtime-key', alg: 'RS256', use: 'sig' };
  jwt = await new SignJWT({ email: 'owner@example.com', type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'runtime-key' })
    .setIssuer(issuer).setAudience('runtime-audience').setSubject('runtime-owner').setIssuedAt().setExpirationTime('1h').sign(pair.privateKey);
  const bundled = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
  const options = convertV4MiniflareOptions({
    name: 'mob-runtime-test', modules: true, script: bundled.outputFiles[0].text, cf: false,
    compatibilityDate: '2026-10-02', r2Buckets: ['MEDIA'],
    durableObjects: { MUTATIONS: { className: 'BlogMutations', useSQLite: true } },
    bindings: {
      APP_ENV: 'production', SITE_ORIGIN: origin, GITHUB_OWNER: 'owner', GITHUB_REPO: 'blog', GITHUB_BRANCH: 'main',
      POSTS_DIRECTORY: 'content/posts', GITHUB_TOKEN: 'runtime-test-token', INDEX_CACHE_SECONDS: '30',
      ACCESS_TEAM_DOMAIN: 'runtime-test.cloudflareaccess.com', ACCESS_AUD: 'runtime-audience', ADMIN_EMAILS: 'owner@example.com',
    },
    serviceBindings: { ASSETS: async req => {
      const url = new URL(req.url); let asset = url.pathname;
      if (asset.endsWith('/')) asset += 'index.html'; else if (!path.extname(asset)) asset += '.html';
      // Deployed registry/config defaults must also be isolated from admin edits.
      const fixturePath = 'frontend' + asset;
      if (PLATFORM_FIXTURE_PATHS.some(filename => filename === fixturePath)) return new RuntimeResponse(readPlatformFixture(fixturePath), { headers: { 'Content-Type': 'application/json' } });
      const filename = path.resolve('frontend', '.' + asset);
      if (!filename.startsWith(path.resolve('frontend') + path.sep) || !existsSync(filename)) return new RuntimeResponse('missing', { status: 404 });
      const type = asset.endsWith('.json') ? 'application/json' : asset.endsWith('.html') ? 'text/html' : asset.endsWith('.avif') ? 'image/avif' : asset.endsWith('.webp') ? 'image/webp' : 'text/javascript';
      return new RuntimeResponse(readFileSync(filename), { headers: { 'Content-Type': type } });
    } },
    outboundService: async (req) => {
      const url = new URL(req.url);
      if (url.href === issuer + '/cdn-cgi/access/certs') return upstream({ keys: [jwk] });
      if (url.hostname !== 'api.github.com') throw new Error('Unexpected outbound request in runtime test');
      githubRequests++;
      expect(req.headers.get('Authorization')).toBe('Bearer runtime-test-token');
      if (upstreamStatus) return upstream({}, upstreamStatus, upstreamStatus === 429 ? { 'retry-after': '1' } : {});
      if (url.pathname === '/graphql') {
        const { variables } = await req.json() as { variables: Record<string, string> };
        const repository: Record<string, unknown> = {};
        for (const [name, sha] of Object.entries(variables)) {
          if (!/^s\d+$/.test(name)) continue;
          const file = [...files.values()].find((item) => item.sha === sha);
          repository[name.replace(/^s/, 'b')] = file ? { oid: sha, byteSize: Buffer.byteLength(file.content), isBinary: false, isTruncated: false, text: file.content } : null;
        }
        return upstream({ data: { repository } });
      }
      if (url.pathname.includes('/git/ref/heads/')) return upstream({ object: { type: 'commit', sha: head } });
      if (url.pathname === '/repos/owner/blog/commits') {
        commitRequests++; expect(url.searchParams.get('sha')).toBe(head);
        return commitStatus ? upstream({}, commitStatus) : upstream([{ sha: digest('activity-commit'), commit: { committer: { date: new Date().toISOString() } } }]);
      }
      if (url.pathname.includes('/git/blobs/')) { const sha = url.pathname.split('/').pop(); const file = [...files.values()].find(file => file.sha === sha); return file ? upstream({ encoding: 'base64', content: Buffer.from(file.content).toString('base64') }) : upstream({}, 404); }
      if (url.pathname.includes('/git/trees/')) return upstream({ sha: digest('base-tree'), truncated: false, tree: [...files].map(([path, file]) => ({ path, type: 'blob', sha: file.sha, size: Buffer.byteLength(file.content) })) });
      if (url.pathname.includes('/git/commits/')) return upstream({ sha: head, tree: { sha: digest('base-tree') } });
      if (url.pathname.endsWith('/git/trees') && req.method === 'POST') {
        const input = await req.json() as { tree: { path: string; content?: string; sha?: null }[] }; const snapshot = new Map(files);
        for (const change of input.tree) { if (change.sha === null) snapshot.delete(change.path); else snapshot.set(change.path, { sha: blobDigest(change.content!), content: change.content! }); }
        const sha = digest('tree-' + pendingTrees.size + '-' + revision); pendingTrees.set(sha, snapshot); return upstream({ sha });
      }
      if (url.pathname.endsWith('/git/commits') && req.method === 'POST') {
        const input = await req.json() as { tree: string; parents: string[] }; const sha = digest('commit-' + pendingCommits.size + '-' + revision);
        pendingCommits.set(sha, { parent: input.parents[0], tree: input.tree }); return upstream({ sha });
      }
      if (url.pathname.includes('/git/refs/heads/') && req.method === 'PATCH') {
        const input = await req.json() as { sha: string; force: boolean }; expect(input.force).toBe(false);
        const commit = pendingCommits.get(input.sha)!;
        if (rejectRef || commit.parent !== head) return upstream({}, 422);
        const snapshot = pendingTrees.get(commit.tree)!; files.clear(); for (const [path, file] of snapshot) files.set(path, file);
        revision++; head = input.sha; return upstream({ object: { sha: head } });
      }
      const path = url.pathname.split('/contents/')[1];
      if (!path) throw new Error('Unexpected GitHub route in runtime test');
      const file = files.get(path);
      if (req.method === 'GET') return file ? upstream({ type: 'file', encoding: 'base64', sha: file.sha, content: Buffer.from(file.content).toString('base64') }) : upstream({}, 404);
      const input = await req.json() as { sha?: string; content?: string };
      if (file ? input.sha !== file.sha : input.sha !== undefined) return upstream({}, 409);
      revision++; head = digest(String(revision));
      if (req.method === 'DELETE') { files.delete(path); return upstream({ commit: { sha: digest(String(revision)) } }); }
      const content = Buffer.from(input.content!, 'base64').toString('utf8');
      const sha = blobDigest(content);
      files.set(path, { sha, content });
      return upstream({ content: { sha }, commit: { sha: digest(String(revision)) } }, file ? 200 : 201);
    },
  });
  options.telemetry = { enabled: false };
  mf = new Miniflare(options);
  await mf.ready;
}, 20000);
beforeEach(() => {
  files.clear(); revision++; head = digest(String(revision)); rejectRef = false; pendingTrees.clear(); pendingCommits.clear(); upstreamStatus = 0; githubRequests = 0; commitStatus = 0; commitRequests = 0;
  storePost('public', 'published'); storePost('private', 'draft');
  for (const filename of PLATFORM_FIXTURE_PATHS) storeFile(filename, readPlatformFixture(filename));
  for (const filename of ['frontend/themes/firefly/theme.json', 'frontend/themes/firefly/config/appearance.schema.json', 'frontend/themes/paper/theme.json', 'frontend/themes/paper/config/reading.schema.json']) storeFile(filename, readFileSync(filename, 'utf8'));
  for (const theme of ['firefly', 'paper']) {
    const definition = JSON.parse(readFileSync(`frontend/themes/${theme}/theme.json`, 'utf8'));
    for (const page of Object.values(definition.routes) as string[]) storeFile(`frontend/themes/${theme}/${page}`, readFileSync(`frontend/themes/${theme}/${page}`, 'utf8'));
  }
});
// Cloudflare's shared build hosts may need longer to reap workerd and close
// its storage/proxy resources. Await real cleanup; never suppress its errors.
afterAll(async () => { await mf?.dispose(); }, 30000);

describe('Cloudflare runtime integration', () => {
  it('releases unused native R2 streams for theme-seed HEAD and conditional responses', async () => {
    const first = await request('/theme-media/firefly/hero.avif'); expect(first.status).toBe(200);
    const head = await request('/theme-media/firefly/hero.avif', 'HEAD'); expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const unchanged = await request('/theme-media/firefly/hero.avif', 'GET', undefined, false, { 'If-None-Match': first.headers.get('ETag')! });
    expect(unchanged.status).toBe(304); expect((await unchanged.arrayBuffer()).byteLength).toBe(0);
  });
  it('recovers adopted managed files whose original R2 MIME was generic', async () => {
    const id = '12345678-1234-4234-8234-123456789abc', key = 'media/' + id + '/old.png';
    const bucket = await mf.getR2Bucket('MEDIA');
    const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0]);
    const original = await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
    expect((await request('/api/admin/gallery/storage/import', 'POST', { key, etag: original!.etag }, true)).status).toBe(200);
    await bucket.delete('.mob/media/' + id + '.json');
    const response = await request('/api/admin/media/' + id + '/file', 'GET', undefined, true);
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png');
  });
  it('recovers registered media from Git after all auxiliary R2 records are cleared, without writes on reads', async () => {
    const record = await uploadFixture();
    const registered = (await data(await request('/api/admin/gallery/items', 'POST', { id: record.id }, true))).data;
    expect((await request('/api/admin/gallery', 'PATCH', { sha: registered.sha, items: [{ id: record.id, isPublic: true }] }, true)).status).toBe(200);
    const bucket = await mf.getR2Bucket('MEDIA');
    const auxiliary = await bucket.list({ prefix: '.mob/', limit: 1000 });
    await bucket.delete(auxiliary.objects.map(object => object.key));
    expect((await request(new URL(record.url).pathname)).status).toBe(200);
    expect((await request('/api/admin/media/' + record.id + '/file', 'GET', undefined, true)).status).toBe(200);
    expect(await bucket.head('.mob/media/' + record.id + '.json')).toBeNull();
    const gallery = (await data(await request('/api/admin/gallery', 'GET', undefined, true))).data;
    expect((await request('/api/admin/gallery/items/' + record.id, 'DELETE', { sha: gallery.sha }, true)).status).toBe(200);
    expect(await bucket.head(record.key)).toBeNull();
    expect((await request(new URL(record.url).pathname)).status).toBe(404);
  });
  it('cleans expired upload sessions through an authenticated coordinator and retains completed media', async () => {
    const record = await uploadFixture(), bucket = await mf.getR2Bucket('MEDIA');
    const key = '.mob/uploads/' + record.id + '/session.json';
    const session = await (await bucket.get(key))!.json() as any;
    session.expiresAt = new Date(Date.now() - 1000).toISOString();
    await bucket.put(key, JSON.stringify(session));
    expect((await request('/api/admin/uploads/cleanup', 'POST', {})).status).toBe(401);
    expect((await request('/api/admin/uploads/cleanup', 'POST', {}, true, { Origin: 'https://other.example.com' })).status).toBe(403);
    let cursor: string | null = null;
    do {
      const response = await request('/api/admin/uploads/cleanup', 'POST', cursor ? { cursor } : {}, true);
      expect(response.status).toBe(200); cursor = (await data(response)).data.cursor;
    } while (cursor);
    expect(await bucket.head(key)).toBeNull(); expect(await bucket.head(record.key)).not.toBeNull();
    expect((await request('/api/admin/media/' + record.id + '/file', 'GET', undefined, true)).status).toBe(200);
  });
  it('deletes an imported legacy object through the real gallery endpoint', async () => {
    const bucket = await mf.getR2Bucket('MEDIA');
    const key = 'legacy/review-delete.png';
    const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0]);
    const original = await bucket.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
    const importedResponse = await request('/api/admin/gallery/storage/import', 'POST', { key, etag: original!.etag }, true);
    expect(importedResponse.status).toBe(200);
    const imported = (await data(importedResponse)).data;
    const deletion = await request('/api/admin/gallery/items/' + imported.item.id, 'DELETE', { sha: imported.sha }, true);
    const error = await data(deletion);
    expect(JSON.parse(files.get('content/gallery/items.json')!.content).items.some((item: any) => item.id === imported.item.id)).toBe(false);
    expect(await bucket.head('media/' + imported.item.id + '/' + imported.item.filename)).toBeNull();
    expect(await bucket.head(key)).not.toBeNull();
    expect({ status: deletion.status, error: error.error }).toEqual({ status: 200, error: undefined });
  });
  it('Paper removes automatic public media grants when the avatar is cleared', async () => {
    const record = await uploadFixture();
    const site = (await data(await request('/api/admin/settings/site', 'GET', undefined, true))).data;
    site.value.profile.avatar = record.url;
    const saved = await request('/api/admin/settings/site', 'PUT', { sha: site.sha, value: site.value }, true);
    expect(saved.status).toBe(200);
    expect((await request(new URL(record.url).pathname)).status).toBe(200);
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(readFileSync('frontend/themes/paper/admin/settings.html', 'utf8'), { url: origin + '/admin/settings.html', runScripts: 'outside-only' });
    const win = dom.window as any;
    win.document.getElementById('paper-doc').value = 'site';
    let initialized!: () => void;
    const loaded = new Promise<void>(resolve => { initialized = resolve; });
    let finished!: () => void;
    const submitted = new Promise<void>(resolve => { finished = resolve; });
    win.Mob = { api: async (path: string, options?: any) => {
      const response = await request(path, options?.method ?? 'GET', options?.json, true);
      const payload = await data(response);
      expect(response.status).toBe(200);
      queueMicrotask(options ? finished : initialized);
      return payload.data;
    } };
    win.eval(readFileSync('frontend/themes/paper/admin/settings.js', 'utf8'));
    await loaded; await new Promise(resolve => setTimeout(resolve, 0));
    const raw = win.document.getElementById('paper-json');
    const updated = JSON.parse(raw.value); updated.profile.avatar = '';
    raw.value = JSON.stringify(updated); raw.dispatchEvent(new win.Event('input', { bubbles: true }));
    win.document.getElementById('paper-save').click();
    await submitted; await new Promise(resolve => setTimeout(resolve, 0));
    dom.window.close();
    expect(JSON.parse(files.get('config/site/settings.json')!.content).profile.avatar).toBe('');
    expect((await request(new URL(record.url).pathname)).status).toBe(404);
  });
  it('aggregates activity through native fetch/R2, labels stale results and respects live disabling', async () => {
    const bucket = await mf.getR2Bucket('MEDIA');
    const cached = await bucket.list({ prefix: 'cache/github-activity/' }); await bucket.delete(cached.objects.map(object => object.key));
    const response = await request('/api/activity'); expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toContain('no-store');
    const activity = (await data(response)).data;
    expect(activity.github).toMatchObject({ status: 'ok', repository: 'owner/blog', stats: { total: 1, activeDays: 1 } });
    expect(activity.github.daily).toHaveLength(365); expect(Object.keys(activity.github.daily[0]).sort()).toEqual(['count', 'date']);
    await request('/api/activity'); expect(commitRequests).toBe(1);
    const stored = (await bucket.list({ prefix: 'cache/github-activity/' })).objects[0];
    const value = await (await bucket.get(stored.key))!.json() as any;
    value.attemptedAt -= 660000; value.snapshot.fetchedAt -= 660000; await bucket.put(stored.key, JSON.stringify(value));
    commitStatus = 502;
    const stale = (await data(await request('/api/activity'))).data;
    expect(stale.github.status).toBe('stale'); expect(stale.github.stats.total).toBe(1);
    expect(stale.range).toEqual(activity.range);
    const settings = (await data(await request('/api/admin/settings/site', 'GET', undefined, true))).data;
    settings.value.activity.enabled = false;
    expect((await request('/api/admin/settings/site', 'PUT', { sha: settings.sha, value: settings.value }, true)).status).toBe(200);
    const disabled = (await data(await request('/api/activity'))).data;
    expect(disabled.github).toMatchObject({ status: 'disabled', daily: null, stats: null }); expect(commitRequests).toBe(2);
    expect((await request('/api/activity?repo=other')).status).toBe(400);
  });
  it('discovers real R2 theme seeds and imports a private copy without changing original URLs', async () => {
    const original = await request('/theme-media/firefly/hero.avif'); expect(original.status).toBe(200);
    expect((await request('/api/admin/gallery/storage')).status).toBe(401);
    let cursor: string | null = null, source: any;
    do {
      const page: { items: any[]; cursor: string | null } = (await data(await request('/api/admin/gallery/storage' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), 'GET', undefined, true))).data;
      source ||= page.items.find((item: any) => item.kind === 'theme' && item.key.endsWith('/hero.avif')); cursor = page.cursor;
    } while (cursor && !source);
    expect(source).toBeDefined();
    const previewURL = '/api/admin/gallery/storage/file?key=' + encodeURIComponent(source.key);
    expect((await request(previewURL)).status).toBe(401);
    const preview = await request(previewURL, 'GET', undefined, true, { Range: 'bytes=0-15' });
    expect(preview.status).toBe(206); expect((await preview.arrayBuffer()).byteLength).toBe(16);
    expect(preview.headers.get('Cache-Control')).toContain('no-store');
    expect((await request('/api/admin/gallery/storage/import', 'POST', { key: source.key, etag: source.etag }, true, { Origin: 'https://evil.example' })).status).toBe(403);
    const imported = (await data(await request('/api/admin/gallery/storage/import', 'POST', { key: source.key, etag: source.etag }, true))).data;
    expect(imported.item).toMatchObject({ id: source.id, isPublic: false, isListed: false });
    const url = new URL(imported.item.url).pathname;
    expect((await request(url)).status).toBe(404);
    expect((await request('/api/admin/media/' + source.id + '/file', 'HEAD', undefined, true)).status).toBe(200);
    const repeat = (await data(await request('/api/admin/gallery/storage/import', 'POST', { key: source.key, etag: source.etag }, true))).data;
    expect(repeat.item.id).toBe(source.id);
    expect((await request('/api/admin/gallery', 'PATCH', { sha: repeat.sha, items: [{ id: source.id, isPublic: true, isListed: true }] }, true)).status).toBe(200);
    const copy = await request(url); expect(copy.status).toBe(200); expect(new Uint8Array(await copy.arrayBuffer())).toEqual(new Uint8Array(await original.arrayBuffer()));
    expect((await request('/theme-media/firefly/hero.avif')).status).toBe(200);
    expect((await request('/api/admin/gallery/storage/file?key=.mob/private.png', 'GET', undefined, true)).status).toBe(404);
  });
  it('checks liveness without depending on GitHub', async () => {
    expect((await data(await request('/api/health'))).data.status).toBe('ok');
    expect(githubRequests).toBe(0);
  });
  it('uses native fetch to list published articles and read Unicode Markdown', async () => {
    const listed = await request('/api/posts');
    expect(listed.status).toBe(200);
    expect((await data(listed)).data.items.map((post: Post) => post.slug)).toEqual(['public']);
    expect((await data(await request('/api/posts/public'))).data.markdown).toContain('中文文章 😀');
    expect((await request('/api/posts/private')).status).toBe(404);
  });
  it('verifies Access signatures and blocks forged administrator headers', async () => {
    expect((await request('/api/admin/posts')).status).toBe(401);
    expect((await request('/api/admin/posts', 'GET', undefined, false, { 'cf-access-authenticated-user-email': 'owner@example.com' })).status).toBe(401);
    const response = await request('/api/admin/posts', 'GET', undefined, true);
    expect(response.status).toBe(200);
    expect((await data(response)).data.items).toHaveLength(2);
  });
  it('creates, updates and deletes articles through the real Durable Object', async () => {
    const input = { sha: null, title: '新文章', markdown: '中文 😀', status: 'draft' };
    const created = await request('/api/admin/posts/runtime-post', 'PUT', input, true);
    expect(created.status).toBe(201);
    const sha = (await data(created)).data.post.sha;
    const updated = await request('/api/admin/posts/runtime-post', 'PUT', { ...input, sha, status: 'published' }, true);
    expect(updated.status).toBe(200);
    expect((await request('/api/posts/runtime-post')).status).toBe(200);
    const currentSha = (await data(updated)).data.post.sha;
    expect((await request('/api/admin/posts/runtime-post', 'DELETE', { sha: currentSha }, true)).status).toBe(200);
    expect((await request('/api/posts/runtime-post')).status).toBe(404);
  });
  it('rejects cross-origin writes and stale article versions', async () => {
    const input = { sha: null, title: 'Title', markdown: 'Body', status: 'draft' };
    expect((await request('/api/admin/posts/new', 'PUT', input, true, { Origin: 'https://evil.example' })).status).toBe(403);
    const conflict = await request('/api/admin/posts/public', 'PUT', { ...input, sha: 'a'.repeat(40) }, true);
    expect(conflict.status).toBe(409);
    expect((await data(conflict)).error?.code).toBe('POST_CONFLICT');
  });
  it.each([[401, 'GITHUB_ACCESS_DENIED'], [429, 'GITHUB_RATE_LIMITED'], [502, 'GITHUB_UNAVAILABLE']])('handles GitHub HTTP %s without exposing credentials', async (status, code) => {
    upstreamStatus = status as number;
    const response = await request('/api/posts');
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe(code);
    expect(text).not.toContain('runtime-test-token');
  });
  it('uploads and reads published media with native R2 and range responses', async () => {
    const bytes = new Uint8Array(32); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set(Buffer.from('IHDR'), 12);
    const session = (await data(await request('/api/admin/uploads', 'POST', { filename: 'photo.png', contentType: 'image/png', size: bytes.length }, true))).data;
    const uploaded = await dispatchRequest(origin + `/api/admin/uploads/${session.id}/body`, { method: 'PUT', body: bytes, headers: { Origin: origin, 'cf-access-jwt-assertion': jwt } });
    expect(uploaded.status).toBe(200);
    const path = new URL(session.url).pathname;
    expect((await request(path)).status).toBe(404);
    expect((await request('/api/admin/posts/with-media', 'PUT', { sha: null, title: 'Photo', markdown: `![图](${session.url})`, status: 'published' }, true)).status).toBe(201);
    const response = await request(path, 'GET', undefined, false, { Range: 'bytes=0-3' });
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(0, 4));
    expect((await request(path, 'HEAD')).headers.get('Content-Length')).toBe('32');
    const blocked = await request(`/api/admin/media/${session.id}`, 'DELETE', undefined, true);
    expect(blocked.status).toBe(409);
  });
  it('completes multipart uploads and deletes unreferenced media using native R2', async () => {
    const bytes = new Uint8Array(partSize + 32); bytes.set([0, 0, 0, 16]); bytes.set(Buffer.from('ftypisom'), 4);
    const session = (await data(await request('/api/admin/uploads', 'POST', { filename: 'video.mp4', contentType: 'video/mp4', size: bytes.length }, true))).data;
    for (let number = 1; number <= 2; number++) {
      const response = await dispatchRequest(origin + `/api/admin/uploads/${session.id}/parts/${number}`, {
        method: 'PUT', body: bytes.slice((number - 1) * partSize, number * partSize), headers: { Origin: origin, 'cf-access-jwt-assertion': jwt },
      });
      expect(response.status).toBe(200);
    }
    expect((await request(`/api/admin/uploads/${session.id}/complete`, 'POST', {}, true)).status).toBe(200);
    expect((await request(`/api/admin/media/${session.id}/file`, 'HEAD', undefined, true)).headers.get('Content-Length')).toBe(String(bytes.length));
    expect((await request(`/api/admin/media/${session.id}`, 'DELETE', undefined, true)).status).toBe(200);
    expect((await request(`/api/admin/media/${session.id}/file`, 'GET', undefined, true)).status).toBe(404);
  });
});

async function uploadFixture(filename = 'photo.png', contentType = 'image/png') {
  const bytes = new Uint8Array(32);
  if (contentType === 'image/png') { bytes.set([137,80,78,71,13,10,26,10]); bytes.set(Buffer.from('IHDR'),12); }
  else bytes.set(Buffer.from('ID3'), 0);
  const session = (await data(await request('/api/admin/uploads', 'POST', { filename, contentType, size: bytes.length }, true))).data;
  const response = await dispatchRequest(origin + `/api/admin/uploads/${session.id}/body`, { method: 'PUT', body: bytes, headers: { Origin: origin, 'cf-access-jwt-assertion': jwt } });
  expect(response.status).toBe(200); return (await data(response)).data;
}
describe('platform integration in workerd', () => {
  it('uses the public reference snapshot only after checking live HEAD and revokes cached media on config changes', async () => {
    const record = await uploadFixture();
    const path = 'frontend/themes/firefly/config/appearance.json';
    const original = files.get(path)!.content;
    const value = JSON.parse(original); value.hero.cover = record.url;
    storeFile(path, JSON.stringify(value)); revision++; head = digest(String(revision));
    const mediaPath = new URL(record.url).pathname;
    let before = githubRequests;
    expect((await request(mediaPath)).status).toBe(200);
    const cold = githubRequests - before;
    const bucket = await mf.getR2Bucket('MEDIA');
    const cache = await bucket.get('.mob/settings/public-references.json');
    expect((await cache!.json() as { head: string }).head).toBe(head);
    before = githubRequests;
    expect((await request(mediaPath)).status).toBe(200);
    const warm = githubRequests - before;
    expect(warm).toBe(3); // Article HEAD, gallery document, configuration HEAD.
    expect(cold).toBeGreaterThan(warm);
    upstreamStatus = 502;
    expect((await request(mediaPath)).status).toBe(502); upstreamStatus = 0;
    storeFile(path, original); revision++; head = digest(String(revision));
    expect((await request(mediaPath)).status).toBe(404);
  });
  it('preserves an existing gallery item when another upload is registered and retried', async () => {
    const existing = await uploadFixture('existing.png');
    const first = (await data(await request('/api/admin/gallery/items', 'POST', { id: existing.id, source: 'theme' }, true))).data;
    expect((await request('/api/admin/gallery', 'PATCH', { sha: first.sha, items: [{ id: existing.id, title: '已有图片', isPublic: true, isListed: true }] }, true)).status).toBe(200);
    const added = await uploadFixture('new.png');
    for (let attempt = 0; attempt < 2; attempt++) expect((await request('/api/admin/gallery/items', 'POST', { id: added.id, source: 'editor' }, true)).status).toBe(201);
    const document = JSON.parse(files.get('content/gallery/items.json')!.content);
    expect(document.items).toHaveLength(2);
    expect(document.items.find((item: any) => item.id === existing.id)).toMatchObject({ title: '已有图片', isPublic: true, isListed: true, source: 'theme' });
    expect(document.items.filter((item: any) => item.id === added.id)).toHaveLength(1);
    expect(document.items.find((item: any) => item.id === added.id)).toMatchObject({ categoryId: 'article-images', isPublic: false, isListed: false });
    expect((await data(await request('/api/gallery'))).data.items.map((item: any) => item.id)).toEqual([existing.id]);
    expect((await request(new URL(existing.url).pathname)).status).toBe(200);
    expect((await request(new URL(added.url).pathname)).status).toBe(404);
  });
  it('keeps theme declarations, global text and R2 objects in their assigned stores', async () => {
    const record = await uploadFixture();
    const registered = await request('/api/admin/gallery/items', 'POST', { id: record.id, source: 'editor' }, true);
    expect(registered.status).toBe(201);
    expect((await data(registered)).data.item).toMatchObject({ categoryId: 'article-images', isPublic: false, isListed: false });
    expect((await data(await request('/api/gallery'))).data.total).toBe(0);
    expect((await request(new URL(record.url).pathname)).status).toBe(404);
    const repeated = (await data(await request('/api/admin/gallery/items', 'POST', { id: record.id, source: 'editor' }, true))).data;
    expect((JSON.parse(files.get('content/gallery/items.json')!.content)).items).toHaveLength(1);
    expect((await request('/api/admin/gallery', 'PATCH', { sha: repeated.sha, items: [{ id: record.id, title: '日记插图', isPublic: true, isListed: true }] }, true)).status).toBe(200);
    expect((await data(await request('/api/gallery'))).data.items[0].title).toBe('日记插图');
    expect((await request(new URL(record.url).pathname)).status).toBe(200);
    const bucket = await mf.getR2Bucket('MEDIA');
    const objects = await bucket.list(); expect(objects.objects.some(item => /media\//.test(item.key))).toBe(true);
    expect(objects.objects.some(item => item.key.includes('gallery/items') || item.key.includes('settings.json'))).toBe(false);
  });
  it('atomically saves free theme config and protects references from deletion', async () => {
    const record = await uploadFixture();
    const before = (await data(await request('/api/admin/themes/firefly/config/appearance', 'GET', undefined, true))).data;
    before.value.hero.cover = record.url; before.value.extra = { independentThemeField: true };
    const saved = await request('/api/admin/themes/firefly/config/appearance', 'PUT', { sha: before.sha, value: before.value }, true);
    expect(saved.status).toBe(200); const value = (await data(saved)).data;
    expect(value.value.extra).toEqual({ independentThemeField: true });
    expect(files.get('frontend/themes/firefly/config/appearance.json')!.sha).toBe(value.sha);
    expect(JSON.parse(files.get('frontend/themes/firefly/config/appearance.references.json')!.content).mediaIds).toContain(record.id);
    expect((await request(new URL(record.url).pathname)).status).toBe(200);
    const blocked = await request('/api/admin/media/' + record.id, 'DELETE', undefined, true);
    expect(blocked.status).toBe(409); expect((await data(blocked)).error?.code).toBe('MEDIA_IN_USE');
    expect((await request('/api/admin/themes/firefly/config/appearance', 'PUT', { sha: before.sha, value: before.value }, true)).status).toBe(409);
  });
  it('leaves both config and reference sidecar unchanged after a branch race', async () => {
    const record = await uploadFixture(); const before = files.get('config/site/settings.json')!; const value = JSON.parse(before.content); value.profile.avatar = record.url;
    rejectRef = true;
    const response = await request('/api/admin/settings/site', 'PUT', { sha: before.sha, value }, true);
    expect(response.status).toBe(409); expect(files.get('config/site/settings.json')).toEqual(before);
    expect(files.has('config/site/settings.references.json')).toBe(false);
  });
  it('rejects schemas, undeclared files, unsafe roots and protected route aliases', async () => {
    const reading = (await data(await request('/api/admin/themes/paper/config/reading', 'GET', undefined, true))).data;
    reading.value.fontSize = 100;
    expect((await request('/api/admin/themes/paper/config/reading', 'PUT', { sha: reading.sha, value: reading.value }, true)).status).toBe(422);
    expect((await request('/api/admin/themes/paper/config/not-declared', 'PUT', { sha: null, value: {} }, true)).status).toBe(404);
    const themes = (await data(await request('/api/admin/themes', 'GET', undefined, true))).data; themes.value.themes[0].root = '../config';
    expect((await request('/api/admin/themes', 'PUT', { sha: themes.sha, value: themes.value }, true)).status).toBe(422);
    for (const path of ['/themes/firefly/admin/editor.js', '/themes/paper/admin/settings.html', '/themes/paper/admin%2Findex.html']) expect((await request(path)).status).toBe(401);
    expect((await request('/api/admin/settings/site', 'PUT', { sha: null, value: {} }, true, { Origin: 'https://evil.example' })).status).toBe(403);
  });
  it('switches complete visitor themes without asset redirects or shared HTML caching', async () => {
    const response = await request('/?theme=paper'); expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-layout="paper"'); expect(response.headers.get('Set-Cookie')).toContain('mob-layout=paper');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store'); expect(response.headers.get('Vary')).toBe('Cookie');
    expect(await (await request('/archive.html', 'GET', undefined, false, { Cookie: 'mob-layout=paper' })).text()).toContain('data-layout="paper"');
  });
  it('validates complete registered themes and applies default changes on deployment', async () => {
    const before = (await data(await request('/api/admin/themes', 'GET', undefined, true))).data;
    before.value.defaultTheme = 'paper';
    const saved = await request('/api/admin/themes', 'PUT', { sha: before.sha, value: before.value }, true); expect(saved.status).toBe(200);
    expect(JSON.parse(files.get('frontend/themes.json')!.content).defaultTheme).toBe('paper');
    expect((await data(await request('/api/themes'))).data.defaultTheme).toBe('paper');
    before.value.themes.push({ id: 'missing', name: 'Missing', root: 'themes/missing', enabled: true });
    const current = files.get('frontend/themes.json')!.sha;
    expect((await request('/api/admin/themes', 'PUT', { sha: current, value: before.value }, true)).status).toBe(422);
    expect((await request('/admin/assets/paper/settings.js')).status).toBe(401);
    const asset = await request('/admin/assets/paper/settings.js', 'GET', undefined, true); expect(asset.status).toBe(200); expect(await asset.text()).toContain('paper-doc');
  });
  it('stores decorative seeds in R2 and blocks raw deployed media paths', async () => {
    const response = await request('/theme-media/firefly/hero.avif'); expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/avif');
    const bucket = await mf.getR2Bucket('MEDIA'); expect((await bucket.list({ prefix: 'theme-media/firefly/' })).objects.length).toBeGreaterThan(0);
    expect((await request('/themes/firefly/assets/images/hero.avif')).status).toBe(404);
  });
  it('preserves disabled theme references while withdrawing their public grants', async () => {
    const record = await uploadFixture(); const path = 'frontend/themes/paper/config/reading.json'; const value = JSON.parse(files.get(path)!.content); value.extraImage = record.url; storeFile(path, JSON.stringify(value));
    const registration = JSON.parse(files.get('frontend/themes.json')!.content); registration.themes[1].enabled = false; storeFile('frontend/themes.json', JSON.stringify(registration)); revision++; head = digest(String(revision));
    expect((await request(new URL(record.url).pathname)).status).toBe(404);
    expect((await request('/api/admin/media/' + record.id, 'DELETE', undefined, true)).status).toBe(409);
  });
  it('uploads audio and prevents removing a category that still owns gallery items', async () => {
    const record = await uploadFixture('sample.mp3', 'audio/mpeg'); await request('/api/admin/gallery/items', 'POST', { id: record.id, source: 'gallery' }, true);
    const gallery = (await data(await request('/api/admin/gallery', 'GET', undefined, true))).data;
    const categories = (await data(await request('/api/admin/gallery/categories', 'GET', undefined, true))).data;
    categories.value.items.push({ id: 'sound', name: '声音' });
    const saved = (await data(await request('/api/admin/gallery/categories', 'PUT', { sha: categories.sha, value: categories.value }, true))).data;
    expect((await request('/api/admin/gallery', 'PATCH', { sha: gallery.sha, items: [{ id: record.id, categoryId: 'sound' }] }, true)).status).toBe(200);
    saved.value.items = saved.value.items.filter((item: { id: string }) => item.id !== 'sound');
    expect((await request('/api/admin/gallery/categories', 'PUT', { sha: saved.sha, value: saved.value }, true)).status).toBe(409);
    const current = (await data(await request('/api/admin/gallery', 'GET', undefined, true))).data;
    expect((await request('/api/admin/gallery/items/' + record.id, 'DELETE', { sha: current.sha }, true)).status).toBe(200);
    expect((await request('/api/admin/media/' + record.id + '/file', 'GET', undefined, true)).status).toBe(404);
  });
});
