import { Validator, type Schema } from '@cfworker/json-schema';
import { ApiError, object, requireId } from './http';
import { GitHubClient, validSha } from './github';
import { registry, manifest, themePath } from './themes';
import { siteOrigin } from './config';
import { MediaService } from './media';
import { GALLERY_INDEX_PATH } from './media-metadata';
import type { Env } from './types';
import { activityConfig } from './activity-config';

export const SITE_PATH = 'config/site/settings.json';
export const THEMES_PATH = 'frontend/themes.json';
export const CATEGORIES_PATH = 'config/gallery/categories.json';
export const GALLERY_PATH = GALLERY_INDEX_PATH;
const PUBLIC_REFERENCES_KEY = '.mob/settings/public-references.json';
const MAX_REFERENCE_CACHE_BYTES = 2 * 1024 * 1024;
const COMMON_REFERENCE_PATHS = new Set([SITE_PATH, CATEGORIES_PATH, THEMES_PATH].flatMap(path => [path, path.replace(/\.json$/, '.references.json')]));
export const DEFAULT_CATEGORIES = { items: [{ id: 'article-images', name: '文章插图' }, { id: 'gallery', name: '日常影像' }] };
export function parseDocument(content: string): unknown {
  try { return JSON.parse(content); } catch { throw new ApiError(503, 'INVALID_STORED_CONFIG', 'The repository contains an invalid JSON document.'); }
}
export function encodeDocument(value: unknown): string {
  const content = JSON.stringify(value, null, 2) + '\n';
  if (new TextEncoder().encode(content).length > 512 * 1024) throw new ApiError(413, 'CONFIG_TOO_LARGE', 'A configuration document may not exceed 512 KiB.');
  return content;
}
export function saveInput(value: unknown): { sha: string | null; value: unknown; mediaIds?: string[] } {
  const input = object(value);
  if (!Object.hasOwn(input, 'value') || (input.sha !== null && !validSha(input.sha)) || Object.keys(input).some(key => !['sha', 'value', 'mediaIds'].includes(key))) throw new ApiError(400, 'INVALID_INPUT', 'Supply value and its current SHA (null for a new document).');
  if (input.mediaIds !== undefined && (!Array.isArray(input.mediaIds) || input.mediaIds.length > 200 || !input.mediaIds.every(id => typeof id === 'string'))) throw new ApiError(400, 'INVALID_MEDIA_ID', 'Invalid media references.');
  for (const id of (input.mediaIds ?? []) as string[]) requireId(id);
  encodeDocument(input.value);
  return input as unknown as { sha: string | null; value: unknown; mediaIds?: string[] };
}
export function references(value: unknown, env: Env, explicit: string[] = []): { ids: string[]; filenames: Map<string, string[]> } {
  const filenames = new Map<string, string[]>(); const ids = new Set(explicit); const origin = siteOrigin(env);
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 40) throw new ApiError(422, 'CONFIG_TOO_DEEP', 'JSON nesting is limited to 40 levels.');
    if (typeof value === 'string') {
      if (/\/api\/admin\/media\/[^/]+\/file/.test(value)) throw new ApiError(422, 'PRIVATE_PREVIEW_LINK', 'Save stable media URLs, not management preview URLs.');
      for (const link of value.match(/(?:https?:)?\/\/[^\s<>"')\]]+|\/media\/[^\s<>"')\]]+/g) ?? []) {
        let url: URL; try { url = new URL(link, origin); } catch { continue; }
        if (url.origin !== origin || !url.pathname.startsWith('/media/')) continue;
        const match = /^\/media\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (!match) throw new ApiError(422, 'INVALID_MEDIA_URL', 'Use the stable media URL returned by the upload API.');
        requireId(match[1]); ids.add(match[1]);
        let name: string; try { name = decodeURIComponent(match[2]); } catch { throw new ApiError(422, 'INVALID_MEDIA_URL', 'Invalid filename.'); }
        filenames.set(match[1], [...(filenames.get(match[1]) ?? []), name]);
      }
    } else if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
    else if (value && typeof value === 'object') Object.values(value).forEach(item => visit(item, depth + 1));
  };
  visit(value);
  if (ids.size > 200) throw new ApiError(422, 'TOO_MANY_MEDIA_REFERENCES', 'A document may reference at most 200 media objects.');
  return { ids: [...ids], filenames };
}
export function validateSite(value: unknown): void {
  const site = object(value); const profile = object(site.profile);
  if (site.activity !== undefined) activityConfig(site.activity);
  if (typeof site.title !== 'string' || !site.title.trim() || site.title.length > 200 || typeof site.description !== 'string' || site.description.length > 2000 || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 100 || typeof profile.bio !== 'string' || profile.bio.length > 4000 || typeof profile.avatar !== 'string') throw new ApiError(422, 'INVALID_SITE', 'Supply title, description and profile name, bio and avatar.');
  for (const group of ['socials', 'friends']) {
    if (!Array.isArray(site[group]) || (site[group] as unknown[]).length > 100) throw new ApiError(422, 'INVALID_SITE', 'Links must be arrays with at most 100 entries.');
    for (const item of site[group] as unknown[]) {
      const link = object(item);
      if (typeof link.label !== 'string' || !link.label.trim() || link.label.length > 100 || typeof link.url !== 'string' || link.url.length > 2000) throw new ApiError(422, 'INVALID_SITE', 'Links need a label and URL.');
      let url: URL; try { url = new URL(link.url); } catch { throw new ApiError(422, 'INVALID_SITE', 'Link URLs must be absolute.'); }
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) throw new ApiError(422, 'INVALID_SITE', 'Unsupported link protocol.');
    }
  }
  if (site.navigation !== undefined) {
    if (!Array.isArray(site.navigation) || site.navigation.length > 30) throw new ApiError(422, 'INVALID_SITE', 'Navigation is limited to 30 links.');
    for (const item of site.navigation) {
      const link = object(item);
      if (typeof link.label !== 'string' || !link.label.trim() || link.label.length > 100 || typeof link.url !== 'string' || link.url.length > 2000) throw new ApiError(422, 'INVALID_SITE', 'Invalid navigation link.');
      let url: URL; try { url = new URL(link.url, 'https://example.invalid'); } catch { throw new ApiError(422, 'INVALID_SITE', 'Invalid navigation URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ApiError(422, 'INVALID_SITE', 'Invalid navigation protocol.');
    }
  }
}
export function validateCategories(value: unknown): void {
  const data = object(value);
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 100) throw new ApiError(422, 'INVALID_CATEGORY', 'Declare 1–100 gallery categories.');
  const ids: string[] = [];
  for (const item of data.items) {
    const category = object(item);
    if (typeof category.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category.id) || typeof category.name !== 'string' || !category.name.trim() || category.name.length > 100) throw new ApiError(422, 'INVALID_CATEGORY', 'Invalid category ID or name.');
    ids.push(category.id);
  }
  if (new Set(ids).size !== ids.length || !ids.includes('article-images') || !ids.includes('gallery')) throw new ApiError(422, 'INVALID_CATEGORY', 'Keep unique IDs and the article-images / gallery categories; their names may change.');
}
export class SettingsService {
  readonly github: GitHubClient;
  constructor(private readonly env: Env, github?: GitHubClient) { this.github = github ?? new GitHubClient(env); }
  async read(path: string, fallback: unknown = {}): Promise<{ sha: string | null; value: unknown }> {
    const file = await this.github.readFile(path);
    return { sha: file?.sha ?? null, value: file ? parseDocument(file.content) : fallback };
  }
  async edit(path: string, fallback: unknown = {}) {
    const result = await this.read(path, fallback);
    const sidecar = await this.read(path.replace(/\.json$/, '.references.json'), { mediaIds: [] });
    const detected = new Set(references(result.value, this.env).ids);
    const stored = references({}, this.env, object(sidecar.value).mediaIds as string[] ?? []).ids;
    // The editor submits additional references only. Automatically detected URLs
    // must not become permanent grants when the corresponding field is removed.
    return { ...result, mediaIds: stored.filter(id => !detected.has(id)) };
  }
  async themes() {
    const file = await this.read(THEMES_PATH); return { ...file, value: registry(file.value) };
  }
  async saveRegistry(input: unknown) {
    const proposed = registry(saveInput(input).value);
    const head = await this.github.readHead(); const tree = await this.github.readTree(head ?? undefined);
    const paths = new Map(tree.map(entry => [entry.path, entry]));
    const manifests = proposed.themes.map(theme => paths.get(`frontend/${theme.root}/theme.json`));
    if (manifests.some(entry => !entry)) throw new ApiError(422, 'THEME_NOT_INSTALLED', 'Commit the complete theme folder before registering it.');
    const blobs = await this.github.readBlobs(manifests.map(entry => entry!.sha)); let configCount = 0;
    for (const [index, theme] of proposed.themes.entries()) {
      const definition = manifest(parseDocument(blobs.get(manifests[index]!.sha)!), theme.id);
      const root = `frontend/${theme.root}/`; configCount += definition.configs.length;
      for (const target of Object.values(definition.routes)) if (!paths.has(root + target)) throw new ApiError(422, 'THEME_NOT_INSTALLED', 'A declared theme page is missing.');
      for (const config of definition.configs) {
        if (!paths.has(root + config.path) && !(config.defaultPath && paths.has(root + config.defaultPath)) || config.schemaPath && !paths.has(root + config.schemaPath)) throw new ApiError(422, 'THEME_NOT_INSTALLED', 'A declared configuration/default/schema is missing.');
      }
    }
    if (configCount > 31) throw new ApiError(422, 'TOO_MANY_CONFIGS', 'Declare at most 31 theme configuration documents.');
    return this.save(THEMES_PATH, input, value => { registry(value); });
  }
  async theme(id: string) {
    const registration = await this.themes(); const theme = registration.value.themes.find(theme => theme.id === id);
    if (!theme) throw new ApiError(404, 'THEME_NOT_FOUND', 'Theme not found.');
    const declaration = await this.read(`frontend/${theme.root}/theme.json`);
    return { theme, manifest: manifest(declaration.value, id) };
  }
  async themeConfig(id: string, document: string) {
    const declaration = await this.theme(id); const config = declaration.manifest.configs.find(config => config.id === document);
    if (!config) throw new ApiError(404, 'CONFIG_NOT_FOUND', 'Configuration not declared by this theme.');
    const root = `frontend/${declaration.theme.root}/`;
    return { ...declaration, config, path: root + config.path, root };
  }
  async readTheme(id: string, document: string, admin = false) {
    const declared = await this.themeConfig(id, document);
    if (!admin && !declared.theme.enabled) throw new ApiError(404, 'THEME_NOT_FOUND', 'Theme disabled.');
    const fallback = declared.config.defaultPath ? (await this.read(declared.root + declared.config.defaultPath)).value : {};
    if (admin) return { ...await this.edit(declared.path, fallback), declaration: declared.config };
    return { value: (await this.read(declared.path, fallback)).value };
  }
  async save(path: string, inputValue: unknown, validate?: (value: unknown) => void) {
    const input = saveInput(inputValue); validate?.(input.value);
    const refs = references(input.value, this.env, input.mediaIds);
    const media = new MediaService(this.env);
    for (const id of refs.ids) {
      const record = await media.getMedia(id);
      if (!record || refs.filenames.get(id)?.some(name => name !== record.filename)) throw new ApiError(422, 'MEDIA_NOT_READY', 'A referenced media object is missing or its URL is invalid.');
    }
    const sidecar = path.replace(/\.json$/, '.references.json'); const old = await this.github.readFile(sidecar);
    const content = encodeDocument(input.value);
    const result = await this.github.writeFiles([{ path, content, sha: input.sha }, { path: sidecar, content: encodeDocument({ mediaIds: refs.ids }), sha: old?.sha ?? null }], `blog: update ${path}`);
    return { sha: result.shas[path], value: input.value, commitSha: result.commitSha };
  }
  async saveTheme(id: string, document: string, input: unknown) {
    const declared = await this.themeConfig(id, document);
    const value = saveInput(input).value;
    if (declared.config.schemaPath) {
      const schema = (await this.read(declared.root + declared.config.schemaPath)).value;
      // Only local fragment references: no network resolver or executable theme code.
      const inspect = (node: unknown, depth = 0): void => {
        if (depth > 40) throw new ApiError(422, 'INVALID_SCHEMA', 'Schema nesting is too deep.');
        if (!node || typeof node !== 'object') return;
        for (const [key, child] of Object.entries(node)) {
          if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#'))) throw new ApiError(422, 'INVALID_SCHEMA', 'Only local schema references are supported.');
          inspect(child, depth + 1);
        }
      };
      inspect(schema);
      let result;
      try { result = new Validator(schema as Schema).validate(value); } catch { throw new ApiError(422, 'INVALID_SCHEMA', 'The theme schema is invalid.'); }
      if (!result.valid) throw new ApiError(422, 'CONFIG_VALIDATION_FAILED', 'Configuration does not match the theme schema.', result.errors.slice(0, 20));
    }
    return this.save(declared.path, input);
  }
  private referenceNamespace(): string {
    return JSON.stringify([this.env.GITHUB_OWNER, this.env.GITHUB_REPO, this.env.GITHUB_BRANCH, siteOrigin(this.env)]);
  }
  private async cachedPublicReferences(head: string): Promise<Map<string, string[]> | null> {
    try {
      const cached = await this.env.MEDIA.get(PUBLIC_REFERENCES_KEY);
      if (!cached) return null;
      if (cached.size > MAX_REFERENCE_CACHE_BYTES) { await cached.body.cancel(); return null; }
      const data = await cached.json<{ version: number; namespace: string; head: string; refs: [string, string[]][] }>();
      if (data.version !== 1 || data.namespace !== this.referenceNamespace() || data.head !== head || !Array.isArray(data.refs) || data.refs.length > 13600) return null;
      const index = new Map<string, string[]>(); let count = 0;
      for (const entry of data.refs) {
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const [id, paths] = entry; requireId(id);
        if (index.has(id) || !Array.isArray(paths) || !paths.length || paths.length > 68) return null;
        for (const path of paths) if (!themePath(path) || !(COMMON_REFERENCE_PATHS.has(path) || /^frontend\/themes\/[a-z0-9-]+\/config\/.+\.json$/.test(path))) return null;
        count += paths.length; if (count > 13600) return null;
        index.set(id, paths);
      }
      return index;
    } catch { return null; } // A disposable cache must never make repository reads fail.
  }
  private async cachePublicReferences(head: string, index: Map<string, string[]>): Promise<void> {
    try {
      const content = JSON.stringify({ version: 1, namespace: this.referenceNamespace(), head, refs: [...index] });
      if (new TextEncoder().encode(content).length <= MAX_REFERENCE_CACHE_BYTES) await this.env.MEDIA.put(PUBLIC_REFERENCES_KEY, content, { httpMetadata: { contentType: 'application/json' } });
    } catch { /* GitHub remains authoritative when R2 is unavailable. */ }
  }
  /** Read live HEAD before a snapshot cache; deletion checks include disabled themes. */
  async usage(id: string, publicOnly = false): Promise<string[]> {
    const head = await this.github.readHead(); if (!head) return [];
    if (publicOnly) {
      const cached = await this.cachedPublicReferences(head);
      if (cached) return cached.get(id) ?? [];
    }
    const tree = await this.github.readTree(head); const byPath = new Map(tree.map(entry => [entry.path, entry]));
    const regEntry = byPath.get(THEMES_PATH);
    const registration = regEntry ? registry(parseDocument(await this.github.readBlob(regEntry.sha))) : null;
    const selected = registration?.themes.filter(theme => !publicOnly || theme.enabled) ?? [];
    const declarations = selected.map(theme => ({ theme, entry: byPath.get(`frontend/${theme.root}/theme.json`) }));
    if (declarations.some(item => !item.entry)) throw new ApiError(503, 'INVALID_STORED_CONFIG', 'A registered theme has no declaration.');
    const blobs = await this.github.readBlobs(declarations.map(item => item.entry!.sha));
    const paths = [SITE_PATH, CATEGORIES_PATH, THEMES_PATH];
    for (const item of declarations) {
      const declaration = manifest(parseDocument(blobs.get(item.entry!.sha)!), item.theme.id);
      for (const config of declaration.configs) {
        const path = `frontend/${item.theme.root}/${config.path}`;
        paths.push(byPath.has(path) ? path : `frontend/${item.theme.root}/${config.defaultPath ?? config.path}`);
      }
    }
    if (paths.length > 34) throw new ApiError(503, 'TOO_MANY_CONFIGS', 'The platform supports 31 theme and three common configuration documents.');
    const files = paths.flatMap(path => [path, path.replace(/\.json$/, '.references.json')]).filter(path => byPath.has(path));
    const index = new Map<string, string[]>();
    for (let at = 0; at < files.length; at += 10) {
      const chunk = files.slice(at, at + 10); const sources = await this.github.readBlobs(chunk.map(path => byPath.get(path)!.sha));
      for (const path of chunk) {
        const value = parseDocument(sources.get(byPath.get(path)!.sha)!);
        const ids = references(value, this.env, path.endsWith('.references.json') ? (object(value).mediaIds ?? []) as string[] : []).ids;
        for (const reference of ids) if (publicOnly || reference === id) index.set(reference, [...(index.get(reference) ?? []), path]);
      }
    }
    if (publicOnly) await this.cachePublicReferences(head, index);
    return index.get(id) ?? [];
  }
}
