import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { serializePost } from '../src/posts';
import type { Post } from '../src/types';

// Exercise the production entrypoint, native fetch, R2 and the mutation Durable Object.
// Every outbound request is handled locally; no GitHub/Cloudflare credentials are used.
const origin = 'https://blog.example.com';
const issuer = 'https://runtime-test.cloudflareaccess.com';
const partSize = 8 * 1024 * 1024;
const files = new Map<string, { sha: string; content: string }>();
const digest = (text: string) => createHash('sha1').update(text).digest('hex');
let revision = 0;
let upstreamStatus = 0;
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
  files.set(`content/posts/${slug}.md`, { sha: digest(content), content });
}
function upstream(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new RuntimeResponse(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function request(path: string, method = 'GET', body?: unknown, admin = false, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(origin + path, {
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
      if (url.pathname.includes('/git/ref/heads/')) return upstream({ object: { type: 'commit', sha: digest(String(revision)) } });
      if (url.pathname.includes('/git/trees/')) return upstream({ truncated: false, tree: [...files].map(([path, file]) => ({ path, type: 'blob', sha: file.sha, size: Buffer.byteLength(file.content) })) });
      const path = url.pathname.split('/contents/')[1];
      if (!path) throw new Error('Unexpected GitHub route in runtime test');
      const file = files.get(path);
      if (req.method === 'GET') return file ? upstream({ type: 'file', encoding: 'base64', sha: file.sha, content: Buffer.from(file.content).toString('base64') }) : upstream({}, 404);
      const input = await req.json() as { sha?: string; content?: string };
      if (file ? input.sha !== file.sha : input.sha !== undefined) return upstream({}, 409);
      revision++;
      if (req.method === 'DELETE') { files.delete(path); return upstream({ commit: { sha: digest(String(revision)) } }); }
      const content = Buffer.from(input.content!, 'base64').toString('utf8');
      const sha = digest(content);
      files.set(path, { sha, content });
      return upstream({ content: { sha }, commit: { sha: digest(String(revision)) } }, file ? 200 : 201);
    },
  });
  options.telemetry = { enabled: false };
  mf = new Miniflare(options);
  await mf.ready;
}, 20000);
beforeEach(() => { files.clear(); revision++; upstreamStatus = 0; githubRequests = 0; storePost('public', 'published'); storePost('private', 'draft'); });
afterAll(async () => { await mf?.dispose(); });

describe('Cloudflare runtime integration', () => {
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
    const uploaded = await mf.dispatchFetch(origin + `/api/admin/uploads/${session.id}/body`, { method: 'PUT', body: bytes, headers: { Origin: origin, 'cf-access-jwt-assertion': jwt } });
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
      const response = await mf.dispatchFetch(origin + `/api/admin/uploads/${session.id}/parts/${number}`, {
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
