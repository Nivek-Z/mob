import { ApiError, object, requireId } from './http';
import { validSha } from './github';
import { SettingsService, CATEGORIES_PATH, DEFAULT_CATEGORIES, GALLERY_PATH, encodeDocument, validateCategories } from './settings';
import { MediaService } from './media';
import type { Env, MediaRecord, Identity } from './types';

export interface GalleryItem { id: string; filename: string; url: string; contentType: string; size: number; createdAt: string; title: string; description: string; categoryId: string; tags: string[]; isPublic: boolean; isListed: boolean; source: 'editor' | 'gallery' | 'theme' | 'import'; }
export class GalleryService {
  readonly settings: SettingsService;
  readonly media: MediaService;
  constructor(env: Env, settings?: SettingsService, media?: MediaService) { this.settings = settings ?? new SettingsService(env); this.media = media ?? new MediaService(env); }
  async categories() { const doc = await this.settings.read(CATEGORIES_PATH, DEFAULT_CATEGORIES); validateCategories(doc.value); return doc; }
  async document(): Promise<{ sha: string | null; items: GalleryItem[] }> {
    const doc = await this.settings.read(GALLERY_PATH, { items: [] }); const data = object(doc.value);
    if (!Array.isArray(data.items) || data.items.length > 1000) throw new ApiError(503, 'INVALID_GALLERY', 'The gallery index is invalid or exceeds 1000 items.');
    for (const item of data.items) { const value = object(item); requireId(value.id as string); if (typeof value.isPublic !== 'boolean' || typeof value.isListed !== 'boolean') throw new ApiError(503, 'INVALID_GALLERY', 'Invalid gallery visibility flags.'); }
    return { sha: doc.sha, items: data.items as GalleryItem[] };
  }
  async list(url: URL, admin = false) {
    const document = await this.document();
    const limit = Number(url.searchParams.get('limit') ?? 40); const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000) throw new ApiError(400, 'INVALID_QUERY', 'Invalid gallery pagination.');
    const category = url.searchParams.get('category'); const query = (url.searchParams.get('q') ?? '').toLowerCase();
    if (query.length > 200) throw new ApiError(400, 'INVALID_QUERY', 'Search query is too long.');
    const items = document.items.filter(item => (admin || item.isPublic && item.isListed) && (!category || item.categoryId === category) && (!query || `${item.title}\n${item.description}\n${item.tags.join(' ')}`.toLowerCase().includes(query))).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset, ...(admin ? { sha: document.sha } : {}) };
  }
  async grants(id: string): Promise<boolean> { return (await this.document()).items.some(item => item.id === id && item.isPublic); }
  async save(items: GalleryItem[], sha: string | null) {
    if (items.length > 1000) throw new ApiError(413, 'GALLERY_FULL', 'The gallery supports 1000 items.');
    const result = await this.settings.github.writeFiles([{ path: GALLERY_PATH, content: encodeDocument({ items }), sha }], 'blog: update gallery');
    return { sha: result.shas[GALLERY_PATH], commitSha: result.commitSha };
  }
  private entry(record: MediaRecord, source: GalleryItem['source']): GalleryItem {
    return { id: record.id, filename: record.filename, url: record.url, contentType: record.contentType, size: record.size, createdAt: record.createdAt, title: record.filename, description: '', categoryId: source === 'editor' ? 'article-images' : 'gallery', tags: [], isPublic: false, isListed: false, source };
  }
  /** Idempotent: a failed metadata registration can retry the completed R2 ID. */
  async register(value: unknown) {
    const input = object(value); requireId(input.id as string);
    const source = input.source ?? 'gallery';
    if (!['editor', 'gallery', 'theme', 'import'].includes(source as string) || Object.keys(input).some(key => !['id', 'source'].includes(key))) throw new ApiError(400, 'INVALID_INPUT', 'Invalid gallery registration.');
    const document = await this.document(); const existing = document.items.find(item => item.id === input.id);
    if (existing) return { item: existing, sha: document.sha };
    const record = await this.media.getMedia(input.id as string);
    if (!record) throw new ApiError(422, 'MEDIA_NOT_READY', 'Finish uploading before gallery registration.');
    const item = this.entry(record, source as GalleryItem['source']);
    return { item, ...await this.save([...document.items, item], document.sha) };
  }
  async update(value: unknown) {
    const input = object(value);
    if (input.sha !== null && !validSha(input.sha) || !Array.isArray(input.items) || !input.items.length || input.items.length > 100 || Object.keys(input).some(key => !['sha', 'items'].includes(key))) throw new ApiError(400, 'INVALID_INPUT', 'Supply the current gallery SHA and 1–100 updates.');
    const document = await this.document();
    if (input.sha !== document.sha) throw new ApiError(409, 'CONFIG_CONFLICT', 'The gallery changed. Reload before saving; keep your edits.');
    const categories = object((await this.categories()).value).items as { id: string }[];
    const updates = new Map<string, Partial<GalleryItem>>();
    for (const raw of input.items) {
      const patch = object(raw); requireId(patch.id as string);
      if (updates.has(patch.id as string) || !document.items.some(item => item.id === patch.id) || Object.keys(patch).some(key => !['id', 'title', 'description', 'categoryId', 'tags', 'isPublic', 'isListed'].includes(key))) throw new ApiError(422, 'INVALID_GALLERY_ITEM', 'Unknown, duplicate or immutable gallery field.');
      for (const [field, max] of [['title', 200], ['description', 4000]] as const) if (patch[field] !== undefined && (typeof patch[field] !== 'string' || (patch[field] as string).length > max)) throw new ApiError(422, 'INVALID_GALLERY_ITEM', 'Invalid gallery text.');
      if (patch.categoryId !== undefined && !categories.some(category => category.id === patch.categoryId)) throw new ApiError(422, 'INVALID_CATEGORY', 'Category not found.');
      if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.length > 30 || !patch.tags.every(tag => typeof tag === 'string' && tag.length <= 100))) throw new ApiError(422, 'INVALID_GALLERY_ITEM', 'Invalid tags.');
      for (const flag of ['isPublic', 'isListed']) if (patch[flag] !== undefined && typeof patch[flag] !== 'boolean') throw new ApiError(422, 'INVALID_GALLERY_ITEM', 'Invalid visibility flag.');
      const merged = { ...document.items.find(item => item.id === patch.id)!, ...patch };
      if (merged.isListed && !merged.isPublic) throw new ApiError(422, 'INVALID_GALLERY_ITEM', 'Listed gallery items must have public URLs.');
      updates.set(patch.id as string, patch as Partial<GalleryItem>);
    }
    return this.save(document.items.map(item => ({ ...item, ...updates.get(item.id) })), document.sha);
  }
  async remove(id: string, value: unknown) {
    const input = object(value); if (input.sha !== null && !validSha(input.sha) || Object.keys(input).some(key => key !== 'sha')) throw new ApiError(400, 'INVALID_INPUT', 'Supply the current gallery SHA.');
    const document = await this.document();
    if (document.sha !== input.sha) throw new ApiError(409, 'CONFIG_CONFLICT', 'The gallery changed. Reload before deleting.');
    // Resolve before unregistering: Git may be the only remaining metadata source.
    const record = await this.media.getMedia(id);
    // Keep a retryable private record if storage deletion fails after the Git commit.
    if (record) await this.media.preserveMedia(record);
    // Revoke the display/public grant first; failed storage deletion can be retried.
    const result = document.items.some(item => item.id === id) ? await this.save(document.items.filter(item => item.id !== id), document.sha) : { sha: document.sha };
    await this.media.deleteMedia(id, record); return { ...result, deleted: true };
  }
  async import(cursor?: string) {
    const page = await this.media.listMedia(cursor); const document = await this.document();
    const existing = new Set(document.items.map(item => item.id)); const additions = page.items.filter(record => !existing.has(record.id)).map(record => this.entry(record, 'import'));
    return { imported: additions.length, cursor: page.cursor, ...(additions.length ? await this.save([...document.items, ...additions], document.sha) : { sha: document.sha }) };
  }
  async storage(cursor?: string) {
    const [page, document] = await Promise.all([this.media.listStoredMedia(cursor), this.document()]);
    const registered = new Set(document.items.map(item => item.id));
    return { items: page.items.filter(item => !registered.has(item.id)), cursor: page.cursor };
  }
  async importStorage(value: unknown, owner: Identity) {
    const input = object(value);
    if (Object.keys(input).some(key => !['key', 'etag'].includes(key)) || typeof input.key !== 'string' || typeof input.etag !== 'string' || input.etag.length > 200) throw new ApiError(400, 'INVALID_INPUT', 'Supply the stored media key and its current ETag.');
    const record = await this.media.importStoredMedia(input.key, input.etag, owner);
    return this.register({ id: record.id, source: 'import' });
  }
  async saveCategories(input: unknown) {
    const value = object(input).value; validateCategories(value);
    const ids = new Set((object(value).items as { id: string }[]).map(item => item.id));
    if ((await this.document()).items.some(item => !ids.has(item.categoryId))) throw new ApiError(409, 'CATEGORY_IN_USE', 'Move the gallery items before removing their category.');
    return this.settings.save(CATEGORIES_PATH, input, validateCategories);
  }
}
