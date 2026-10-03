import { type Env, type Identity, type MediaRecord, type UploadSession } from './types';
import { ApiError, readBytes, requireId } from './http';

const PART_SIZE = 8 * 1024 * 1024;
const DEFAULT_LIMIT = 1024 * 1024 * 1024;
const HARD_LIMIT = 5 * DEFAULT_LIMIT;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const MIME_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/gif': ['gif'],
  'image/webp': ['webp'], 'image/avif': ['avif'], 'video/mp4': ['mp4'], 'video/webm': ['webm'],
  'audio/mpeg': ['mp3'], 'audio/wav': ['wav'], 'audio/ogg': ['ogg', 'opus'], 'audio/mp4': ['m4a'],
};
interface PartRecord { partNumber: number; etag: string; size: number; }
interface UploadState { status: 'active' | 'completed' | 'aborted' | 'deleted'; at: string; }
const sessionKey = (id: string) => `.mob/uploads/${id}/session.json`;
const recordKey = (id: string) => `.mob/media/${id}.json`;
const partKey = (id: string, number: number) => `.mob/uploads/${id}/parts/${number}.json`;
const stateKey = (id: string) => `.mob/uploads/${id}/state.json`;

function filenameFor(input: string, contentType: string): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 255 || /[\\/\x00-\x1f\x7f:]/.test(input) || input === '.' || input === '..') {
    throw new ApiError(400, 'INVALID_FILENAME', 'Use a filename, without directories or control characters.');
  }
  const name = input.trim();
  const dot = name.lastIndexOf('.');
  const extensions = MIME_EXTENSIONS[contentType];
  if (dot >= 0 && !extensions.includes(name.slice(dot + 1).toLowerCase())) {
    throw new ApiError(400, 'EXTENSION_MISMATCH', 'Filename extension must match the media content type.');
  }
  const stem = (dot >= 0 ? name.slice(0, dot) : name).normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'file';
  return `${stem}.${extensions[0]}`;
}
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
/** File-header validation is deliberately bounded; it does not decode or transcode media. */
function validSignature(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === 'audio/mpeg') return bytes.length >= 4 && (ascii(bytes, 0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0 && (bytes[2] & 0xf0) !== 0xf0);
  if (contentType === 'audio/wav') return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE';
  if (contentType === 'audio/ogg') return bytes.length >= 32 && ascii(bytes, 0, 4) === 'OggS' && /OpusHead|vorbis/.test(ascii(bytes, 0, Math.min(bytes.length, 4096)));
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) && ascii(bytes, 12, 4) === 'IHDR';
  if (contentType === 'image/gif') return bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6));
  if (contentType === 'image/webp') return bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 4));
  if (contentType === 'image/avif' || contentType === 'video/mp4' || contentType === 'audio/mp4') {
    if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return false;
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (boxSize < 16 || boxSize > bytes.length || boxSize > 4096 || boxSize % 4 !== 0) return false;
    const brands = [ascii(bytes, 8, 4)];
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(ascii(bytes, offset, 4));
    return contentType === 'audio/mp4' ? brands.some(brand => ['M4A ', 'M4B ', 'mp42', 'isom'].includes(brand)) : contentType === 'image/avif' ? brands.some(brand => brand === 'avif' || brand === 'avis')
      : !brands.some(brand => brand === 'avif' || brand === 'avis') && brands.some(brand => /^iso[0-9m]$/.test(brand) || ['mp41', 'mp42', 'avc1', 'M4V ', 'MSNV', 'dash', 'cmfc', 'cmfs'].includes(brand));
  }
  if (contentType === 'video/webm') {
    if (bytes.length < 8 || ![0x1a, 0x45, 0xdf, 0xa3].every((v, i) => bytes[i] === v)) return false;
    // EBML DocType element (0x4282), using its variable-length size encoding.
    const end = Math.min(bytes.length, 4096);
    for (let offset = 4; offset + 7 <= end; offset++) {
      if (bytes[offset] !== 0x42 || bytes[offset + 1] !== 0x82) continue;
      let mask = 0x80, width = 1;
      while (width <= 8 && !(bytes[offset + 2] & mask)) { mask >>= 1; width++; }
      if (width > 8 || offset + 2 + width + 4 > end) continue;
      let length = bytes[offset + 2] & (mask - 1);
      for (let index = 1; index < width; index++) length = length * 256 + bytes[offset + 2 + index];
      if (length === 4 && ascii(bytes, offset + 2 + width, 4) === 'webm') return true;
    }
  }
  return false;
}
function requireSignature(bytes: Uint8Array, contentType: string): void {
  if (!validSignature(bytes, contentType)) throw new ApiError(415, 'MEDIA_SIGNATURE_MISMATCH', 'File header does not match the declared media content type.');
}
function matchEtag(header: string | null, etag: string): boolean {
  return !!header && header.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
}
function parseRange(header: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset) return null;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

export class MediaService {
  constructor(private readonly env: Env) {}
  private maxSize(): number {
    const configured = this.env.MAX_MEDIA_BYTES === undefined ? DEFAULT_LIMIT : Number(this.env.MAX_MEDIA_BYTES);
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > HARD_LIMIT) {
      throw new ApiError(503, 'MEDIA_CONFIGURATION_ERROR', 'MAX_MEDIA_BYTES must be an integer between 1 and 5368709120.');
    }
    return configured;
  }
  private origin(): string {
    try {
      const url = new URL(this.env.SITE_ORIGIN);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      return url.origin;
    } catch { throw new ApiError(503, 'MEDIA_CONFIGURATION_ERROR', 'SITE_ORIGIN must be an absolute site origin.'); }
  }
  private async readRecord<T>(key: string): Promise<T | null> {
    const object = await this.env.MEDIA.get(key);
    if (!object) return null;
    try { return await object.json<T>(); }
    catch { throw new ApiError(503, 'MEDIA_STORAGE_ERROR', 'Stored media metadata is invalid.'); }
  }
  private async writeRecord(key: string, value: unknown): Promise<void> {
    await this.env.MEDIA.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
  }
  private async state(id: string): Promise<{ value: UploadState; etag: string }> {
    const stored = await this.env.MEDIA.get(stateKey(id));
    if (!stored) throw new ApiError(503, 'MEDIA_STORAGE_ERROR', 'Upload state is missing.');
    let value: UploadState;
    try { value = await stored.json<UploadState>(); }
    catch { throw new ApiError(503, 'MEDIA_STORAGE_ERROR', 'Upload state is invalid.'); }
    if (!value || !['active', 'completed', 'aborted', 'deleted'].includes(value.status)) throw new ApiError(503, 'MEDIA_STORAGE_ERROR', 'Upload state is invalid.');
    return { value, etag: stored.etag };
  }
  private async terminal(id: string): Promise<'aborted' | 'deleted' | null> {
    const { value } = await this.state(id);
    return value.status === 'aborted' || value.status === 'deleted' ? value.status : null;
  }
  private async transition(id: string, target: 'completed' | 'aborted' | 'deleted'): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { value, etag } = await this.state(id);
      if (value.status === target) return;
      if (target === 'aborted' && value.status === 'completed') throw new ApiError(409, 'UPLOAD_ALREADY_COMPLETED', 'Completed media must be removed using the media delete endpoint.');
      if (target === 'aborted' && value.status === 'deleted') return;
      if (target === 'completed' && value.status !== 'active') throw new ApiError(410, 'UPLOAD_CLOSED', 'This upload was cancelled or deleted.');
      if (target === 'deleted' && value.status !== 'completed') throw new ApiError(409, 'UPLOAD_CLOSED', 'This upload is not completed.');
      const updated = await this.env.MEDIA.put(stateKey(id), JSON.stringify({ status: target, at: new Date().toISOString() } satisfies UploadState), {
        onlyIf: { etagMatches: etag }, httpMetadata: { contentType: 'application/json' },
      });
      if (updated) return;
    }
    throw new ApiError(409, 'UPLOAD_BUSY', 'The upload changed concurrently; retry the operation.');
  }
  private async assertActive(session: UploadSession): Promise<void> {
    if (await this.terminal(session.id)) throw new ApiError(410, 'UPLOAD_CLOSED', 'This upload was cancelled or deleted.');
    if (Date.parse(session.expiresAt) <= Date.now()) throw new ApiError(410, 'UPLOAD_EXPIRED', 'The upload session expired; create a new session.');
  }
  private async ownedSession(id: string, identity: Identity): Promise<UploadSession> {
    requireId(id);
    const session = await this.readRecord<UploadSession>(sessionKey(id));
    if (!session) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload session does not exist.');
    if (session.owner !== identity.subject) throw new ApiError(403, 'UPLOAD_FORBIDDEN', 'This upload belongs to a different administrator.');
    return session;
  }
  async createUpload(input: { filename: string; contentType: string; size: number }, identity: Identity): Promise<UploadSession> {
    if (!input || typeof input !== 'object' || typeof input.contentType !== 'string') throw new ApiError(400, 'INVALID_INPUT', 'filename, contentType and size are required.');
    const contentType = input.contentType.trim().toLowerCase();
    if (!Object.hasOwn(MIME_EXTENSIONS, contentType)) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Allowed media types: JPEG, PNG, GIF, WebP, AVIF, MP4 and WebM.');
    if (!Number.isSafeInteger(input.size) || input.size < 1) throw new ApiError(400, 'INVALID_MEDIA_SIZE', 'size must be a positive integer in bytes.');
    if (input.size > this.maxSize()) throw new ApiError(413, 'MEDIA_TOO_LARGE', 'The file exceeds MAX_MEDIA_BYTES.');
    const filename = filenameFor(input.filename, contentType);
    const id = crypto.randomUUID();
    const key = `media/${id}/${filename}`;
    const now = Date.now();
    const session: UploadSession = {
      id, key, filename, contentType, size: input.size, owner: identity.subject,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_TTL).toISOString(),
      mode: input.size <= PART_SIZE ? 'single' : 'multipart', partSize: PART_SIZE,
      partCount: Math.ceil(input.size / PART_SIZE), url: `${this.origin()}/media/${id}/${filename}`,
    };
    if (session.mode === 'multipart') {
      const multipart = await this.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType }, customMetadata: { uploadSessionId: id, owner: identity.subject } });
      session.uploadId = multipart.uploadId;
    }
    try {
      await this.writeRecord(stateKey(id), { status: 'active', at: session.createdAt } satisfies UploadState);
      await this.writeRecord(sessionKey(id), session);
    }
    catch (error) {
      if (session.uploadId) await this.env.MEDIA.resumeMultipartUpload(key, session.uploadId).abort().catch(() => undefined);
      throw error;
    }
    return session;
  }
  async getUpload(id: string, identity: Identity): Promise<UploadSession & { record?: MediaRecord; status: string }> {
    const session = await this.ownedSession(id, identity);
    const record = await this.getMedia(id);
    if (!record) await this.assertActive(session);
    return { ...session, status: record ? 'completed' : 'active', ...(record ? { record } : {}) };
  }
  private verifyStoredObject(object: R2Object, session: UploadSession): void {
    if (object.size !== session.size || object.customMetadata?.uploadSessionId !== session.id || object.customMetadata?.owner !== session.owner || object.httpMetadata?.contentType !== session.contentType) {
      throw new ApiError(409, 'MEDIA_OBJECT_MISMATCH', 'Stored object does not match the upload session.');
    }
  }
  private async finalize(session: UploadSession, object: R2Object): Promise<MediaRecord> {
    this.verifyStoredObject(object, session);
    try {
      await this.assertActive(session);
      // Claim completion atomically before publishing metadata; abort can no longer delete it.
      await this.transition(session.id, 'completed');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UPLOAD_CLOSED') await this.env.MEDIA.delete([session.key, recordKey(session.id)]);
      throw error;
    }
    const record: MediaRecord = {
      id: session.id, key: session.key, filename: session.filename, contentType: session.contentType,
      size: object.size, owner: session.owner, createdAt: session.createdAt, url: session.url,
    };
    await this.writeRecord(recordKey(session.id), record);
    if (await this.terminal(session.id)) {
      await this.env.MEDIA.delete([session.key, recordKey(session.id)]);
      throw new ApiError(410, 'UPLOAD_CLOSED', 'This upload was cancelled or deleted.');
    }
    return record;
  }
  async uploadSingle(id: string, request: Request, identity: Identity): Promise<MediaRecord> {
    const session = await this.ownedSession(id, identity);
    const completed = await this.getMedia(id);
    if (completed) return completed;
    await this.assertActive(session);
    if (session.mode !== 'single') throw new ApiError(409, 'MULTIPART_REQUIRED', 'Upload this file using the multipart endpoints.');
    const bytes = await readBytes(request, session.size);
    if (bytes.length !== session.size) throw new ApiError(400, 'MEDIA_SIZE_MISMATCH', 'Uploaded bytes must exactly match the declared size.');
    requireSignature(bytes, session.contentType);
    // Conditional write makes successful single uploads immutable, including concurrent retries.
    const written = await this.env.MEDIA.put(session.key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: session.contentType },
      customMetadata: { uploadSessionId: id, owner: session.owner },
    });
    const object = written ?? await this.env.MEDIA.head(session.key);
    if (!object) throw new ApiError(503, 'MEDIA_STORAGE_ERROR', 'Uploaded object could not be verified; retry the request.');
    return this.finalize(session, object);
  }
  async uploadPart(id: string, partNumber: number, request: Request, identity: Identity): Promise<{ partNumber: number; etag: string }> {
    const session = await this.ownedSession(id, identity);
    if (await this.getMedia(id)) throw new ApiError(409, 'UPLOAD_ALREADY_COMPLETED', 'This media upload has already completed.');
    await this.assertActive(session);
    if (session.mode !== 'multipart' || !session.uploadId) throw new ApiError(409, 'SINGLE_UPLOAD_REQUIRED', 'Use the single upload endpoint for this file.');
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > session.partCount) throw new ApiError(400, 'INVALID_PART_NUMBER', 'partNumber is outside this upload session.');
    const expected = partNumber === session.partCount ? session.size - PART_SIZE * (partNumber - 1) : PART_SIZE;
    const bytes = await readBytes(request, expected);
    if (bytes.length !== expected) throw new ApiError(400, 'MEDIA_SIZE_MISMATCH', 'Each part must have the exact expected number of bytes.');
    if (partNumber === 1) requireSignature(bytes, session.contentType);
    let uploaded: R2UploadedPart;
    try { uploaded = await this.env.MEDIA.resumeMultipartUpload(session.key, session.uploadId).uploadPart(partNumber, bytes); }
    catch { throw new ApiError(503, 'MEDIA_UPLOAD_FAILED', 'The multipart upload failed; retry or create a new upload session.'); }
    // One record per part avoids overwriting metadata for concurrently uploaded different parts.
    await this.env.MEDIA.put(partKey(id, partNumber), JSON.stringify({ ...uploaded, size: bytes.length } satisfies PartRecord), { httpMetadata: { contentType: 'application/json' }, customMetadata: { partNumber: String(partNumber), etag: uploaded.etag, size: String(bytes.length) } });
    await this.assertActive(session);
    return uploaded;
  }
  async completeUpload(id: string, identity: Identity): Promise<MediaRecord> {
    const session = await this.ownedSession(id, identity);
    const completed = await this.getMedia(id);
    if (completed) return completed;
    await this.assertActive(session);
    // If R2 completed but metadata saving failed, recover without completing the same upload twice.
    const existing = await this.env.MEDIA.head(session.key);
    if (existing) return this.finalize(session, existing);
    if (session.mode !== 'multipart' || !session.uploadId) throw new ApiError(409, 'UPLOAD_INCOMPLETE', 'Upload the single file before completing this session.');
    const parts: PartRecord[] = [];
    const missing: number[] = [];
    const recorded = new Map<number, PartRecord>();
    // List part metadata in batches instead of spending one subrequest per part.
    // A 1 GiB upload has 128 parts, exceeding free-plan subrequest limits if read individually.
    let cursor: string | undefined;
    do {
      const listed = await this.env.MEDIA.list({ prefix: `.mob/uploads/${id}/parts/`, limit: 1000, include: ['customMetadata'], cursor });
      for (const entry of listed.objects) {
        const metadata = entry.customMetadata;
        const number = Number(metadata?.partNumber);
        if (Number.isSafeInteger(number) && number >= 1 && number <= session.partCount && entry.key === partKey(id, number)) {
          recorded.set(number, { partNumber: number, etag: metadata?.etag ?? '', size: Number(metadata?.size) });
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    for (let number = 1; number <= session.partCount; number++) {
      const part = recorded.get(number);
      const expected = number === session.partCount ? session.size - PART_SIZE * (number - 1) : PART_SIZE;
      if (!part || part.size !== expected || !part.etag) missing.push(number);
      else parts.push(part);
    }
    if (missing.length) throw new ApiError(409, 'UPLOAD_INCOMPLETE', 'Upload all parts before completing the session.', { missingParts: missing });
    await this.assertActive(session);
    let object: R2Object;
    try { object = await this.env.MEDIA.resumeMultipartUpload(session.key, session.uploadId).complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag }))); }
    catch {
      // A concurrent completion may have succeeded, or the response may have been lost.
      const recovered = await this.env.MEDIA.head(session.key);
      if (!recovered) throw new ApiError(503, 'MEDIA_UPLOAD_FAILED', 'Completion failed; retry the operation.');
      object = recovered;
    }
    return this.finalize(session, object);
  }
  async abortUpload(id: string, identity: Identity): Promise<void> {
    const session = await this.ownedSession(id, identity);
    if (await this.getMedia(id)) throw new ApiError(409, 'UPLOAD_ALREADY_COMPLETED', 'Completed media must be removed using the media delete endpoint.');
    // Compare-and-swap prevents an abort from deleting media claimed by concurrent completion.
    await this.transition(id, 'aborted');
    if (session.uploadId) {
      try { await this.env.MEDIA.resumeMultipartUpload(session.key, session.uploadId).abort(); }
      catch {
        // An already completed/aborted underlying upload has nothing left to abort.
        // The tombstone still blocks completion; delete any final object below.
      }
    }
    await this.env.MEDIA.delete([session.key, recordKey(id)]);
  }
  async getMedia(id: string): Promise<MediaRecord | null> {
    requireId(id);
    const record = await this.readRecord<MediaRecord>(recordKey(id));
    if (!record) return null;
    if (record.id !== id || typeof record.filename !== 'string' || !/^[a-zA-Z0-9_-]+\.(jpg|png|gif|webp|avif|mp4|webm|mp3|wav|ogg|m4a)$/.test(record.filename) || record.key !== `media/${id}/${record.filename}` || !Object.hasOwn(MIME_EXTENSIONS, record.contentType) || !Number.isSafeInteger(record.size) || record.size < 1) {
      throw new ApiError(503, 'MEDIA_STORAGE_ERROR', 'Stored media metadata is invalid.');
    }
    return record;
  }
  async listMedia(cursor?: string): Promise<{ items: MediaRecord[]; cursor: string | null }> {
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048)) throw new ApiError(400, 'INVALID_CURSOR', 'Invalid pagination cursor.');
    const listed = await this.env.MEDIA.list({ prefix: '.mob/media/', limit: 25, cursor });
    const ids = listed.objects.map(entry => /^\.mob\/media\/([0-9a-f-]+)\.json$/.exec(entry.key)?.[1]).filter((id): id is string => !!id);
    const items: MediaRecord[] = [];
    for (let start = 0; start < ids.length; start += 8) {
      const records = await Promise.all(ids.slice(start, start + 8).map(id => this.getMedia(id)));
      items.push(...records.filter((record): record is MediaRecord => record !== null));
    }
    return { items, cursor: listed.truncated ? listed.cursor : null };
  }
  async deleteMedia(id: string): Promise<void> {
    requireId(id);
    const record = await this.getMedia(id);
    if (!record) return;
    await this.transition(id, 'deleted');
    await this.env.MEDIA.delete([record.key, recordKey(id)]);
  }
  async readMedia(id: string, request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Media supports GET and HEAD.');
    const record = await this.getMedia(id);
    if (!record) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media does not exist or its upload has not completed.');
    const object = await this.env.MEDIA.head(record.key);
    if (!object) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media object does not exist.');
    const headers = new Headers({
      'Content-Type': record.contentType, 'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes', ETag: object.httpEtag, 'Last-Modified': object.uploaded.toUTCString(),
      'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename="${record.filename}"`,
    });
    if (matchEtag(request.headers.get('if-none-match'), object.httpEtag)) return new Response(null, { status: 304, headers });
    let range: { offset: number; length: number } | undefined;
    const rangeHeader = request.method === 'GET' ? request.headers.get('range') : null;
    const ifRange = request.headers.get('if-range');
    const ifRangeTime = ifRange ? Date.parse(ifRange) : NaN;
    const allowRange = !ifRange || ifRange === object.httpEtag || (Number.isFinite(ifRangeTime) && Math.floor(object.uploaded.getTime() / 1000) * 1000 <= ifRangeTime);
    if (rangeHeader && allowRange) {
      const parsed = parseRange(rangeHeader, object.size);
      if (!parsed) {
        headers.set('Content-Range', `bytes */${object.size}`);
        return new Response(null, { status: 416, headers });
      }
      range = parsed;
      headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    }
    headers.set('Content-Length', String(range?.length ?? object.size));
    if (request.method === 'HEAD') return new Response(null, { headers });
    const body = await this.env.MEDIA.get(record.key, range ? { range } : undefined);
    if (!body || !('body' in body)) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media object does not exist.');
    return new Response(body.body, { status: range ? 206 : 200, headers });
  }
}
