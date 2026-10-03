(function () {
  const root = document.querySelector('[data-storage-discovery]');
  if (!root) return;
  const api = window.Mob.api, list = root.querySelector('[data-storage-items]'), note = root.querySelector('[data-storage-note]');
  const scan = root.querySelector('[data-storage-scan]');
  let cursor, started = false, busy = false;
  const say = message => { note.textContent = message; };
  function card(item) {
    const row = document.createElement('article'); row.className = 'media-card';
    const url = '/api/admin/gallery/storage/file?' + new URLSearchParams({ key: item.key });
    const preview = document.createElement(item.contentType.startsWith('image/') ? 'img' : item.contentType.startsWith('audio/') ? 'audio' : 'video');
    preview.src = url;
    if (preview.tagName === 'IMG') { preview.alt = item.filename; preview.loading = 'lazy'; }
    else { preview.controls = true; preview.preload = 'none'; }
    const name = document.createElement('strong'); name.textContent = item.filename;
    const info = document.createElement('small'); info.textContent = ({ managed: '历史上传', theme: '主题预置素材', legacy: '其他 R2 素材' }[item.kind] || 'R2 素材') + ' · ' + (item.size / 1024 / 1024).toFixed(2) + ' MB';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = item.kind === 'managed' ? '纳入图床' : '创建图床副本';
    button.addEventListener('click', async () => {
      if (busy) return;
      const check = new CustomEvent('mob:gallery-storage-before-import', { cancelable: true });
      if (!window.dispatchEvent(check)) { say('请先保存当前图库修改，再纳入素材。'); return; }
      busy = true; button.disabled = true; scan.disabled = true; say('正在纳入图床…');
      try {
        await api('/api/admin/gallery/storage/import', { method: 'POST', json: { key: item.key, etag: item.etag } });
        row.remove(); say('已纳入私有图床，可在上方编辑分类与公开设置。');
        window.dispatchEvent(new CustomEvent('mob:gallery-storage-import'));
      } catch (error) { say(error.code === 'STORAGE_CONFLICT' ? 'R2 文件已变化，请重新扫描后导入。' : error.message + '；素材仍保留，可重试。'); }
      finally { busy = false; button.disabled = false; scan.disabled = false; }
    });
    row.append(preview, name, info, button); return row;
  }
  async function discover(reset = false) {
    if (busy) return; busy = true; scan.disabled = true;
    if (reset) { cursor = undefined; started = false; list.replaceChildren(); }
    say('正在扫描 R2 素材…');
    try {
      let pages = 0;
      do {
        const page = await api('/api/admin/gallery/storage' + (cursor ? '?' + new URLSearchParams({ cursor }) : ''));
        page.items.forEach(item => list.append(card(item))); cursor = page.cursor; started = true; pages++;
      } while (cursor && !list.children.length && pages < 4);
      scan.textContent = cursor ? '继续扫描' : '重新扫描';
      say(list.children.length ? '发现以下未登记素材。纳入后默认私有。' : cursor ? '这一批未发现素材，可继续扫描。' : '扫描完成，未发现可纳入的素材。');
    } catch (error) { say(error.message + '；可继续重试扫描。'); }
    finally { busy = false; scan.disabled = false; }
  }
  scan.addEventListener('click', () => discover(started && !cursor));
  discover();
})();
