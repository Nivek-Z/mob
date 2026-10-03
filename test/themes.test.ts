import { describe, expect, it } from 'vitest';
import { registry, manifest, isAdminAsset } from '../src/themes';
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
});
