import { describe, expect, it, vi } from 'vitest';
import { BlogMutations } from '../src/coordinator';
import { createApp } from '../src/index';
import type { GithubPosts } from '../src/posts';
import { MediaService } from '../src/media';
import type { Env, Identity, Post, SavePostInput } from '../src/types';
import { FakeR2Bucket } from './fake-r2';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const state = {} as DurableObjectState;

describe('BlogMutations queue', () => {
  it('runs overlapping requests one at a time in arrival order', async () => {
    const entered = deferred(); const release = deferred();
    const events: string[] = [];
    let active = 0; let maximumActive = 0;
    const coordinator = new BlogMutations(state, {} as Env, async request => {
      const name = new URL(request.url).pathname;
      active++; maximumActive = Math.max(maximumActive, active); events.push(`start:${name}`);
      if (name === '/first') { entered.resolve(); await release.promise; }
      events.push(`end:${name}`); active--;
      return new Response(name);
    });
    const first = coordinator.fetch(new Request('https://blog.example.com/first'));
    await entered.promise;
    const second = coordinator.fetch(new Request('https://blog.example.com/second'));
    const third = coordinator.fetch(new Request('https://blog.example.com/third'));
    await Promise.resolve();
    expect(events).toEqual(['start:/first']);
    release.resolve();
    const responses = await Promise.all([first, second, third]);
    expect(await Promise.all(responses.map(response => response.text()))).toEqual(['/first', '/second', '/third']);
    expect(maximumActive).toBe(1);
    expect(events).toEqual(['start:/first', 'end:/first', 'start:/second', 'end:/second', 'start:/third', 'end:/third']);
  });
  it('continues processing after a rejected handler', async () => {
    const seen: string[] = [];
    const coordinator = new BlogMutations(state, {} as Env, async request => {
      const name = new URL(request.url).pathname; seen.push(name);
      if (name === '/failure') throw new Error('Test failure');
      return new Response('saved');
    });
    const failed = coordinator.fetch(new Request('https://blog.example.com/failure'));
    const next = coordinator.fetch(new Request('https://blog.example.com/next'));
    await expect(failed).rejects.toThrow('Test failure');
    expect(await (await next).text()).toBe('saved');
    expect(seen).toEqual(['/failure', '/next']);
  });
});

const admin: Identity = { email: 'owner@example.com', subject: 'owner' };
const origin = 'https://blog.example.com';
function writeRequest(path: string, method: string, data?: unknown): Request {
  return new Request(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}
async function fixture() {
  const bucket = new FakeR2Bucket();
  const env = { MEDIA: bucket.asBucket(), SITE_ORIGIN: origin, APP_ENV: 'production' } as Env;
  const media = new MediaService(env);
  const bytes = new Uint8Array(32); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set([73, 72, 68, 82], 12);
  const upload = await media.createUpload({ filename: 'photo.png', contentType: 'image/png', size: bytes.length }, admin);
  const record = await media.uploadSingle(upload.id, new Request(origin + '/upload', { method: 'PUT', body: bytes.buffer as ArrayBuffer }), admin);
  const posts: Post[] = [];
  const repository = {
    async listPosts() { return [...posts]; },
    async savePost(slug: string, input: SavePostInput) {
      const now = '2026-10-02T00:00:00.000Z';
      const post: Post = { slug, sha: 'a'.repeat(40), title: input.title, markdown: input.markdown, description: input.description ?? '', tags: input.tags ?? [], status: input.status, createdAt: now, updatedAt: now, publishedAt: now, cover: input.cover ?? null, mediaIds: input.mediaIds ?? [] };
      posts.push(post);
      return { post, commitSha: 'b'.repeat(40) };
    },
  };
  const app = createApp({ posts: () => repository as unknown as GithubPosts, media: () => media, authenticate: async () => admin }, { coordinateMutations: false });
  const coordinator = new BlogMutations(state, env, (request, environment) => app.fetch(request, environment));
  const save = () => coordinator.fetch(writeRequest('/api/admin/posts/hello', 'PUT', { sha: null, title: 'Hello', markdown: `![Photo](${record.url})`, status: 'published' }));
  const remove = () => coordinator.fetch(writeRequest(`/api/admin/media/${record.id}`, 'DELETE'));
  return { media, record, repository, posts, save, remove };
}

describe('article save and media delete coordination', () => {
  it('rejects saving a media reference when concurrent deletion arrives first', async () => {
    const { media, record, posts, save, remove } = await fixture();
    const entered = deferred(); const release = deferred();
    const original = media.deleteMedia.bind(media);
    vi.spyOn(media, 'deleteMedia').mockImplementation(async id => { entered.resolve(); await release.promise; await original(id); });
    const deletion = remove();
    await entered.promise;
    const saving = save();
    release.resolve();
    expect((await deletion).status).toBe(200);
    const result = await saving;
    expect(result.status).toBe(422);
    expect(await result.json()).toMatchObject({ error: { code: 'MEDIA_NOT_READY' } });
    expect(posts).toHaveLength(0);
    expect(await media.getMedia(record.id)).toBeNull();
  });
  it('rejects concurrent deletion when the article save arrives first', async () => {
    const { media, record, repository, posts, save, remove } = await fixture();
    const entered = deferred(); const release = deferred();
    const original = repository.savePost.bind(repository);
    vi.spyOn(repository, 'savePost').mockImplementation(async (slug, input) => { entered.resolve(); await release.promise; return original(slug, input); });
    const saving = save();
    await entered.promise;
    const deletion = remove();
    release.resolve();
    expect((await saving).status).toBe(201);
    const result = await deletion;
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: { code: 'MEDIA_IN_USE', details: { articles: ['hello'] } } });
    expect(posts).toHaveLength(1);
    expect(posts[0].mediaIds).toEqual([record.id]);
    expect(await media.getMedia(record.id)).toEqual(record);
  });
});
