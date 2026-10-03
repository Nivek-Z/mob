import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaService } from '../src/media';
import { GalleryService } from '../src/gallery';
import { SettingsService, GALLERY_PATH } from '../src/settings';
import type { Env, Identity } from '../src/types';
import { FakeR2Bucket } from './fake-r2';

const admin: Identity = { email: 'owner@example.com', subject: 'owner' };
const origin = 'https://blog.example.com';
const png = () => Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0]);
let bucket: FakeR2Bucket, media: MediaService, gallery: GalleryService, items: any[], sha: string, write: ReturnType<typeof vi.fn>;
beforeEach(() => {
  bucket = new FakeR2Bucket(); const env = { MEDIA: bucket.asBucket(), SITE_ORIGIN: origin } as Env;
  media = new MediaService(env); items = []; sha = 'a'.repeat(40);
  write = vi.fn(async (changes: { path: string; content: string; sha: string }[]) => {
    expect(changes[0].path).toBe(GALLERY_PATH); expect(changes[0].sha).toBe(sha);
    items = JSON.parse(changes[0].content).items;
    sha = 'b'.repeat(40); return { shas: { [GALLERY_PATH]: sha }, commitSha: 'c'.repeat(40) };
  });
  const settings = { read: vi.fn(async () => ({ sha, value: { items } })), github: { writeFiles: write } } as unknown as SettingsService;
  gallery = new GalleryService(env, settings, media);
});
async function store(key: string, bytes = png(), contentType?: string) {
  return (await bucket.put(key, bytes, { httpMetadata: { contentType } }))!;
}
describe('R2 discovery and gallery adoption', () => {
  it('discovers legacy/theme images, infers MIME and excludes internal or unsupported objects', async () => {
    for (const key of ['.mob/private.png', 'cache/aggregate.png', 'legacy/file.svg', 'legacy/file.html', 'empty.png']) await store(key, key === 'empty.png' ? new Uint8Array() : png());
    await store('theme-media/firefly/digest/hero.png', png(), 'image/png');
    await store('legacy/旅行.png');
    const result = await gallery.storage();
    expect(result.items.map(item => item.kind).sort()).toEqual(['legacy', 'theme']);
    expect(result.items.every(item => item.contentType === 'image/png')).toBe(true);
    expect(result.items.find(item => item.kind === 'legacy')!.filename).toBe('file.png');
    expect(write).not.toHaveBeenCalled();
  });
  it('creates one immutable managed copy, retains the original, retries registration and hides registered sources', async () => {
    const key = 'theme-media/firefly/digest/hero.png', original = await store(key, png(), 'image/png');
    write.mockRejectedValueOnce(new Error('GitHub unavailable'));
    await expect(gallery.importStorage({ key, etag: original.etag }, admin)).rejects.toThrow('GitHub unavailable');
    const copies = [...bucket.objects.keys()].filter(name => name.startsWith('media/'));
    expect(copies).toHaveLength(1); expect(await bucket.head(key)).not.toBeNull();
    const result = await gallery.importStorage({ key, etag: original.etag }, admin);
    expect(result.item).toMatchObject({ isPublic: false, isListed: false, categoryId: 'gallery', source: 'import' });
    expect(result.item.url).toBe(origin + '/' + copies[0]);
    expect((await gallery.storage()).items).toHaveLength(0);
    expect((await gallery.importStorage({ key, etag: original.etag }, admin)).item.id).toBe(result.item.id);
    expect([...bucket.objects.keys()].filter(name => name.startsWith('media/'))).toEqual(copies);
    expect(await bucket.head(key)).toMatchObject({ etag: original.etag });
  });
  it('keeps existing upload IDs and adopts orphan managed objects without a second byte copy', async () => {
    const session = await media.createUpload({ filename: 'upload.png', contentType: 'image/png', size: 32 }, admin);
    const record = await media.uploadSingle(session.id, new Request(origin, { method: 'PUT', body: png().buffer }), admin);
    const candidate = (await gallery.storage()).items.find(item => item.id === record.id)!;
    expect(candidate.kind).toBe('managed');
    expect((await gallery.importStorage({ key: candidate.key, etag: candidate.etag }, admin)).item.id).toBe(record.id);
    const orphanId = '12345678-1234-4234-8234-123456789abc';
    const orphan = await store(`media/${orphanId}/old.png`, png(), 'image/png');
    expect((await gallery.importStorage({ key: orphan.key, etag: orphan.etag }, admin)).item.id).toBe(orphanId);
    expect([...bucket.objects.keys()].filter(key => key.startsWith('media/'))).toHaveLength(2);
  });
  it('does not resurrect incomplete or aborted uploads', async () => {
    const session = await media.createUpload({ filename: 'pending.png', contentType: 'image/png', size: 32 }, admin);
    await store(session.key, png(), 'image/png');
    expect((await media.listStoredMedia()).items).toHaveLength(0);
    await media.abortUpload(session.id, admin);
    await store(session.key, png(), 'image/png');
    expect((await media.listStoredMedia()).items).toHaveLength(0);
    await expect(media.importStoredMedia(session.key, (await bucket.head(session.key))!.etag, admin)).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
  });
  it('rejects changes, invalid file signatures, unexpected request fields and occupied destinations', async () => {
    const key = 'legacy/test.png', source = await store(key);
    const changed = png(); changed[31] = 1; await store(key, changed);
    await expect(gallery.importStorage({ key, etag: source.etag }, admin)).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' });
    const bad = await store('legacy/bad.png', new Uint8Array(32), 'image/png');
    await expect(gallery.importStorage({ key: bad.key, etag: bad.etag }, admin)).rejects.toMatchObject({ code: 'MEDIA_SIGNATURE_MISMATCH' });
    await expect(gallery.importStorage({ key, etag: source.etag, isPublic: true }, admin)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const current = (await media.listStoredMedia()).items.find(item => item.key === key)!;
    await store(`media/${current.id}/${current.filename}`, png(), 'image/png');
    await expect(gallery.importStorage({ key, etag: current.etag }, admin)).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' });
    expect(items).toHaveLength(0);
  });
  it('recovers a copied object after metadata persistence fails', async () => {
    const source = await store('legacy/retry.png', png(), 'image/png');
    const put = bucket.put.bind(bucket); let failed = false;
    vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
      if (!failed && key.startsWith('.mob/media/')) { failed = true; throw new Error('temporary R2 error'); }
      return put(key, value, options);
    });
    await expect(media.importStoredMedia(source.key, source.etag, admin)).rejects.toThrow('temporary R2 error');
    const record = await media.importStoredMedia(source.key, source.etag, admin);
    expect([...bucket.objects.keys()].filter(key => key.startsWith('media/'))).toEqual([record.key]);
    expect(await media.getMedia(record.id)).toEqual(record);
  });
  it('paginates across internal keys without losing eligible objects and supports private range/HEAD previews', async () => {
    for (let index = 0; index < 101; index++) await store('.mob/internal-' + index + '.png');
    const source = await store('legacy/visible.png', png(), 'image/png');
    const first = await gallery.storage(); expect(first.items).toHaveLength(0); expect(first.cursor).not.toBeNull();
    expect((await gallery.storage(first.cursor!)).items.map(item => item.key)).toEqual([source.key]);
    const preview = await media.previewStoredMedia(source.key, new Request(origin, { headers: { Range: 'bytes=0-7' } }));
    expect(preview.status).toBe(206); expect(preview.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(png().slice(0, 8));
    expect((await media.previewStoredMedia(source.key, new Request(origin, { method: 'HEAD' }))).body).toBeNull();
    await expect(media.previewStoredMedia('.mob/internal-1.png', new Request(origin))).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
  });
});
