import { describe, expect, it, vi } from 'vitest';
import { registry, manifest, isAdminAsset, routeTheme } from '../src/themes';
import type { Env } from '../src/types';
const declaration = { schemaVersion: 1, id: 'custom', routes: { '/': 'index.html', '/admin/': 'admin/index.html' }, configs: [{ id: 'custom', label: '自由配置', path: 'config/sections/custom.json' }] };
describe('theme extension boundaries', () => {
  it('allows nested theme-specific config folders and optional schemas', () => { expect(manifest(declaration, 'custom').configs[0].path).toBe('config/sections/custom.json'); });
  it.each(['../settings.json', 'config/../../config/cloudflare.json', 'config/app.schema.json', 'config/app.references.json', '/config/a.json'])('rejects editable file %s', path => { expect(() => manifest({ ...declaration, configs: [{ id: 'bad', label: 'Bad', path }] }, 'custom')).toThrow(); });
  it('forbids public aliases for protected management assets and API overrides', () => {
    for (const routes of [{ ...declaration.routes, '/write': 'admin/index.html' }, { ...declaration.routes, '/api/posts': 'index.html' }, { ...declaration.routes, '/admin/settings': 'index.html' }]) expect(() => manifest({ ...declaration, routes }, 'custom')).toThrow();
  });
  it('cannot disable the current default or reuse theme IDs', () => {
    expect(() => registry({ schemaVersion: 1, defaultTheme: 'custom', allowVisitorSwitch: true, themes: [{ id: 'custom', root: 'themes/custom', name: 'Custom', enabled: false }] })).toThrow();
  });
  it('recognizes management assets through encoded separators', () => { for (const path of ['/admin', '/themes/custom/admin/index.html', '/themes/custom/admin%2Fsettings.js', '/themes/custom/admin%252Fsettings.js']) expect(isAdminAsset(path)).toBe(true); });
  it('serves reserved public theme assets with one binding fetch and preserves the asset response headers', async () => {
    const fetch = vi.fn(async () => new Response('/* css */', { headers: { 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: '"asset"' } }));
    const request = new Request('https://blog.example.com/themes/custom/css/site.css', { headers: { Cookie: 'mob-layout=other' } });
    const response = await routeTheme(request, { ASSETS: { fetch } } as unknown as Env);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(response.headers.get('ETag')).toBe('"asset"');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });
  it('still resolves declared extensionful page routes and protected management assets through manifests', async () => {
    const registration = { schemaVersion: 1, defaultTheme: 'custom', allowVisitorSwitch: true, themes: [{ id: 'custom', name: 'Custom', root: 'themes/custom', enabled: true }] };
    const fetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/themes.json') return Response.json(registration);
      if (path === '/themes/custom/theme.json') return Response.json({ ...declaration, routes: { ...declaration.routes, '/special.css': 'index.html' } });
      return new Response('page');
    });
    const env = { ASSETS: { fetch } } as unknown as Env;
    const page = await routeTheme(new Request('https://blog.example.com/special.css'), env);
    expect(page.headers.get('X-Mob-Theme')).toBe('custom');
    expect(page.headers.get('Cache-Control')).toBe('private, no-store');
    expect(page.headers.get('Vary')).toBe('Cookie'); expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockClear();
    await routeTheme(new Request('https://blog.example.com/themes/custom/admin/settings.js'), env);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
