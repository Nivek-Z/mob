import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { activityStats, calendarDays } from '../src/activity';
import { readPlatformFixture } from './platform-fixtures';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function open(theme: string, page: string) {
  const dom = new JSDOM(readFileSync(`frontend/themes/${theme}/${page}`, 'utf8'), { url: 'https://blog.example.com', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.eval(readFileSync('frontend/core/api.js', 'utf8')); return { dom, win: dom.window };
}
function sample(status = 'ok') {
  const daily = calendarDays('2026-10-03', 365).map((date, index) => ({ date, count: index % 11 === 0 ? 4 : 0 }));
  return { enabled: true, title: '代码足迹', timezone: 'Asia/Hong_Kong', range: { from: daily[0].date, to: daily.at(-1)!.date, days: 365 }, github: { status, title: '仓库活动', repository: 'owner/blog', branch: 'main', url: 'https://github.com/owner/blog/commits/main/', daily, stats: activityStats(daily), updatedAt: '2026-10-03T05:00:00Z' } };
}
describe('activity and storage frontends', () => {
  for (const theme of ['firefly', 'paper']) {
    it(`${theme} renders a full calendar with accessible day selection and keyboard navigation`, async () => {
      const { dom, win } = open(theme, 'index.html'); const value = sample();
      win.Mob.api = vi.fn(async () => value); win.eval(readFileSync('frontend/core/activity.js', 'utf8')); await tick();
      const cells = [...win.document.querySelectorAll<HTMLButtonElement>('.activity-calendar button')];
      expect(cells).toHaveLength(365); expect(win.document.querySelectorAll('.activity-stat')).toHaveLength(5);
      expect(win.document.querySelector('.activity-context')!.textContent).toContain('Asia/Hong_Kong');
      expect(cells[0].title).toBe('2025-10-04 · 4 次提交');
      cells[364].focus(); cells[364].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      expect(win.document.activeElement).toBe(cells[357]); expect(cells[357].getAttribute('aria-pressed')).toBe('true');
      cells[357].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true })); expect(win.document.activeElement).toBe(cells[0]);
      cells[100].click(); expect(win.document.querySelector('.activity-detail')!.textContent).toBe(cells[100].title);
      expect(cells.filter(cell => cell.tabIndex === 0)).toHaveLength(1); dom.window.close();
    });
    it(`${theme} distinguishes stale, unavailable, true zero and disabled activity`, async () => {
      for (const state of ['stale', 'unavailable', 'zero', 'disabled']) {
        const { dom, win } = open(theme, 'index.html'); const value = sample(state === 'zero' ? 'ok' : state);
        if (state === 'unavailable') Object.assign(value.github, { daily: null, stats: null });
        if (state === 'zero') { value.github.daily.forEach(day => { day.count = 0; }); value.github.stats = activityStats(value.github.daily); }
        win.Mob.api = vi.fn(async () => value); win.eval(readFileSync('frontend/core/activity.js', 'utf8')); await tick();
        const root = win.document.querySelector<HTMLElement>('[data-github-activity]')!;
        if (state === 'disabled') expect(root.hidden).toBe(true);
        if (state === 'stale') expect(root.textContent).toContain('上次同步的数据');
        if (state === 'unavailable') { expect(root.querySelectorAll('.activity-cell')).toHaveLength(0); expect(root.querySelector('button')!.textContent).toBe('重新读取'); }
        if (state === 'zero') expect(root.querySelector('.activity-stat dd')!.textContent).toBe('0 次');
        dom.window.close();
      }
    });
    it(`${theme} saves activity through shared settings with its current SHA`, async () => {
      const { dom, win } = open(theme, 'admin/settings.html');
      const site = JSON.parse(readPlatformFixture('config/site/settings.json'));
      const defaultValue = JSON.parse(readPlatformFixture(`frontend/themes/${theme}/config/${theme === 'paper' ? 'reading' : 'appearance'}.json`));
      const api = vi.fn(async (url: string, options?: any) => options?.method === 'PUT' ? { sha: 'b'.repeat(40), value: options.json.value, commitSha: 'c'.repeat(40) } : { sha: 'a'.repeat(40), value: url === '/api/admin/settings/site' ? site : defaultValue, mediaIds: [] });
      win.Mob.api = api; win.eval(readFileSync(`frontend/themes/${theme}/admin/settings.js`, 'utf8')); await tick();
      const selector = win.document.getElementById(theme === 'paper' ? 'paper-doc' : 'settings-document') as unknown as HTMLSelectElement;
      selector.value = 'site'; selector.dispatchEvent(new win.Event('change')); await tick();
      const days = theme === 'paper' ? win.document.getElementById('paper-activity-days') as HTMLInputElement : win.document.querySelector<HTMLInputElement>('input[min="30"][max="366"]')!;
      days.value = '90'; days.dispatchEvent(new win.Event('input'));
      win.document.getElementById(theme === 'paper' ? 'paper-save' : 'settings-save')!.click(); await tick();
      const saved = api.mock.calls.find(([, options]) => options?.method === 'PUT')!;
      expect(saved[0]).toBe('/api/admin/settings/site'); expect(saved[1].json).toMatchObject({ sha: 'a'.repeat(40), value: { activity: { days: 90 } } });
      expect(saved[1].json.value.socials).toEqual(site.socials); dom.window.close();
    });
    it(`${theme} offers private storage previews and preserves failed imports for retry`, async () => {
      const { dom, win } = open(theme, 'admin/gallery.html'); let fails = true;
      const api = vi.fn(async (url: string, options?: any) => {
        if (options?.method === 'POST') { if (fails) throw new Error('GitHub unavailable'); return { item: { id: 'imported' } }; }
        return { items: [{ key: 'theme-media/firefly/sha/hero.png', etag: 'etag', filename: 'hero.png', contentType: 'image/png', size: 32, kind: 'theme' }], cursor: null };
      });
      win.Mob.api = api; win.eval(readFileSync('frontend/core/storage.js', 'utf8')); await tick();
      expect(win.document.querySelector('[data-storage-items] img')!.getAttribute('src')).toContain('/api/admin/gallery/storage/file?key=');
      const button = win.document.querySelector<HTMLButtonElement>('[data-storage-items] button')!;
      button.click(); await tick(); expect(button.disabled).toBe(false); expect(button.isConnected).toBe(true);
      expect(win.document.querySelector('[data-storage-note]')!.textContent).toContain('可重试');
      const block = (event: Event) => event.preventDefault(); win.addEventListener('mob:gallery-storage-before-import', block);
      button.click(); await tick(); expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
      win.removeEventListener('mob:gallery-storage-before-import', block); fails = false; button.click(); await tick();
      expect(button.isConnected).toBe(false); expect(win.document.querySelector('[data-storage-note]')!.textContent).toContain('私有图床'); dom.window.close();
    });
  }
});
