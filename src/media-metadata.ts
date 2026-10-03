import { ApiError } from './http';
import type { MediaRecord } from './types';

export const GALLERY_INDEX_PATH = 'content/gallery/items.json';
export const MEDIA_FILENAME = /^[a-zA-Z0-9_-]+\.(jpg|png|gif|webp|avif|mp4|webm|mp3|wav|ogg|m4a)$/;
const extensions: Record<string, string[]> = {
  'image/jpeg': ['jpg'], 'image/png': ['png'], 'image/gif': ['gif'], 'image/webp': ['webp'], 'image/avif': ['avif'],
  'video/mp4': ['mp4'], 'video/webm': ['webm'], 'audio/mpeg': ['mp3'], 'audio/wav': ['wav'], 'audio/ogg': ['ogg'], 'audio/mp4': ['m4a'],
};

/** Git stores these completed-media fields; the managed object key is derived from the ID and filename. */
export function mediaMetadata(value: unknown, id: string): Omit<MediaRecord, 'key' | 'owner'> {
  const record = value as MediaRecord | null;
  let url: URL | undefined;
  try { url = new URL(record?.url ?? ''); } catch { /* Validated below. */ }
  if (!record || record.id !== id || typeof record.filename !== 'string' || !MEDIA_FILENAME.test(record.filename)
    || typeof record.contentType !== 'string' || !Object.hasOwn(extensions, record.contentType)
    || !extensions[record.contentType].includes(record.filename.split('.').at(-1)!)
    || !Number.isSafeInteger(record.size) || record.size < 1 || record.size > 5 * 1024 ** 3
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== `/media/${id}/${record.filename}`) {
    throw new ApiError(503, 'MEDIA_STORAGE_ERROR', 'Stored media metadata is invalid.');
  }
  return { id, filename: record.filename, contentType: record.contentType, size: record.size, createdAt: record.createdAt, url: record.url };
}
