import { type Env } from './types';
import { ApiError } from './http';

export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_BLOB_BATCH_SIZE = 20;
// Reserve room for JSON escapes and GraphQL metadata within the 16 MiB response bound.
export const GITHUB_BLOB_BATCH_BYTES = 7 * 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
export interface RepositoryFile { sha: string; content: string; }
export interface TreeEntry { path: string; sha: string; size?: number; }
export interface FileMutation { sha: string; commitSha: string; }

export function validSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

export function repositoryConfig(env: Env): { owner: string; repo: string; branch: string; directory: string } {
  const segment = /^[a-zA-Z0-9_.-]+$/;
  if (![env.GITHUB_OWNER, env.GITHUB_REPO].every((value) => typeof value === 'string' && segment.test(value) && value !== '.' && value !== '..')
    || typeof env.GITHUB_BRANCH !== 'string' || !env.GITHUB_BRANCH.trim() || env.GITHUB_BRANCH.length > 255 || /[\x00-\x20\\]/.test(env.GITHUB_BRANCH)
    || typeof env.POSTS_DIRECTORY !== 'string' || env.POSTS_DIRECTORY.length > 256
    || !env.POSTS_DIRECTORY.split('/').every((part) => /^[a-zA-Z0-9_-]+$/.test(part))) {
    throw new ApiError(503, 'GITHUB_NOT_CONFIGURED', 'The article repository is not configured correctly.');
  }
  return { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH, directory: env.POSTS_DIRECTORY };
}

function encodePath(path: string): string { return path.split('/').map(encodeURIComponent).join('/'); }
function base64Encode(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function base64Decode(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 * 1024) throw upstreamError();
  try {
    const binary = atob(value.replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw upstreamError(); }
}
function upstreamError(): ApiError { return new ApiError(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected response.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw upstreamError();
  return value as Record<string, unknown>;
}

/** GitHub credentials and repository identity never come from a browser request. */
export class GitHubClient {
  private readonly config: ReturnType<typeof repositoryConfig>;
  private readonly baseUrl: string;
  constructor(private readonly env: Env, private readonly fetcher: typeof fetch = fetch) {
    this.config = repositoryConfig(env);
    this.baseUrl = `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
  }
  private async request(path: string, method = 'GET', body?: unknown, apiRoot = false): Promise<Response> {
    if (method !== 'GET' && !this.env.GITHUB_TOKEN?.trim()) throw new ApiError(503, 'GITHUB_NOT_CONFIGURED', 'GitHub write access is not configured.');
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': GITHUB_API_VERSION, 'User-Agent': 'mob-blog-worker',
    };
    if (this.env.GITHUB_TOKEN?.trim()) headers.Authorization = `Bearer ${this.env.GITHUB_TOKEN.trim()}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      // Workers native fetch rejects an unrelated receiver. Calling it as
      // this.fetcher(...) would supply this GitHubClient as the receiver.
      response = await this.fetcher.call(globalThis, `${apiRoot ? 'https://api.github.com' : this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    } catch (error) {
      const timeout = (error instanceof Error || error instanceof DOMException) && ['TimeoutError', 'AbortError'].includes(error.name);
      const invocation = error instanceof Error && error.message.includes('Illegal invocation');
      const code = timeout ? 'GITHUB_TIMEOUT' : invocation ? 'GITHUB_REQUEST_FAILED' : 'GITHUB_UNAVAILABLE';
      // Never log headers, the token, upstream response bodies or raw exception messages.
      console.error(JSON.stringify({ event: 'github_request_failed', code, method }));
      if (timeout) throw new ApiError(504, code, 'The GitHub request timed out. Try again later.');
      if (invocation) throw new ApiError(503, code, 'The Worker could not start the GitHub request. Check the runtime logs.');
      throw new ApiError(502, code, 'GitHub is temporarily unavailable.');
    }
    if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
      throw new ApiError(503, 'GITHUB_RATE_LIMITED', 'GitHub rate limits have been reached. Try again later.');
    }
    if (response.status === 401 || response.status === 403) throw new ApiError(503, 'GITHUB_ACCESS_DENIED', 'The configured GitHub credential cannot access this repository.');
    if (response.status >= 500) {
      console.error(JSON.stringify({ event: 'github_upstream_error', method, status: response.status }));
      throw new ApiError(502, 'GITHUB_UNAVAILABLE', 'GitHub is temporarily unavailable.');
    }
    return response;
  }
  private async data(response: Response, maximumBytes = 4 * 1024 * 1024): Promise<Record<string, unknown>> {
    // Bound upstream allocations; neither GitHub trees nor batched sources may consume the whole Worker heap.
    if (!response.body) throw upstreamError();
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) { await reader.cancel(); throw upstreamError(); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch { throw upstreamError(); } finally { reader.releaseLock(); }
  }
  async readFile(path: string, ref = this.config.branch): Promise<RepositoryFile | null> {
    const response = await this.request(`/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw upstreamError();
    const data = await this.data(response);
    if (data.type !== 'file' || data.encoding !== 'base64' || !validSha(data.sha)) throw upstreamError();
    return { sha: data.sha, content: base64Decode(data.content) };
  }
  async readHead(): Promise<string | null> {
    const response = await this.request(`/git/ref/heads/${encodePath(this.config.branch)}`);
    if (response.status === 409) return null;
    if (response.status === 404) throw new ApiError(503, 'GITHUB_REPOSITORY_UNAVAILABLE', 'The configured GitHub repository or branch is unavailable.');
    if (!response.ok) throw upstreamError();
    const object = record((await this.data(response)).object);
    if (object.type !== 'commit' || !validSha(object.sha)) throw upstreamError();
    return object.sha;
  }
  async readTree(head = this.config.branch): Promise<TreeEntry[]> {
    const response = await this.request(`/git/trees/${encodeURIComponent(head)}?recursive=1`);
    // GitHub returns 409 for a repository with no commits.
    if (response.status === 409) return [];
    if (response.status === 404) throw new ApiError(503, 'GITHUB_REPOSITORY_UNAVAILABLE', 'The configured GitHub repository or branch is unavailable.');
    if (!response.ok) throw upstreamError();
    const data = await this.data(response);
    if (data.truncated === true) throw new ApiError(502, 'POST_INDEX_TOO_LARGE', 'GitHub returned a truncated repository index. Reduce repository size before listing articles.');
    if (!Array.isArray(data.tree)) throw upstreamError();
    return data.tree.flatMap((value) => {
      const entry = record(value);
      if (entry.type !== 'blob') return [];
      if (typeof entry.path !== 'string' || !validSha(entry.sha)) throw upstreamError();
      const size = typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : undefined;
      return [{ path: entry.path, sha: entry.sha, ...(size === undefined ? {} : { size }) }];
    });
  }
  async readBlob(sha: string): Promise<string> {
    if (!validSha(sha)) throw new ApiError(400, 'INVALID_SHA', 'A valid article SHA is required.');
    const response = await this.request(`/git/blobs/${sha}`);
    if (!response.ok) throw upstreamError();
    const data = await this.data(response);
    if (data.encoding !== 'base64') throw upstreamError();
    return base64Decode(data.content);
  }
  async readBlobs(shas: string[]): Promise<Map<string, string>> {
    if (shas.length > GITHUB_BLOB_BATCH_SIZE || !shas.every(validSha)) throw new ApiError(400, 'INVALID_SHA', `Blob batches must contain at most ${GITHUB_BLOB_BATCH_SIZE} valid article SHAs.`);
    if (!shas.length) return new Map();
    if (!this.env.GITHUB_TOKEN?.trim()) throw new ApiError(503, 'GITHUB_NOT_CONFIGURED', 'GitHub authentication is required for batched article reads.');
    const definitions = shas.map((_, index) => `$s${index}: GitObjectID!`).join(', ');
    const selections = shas.map((_, index) => `b${index}: object(oid: $s${index}) { ... on Blob { oid byteSize isBinary isTruncated text } }`).join('\n');
    const query = `query ($owner: String!, $repo: String!, ${definitions}) { repository(owner: $owner, name: $repo) { ${selections} } }`;
    const variables: Record<string, string> = { owner: this.config.owner, repo: this.config.repo };
    shas.forEach((sha, index) => { variables[`s${index}`] = sha; });
    const response = await this.request('/graphql', 'POST', { query, variables }, true);
    if (!response.ok) throw upstreamError();
    const payload = await this.data(response, 16 * 1024 * 1024);
    if (Array.isArray(payload.errors) && payload.errors.length) {
      const rateLimited = payload.errors.some((error) => error && typeof error === 'object' && (error as Record<string, unknown>).type === 'RATE_LIMITED');
      if (rateLimited) throw new ApiError(503, 'GITHUB_RATE_LIMITED', 'GitHub rate limits have been reached. Try again later.');
      throw new ApiError(503, 'GITHUB_ACCESS_DENIED', 'GitHub could not read the configured article objects. Check repository permissions.');
    }
    const repository = record(record(payload.data).repository);
    const results = new Map<string, string>();
    for (let index = 0; index < shas.length; index++) {
      const blob = record(repository[`b${index}`]);
      if (blob.oid !== shas[index] || blob.isBinary !== false || blob.isTruncated !== false || typeof blob.text !== 'string' || typeof blob.byteSize !== 'number' || blob.byteSize > 576 * 1024 || new TextEncoder().encode(blob.text).byteLength !== blob.byteSize) throw upstreamError();
      results.set(shas[index], blob.text);
    }
    return results;
  }
  async writeFile(path: string, content: string, sha: string | null, message: string): Promise<FileMutation> {
    const response = await this.request(`/contents/${encodePath(path)}`, 'PUT', {
      message, branch: this.config.branch, content: base64Encode(content), ...(sha === null ? {} : { sha }),
    });
    if (response.status === 409 || response.status === 422) throw new ApiError(409, 'POST_CONFLICT', 'The article changed. Reload it before saving.');
    if (!response.ok) throw upstreamError();
    const data = await this.data(response);
    const file = record(data.content); const commit = record(data.commit);
    if (!validSha(file.sha) || !validSha(commit.sha)) throw upstreamError();
    return { sha: file.sha, commitSha: commit.sha };
  }
  async deleteFile(path: string, sha: string, message: string): Promise<{ commitSha: string }> {
    const response = await this.request(`/contents/${encodePath(path)}`, 'DELETE', { message, branch: this.config.branch, sha });
    if (response.status === 409 || response.status === 422 || response.status === 404) throw new ApiError(409, 'POST_CONFLICT', 'The article changed. Reload it before deleting.');
    if (!response.ok) throw upstreamError();
    const commit = record((await this.data(response)).commit);
    if (!validSha(commit.sha)) throw upstreamError();
    return { commitSha: commit.sha };
  }
  /** Commit related JSON documents together, never exposing half-written references. */
  async writeFiles(files: { path: string; content: string | null; sha: string | null }[], message: string): Promise<{ commitSha: string; shas: Record<string, string> }> {
    if (!files.length || new Set(files.map(file => file.path)).size !== files.length || files.some(file => file.sha !== null && !validSha(file.sha))) throw new ApiError(400, 'INVALID_SHA', 'Supply unique paths and their current SHAs.');
    const head = await this.readHead();
    if (!head) throw new ApiError(503, 'GITHUB_REPOSITORY_UNAVAILABLE', 'Initialize the repository before saving settings.');
    const entries = await this.readTree(head);
    for (const file of files) {
      if ((entries.find(entry => entry.path === file.path)?.sha ?? null) !== file.sha) throw new ApiError(409, 'CONFIG_CONFLICT', 'The document changed. Reload before saving; keep your unsaved edits.');
    }
    const commitResponse = await this.request(`/git/commits/${head}`);
    if (!commitResponse.ok) throw upstreamError();
    const baseTree = record((await this.data(commitResponse)).tree).sha;
    if (!validSha(baseTree)) throw upstreamError();
    const treeResponse = await this.request('/git/trees', 'POST', { base_tree: baseTree, tree: files.map(file => ({ path: file.path, mode: '100644', type: 'blob', ...(file.content === null ? { sha: null } : { content: file.content }) })) });
    if (!treeResponse.ok) throw upstreamError();
    const treeSha = (await this.data(treeResponse)).sha;
    if (!validSha(treeSha)) throw upstreamError();
    const created = await this.request('/git/commits', 'POST', { message, tree: treeSha, parents: [head] });
    if (!created.ok) throw upstreamError();
    const commitSha = (await this.data(created)).sha;
    if (!validSha(commitSha)) throw upstreamError();
    const updated = await this.request(`/git/refs/heads/${encodePath(this.config.branch)}`, 'PATCH', { sha: commitSha, force: false });
    if ([409, 422].includes(updated.status)) throw new ApiError(409, 'CONFIG_CONFLICT', 'The repository changed during saving. Reload before retrying; keep your edits.');
    if (!updated.ok) throw upstreamError();
    const shas: Record<string, string> = {};
    for (const file of files) {
      if (file.content === null) continue;
      const body = new TextEncoder().encode(file.content);
      const prefix = new TextEncoder().encode(`blob ${body.byteLength}\0`);
      const bytes = new Uint8Array(prefix.length + body.length); bytes.set(prefix); bytes.set(body, prefix.length);
      shas[file.path] = [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return { commitSha, shas };
  }
}
