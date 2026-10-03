import { parseDocument, stringify } from 'yaml';
import { type Env, type Post, type PostMutation, type SavePostInput } from './types';
import { GitHubClient, GITHUB_BLOB_BATCH_SIZE, GITHUB_BLOB_BATCH_BYTES, repositoryConfig, validSha } from './github';
import { ApiError, UUID_PATTERN } from './http';

const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_POSTS = 500;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const LEGACY_CACHE_KEY = '.mob/content-index.json';
const ALLOWED_INPUT = new Set(['sha', 'title', 'markdown', 'status', 'description', 'tags', 'cover', 'mediaIds']);
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const encoder = new TextEncoder();

export function validateSlug(slug: string): void {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) throw new ApiError(400, 'INVALID_SLUG', 'Article slug must contain 1 to 80 lowercase letters, digits, or hyphens and start and end with a letter or digit.');
}
function invalid(message: string): never { throw new ApiError(400, 'INVALID_INPUT', message); }
function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Article input must be an object.');
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim()) || /[\x00]/.test(value)) invalid(`${label} must be a string of at most ${maximum} characters${required ? ' and cannot be empty' : ''}.`);
  return value as string;
}
function stringArray(value: unknown, label: string, maximum: number, itemMaximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} must be an array with at most ${maximum} items.`);
  const result = value.map((item) => boundedString(item, label, itemMaximum, true));
  if (new Set(result).size !== result.length) invalid(`${label} must not contain duplicates.`);
  return result;
}
function coverUrl(value: unknown): string | null {
  if (value === null) return null;
  const cover = boundedString(value, 'cover', 2048, true);
  try { const url = new URL(cover); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid('cover must be an absolute HTTP or HTTPS URL without credentials.'); }
  catch { invalid('cover must be an absolute HTTP or HTTPS URL without credentials.'); }
  return cover;
}
function validateMetadata(value: Record<string, unknown>): Pick<Post, 'title' | 'markdown' | 'description' | 'tags' | 'status' | 'cover' | 'mediaIds'> {
  const title = boundedString(value.title, 'title', 200, true);
  if (typeof value.markdown !== 'string' || encoder.encode(value.markdown).byteLength > MAX_MARKDOWN_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value.markdown)) invalid('markdown must contain at most 512 KiB of UTF-8 text.');
  if (value.status !== 'draft' && value.status !== 'published') invalid('status must be draft or published.');
  const tags = stringArray(value.tags ?? [], 'tags', 20, 64);
  const mediaIds = stringArray(value.mediaIds ?? [], 'mediaIds', 200, 36);
  if (!mediaIds.every((id) => UUID_PATTERN.test(id))) invalid('mediaIds must contain valid version 4 UUIDs.');
  return { title, markdown: value.markdown, status: value.status, description: boundedString(value.description ?? '', 'description', 2000), tags, cover: coverUrl(value.cover ?? null), mediaIds };
}
export function validateSavePostInput(value: unknown): SavePostInput {
  const input = plainObject(value);
  if (Object.keys(input).some((key) => !ALLOWED_INPUT.has(key))) invalid('Article input contains unsupported fields.');
  if (input.sha !== null && !validSha(input.sha)) invalid('sha is required: use null to create or the current 40-character file SHA to update.');
  return { ...validateMetadata(input), sha: input.sha as string | null };
}
function isoDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('Article dates must be ISO 8601 UTC timestamps.');
  return value;
}
export function serializePost(post: Post): string {
  const metadata = { schemaVersion: 1, title: post.title, description: post.description, tags: post.tags, status: post.status, createdAt: post.createdAt, updatedAt: post.updatedAt, publishedAt: post.publishedAt, cover: post.cover, mediaIds: post.mediaIds };
  return `---\n${stringify(metadata, { lineWidth: 0 })}---\n\n${post.markdown}`;
}
export function parsePost(slug: string, sha: string, source: string): Post {
  try {
    validateSlug(slug);
    if (!validSha(sha) || encoder.encode(source).byteLength > MAX_MARKDOWN_BYTES + 64 * 1024) invalid('Article file is invalid or too large.');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (!match || match[1].length > 64 * 1024) invalid('Article YAML frontmatter is required.');
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length) invalid('Article YAML frontmatter is invalid.');
    const metadata = plainObject(document.toJS({ maxAliasCount: 20 }));
    if (metadata.schemaVersion !== 1) invalid('Unsupported article schema version.');
    let markdown = source.slice(match[0].length);
    // Serialization adds one separator line; everything after it belongs to the author.
    if (markdown.startsWith('\r\n')) markdown = markdown.slice(2); else if (markdown.startsWith('\n')) markdown = markdown.slice(1);
    const fields = validateMetadata({ ...metadata, markdown });
    const createdAt = isoDate(metadata.createdAt); const updatedAt = isoDate(metadata.updatedAt);
    const publishedAt = metadata.publishedAt === null ? null : isoDate(metadata.publishedAt);
    if (fields.status === 'published' && !publishedAt) invalid('Published articles need a publication timestamp.');
    return { slug, sha, ...fields, createdAt, updatedAt, publishedAt };
  } catch { throw new ApiError(422, 'INVALID_POST_CONTENT', 'An article file has invalid metadata or content.'); }
}

/** GitHub is authoritative; R2 keeps only a disposable, short-lived content index. */
export class GithubPosts {
  private readonly github: GitHubClient;
  private readonly directory: string;
  private readonly namespace: string;
  private readonly cacheKeys = new Set<string>();
  constructor(private readonly env: Env, fetcher: typeof fetch = fetch) {
    const config = repositoryConfig(env);
    this.directory = config.directory;
    this.namespace = `${config.owner}/${config.repo}/${config.branch}/${config.directory}`;
    this.github = new GitHubClient(env, fetcher);
  }
  private cacheSeconds(): number {
    const value = Number(this.env.INDEX_CACHE_SECONDS ?? '30');
    return Number.isFinite(value) && value >= 0 && value <= 3600 ? value : 30;
  }
  private async cachedIndex(head: string): Promise<Post[] | null> {
    if (this.cacheSeconds() === 0) return null;
    try {
      const key = this.cacheKey(head);
      const cached = await this.env.MEDIA.get(key);
      if (!cached) return null;
      const data = await cached.json<{ version: number; namespace: string; head: string; savedAt: number; posts: Post[] }>();
      if (data.version !== 1 || data.head !== head || data.namespace !== this.namespace || !Number.isFinite(data.savedAt) || data.savedAt > Date.now() + 5000 || Date.now() - data.savedAt >= this.cacheSeconds() * 1000 || !Array.isArray(data.posts) || data.posts.length > MAX_POSTS) return null;
      for (const post of data.posts) {
        validateSlug(post.slug); if (!validSha(post.sha)) return null;
        validateMetadata(post as unknown as Record<string, unknown>); isoDate(post.createdAt); isoDate(post.updatedAt);
        if (post.publishedAt !== null) isoDate(post.publishedAt);
        if (post.status === 'published' && !post.publishedAt) return null;
      }
      this.cacheKeys.add(key);
      return data.posts;
    } catch { return null; }
  }
  private cacheKey(head: string): string { return `.mob/index/${head}.json`; }
  private async invalidateCache(): Promise<void> {
    // Old commit caches are immutable and harmless; remove locally observed ones opportunistically.
    for (const key of [LEGACY_CACHE_KEY, ...this.cacheKeys]) {
      try { await this.env.MEDIA.delete(key); } catch { /* A cache outage cannot reverse a successful GitHub commit. */ }
    }
    this.cacheKeys.clear();
  }
  async listPosts(force = false): Promise<Post[]> {
    // Always check branch head. A cached published article must disappear as soon as its withdrawal commits.
    const head = await this.github.readHead();
    if (head === null) return [];
    if (!force) { const cached = await this.cachedIndex(head); if (cached) return cached; }
    const prefix = `${this.directory}/`;
    const entries = (await this.github.readTree(head)).filter((entry) => entry.path.startsWith(prefix) && entry.path.endsWith('.md'));
    if (entries.length > MAX_POSTS) throw new ApiError(502, 'POST_INDEX_TOO_LARGE', 'The article directory exceeds the supported limit of 500 articles.');
    if (entries.reduce((total, entry) => total + (entry.size ?? 0), 0) > MAX_INDEX_BYTES) throw new ApiError(502, 'POST_INDEX_TOO_LARGE', 'Article sources exceed the supported total size of 32 MiB.');
    for (const entry of entries) {
      try { validateSlug(entry.path.slice(prefix.length, -3)); } catch { throw new ApiError(422, 'INVALID_POST_CONTENT', 'Article filenames must be valid slugs in the configured article directory.'); }
    }
    const posts: Post[] = []; let totalSourceBytes = 0;
    // Small articles still use batches of 20. At the maximum supported file size,
    // at least 12 fit: 500 articles need at most 42 reads + HEAD + tree.
    // Bound source bytes as well as count, since JSON can double the source size.
    for (let offset = 0; offset < entries.length;) {
      let end = offset; let batchBytes = 0;
      while (end < entries.length && end - offset < GITHUB_BLOB_BATCH_SIZE) {
        const size = entries[end].size ?? MAX_MARKDOWN_BYTES + 64 * 1024;
        if (end > offset && batchBytes + size > GITHUB_BLOB_BATCH_BYTES) break;
        batchBytes += size; end++;
      }
      const batch = entries.slice(offset, end); offset = end;
      const sources = await this.github.readBlobs(batch.map((entry) => entry.sha));
      for (const entry of batch) {
        const source = sources.get(entry.sha)!;
        totalSourceBytes += encoder.encode(source).byteLength;
        if (totalSourceBytes > MAX_INDEX_BYTES) throw new ApiError(502, 'POST_INDEX_TOO_LARGE', 'Article sources exceed the supported total size of 32 MiB.');
        posts.push(parsePost(entry.path.slice(prefix.length, -3), entry.sha, source));
      }
    }
    posts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug));
    const envelope = { version: 1, namespace: this.namespace, head, savedAt: Date.now(), posts };
    let serializedBytes = encoder.encode(JSON.stringify({ ...envelope, posts: [] })).byteLength;
    for (const [index, post] of posts.entries()) {
      // Serialize only one bounded article at a time. This counts every JSON
      // escape, including tabs, before allocating the complete index.
      serializedBytes += encoder.encode(JSON.stringify(post)).byteLength + (index > 0 ? 1 : 0);
      if (serializedBytes > MAX_INDEX_BYTES) throw new ApiError(502, 'POST_INDEX_TOO_LARGE', 'The serialized article index exceeds the supported size of 32 MiB.');
    }
    const serialized = JSON.stringify(envelope);
    if (this.cacheSeconds() > 0) {
      try {
        const key = this.cacheKey(head);
        await this.env.MEDIA.put(key, serialized, { httpMetadata: { contentType: 'application/json' } });
        this.cacheKeys.add(key);
      }
      catch { /* Reads remain available when the optional cache is unavailable. */ }
    }
    return posts;
  }
  async getPost(slug: string): Promise<Post | null> {
    validateSlug(slug);
    const file = await this.github.readFile(`${this.directory}/${slug}.md`);
    return file ? parsePost(slug, file.sha, file.content) : null;
  }
  async savePost(slug: string, value: SavePostInput): Promise<PostMutation> {
    validateSlug(slug);
    const input = validateSavePostInput(value);
    const existing = await this.getPost(slug);
    if ((input.sha === null && existing !== null) || (input.sha !== null && existing?.sha !== input.sha)) throw new ApiError(409, 'POST_CONFLICT', 'The article changed. Reload it before saving.');
    const now = new Date().toISOString();
    const post: Post = { slug, sha: input.sha ?? '', title: input.title, markdown: input.markdown, status: input.status, description: input.description ?? '', tags: input.tags ?? [], cover: input.cover ?? null, mediaIds: input.mediaIds ?? [], createdAt: existing?.createdAt ?? now, updatedAt: now, publishedAt: existing?.publishedAt ?? (input.status === 'published' ? now : null) };
    const result = await this.github.writeFile(`${this.directory}/${slug}.md`, serializePost(post), input.sha, `blog: ${existing ? 'update' : 'create'} ${slug}`);
    await this.invalidateCache();
    return { post: { ...post, sha: result.sha }, commitSha: result.commitSha };
  }
  async deletePost(slug: string, sha: string): Promise<{ commitSha: string }> {
    validateSlug(slug);
    if (!validSha(sha)) throw new ApiError(400, 'INVALID_SHA', 'The current 40-character file SHA is required.');
    const result = await this.github.deleteFile(`${this.directory}/${slug}.md`, sha, `blog: delete ${slug}`);
    await this.invalidateCache();
    return result;
  }
}
