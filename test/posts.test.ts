import { describe, expect, it, vi } from 'vitest';
import { GithubPosts, parsePost, serializePost, validateSavePostInput } from '../src/posts';
import type { Env, Post, SavePostInput } from '../src/types';

const originalSha = 'a'.repeat(40); const changedSha = 'b'.repeat(40); const commitSha = 'c'.repeat(40);
function basePost(overrides: Partial<Post> = {}): Post {
  return { slug: 'hello', sha: originalSha, title: '中文文章：你好', markdown: '\n# 正文\n\n图片 ![](https://media.example.com/photo.webp)\n😀\n', description: '中文说明', tags: ['旅行', 'Cloudflare'], status: 'draft', createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', publishedAt: null, cover: null, mediaIds: [], ...overrides };
}
function createInput(overrides: Partial<SavePostInput> = {}): SavePostInput { return { sha: null, title: '文章', markdown: '正文', status: 'draft', ...overrides }; }
function response(data: unknown, status = 200): Response { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
function fixture(includeSizes = true) {
  const files = new Map<string, { sha: string; content: string }>();
  let revision = 1;
  const nextHead = () => { revision++; };
  const cache = new Map<string, string>();
  const media = { get: vi.fn(async (key: string) => cache.has(key) ? { json: async () => JSON.parse(cache.get(key)!) } : null), put: vi.fn(async (key: string, value: string) => { cache.set(key, value); }), delete: vi.fn(async (key: string) => { cache.delete(key); }) };
  const env = { GITHUB_OWNER: 'owner', GITHUB_REPO: 'blog', GITHUB_BRANCH: 'main', POSTS_DIRECTORY: 'content/posts', GITHUB_TOKEN: 'TOP_SECRET', MEDIA: media } as unknown as Env;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/graphql') {
      const variables = JSON.parse(init?.body as string).variables; const repository: Record<string, unknown> = {};
      for (const [key, requestedSha] of Object.entries(variables)) {
        if (!/^s\d+$/.test(key)) continue;
        const file = [...files.values()].find((item) => item.sha === requestedSha);
        repository[key.replace(/^s/, 'b')] = file ? { oid: file.sha, byteSize: Buffer.byteLength(file.content), isBinary: false, isTruncated: false, text: file.content } : null;
      }
      return response({ data: { repository } });
    }
    if (url.pathname.includes('/git/ref/heads/')) return response({ object: { type: 'commit', sha: revision.toString(16).padStart(40, '0') } });
    if (url.pathname.includes('/git/trees/')) return response({ truncated: false, tree: Array.from(files, ([path, file]) => ({ path, type: 'blob', sha: file.sha, ...(includeSizes ? { size: Buffer.byteLength(file.content) } : {}) })) });
    if (url.pathname.includes('/git/blobs/')) { const file = [...files.values()].find((item) => item.sha === url.pathname.split('/').at(-1)); return file ? response({ encoding: 'base64', content: Buffer.from(file.content).toString('base64') }) : response({}, 404); }
    const path = decodeURIComponent(url.pathname.split('/contents/')[1]);
    const file = files.get(path);
    if (!init?.method || init.method === 'GET') return file ? response({ type: 'file', encoding: 'base64', sha: file.sha, content: Buffer.from(file.content).toString('base64') }) : response({}, 404);
    const body = JSON.parse(init.body as string);
    if (init.method === 'PUT') {
      if ((file && body.sha !== file.sha) || (!file && body.sha)) return response({ message: 'sensitive' }, 409);
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      files.set(path, { sha: changedSha, content }); nextHead();
      return response({ content: { sha: changedSha }, commit: { sha: commitSha } }, file ? 200 : 201);
    }
    if (!file || body.sha !== file.sha) return response({}, 409);
    files.delete(path); nextHead(); return response({ commit: { sha: commitSha } });
  });
  return { files, cache, media, env, fetcher, nextHead, posts: new GithubPosts(env, fetcher as typeof fetch) };
}

describe('GitHub article source format', () => {
  it('roundtrips Chinese YAML, tags, URLs, and exact Markdown whitespace', () => {
    const post = basePost({ title: 'false: 中文\n第二行', cover: 'https://media.example.com/%E4%B8%AD.webp', mediaIds: ['12345678-1234-4234-8234-123456789abc'] });
    expect(parsePost(post.slug, post.sha, serializePost(post))).toEqual(post);
  });
  it('rejects duplicate or malicious YAML frontmatter without exposing its content', () => {
    const source = serializePost(basePost()).replace('schemaVersion: 1', 'schemaVersion: 1\nschemaVersion: 2\nsecret: TOP_SECRET');
    expect(() => parsePost('hello', originalSha, source)).toThrow('An article file has invalid metadata or content.');
    try { parsePost('hello', originalSha, source); } catch (error) { expect(String(error)).not.toContain('TOP_SECRET'); }
  });
  it('requires a SHA and rejects unsupported input, malformed media IDs, and oversized Unicode', () => {
    for (const invalid of [ { title: 'Title', markdown: '', status: 'draft' }, createInput({ sha: '' }), { ...createInput(), owner: 'attacker' }, createInput({ tags: ['x', 'x'] }), createInput({ mediaIds: ['../secrets'] }), createInput({ cover: 'javascript:alert(1)' }), createInput({ markdown: '中'.repeat(180000) }), createInput({ status: 'other' as 'draft' }) ]) expect(() => validateSavePostInput(invalid)).toThrow();
  });
});

describe('GitHub article operations', () => {
  it('creates a draft with media links and then publishes while preserving creation time', async () => {
    const f = fixture();
    const draft = await f.posts.savePost('first-post', createInput({ markdown: '![图](https://media.example.com/photo.webp)' }));
    expect(draft.post.status).toBe('draft'); expect(draft.post.publishedAt).toBeNull();
    expect(draft.post.sha).toBe(changedSha); expect(draft.commitSha).toBe(commitSha);
    const published = await f.posts.savePost('first-post', createInput({ sha: draft.post.sha, status: 'published' }));
    expect(published.post.createdAt).toBe(draft.post.createdAt); expect(published.post.publishedAt).not.toBeNull();
    const roundtrip = await f.posts.getPost('first-post'); expect(roundtrip).toEqual(published.post);
  });
  it('does not blind overwrite existing articles or create missing articles with an old SHA', async () => {
    const f = fixture(); f.files.set('content/posts/hello.md', { sha: originalSha, content: serializePost(basePost()) });
    for (const input of [createInput(), createInput({ sha: changedSha })]) await expect(f.posts.savePost('hello', input)).rejects.toMatchObject({ status: 409, code: 'POST_CONFLICT' });
    await expect(f.posts.savePost('missing', createInput({ sha: originalSha }))).rejects.toMatchObject({ code: 'POST_CONFLICT' });
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method !== 'PUT')).toBe(true);
  });
  it('rejects traversal before accessing GitHub', async () => {
    const f = fixture();
    for (const slug of ['../secret', 'hello/world', '%2e%2e', 'Uppercase', '-bad', 'a'.repeat(81)]) {
      await expect(f.posts.getPost(slug)).rejects.toMatchObject({ code: 'INVALID_SLUG' });
      await expect(f.posts.savePost(slug, createInput())).rejects.toMatchObject({ code: 'INVALID_SLUG' });
      await expect(f.posts.deletePost(slug, originalSha)).rejects.toMatchObject({ code: 'INVALID_SLUG' });
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('checks current commit before index cache hits and always reads editor content fresh', async () => {
    const f = fixture(); f.files.set('content/posts/hello.md', { sha: originalSha, content: serializePost(basePost()) });
    const initial = await f.posts.listPosts(); expect(initial[0].status).toBe('draft');
    f.fetcher.mockClear();
    expect((await f.posts.listPosts())[0].title).toBe('中文文章：你好');
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(String(f.fetcher.mock.calls[0][0])).toContain('/git/ref/heads/main');
    f.files.set('content/posts/hello.md', { sha: changedSha, content: serializePost(basePost({ title: 'Updated', sha: changedSha, status: 'published', publishedAt: '2026-10-02T10:00:00.000Z' })) }); f.nextHead();
    expect((await f.posts.listPosts())[0].title).toBe('Updated');
    expect((await f.posts.getPost('hello'))?.title).toBe('Updated');
    expect((await f.posts.listPosts(true))[0].status).toBe('published');
  });
  it('invalidates list cache after save and delete', async () => {
    const f = fixture(); f.files.set('content/posts/hello.md', { sha: originalSha, content: serializePost(basePost()) });
    await f.posts.listPosts(); expect(f.cache.size).toBe(1);
    await f.posts.savePost('hello', createInput({ sha: originalSha, title: 'New title' })); expect(f.cache.size).toBe(0);
    expect((await f.posts.listPosts())[0].title).toBe('New title');
    await f.posts.deletePost('hello', changedSha); expect(f.cache.size).toBe(0); expect(await f.posts.listPosts()).toEqual([]);
  });
  it('keeps successful commits successful when R2 cache operations fail', async () => {
    const f = fixture(); f.media.get.mockRejectedValue(new Error('R2 unavailable')); f.media.put.mockRejectedValue(new Error('R2 unavailable')); f.media.delete.mockRejectedValue(new Error('R2 unavailable'));
    expect(await f.posts.listPosts()).toEqual([]);
    await expect(f.posts.savePost('hello', createInput())).resolves.toMatchObject({ commitSha });
    await expect(f.posts.deletePost('hello', changedSha)).resolves.toEqual({ commitSha });
  });
  it('cannot reuse an old published cache after a withdrawal commit', async () => {
    const f = fixture(); f.files.set('content/posts/hello.md', { sha: originalSha, content: serializePost(basePost({ status: 'published', publishedAt: '2026-10-02T10:00:00.000Z' })) });
    await f.posts.listPosts(); const oldKey = [...f.cache.keys()][0]; const oldCache = f.cache.get(oldKey)!;
    // A separate GitHub editor changes the branch without calling this Worker's invalidation.
    f.files.set('content/posts/hello.md', { sha: changedSha, content: serializePost(basePost({ sha: changedSha, status: 'draft' })) }); f.nextHead();
    expect((await f.posts.listPosts()).filter((post) => post.status === 'published')).toEqual([]);
    // Simulate an old in-flight refresh completing after the withdrawal.
    f.cache.set(oldKey, oldCache);
    expect((await new GithubPosts(f.env, f.fetcher as typeof fetch).listPosts()).filter((post) => post.status === 'published')).toEqual([]);
  });
  it('does not serve an old cached index when GitHub access is unavailable', async () => {
    const f = fixture(); f.files.set('content/posts/hello.md', { sha: originalSha, content: serializePost(basePost()) }); await f.posts.listPosts();
    const unavailable = vi.fn(async () => new Response('TOP_SECRET', { status: 500 }));
    await expect(new GithubPosts(f.env, unavailable as typeof fetch).listPosts()).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' });
  });
  it('rejects oversized aggregate source metadata before downloading article bodies', async () => {
    const f = fixture();
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/git/ref/') ? response({ object: { type: 'commit', sha: commitSha } }) : response({ truncated: false, tree: Array.from({ length: 100 }, (_, index) => ({ type: 'blob', path: `content/posts/post-${index}.md`, sha: originalSha, size: 512 * 1024 })) }));
    await expect(new GithubPosts(f.env, fetcher as typeof fetch).listPosts()).rejects.toMatchObject({ code: 'POST_INDEX_TOO_LARGE' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([true, false])('batches 500 sources inside Workers Free subrequest limits with size metadata %s', async (includeSizes) => {
    const f = fixture(includeSizes); let active = 0; let maximum = 0;
    for (let index = 0; index < 500; index++) f.files.set(`content/posts/post-${index}.md`, { sha: index.toString(16).padStart(40, '0'), content: serializePost(basePost({ slug: `post-${index}` })) });
    const realFetch = f.fetcher;
    const concurrentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/graphql')) return realFetch(input, init);
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try { return await realFetch(input, init); } finally { active--; }
    });
    expect(await new GithubPosts(f.env, concurrentFetch as typeof fetch).listPosts()).toHaveLength(500); expect(maximum).toBe(1);
    expect(concurrentFetch.mock.calls.length).toBeLessThanOrEqual(includeSizes ? 27 : 46);
    for (let index = 500; index < 501; index++) f.files.set(`content/posts/post-${index}.md`, { sha: index.toString(16).padStart(40, '0'), content: '' });
    await expect(f.posts.listPosts(true)).rejects.toMatchObject({ code: 'POST_INDEX_TOO_LARGE' });
  });
  it('reads legal large articles even when JSON escaping expands the GraphQL response', async () => {
    const f = fixture();
    for (let index = 0; index < 19; index++) {
      const content = serializePost(basePost({ markdown: '\t'.repeat(512 * 1024) }));
      f.files.set(`content/posts/large-${index}.md`, { sha: index.toString(16).padStart(40, '0'), content });
    }
    expect(await f.posts.listPosts()).toHaveLength(19);
  });
  it('bounds the actual serialized index including escaped tabs before saving to R2', async () => {
    const f = fixture();
    for (let index = 0; index < 65; index++) {
      const content = serializePost(basePost({ markdown: '\t'.repeat(256 * 1024) }));
      f.files.set(`content/posts/large-${index}.md`, { sha: index.toString(16).padStart(40, '0'), content });
    }
    await expect(f.posts.listPosts()).rejects.toMatchObject({ code: 'POST_INDEX_TOO_LARGE' });
    expect(f.media.put).not.toHaveBeenCalled();
  });
});
