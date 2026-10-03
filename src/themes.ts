import { ApiError, object } from './http';
import type { Env } from './types';

export interface Theme { id: string; name: string; root: string; enabled: boolean; }
export interface ThemeRegistry { schemaVersion: 1; defaultTheme: string; allowVisitorSwitch: boolean; themes: Theme[]; }
export interface ThemeConfig { id: string; label: string; path: string; defaultPath?: string; schemaPath?: string; }
export interface ThemeManifest { schemaVersion: 1; id: string; routes: Record<string, string>; configs: ThemeConfig[]; }
const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function themePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 180 && value.split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) && part !== '.' && part !== '..');
}
export function registry(value: unknown): ThemeRegistry {
  const data = object(value);
  if (data.schemaVersion !== 1 || typeof data.allowVisitorSwitch !== 'boolean' || !Array.isArray(data.themes) || !data.themes.length || data.themes.length > 8) throw new ApiError(422, 'INVALID_THEME', 'Declare between one and eight themes.');
  const themes = data.themes.map(value => {
    const theme = object(value);
    if (typeof theme.id !== 'string' || !identifier.test(theme.id) || typeof theme.name !== 'string' || !theme.name.trim() || theme.name.length > 80 || !themePath(theme.root) || theme.root !== `themes/${theme.id}` || typeof theme.enabled !== 'boolean') throw new ApiError(422, 'INVALID_THEME', 'Invalid theme identity, root or enabled flag.');
    return theme as unknown as Theme;
  });
  if (new Set(themes.map(theme => theme.id)).size !== themes.length || !themes.some(theme => theme.id === data.defaultTheme && theme.enabled)) throw new ApiError(422, 'INVALID_THEME', 'The default theme must be enabled; IDs must be unique.');
  return { schemaVersion: 1, defaultTheme: data.defaultTheme as string, allowVisitorSwitch: data.allowVisitorSwitch, themes };
}
export function manifest(value: unknown, id: string): ThemeManifest {
  const data = object(value); const routes = object(data.routes);
  if (data.schemaVersion !== 1 || data.id !== id || !routes['/'] || !routes['/admin/'] || Object.keys(routes).length > 30) throw new ApiError(422, 'INVALID_THEME', 'A theme must declare home and management entries.');
  for (const [route, target] of Object.entries(routes)) {
    if (!/^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]*$/.test(route) || route.split('/').some(part => ['.', '..'].includes(part)) || /^\/(api|media|themes|theme-media)(\/|$)/.test(route) || !themePath(target) || !target.endsWith('.html') || (/^\/admin(?:\/|$)/.test(route) !== target.startsWith('admin/'))) throw new ApiError(422, 'INVALID_THEME', 'Invalid theme route or an unprotected management alias.');
  }
  if (!Array.isArray(data.configs) || data.configs.length > 8) throw new ApiError(422, 'INVALID_THEME', 'A theme may declare up to eight configuration documents.');
  const configs = data.configs.map(value => {
    const config = object(value);
    if (typeof config.id !== 'string' || !identifier.test(config.id) || typeof config.label !== 'string' || config.label.length > 80 || !themePath(config.path) || !/^config\/.+\.json$/.test(config.path) || /\.(default|schema|references)\.json$/.test(config.path)) throw new ApiError(422, 'INVALID_THEME', 'Editable documents must be JSON files in the theme config folder.');
    for (const key of ['defaultPath', 'schemaPath']) if (config[key] !== undefined && (!themePath(config[key]) || !(config[key] as string).startsWith('config/') || !(config[key] as string).endsWith('.json'))) throw new ApiError(422, 'INVALID_THEME', 'Invalid default or schema path.');
    return config as unknown as ThemeConfig;
  });
  if (new Set(configs.map(config => config.id)).size !== configs.length || new Set(configs.map(config => config.path)).size !== configs.length || configs.some(config => configs.some(other => other.path === config.defaultPath || other.path === config.schemaPath))) throw new ApiError(422, 'INVALID_THEME', 'Configuration declarations overlap.');
  return { schemaVersion: 1, id, routes: routes as Record<string, string>, configs };
}
export function isAdminAsset(path: string): boolean {
  let decoded: string; try { decoded = decodeURIComponent(path); } catch { return true; }
  return decoded === '/admin' || decoded.startsWith('/admin/') || /^\/themes\/[^/]+\/admin(?:\/|$)/.test(decoded) || /%(?:2f|5c|2e)/i.test(decoded) || decoded.includes('\\');
}
async function assetJson(env: Env, origin: string, path: string): Promise<unknown | null> {
  if (!env.ASSETS) return null;
  const response = await env.ASSETS.fetch(new Request(origin + path));
  if (!response.ok || !(response.headers.get('Content-Type') ?? '').includes('application/json')) return null;
  return response.json();
}
export async function routeTheme(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Theme routes cannot alias this reserved prefix. Protected assets still pass
  // through the normal path after the app's Access checks; HTML keeps Vary Cookie.
  if (url.pathname.startsWith('/themes/') && !isAdminAsset(url.pathname)) return env.ASSETS.fetch(request);
  const declared = await assetJson(env, url.origin, '/themes.json');
  if (!declared) return env.ASSETS.fetch(request);
  const registration = registry(declared);
  const managementAsset = /^\/admin\/assets\/([a-z0-9-]+)\/(.+)$/.exec(url.pathname);
  if (managementAsset) {
    const owner = registration.themes.find(theme => theme.id === managementAsset[1]);
    if (!owner || !themePath(managementAsset[2])) throw new ApiError(404, 'THEME_NOT_FOUND', 'Management asset not found.');
    url.pathname = `/${owner.root}/admin/${managementAsset[2]}`;
    return env.ASSETS.fetch(new Request(url, request));
  }
  const candidate = url.searchParams.get('theme') ?? /(?:^|;\s*)mob-layout=([a-z0-9-]+)/.exec(request.headers.get('Cookie') ?? '')?.[1];
  const selected = registration.themes.find(theme => theme.enabled && registration.allowVisitorSwitch && theme.id === candidate) ?? registration.themes.find(theme => theme.id === registration.defaultTheme)!;
  const declaration = await assetJson(env, url.origin, `/${selected.root}/theme.json`);
  if (!declaration) throw new ApiError(503, 'THEME_NOT_INSTALLED', 'The selected theme is missing its deployed declaration.');
  const theme = manifest(declaration, selected.id);
  const canonical = url.pathname === '/admin' ? '/admin/' : url.pathname;
  const target = theme.routes[canonical] ?? theme.routes[canonical + '.html'] ?? theme.routes[canonical + '/'];
  if (!target) return env.ASSETS.fetch(request);
  // Match Cloudflare auto-trailing-slash URLs internally, so asset redirects do
  // not send visitors to a raw theme directory or lose their query parameters.
  const assetPath = target.replace(/(?:^|\/)index\.html$/, match => match.startsWith('/') ? '/' : '').replace(/\.html$/, '');
  url.pathname = `/${selected.root}/${assetPath}`; url.searchParams.delete('theme');
  const response = await env.ASSETS.fetch(new Request(url, request));
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store'); headers.set('Vary', 'Cookie');
  headers.set('X-Mob-Theme', selected.id);
  if (registration.allowVisitorSwitch && selected.id === candidate && request.method === 'GET') headers.append('Set-Cookie', `mob-layout=${selected.id}; Path=/; Max-Age=31536000; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`);
  return new Response(response.body, { status: response.status, headers });
}
