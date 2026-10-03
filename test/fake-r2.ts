import { createHash } from 'node:crypto';
interface StoredObject { data: Uint8Array; uploaded: Date; etag: string; httpMetadata: R2HTTPMetadata; customMetadata: Record<string, string>; }
interface MultipartState { key: string; uploadId: string; options: R2MultipartOptions; parts: Map<number, { data: Uint8Array; etag: string }>; }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function bytesFor(value: unknown): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array();
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
}
function metadata(input: R2HTTPMetadata | Headers | undefined): R2HTTPMetadata {
  if (input instanceof Headers) return { contentType: input.get('content-type') ?? undefined };
  return { ...input };
}
/** In-memory binding fake. Does not emulate Cloudflare networking or resource limits. */
export class FakeR2Bucket {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<string, MultipartState>();
  asBucket(): R2Bucket { return this as unknown as R2Bucket; }
  private object(key: string, stored: StoredObject): R2Object {
    return { key, version: stored.etag, size: stored.data.length, etag: stored.etag,
      httpEtag: `"${stored.etag}"`, uploaded: stored.uploaded,
      httpMetadata: { ...stored.httpMetadata }, customMetadata: { ...stored.customMetadata },
      checksums: {}, storageClass: 'Standard',
      writeHttpMetadata(headers: Headers) { if (stored.httpMetadata.contentType) headers.set('Content-Type', stored.httpMetadata.contentType); },
    } as R2Object;
  }
  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key); return stored ? this.object(key, stored) : null;
  }
  async put(key: string, value: unknown, options: R2PutOptions = {}): Promise<R2Object | null> {
    const data = await bytesFor(value);
    const existing = this.objects.get(key);
    if (options.onlyIf && !(options.onlyIf instanceof Headers)) {
      const condition = options.onlyIf;
      if (condition.etagDoesNotMatch === '*' && existing) return null;
      if (condition.etagMatches && existing?.etag !== condition.etagMatches.replace(/^"|"$/g, '')) return null;
    }
    const stored: StoredObject = { data, uploaded: new Date(), etag: digest(data), httpMetadata: metadata(options.httpMetadata), customMetadata: { ...options.customMetadata } };
    this.objects.set(key, stored); return this.object(key, stored);
  }
  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key); if (!stored) return null;
    const object = this.object(key, stored); let data = stored.data;
    if (options?.range && !(options.range instanceof Headers)) {
      const range = options.range;
      const offset = 'suffix' in range ? Math.max(0, data.length - (range.suffix ?? 0)) : range.offset ?? 0;
      const length = 'suffix' in range ? data.length - offset : range.length ?? data.length - offset;
      data = data.slice(offset, offset + length);
    }
    const bodyBytes = data.slice(); const response = new Response(bodyBytes.buffer as ArrayBuffer);
    return { ...object, body: response.body!, bodyUsed: false,
      async arrayBuffer() { return bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer; },
      async text() { return new TextDecoder().decode(bodyBytes); },
      async json<T>() { return JSON.parse(new TextDecoder().decode(bodyBytes)) as T; },
      async blob() { return new Blob([bodyBytes.buffer as ArrayBuffer]); },
    } as R2ObjectBody;
  }
  async delete(key: string | string[]): Promise<void> { for (const name of Array.isArray(key) ? key : [key]) this.objects.delete(name); }
  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const keys = [...this.objects.keys()].filter(key => key.startsWith(options.prefix ?? '')).sort();
    if (options.delimiter) {
      const entries = [...new Set(keys.map(key => {
        const end = key.indexOf(options.delimiter!, (options.prefix ?? '').length);
        return end < 0 ? key : key.slice(0, end + options.delimiter!.length);
      }))];
      const start = options.cursor ? entries.findIndex(key => key > options.cursor!) : 0;
      const selected = start < 0 ? [] : entries.slice(start, start + (options.limit ?? 1000));
      const truncated = start >= 0 && start + selected.length < entries.length;
      return { objects: selected.filter(key => this.objects.has(key)).map(key => this.object(key, this.objects.get(key)!)),
        delimitedPrefixes: selected.filter(key => !this.objects.has(key)), truncated, ...(truncated ? { cursor: selected.at(-1)! } : {}) } as R2Objects;
    }
    const offset = options.cursor ? Number(options.cursor) : 0;
    const slice = keys.slice(offset, offset + (options.limit ?? 1000)); const truncated = offset + slice.length < keys.length;
    return { objects: slice.map(key => this.object(key, this.objects.get(key)!)), truncated, ...(truncated ? { cursor: String(offset + slice.length) } : {}), delimitedPrefixes: [] } as R2Objects;
  }
  async createMultipartUpload(key: string, options: R2MultipartOptions = {}): Promise<R2MultipartUpload> {
    const uploadId = crypto.randomUUID(); this.uploads.set(uploadId, { key, uploadId, options, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    const bucket = this;
    function state(): MultipartState {
      const value = bucket.uploads.get(uploadId); if (!value || value.key !== key) throw new Error('Multipart upload does not exist.'); return value;
    }
    return { key, uploadId,
      async uploadPart(partNumber: number, value: unknown) {
        const data = await bytesFor(value); const etag = digest(data); state().parts.set(partNumber, { data, etag }); return { partNumber, etag };
      },
      async abort() { state(); bucket.uploads.delete(uploadId); },
      async complete(parts: R2UploadedPart[]) {
        const upload = state();
        const selected = parts.map(part => { const stored = upload.parts.get(part.partNumber); if (!stored || stored.etag !== part.etag) throw new Error('Multipart ETag does not match.'); return stored.data; });
        const data = new Uint8Array(selected.reduce((size, part) => size + part.length, 0)); let offset = 0;
        for (const part of selected) { data.set(part, offset); offset += part.length; }
        const object = await bucket.put(key, data, { httpMetadata: upload.options.httpMetadata, customMetadata: upload.options.customMetadata }); bucket.uploads.delete(uploadId); return object!;
      },
    } as R2MultipartUpload;
  }
}
