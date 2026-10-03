import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const origin = 'https://blog.example.com';

it('Paper preserves the unsaved warning for edits made during an article save', async () => {
  const dom = new JSDOM(readFileSync('frontend/themes/paper/admin/index.html', 'utf8'), { url: origin + '/admin/', runScripts: 'outside-only' });
  const win = dom.window as any;
  let acknowledge!: (result: unknown) => void;
  let submitted: any;
  win.Mob = {
    api: async (path: string, options?: any) => {
      if (options?.method === 'PUT') { submitted = structuredClone(options.json); return new Promise(resolve => { acknowledge = resolve; }); }
      return path === '/api/admin/session' ? { email: 'owner@example.com' } : { items: [] };
    },
    escapeHtml: (text: string) => text,
    renderMarkdown: () => '', safeUrl: () => '', bindDrops: () => {},
  };
  win.eval(readFileSync('frontend/themes/paper/admin/editor.js', 'utf8'));
  await tick();
  const doc = win.document;
  doc.getElementById('title').value = 'Review';
  doc.getElementById('slug').value = 'review';
  const markdown = doc.getElementById('markdown');
  markdown.value = 'Sent to GitHub';
  markdown.dispatchEvent(new win.Event('input', { bubbles: true }));
  doc.getElementById('editor').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  expect(submitted.markdown).toBe('Sent to GitHub');
  markdown.value = 'New unsaved text';
  markdown.dispatchEvent(new win.Event('input', { bubbles: true }));
  acknowledge({ post: { ...submitted, sha: 'b'.repeat(40), slug: 'review' } });
  await tick();
  const leaving = new win.Event('beforeunload', { cancelable: true });
  win.dispatchEvent(leaving);
  const protectedUnsavedText = leaving.defaultPrevented;
  dom.window.close();
  expect(protectedUnsavedText).toBe(true);
});

it('Paper keeps gallery edits entered while an earlier save is pending', async () => {
  const dom = new JSDOM(readFileSync('frontend/themes/paper/admin/gallery.html', 'utf8'), { url: origin + '/admin/gallery.html', runScripts: 'outside-only' });
  const win = dom.window as any;
  const item = { id: '12345678-1234-4234-8234-123456789abc', title: 'Original', description: '', filename: 'image.png', contentType: 'image/png', size: 32, categoryId: 'gallery', tags: [], url: origin + '/media/test/image.png', isPublic: false, isListed: false };
  let acknowledge!: (result: unknown) => void;
  let patch: any;
  win.Mob = {
    api: async (path: string, options?: any) => {
      if (path.endsWith('/categories')) return { value: { items: [{ id: 'gallery', name: 'Gallery' }] } };
      if (options?.method === 'PATCH') { patch = structuredClone(options.json.items[0]); return new Promise(resolve => { acknowledge = resolve; }); }
      return { sha: 'a'.repeat(40), items: [structuredClone(item)], total: 1, limit: 24 };
    },
    escapeHtml: (text: string) => text,
    bindDrops: () => {},
  };
  win.eval(readFileSync('frontend/themes/paper/admin/gallery.js', 'utf8'));
  await tick();
  const field = win.document.querySelector('[data-field=title]');
  field.value = 'First saved title'; field.dispatchEvent(new win.Event('input', { bubbles: true }));
  win.document.getElementById('gallery-save').click();
  field.value = 'Later unsaved title'; field.dispatchEvent(new win.Event('input', { bubbles: true }));
  item.title = patch.title;
  acknowledge({ sha: 'b'.repeat(40) });
  await tick();
  const survivingTitle = win.document.querySelector('[data-field=title]').value;
  dom.window.close();
  expect(survivingTitle).toBe('Later unsaved title');
});
