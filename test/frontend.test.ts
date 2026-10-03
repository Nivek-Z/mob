import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { readPlatformFixture } from './platform-fixtures';

function fixture(filename: string, script?: string) {
  const dom = new JSDOM(readFileSync(filename, 'utf8'), { url: 'https://blog.example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.eval(readFileSync('frontend/core/api.js', 'utf8'));
  win.eval(readFileSync('frontend/core/markdown.js', 'utf8'));
  if (script) win.eval(readFileSync(script, 'utf8'));
  return { dom, win };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe('theme frontends', () => {
  it('ships complete standalone routes, valid asset references and its own admin per theme', () => {
    const registration = JSON.parse(readPlatformFixture('frontend/themes.json'));
    for (const theme of registration.themes) {
      const declaration = JSON.parse(readFileSync('frontend/' + theme.root + '/theme.json', 'utf8'));
      expect(declaration.routes['/admin/']).toBe('admin/index.html');
      for (const target of Object.values(declaration.routes) as string[]) {
        const { dom, win } = fixture('frontend/' + theme.root + '/' + target);
        expect(win.document.documentElement.dataset.layout).toBe(theme.id);
        for (const node of [...win.document.querySelectorAll('script[src],link[href],img[src]')]) {
          const url = node.getAttribute('src') || node.getAttribute('href')!;
          if (url.startsWith('/theme-media/')) continue;
          const asset = url.replace(/^\/admin\/assets\/([^/]+)\//, '/themes/$1/admin/');
          if (asset.startsWith('/')) expect(existsSync(path.resolve('frontend', '.' + asset)), url).toBe(true);
        }
        if (target === 'index.html') expect(win.document.querySelector('a[href="/gallery.html"]'), target).not.toBeNull(); dom.window.close();
      }
    }
  });
  it('renders the same social links, profile and friends in both themes', async () => {
    const site = { title: '我的空间', profile: { name: '测试用户', bio: '共同简介', avatar: '/media/avatar.png' }, description: '介绍', socials: [{ label: '主页', url: 'https://example.com' }], friends: [{ label: '友邻', url: 'https://friend.example.com' }] };
    for (const theme of ['firefly', 'paper']) {
      const { dom, win } = fixture(`frontend/themes/${theme}/index.html`);
      win.Mob = { ...win.Mob, api: vi.fn(async url => url === '/api/site' ? { value: site } : { allowVisitorSwitch: true, defaultTheme: 'firefly', themes: [{ id: 'firefly', name: '萤火' }, { id: 'paper', name: '纸间' }] }) };
      win.eval(readFileSync('frontend/core/runtime.js', 'utf8')); await tick();
      expect(win.document.querySelector('[data-friends] a')?.textContent).toBe('友邻');
      expect((win.document.querySelector('.layout-picker select') as unknown as { value: string })?.value).toBe(theme);
      expect(win.document.querySelector('.hero-identity h1 span, [data-profile-name]')?.textContent).toBe('测试用户');
      dom.window.close();
    }
  });
  it('applies Firefly cover, custom image stickers, text and styles from its own config', async () => {
    const { dom, win } = fixture('frontend/themes/firefly/index.html');
    const value = JSON.parse(readPlatformFixture('frontend/themes/firefly/config/appearance.json'));
    value.hero.cover = '/media/custom/cover.png'; value.stickers = [{ text: '', image: '/media/custom/sticker.png', x: 20, y: 40, rotation: 12, size: 50 }]; value.guide.title = '新导航'; value.styles = { '.hero-identity': { 'letter-spacing': '2px' } };
    win.Mob.api = vi.fn(async () => ({ value })); win.eval(readFileSync('frontend/themes/firefly/js/config.js', 'utf8')); await tick();
    expect(win.document.querySelector('.hero-backdrop')?.getAttribute('src')).toContain('/media/custom/cover.png');
    expect(win.document.querySelector('.custom-stickers img')?.getAttribute('src')).toContain('/media/custom/sticker.png');
    expect(win.document.getElementById('guide-title')?.textContent).toBe('新导航');
    expect((win.document.querySelector('.hero-identity') as HTMLElement).style.letterSpacing).toBe('2px'); dom.window.close();
  });
  it('keeps settings input after a GitHub SHA conflict', async () => {
    const { dom, win } = fixture('frontend/themes/firefly/admin/settings.html');
    const value = JSON.parse(readPlatformFixture('frontend/themes/firefly/config/appearance.json'));
    const api = vi.fn(async (_url, options) => { if (options?.method === 'PUT') throw Object.assign(new Error('conflict'), { code: 'CONFIG_CONFLICT' }); return { sha: 'a'.repeat(40), value, mediaIds: [] }; });
    win.Mob.api = api; win.eval(readFileSync('frontend/themes/firefly/admin/ui.js', 'utf8')); win.eval(readFileSync('frontend/themes/firefly/admin/settings.js', 'utf8')); await tick();
    const raw = win.document.getElementById('settings-json') as HTMLTextAreaElement; value.hero.eyebrow = '未保存的文字'; raw.value = JSON.stringify(value); raw.dispatchEvent(new win.Event('input'));
    win.document.getElementById('settings-save')!.click(); await tick();
    expect(raw.value).toContain('未保存的文字'); expect(win.document.getElementById('settings-note')!.textContent).toContain('已保留');
    expect(api.mock.calls.at(-1)![0]).toBe('/api/admin/themes/firefly/config/appearance'); dom.window.close();
  });
  it('pasted and dropped files use the same upload path without interfering with text', () => {
    const { dom, win } = fixture('frontend/themes/firefly/admin/index.html', 'frontend/core/upload.js');
    const box = win.document.getElementById('markdown')!; const accept = vi.fn(); win.Mob.bindDrops(box, accept);
    const file = new win.File(['image'], 'clip.png', { type: 'image/png' });
    const paste = new win.Event('paste', { cancelable: true }); Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } }); box.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true); expect(accept).toHaveBeenCalledWith([file]);
    const text = new win.Event('paste', { cancelable: true }); Object.defineProperty(text, 'clipboardData', { value: { files: [] } }); box.dispatchEvent(text); expect(text.defaultPrevented).toBe(false);
    const drop = new win.Event('drop', { cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } }); box.dispatchEvent(drop); expect(accept).toHaveBeenCalledTimes(2); dom.window.close();
  });
  it('retries GitHub registration with the completed ID and does not reupload bytes', async () => {
    const { dom, win } = fixture('frontend/themes/firefly/admin/index.html', 'frontend/core/upload.js');
    const record = { id: '11111111-1111-4111-8111-111111111111', filename: 'clip.png', contentType: 'image/png', url: 'https://blog.example.com/media/id/clip.png' };
    const binary = vi.fn();
    class XHR {
      upload = {}; responseText = JSON.stringify({ data: record }); status = 200; onload?: () => void;
      open() {} setRequestHeader() {} send() { binary(); this.onload?.(); }
    }
    win.XMLHttpRequest = XHR as unknown as typeof win.XMLHttpRequest;
    let registrations = 0;
    win.Mob.api = vi.fn(async (url, options) => {
      if (url === '/api/admin/uploads') return { id: record.id, mode: 'single' };
      if (url === '/api/admin/gallery/items') { registrations++; if (registrations === 1) throw new Error('temporary write failure'); expect(options.json.id).toBe(record.id); return { item: record }; }
      return { status: 'active' };
    });
    const task = win.Mob.uploadTask(new win.File(['png'], 'clip.png', { type: 'image/png' }), 'editor');
    await expect(task()).rejects.toThrow('temporary write failure'); expect(await task()).toEqual(record); expect(binary).toHaveBeenCalledTimes(1); dom.window.close();
  });
});
