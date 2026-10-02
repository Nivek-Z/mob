import { describe, expect, it, vi } from 'vitest';
import { GitHubClient, GITHUB_API_VERSION, repositoryConfig } from '../src/github';
import type { Env } from '../src/types';

const sha = 'a'.repeat(40); const commitSha = 'c'.repeat(40);
function env(overrides: Partial<Env> = {}): Env {
  return { GITHUB_OWNER: 'owner', GITHUB_REPO: 'blog', GITHUB_BRANCH: 'main', POSTS_DIRECTORY: 'content/posts', GITHUB_TOKEN: 'TOP_SECRET', ...overrides } as Env;
}
function response(data: unknown, status = 200, headers: Record<string, string> = {}): Response { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } }); }

describe('GitHub repository client', () => {
  it('uses fixed GitHub headers and preserves UTF-8 article content', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ type: 'file', encoding: 'base64', sha, content: Buffer.from('中文文章\n😀').toString('base64') }));
    const client = new GitHubClient(env(), fetcher as typeof fetch);
    expect(await client.readFile('content/posts/hello.md')).toEqual({ sha, content: '中文文章\n😀' });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/owner/blog/contents/content/posts/hello.md?ref=main');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer TOP_SECRET', 'X-GitHub-Api-Version': GITHUB_API_VERSION, Accept: 'application/vnd.github+json' });
  });
  it('writes base64 UTF-8 using only the configured branch and repository', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ content: { sha }, commit: { sha: commitSha } }, 201));
    const result = await new GitHubClient(env({ GITHUB_BRANCH: 'articles/main' }), fetcher as typeof fetch).writeFile('content/posts/hello.md', '你好世界', null, 'blog: create hello');
    expect(result).toEqual({ sha, commitSha });
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string);
    expect(body.branch).toBe('articles/main'); expect(body).not.toHaveProperty('sha');
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe('你好世界');
  });
  it('does not disclose credentials or upstream errors', async () => {
    const fetcher = vi.fn(async () => new Response('TOP_SECRET internal private repository details', { status: 403 }));
    await expect(new GitHubClient(env(), fetcher as typeof fetch).readTree()).rejects.toMatchObject({ code: 'GITHUB_ACCESS_DENIED', status: 503 });
    try { await new GitHubClient(env(), fetcher as typeof fetch).readTree(); } catch (error) { expect(String(error)).not.toContain('TOP_SECRET'); expect(String(error)).not.toContain('private repository details'); }
    const throwing = vi.fn(async () => { throw new Error('fetch failed Authorization TOP_SECRET'); });
    await expect(new GitHubClient(env(), throwing as typeof fetch).readTree()).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' });
  });
  it('maps upstream write races to a safe conflict response', async () => {
    for (const status of [409, 422]) {
      const fetcher = vi.fn(async () => new Response('sensitive details', { status }));
      await expect(new GitHubClient(env(), fetcher as typeof fetch).writeFile('content/posts/test.md', 'text', sha, 'update')).rejects.toMatchObject({ code: 'POST_CONFLICT', status: 409 });
    }
  });
  it('recognizes rate limits without returning the upstream payload', async () => {
    const fetcher = vi.fn(async () => response({ message: 'TOP_SECRET' }, 403, { 'x-ratelimit-remaining': '0' }));
    await expect(new GitHubClient(env(), fetcher as typeof fetch).readTree()).rejects.toMatchObject({ code: 'GITHUB_RATE_LIMITED', status: 503 });
  });
  it('reads the latest branch head and pins index trees to an immutable commit', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/git/ref/') ? response({ object: { type: 'commit', sha } }) : response({ tree: [], truncated: false }));
    const client = new GitHubClient(env({ GITHUB_BRANCH: 'feature/articles' }), fetcher as typeof fetch);
    expect(await client.readHead()).toBe(sha); await client.readTree(sha);
    expect(String(fetcher.mock.calls[0][0])).toContain('/git/ref/heads/feature/articles');
    expect(String(fetcher.mock.calls[1][0])).toContain(`/git/trees/${sha}?recursive=1`);
  });
  it('returns an empty tree for an empty repository and rejects truncation', async () => {
    await expect(new GitHubClient(env(), vi.fn(async () => new Response(null, { status: 409 })) as typeof fetch).readTree()).resolves.toEqual([]);
    await expect(new GitHubClient(env(), vi.fn(async () => response({ tree: [], truncated: true })) as typeof fetch).readTree()).rejects.toMatchObject({ code: 'POST_INDEX_TOO_LARGE' });
  });
  it('rejects unsafe configured paths and refuses writes without a secret', async () => {
    for (const path of ['../posts', '/posts', 'content//posts', 'content/posts/..', 'content\\posts']) expect(() => repositoryConfig(env({ POSTS_DIRECTORY: path }))).toThrow();
    const fetcher = vi.fn(async () => response({}));
    await expect(new GitHubClient(env({ GITHUB_TOKEN: undefined }), fetcher as typeof fetch).writeFile('content/posts/test.md', 'text', null, 'create')).rejects.toMatchObject({ code: 'GITHUB_NOT_CONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses bounded GraphQL blob queries with the configured repository and validates complete UTF-8 text', async () => {
    const source = '中文正文';
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({ data: { repository: { b0: { oid: sha, byteSize: Buffer.byteLength(source), isBinary: false, isTruncated: false, text: source } } } }));
    expect(await new GitHubClient(env(), fetcher as typeof fetch).readBlobs([sha])).toEqual(new Map([[sha, source]]));
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/graphql');
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string);
    expect(body.variables).toEqual({ owner: 'owner', repo: 'blog', s0: sha }); expect(body.query).toContain('isTruncated');
    await expect(new GitHubClient(env({ GITHUB_TOKEN: undefined }), fetcher as typeof fetch).readBlobs([sha])).rejects.toMatchObject({ code: 'GITHUB_NOT_CONFIGURED' });
  });
  it('rejects partial, truncated, or sensitive GraphQL error responses', async () => {
    const bad = vi.fn(async () => response({ errors: [{ type: 'FORBIDDEN', message: 'TOP_SECRET private details' }] }));
    try { await new GitHubClient(env(), bad as typeof fetch).readBlobs([sha]); throw new Error('Expected failure'); } catch (error) { expect(String(error)).not.toContain('TOP_SECRET'); }
    const truncated = vi.fn(async () => response({ data: { repository: { b0: { oid: sha, byteSize: 3, isBinary: false, isTruncated: true, text: 'abc' } } } }));
    await expect(new GitHubClient(env(), truncated as typeof fetch).readBlobs([sha])).rejects.toMatchObject({ code: 'GITHUB_INVALID_RESPONSE' });
  });
  it('rejects malformed and non-UTF-8 GitHub content responses', async () => {
    const fetcher = vi.fn(async () => response({ type: 'file', sha, encoding: 'base64', content: '/w==' }));
    await expect(new GitHubClient(env(), fetcher as typeof fetch).readFile('content/posts/test.md')).rejects.toMatchObject({ code: 'GITHUB_INVALID_RESPONSE' });
  });
});
