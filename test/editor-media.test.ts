import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';

const origin = 'https://blog.example.com';
const automaticId = '11111111-1111-4111-8111-111111111111';
const extraId = '22222222-2222-4222-8222-222222222222';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function editor(theme: string) {
  const dom = new JSDOM(readFileSync(`frontend/themes/${theme}/admin/index.html`, 'utf8'), {
    url: origin + '/admin/?slug=hello', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const win = dom.window;
  const post = {
    slug: 'hello', sha: 'a'.repeat(40), title: 'Original', description: '', tags: [], status: 'published', cover: null,
    markdown: `![Automatic](${origin}/media/${automaticId}/auto.png)\n<img src="&#47;media/${extraId}/extra.png">`,
    mediaIds: [automaticId, extraId],
  };
  const api = vi.fn(async (path: string, options?: { method?: string; json?: any }) => {
    if (options?.method === 'PUT') return { post: { ...post, ...options.json, sha: 'b'.repeat(40) } };
    if (path === '/api/admin/session') return { email: 'owner@example.com' };
    if (path === '/api/admin/posts') return { items: [structuredClone(post)] };
    return structuredClone(post);
  });
  for (const script of ['api.js', 'vendor/marked.umd.js', 'vendor/purify.min.js', 'markdown.js']) win.eval(readFileSync('frontend/core/' + script, 'utf8'));
  win.Mob.api = api;
  win.Mob.bindDrops = () => {};
  if (theme === 'firefly') win.eval(readFileSync('frontend/themes/firefly/admin/ui.js', 'utf8'));
  win.eval(readFileSync(`frontend/themes/${theme}/admin/editor.js`, 'utf8'));
  await tick();
  function input(id: string, value: string) {
    const field = win.document.getElementById(id) as HTMLInputElement;
    field.value = value;
    field.dispatchEvent(new win.Event('input', { bubbles: true }));
  }
  async function save() {
    const submitter = win.document.querySelector<HTMLButtonElement>('[data-status="published"]')!;
    win.document.getElementById('editor')!.dispatchEvent(new win.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));
    await tick();
    return api.mock.calls.filter(([, options]) => options?.method === 'PUT').at(-1)?.[1]?.json;
  }
  return { dom, win, api, post, input, save };
}

it.each(['paper', 'firefly'])('%s preserves extra references when only the title changes', async theme => {
  const page = await editor(theme);
  try {
    expect((page.win.document.getElementById('media-refs') as HTMLInputElement).value).toBe(extraId);
    expect(page.win.Mob.renderMarkdown(page.post.markdown)).toContain(`${origin}/media/${extraId}/extra.png`);
    page.input('title', 'New title');
    expect((await page.save()).mediaIds).toEqual([extraId, automaticId]);
  } finally { page.dom.window.close(); }
});

it.each(['paper', 'firefly'])('%s drops removed automatic URLs without discarding extra references', async theme => {
  const page = await editor(theme);
  try {
    page.input('markdown', 'No automatically detected URLs');
    expect((await page.save()).mediaIds).toEqual([extraId]);
    page.input('media-refs', '');
    const leaving = new page.win.Event('beforeunload', { cancelable: true });
    page.win.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    expect((await page.save()).mediaIds).toEqual([]);
  } finally { page.dom.window.close(); }
});

it.each(['paper', 'firefly'])('%s retains edited extra references when saving conflicts', async theme => {
  const page = await editor(theme);
  try {
    page.input('media-refs', extraId + ', ' + extraId);
    page.api.mockImplementationOnce(async () => { throw Object.assign(new Error('Conflict'), { code: 'POST_CONFLICT' }); });
    expect((await page.save()).mediaIds).toEqual([extraId, automaticId]);
    expect((page.win.document.getElementById('media-refs') as HTMLInputElement).value).toBe(extraId + ', ' + extraId);
    const leaving = new page.win.Event('beforeunload', { cancelable: true });
    page.win.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
  } finally { page.dom.window.close(); }
});
