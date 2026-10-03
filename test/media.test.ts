import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaService } from '../src/media';
import { type Env, type Identity } from '../src/types';
import { FakeR2Bucket } from './fake-r2';
const PART_SIZE = 8 * 1024 * 1024;
const admin: Identity = { email: 'owner@example.com', subject: 'owner-subject' };
const other: Identity = { email: 'owner@example.com', subject: 'other-subject' };
function png(size = 32): Uint8Array {
  const result = new Uint8Array(size);
  result.set([137, 80, 78, 71, 13, 10, 26, 10]);
  result.set([73, 72, 68, 82], 12);
  return result;
}
function mp4(size: number): Uint8Array {
  const result = new Uint8Array(size);
  result.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  result.set([105, 115, 111, 109, 109, 112, 52, 50], 16);
  return result;
}
function body(bytes: Uint8Array, headers?: HeadersInit): Request {
  return new Request('https://blog.example.com/api/admin/uploads/test', { method: 'PUT', body: bytes.slice().buffer as ArrayBuffer, headers });
}
let bucket: FakeR2Bucket;
let env: Env;
let service: MediaService;
beforeEach(() => {
  bucket = new FakeR2Bucket();
  env = { MEDIA: bucket.asBucket(), SITE_ORIGIN: 'https://blog.example.com' } as Env;
  service = new MediaService(env);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function uploadPng() {
  const bytes = png();
  const session = await service.createUpload({ filename: 'photo.png', contentType: 'image/png', size: bytes.length }, admin);
  const record = await service.uploadSingle(session.id, body(bytes), admin);
  return { session, record, bytes };
}

describe('upload housekeeping', () => {
  it('retains a retryable session and tombstone when part cleanup fails', async () => {
    vi.useFakeTimers();
    const { session, record } = await uploadPng();
    const part = `.mob/uploads/${session.id}/parts/1.json`;
    await bucket.put(part, JSON.stringify({ partNumber: 1, etag: 'test', size: 32 }));
    vi.advanceTimersByTime(86_400_001);
    const remove = bucket.delete.bind(bucket); let fail = true;
    vi.spyOn(bucket, 'delete').mockImplementation(async keys => {
      if (fail && (Array.isArray(keys) ? keys : [keys]).includes(part)) { fail = false; throw new Error('Transient part cleanup failure'); }
      return remove(keys);
    });
    await expect(service.cleanupUploads()).rejects.toThrow('Transient');
    expect(await bucket.head(`.mob/uploads/${session.id}/session.json`)).not.toBeNull();
    expect(await bucket.head(`.mob/uploads/${session.id}/state.json`)).not.toBeNull();
    expect(await service.cleanupUploads()).toMatchObject({ cleaned: 1 });
    expect(await bucket.head(record.key)).not.toBeNull();
  });
  it('keeps completed bytes and metadata while retiring expired sessions, with bounded pagination', async () => {
    vi.useFakeTimers();
    const records = [];
    for (let index = 0; index < 5; index++) records.push(await uploadPng());
    expect(await service.cleanupUploads()).toMatchObject({ cleaned: 0, expired: 0 });
    vi.advanceTimersByTime(86_400_001);
    const first = await service.cleanupUploads();
    expect(first.cleaned).toBe(4); expect(first.cursor).not.toBeNull();
    expect(await service.cleanupUploads(first.cursor!)).toEqual({ cleaned: 1, expired: 0, cursor: null });
    expect([...bucket.objects.keys()].filter(key => key.startsWith('.mob/uploads/'))).toHaveLength(0);
    for (const { record, session } of records) {
      expect(await service.getMedia(record.id)).toEqual(record);
      expect(await bucket.head(record.key)).not.toBeNull();
      await expect(service.getUpload(session.id, admin)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    }
  });
  it('expires incomplete multipart sessions, aborts their parts and retains a one-day cancellation tombstone', async () => {
    vi.useFakeTimers();
    const session = await service.createUpload({ filename: 'video.mp4', contentType: 'video/mp4', size: PART_SIZE + 20 }, admin);
    await service.uploadPart(session.id, 1, body(mp4(PART_SIZE)), admin);
    vi.advanceTimersByTime(86_400_001);
    expect(await service.cleanupUploads()).toEqual({ cleaned: 0, expired: 1, cursor: null });
    expect(bucket.uploads.size).toBe(0);
    await expect(service.completeUpload(session.id, admin)).rejects.toMatchObject({ code: 'UPLOAD_CLOSED' });
    expect(await service.cleanupUploads()).toMatchObject({ cleaned: 0 });
    vi.advanceTimersByTime(86_400_001);
    expect(await service.cleanupUploads()).toEqual({ cleaned: 1, expired: 0, cursor: null });
    expect([...bucket.objects.keys()].filter(key => key.startsWith('.mob/uploads/'))).toHaveLength(0);
    expect(await bucket.head(session.key)).toBeNull();
  });
  it('preserves a completed object when its final metadata write failed', async () => {
    vi.useFakeTimers();
    const session = await service.createUpload({ filename: 'photo.png', contentType: 'image/png', size: 32 }, admin);
    const put = bucket.put.bind(bucket);
    const fail = vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
      if (key.startsWith('.mob/media/')) throw new Error('Transient metadata write failure');
      return put(key, value, options);
    });
    await expect(service.uploadSingle(session.id, body(png()), admin)).rejects.toThrow('Transient');
    fail.mockRestore(); vi.advanceTimersByTime(86_400_001);
    expect(await service.cleanupUploads()).toMatchObject({ cleaned: 1 });
    expect(await service.getMedia(session.id)).toMatchObject({ id: session.id, size: 32 });
    expect(await bucket.head(session.key)).not.toBeNull();
  });
});

describe('upload validation and ownership', () => {
  it('creates cryptographic IDs, canonical names and fixed URLs', async () => {
    const session = await service.createUpload({ filename: '旅行照片.JPEG', contentType: 'image/jpeg', size: 4 }, admin);
    expect(session.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(session.filename).toBe('file.jpg');
    expect(session.key).toBe(`media/${session.id}/file.jpg`);
    expect(session.url).toBe(`https://blog.example.com/media/${session.id}/file.jpg`);
    expect(Date.parse(session.expiresAt) - Date.parse(session.createdAt)).toBe(86_400_000);
    expect(session.owner).toBe(admin.subject);
  });
  it.each(['../a.png', 'folder/a.png', 'folder\\a.png', '.', '..', 'a:png', 'a\u0000.png'])('rejects path-like filename %s', async filename => {
    await expect(service.createUpload({ filename, contentType: 'image/png', size: 32 }, admin)).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
  });
  it('rejects SVG/HTML and extensions that do not match', async () => {
    for (const contentType of ['image/svg+xml', 'text/html', 'application/octet-stream', '__proto__']) {
      await expect(service.createUpload({ filename: 'file.svg', contentType, size: 32 }, admin)).rejects.toMatchObject({ status: 415 });
    }
    await expect(service.createUpload({ filename: 'file.jpg', contentType: 'image/png', size: 32 }, admin)).rejects.toMatchObject({ code: 'EXTENSION_MISMATCH' });
  });
  it('validates declared size and configured bounds', async () => {
    for (const size of [0, -1, 1.1, Infinity, NaN]) await expect(service.createUpload({ filename: 'x.png', contentType: 'image/png', size }, admin)).rejects.toMatchObject({ code: 'INVALID_MEDIA_SIZE' });
    await expect(service.createUpload({ filename: 'x.png', contentType: 'image/png', size: 1024 ** 3 + 1 }, admin)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    env.MAX_MEDIA_BYTES = String(5 * 1024 ** 3 + 1);
    await expect(service.createUpload({ filename: 'x.png', contentType: 'image/png', size: 32 }, admin)).rejects.toMatchObject({ code: 'MEDIA_CONFIGURATION_ERROR' });
    env.MAX_MEDIA_BYTES = '100';
    await expect(service.createUpload({ filename: 'x.png', contentType: 'image/png', size: 101 }, admin)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
  });
  it('rejects another identity even when its email matches', async () => {
    const { session } = await uploadPng();
    for (const operation of [() => service.getUpload(session.id, other), () => service.uploadSingle(session.id, body(png()), other), () => service.completeUpload(session.id, other), () => service.abortUpload(session.id, other)]) {
      await expect(operation()).rejects.toMatchObject({ status: 403, code: 'UPLOAD_FORBIDDEN' });
    }
  });
  it('never accepts object keys in place of IDs', async () => {
    for (const id of ['../secret', '.mob/media/x.json', 'media/thing/file.png']) {
      await expect(service.getMedia(id)).rejects.toMatchObject({ code: 'INVALID_MEDIA_ID' });
      await expect(service.deleteMedia(id)).rejects.toMatchObject({ code: 'INVALID_MEDIA_ID' });
    }
  });
  it('cannot upload or complete after expiry; cancellation still works', async () => {
    vi.useFakeTimers();
    const session = await service.createUpload({ filename: 'x.png', contentType: 'image/png', size: 32 }, admin);
    vi.advanceTimersByTime(86_400_001);
    await expect(service.getUpload(session.id, admin)).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    await expect(service.uploadSingle(session.id, body(png()), admin)).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    await service.abortUpload(session.id, admin);
    await expect(service.getUpload(session.id, admin)).rejects.toMatchObject({ code: 'UPLOAD_CLOSED' });
  });
});

describe('single uploads', () => {
  it('requires actual byte count and a matching signature before committing', async () => {
    const session = await service.createUpload({ filename: 'x.png', contentType: 'image/png', size: 32 }, admin);
    await expect(service.uploadSingle(session.id, body(png(31)), admin)).rejects.toMatchObject({ code: 'MEDIA_SIZE_MISMATCH' });
    await expect(service.uploadSingle(session.id, body(png(33)), admin)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    await expect(service.uploadSingle(session.id, body(new Uint8Array(32)), admin)).rejects.toMatchObject({ code: 'MEDIA_SIGNATURE_MISMATCH' });
    expect(await service.getMedia(session.id)).toBeNull();
    expect(await bucket.head(session.key)).toBeNull();
  });
  it('counts streamed bytes even with a false Content-Length', async () => {
    const session = await service.createUpload({ filename: 'x.png', contentType: 'image/png', size: 32 }, admin);
    await expect(service.uploadSingle(session.id, body(png(40), { 'Content-Length': '1' }), admin)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    const record = await service.uploadSingle(session.id, body(png(), { 'Content-Length': '32' }), admin);
    expect(record.size).toBe(32);
  });
  it('is immutable and returns the completed media on retries', async () => {
    const { session, record, bytes } = await uploadPng();
    const modified = png(); modified[31] = 99;
    expect(await service.uploadSingle(session.id, body(modified), admin)).toEqual(record);
    expect(await service.completeUpload(session.id, admin)).toEqual(record);
    expect(Buffer.from(bucket.objects.get(session.key)!.data).equals(Buffer.from(bytes))).toBe(true);
    await expect(service.abortUpload(session.id, admin)).rejects.toMatchObject({ code: 'UPLOAD_ALREADY_COMPLETED' });
    expect(await service.getMedia(session.id)).toEqual(record);
  });
  it('recovers when storing final metadata failed after upload', async () => {
    const session = await service.createUpload({ filename: 'x.png', contentType: 'image/png', size: 32 }, admin);
    const original = bucket.put.bind(bucket);
    let failed = false;
    vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
      if (!failed && key === `.mob/media/${session.id}.json`) { failed = true; throw new Error('Transient storage failure'); }
      return original(key, value, options);
    });
    await expect(service.uploadSingle(session.id, body(png()), admin)).rejects.toThrow('Transient');
    expect(await service.getMedia(session.id)).toBeNull();
    const record = await service.completeUpload(session.id, admin);
    expect(record.size).toBe(32);
    expect(await service.getMedia(session.id)).toEqual(record);
  });
  it('cancelled and deleted sessions cannot resurrect media', async () => {
    const pending = await service.createUpload({ filename: 'x.png', contentType: 'image/png', size: 32 }, admin);
    await service.abortUpload(pending.id, admin);
    await service.abortUpload(pending.id, admin);
    await expect(service.uploadSingle(pending.id, body(png()), admin)).rejects.toMatchObject({ code: 'UPLOAD_CLOSED' });
    const { session } = await uploadPng();
    await service.deleteMedia(session.id);
    await service.deleteMedia(session.id);
    expect(await service.getMedia(session.id)).toBeNull();
    expect(await bucket.head(session.key)).toBeNull();
    await expect(service.uploadSingle(session.id, body(png()), admin)).rejects.toMatchObject({ code: 'UPLOAD_CLOSED' });
  });
  it('lists complete records and excludes internal metadata and pending uploads', async () => {
    const { record } = await uploadPng();
    await service.createUpload({ filename: 'pending.png', contentType: 'image/png', size: 32 }, admin);
    await bucket.put('.mob/other/secret', 'secret');
    expect(await service.listMedia()).toEqual({ items: [record], cursor: null });
  });
});

describe('multipart uploads', () => {
  it('validates exact chunks, stores concurrently uploaded parts, and completes idempotently', async () => {
    const bytes = mp4(PART_SIZE + 50);
    const session = await service.createUpload({ filename: 'clip.mp4', contentType: 'video/mp4', size: bytes.length }, admin);
    expect(session.mode).toBe('multipart'); expect(session.partCount).toBe(2); expect(session.partSize).toBe(PART_SIZE);
    await expect(service.uploadSingle(session.id, body(bytes.slice(0, 20)), admin)).rejects.toMatchObject({ code: 'MULTIPART_REQUIRED' });
    await expect(service.uploadPart(session.id, 0, body(bytes.slice(0, 20)), admin)).rejects.toMatchObject({ code: 'INVALID_PART_NUMBER' });
    await expect(service.uploadPart(session.id, 2, body(bytes.slice(PART_SIZE, -1)), admin)).rejects.toMatchObject({ code: 'MEDIA_SIZE_MISMATCH' });
    await expect(service.uploadPart(session.id, 1, body(new Uint8Array(PART_SIZE)), admin)).rejects.toMatchObject({ code: 'MEDIA_SIGNATURE_MISMATCH' });
    await expect(service.completeUpload(session.id, admin)).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE', details: { missingParts: [1, 2] } });
    await Promise.all([
      service.uploadPart(session.id, 1, body(bytes.slice(0, PART_SIZE)), admin),
      service.uploadPart(session.id, 2, body(bytes.slice(PART_SIZE)), admin),
    ]);
    expect(await service.getMedia(session.id)).toBeNull();
    const retry = await service.uploadPart(session.id, 2, body(bytes.slice(PART_SIZE)), admin);
    expect(retry.partNumber).toBe(2);
    const record = await service.completeUpload(session.id, admin);
    expect(record.size).toBe(bytes.length);
    expect(Buffer.from(bucket.objects.get(session.key)!.data).equals(Buffer.from(bytes))).toBe(true);
    expect(await service.completeUpload(session.id, admin)).toEqual(record);
    await expect(service.uploadPart(session.id, 2, body(bytes.slice(PART_SIZE)), admin)).rejects.toMatchObject({ code: 'UPLOAD_ALREADY_COMPLETED' });
  });
  it('recovers final object when completion succeeded but metadata write failed', async () => {
    const bytes = mp4(PART_SIZE + 50);
    const session = await service.createUpload({ filename: 'clip.mp4', contentType: 'video/mp4', size: bytes.length }, admin);
    await service.uploadPart(session.id, 1, body(bytes.slice(0, PART_SIZE)), admin);
    await service.uploadPart(session.id, 2, body(bytes.slice(PART_SIZE)), admin);
    const original = bucket.put.bind(bucket); let failed = false;
    vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
      if (!failed && key === `.mob/media/${session.id}.json`) { failed = true; throw new Error('Metadata temporarily unavailable'); }
      return original(key, value, options);
    });
    await expect(service.completeUpload(session.id, admin)).rejects.toThrow('Metadata temporarily');
    expect(bucket.uploads.has(session.uploadId!)).toBe(false);
    expect((await service.completeUpload(session.id, admin)).size).toBe(bytes.length);
  });
  it('aborts an incomplete multipart upload without publishing it', async () => {
    const session = await service.createUpload({ filename: 'clip.mp4', contentType: 'video/mp4', size: PART_SIZE + 20 }, admin);
    await service.abortUpload(session.id, admin);
    expect(bucket.uploads.has(session.uploadId!)).toBe(false);
    expect(await service.getMedia(session.id)).toBeNull();
    await expect(service.completeUpload(session.id, admin)).rejects.toMatchObject({ code: 'UPLOAD_CLOSED' });
  });
});

describe('media reads', () => {
  it('serves the exact bytes with a safe content type and no internal paths', async () => {
    const { session, bytes } = await uploadPng();
    const response = await service.readMedia(session.id, new Request(session.url));
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Length')).toBe('32'); expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
  it('handles HEAD and conditional requests', async () => {
    const { session } = await uploadPng();
    const head = await service.readMedia(session.id, new Request(session.url, { method: 'HEAD', headers: { Range: 'bytes=0-3' } }));
    expect(head.status).toBe(200); expect(head.headers.get('Content-Length')).toBe('32'); expect(await head.text()).toBe('');
    const etag = head.headers.get('ETag')!;
    for (const match of [etag, `W/${etag}`, '*', `"other", ${etag}`]) {
      const response = await service.readMedia(session.id, new Request(session.url, { headers: { 'If-None-Match': match } }));
      expect(response.status).toBe(304); expect(await response.text()).toBe('');
    }
  });
  it.each([
    ['bytes=0-3', 0, 4], ['bytes=28-', 28, 4], ['bytes=-4', 28, 4], ['bytes=30-100', 30, 2], ['bytes=-100', 0, 32],
  ])('supports single range %s', async (range, start, size) => {
    const { session, bytes } = await uploadPng();
    const response = await service.readMedia(session.id, new Request(session.url, { headers: { Range: range } }));
    expect(response.status).toBe(206); expect(response.headers.get('Content-Length')).toBe(String(size));
    expect(response.headers.get('Content-Range')).toBe(`bytes ${start}-${start + size - 1}/32`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(start, start + size));
  });
  it.each(['bytes=32-', 'bytes=8-4', 'bytes=-0', 'bytes=', 'bytes=0-1,3-4', 'units=0-4'])('rejects unsatisfiable or unsupported ranges %s', async range => {
    const { session } = await uploadPng();
    const response = await service.readMedia(session.id, new Request(session.url, { headers: { Range: range } }));
    expect(response.status).toBe(416); expect(response.headers.get('Content-Range')).toBe('bytes */32');
  });
  it('ignores Range when If-Range does not match', async () => {
    const { session } = await uploadPng();
    const response = await service.readMedia(session.id, new Request(session.url, { headers: { Range: 'bytes=0-3', 'If-Range': '"other"' } }));
    expect(response.status).toBe(200); expect(response.headers.get('Content-Length')).toBe('32');
  });
  it('rejects pending media, missing objects, and corrupted object keys', async () => {
    const pending = await service.createUpload({ filename: 'x.png', contentType: 'image/png', size: 32 }, admin);
    await expect(service.readMedia(pending.id, new Request(pending.url))).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    const { session, record } = await uploadPng();
    await bucket.put(`.mob/media/${session.id}.json`, JSON.stringify({ ...record, key: '.mob/secret' }));
    await expect(service.readMedia(session.id, new Request(session.url))).rejects.toMatchObject({ code: 'MEDIA_STORAGE_ERROR' });
  });
});


describe('upload cancellation races', () => {
  it('cannot cancel a completed object while its final metadata write is delayed', async () => {
    const session = await service.createUpload({ filename: 'race.png', contentType: 'image/png', size: 32 }, admin);
    const original = bucket.put.bind(bucket);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let claimed!: () => void;
    const hasClaimed = new Promise<void>(resolve => { claimed = resolve; });
    vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
      if (key === `.mob/media/${session.id}.json`) { claimed(); await gate; }
      return original(key, value, options);
    });
    const completion = service.uploadSingle(session.id, body(png()), admin);
    await hasClaimed;
    expect(await service.getMedia(session.id)).toBeNull();
    await expect(service.abortUpload(session.id, admin)).rejects.toMatchObject({ code: 'UPLOAD_ALREADY_COMPLETED' });
    release();
    const record = await completion;
    expect(await service.getMedia(session.id)).toEqual(record);
    expect(await bucket.head(session.key)).not.toBeNull();
  });
  it('cleans a delayed object write when cancellation wins before finalization', async () => {
    const session = await service.createUpload({ filename: 'race.png', contentType: 'image/png', size: 32 }, admin);
    const original = bucket.put.bind(bucket);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let received!: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
      if (key === session.key) { received(); await gate; }
      return original(key, value, options);
    });
    const upload = service.uploadSingle(session.id, body(png()), admin);
    await started;
    await service.abortUpload(session.id, admin);
    release();
    await expect(upload).rejects.toMatchObject({ code: 'UPLOAD_CLOSED' });
    expect(await service.getMedia(session.id)).toBeNull();
    expect(await bucket.head(session.key)).toBeNull();
  });
});

describe('supported media headers', () => {
  it.each([
    ['image/jpeg', 'jpg', [0xff, 0xd8, 0xff, 0xe0]],
    ['image/gif', 'gif', [...Buffer.from('GIF89a'), 1, 0, 1, 0, 0, 0, 0]],
    ['image/webp', 'webp', [...Buffer.from('RIFF'), 12, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]],
    ['image/avif', 'avif', [0, 0, 0, 16, ...Buffer.from('ftypavif'), 0, 0, 0, 0]],
    ['video/webm', 'webm', [0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, ...Buffer.from('webm')]],
  ])('accepts a bounded matching header for %s', async (contentType, extension, header) => {
    const data = new Uint8Array(32); data.set(header);
    const session = await service.createUpload({ filename: `media.${extension}`, contentType, size: data.length }, admin);
    expect((await service.uploadSingle(session.id, body(data), admin)).contentType).toBe(contentType);
  });
  it('rejects AVIF presented as MP4 and EBML without WebM DocType', async () => {
    const avif = new Uint8Array(32); avif.set([0, 0, 0, 16, ...Buffer.from('ftypavif'), 0, 0, 0, 0]);
    const session = await service.createUpload({ filename: 'file.mp4', contentType: 'video/mp4', size: 32 }, admin);
    await expect(service.uploadSingle(session.id, body(avif), admin)).rejects.toMatchObject({ code: 'MEDIA_SIGNATURE_MISMATCH' });
    const ebml = new Uint8Array(32); ebml.set([0x1a, 0x45, 0xdf, 0xa3]);
    const webm = await service.createUpload({ filename: 'file.webm', contentType: 'video/webm', size: 32 }, admin);
    await expect(service.uploadSingle(webm.id, body(ebml), admin)).rejects.toMatchObject({ code: 'MEDIA_SIGNATURE_MISMATCH' });
  });
});
