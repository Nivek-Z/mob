(function () {
  const api = window.Mob.api; const escape = window.Mob.escapeHtml; const root = document.getElementById('gallery-items');
  const note = document.getElementById('gallery-note'); const category = document.getElementById('gallery-category');
  let sha = null, offset = 0, categories = [], pending = new Map(), busy = false, loading = false, initializing = true, locking = false, uploading = 0, currentCategory = '', total = 0;
  const say = message => { note.textContent = message; };
  function sync() {
    root.inert = loading || locking || initializing;
    category.disabled = busy || loading || initializing || uploading > 0;
    ['gallery-save', 'gallery-batch', 'gallery-import', 'gallery-file'].forEach(id => { document.getElementById(id).disabled = busy || loading || initializing || uploading > 0; });
    document.getElementById('gallery-prev').disabled = busy || loading || initializing || uploading > 0 || offset === 0;
    document.getElementById('gallery-next').disabled = busy || loading || initializing || uploading > 0 || offset + 24 >= total;
  }
  function preview(item) {
    const url = '/api/admin/media/' + item.id + '/file';
    if (item.contentType.startsWith('image/')) return '<img src="' + url + '" alt="' + escape(item.title) + '" loading="lazy">';
    if (item.contentType.startsWith('audio/')) return '<audio controls preload="none" src="' + url + '"></audio>';
    return '<video controls preload="none" playsinline src="' + url + '"></video>';
  }
  async function load(preserve = false, nextOffset = offset, nextCategory = currentCategory) {
    if (loading) return; loading = true; sync();
    try {
    const params = new URLSearchParams({ limit: '24', offset: String(nextOffset) }); if (nextCategory) params.set('category', nextCategory);
    const page = await api('/api/admin/gallery?' + params); sha = page.sha; offset = nextOffset; currentCategory = nextCategory; category.value = nextCategory; total = page.total; if (!preserve) pending.clear();
    root.innerHTML = page.items.map(stored => { const item = { ...stored, ...pending.get(stored.id) }; return '<article class="media-card" data-id="' + item.id + '"><label class="batch-check"><input type="checkbox" data-select> 选择</label>' + preview(item) + '<label>标题<input data-field="title" value="' + escape(item.title) + '" maxlength="200"></label><label>说明<textarea data-field="description" maxlength="4000">' + escape(item.description) + '</textarea></label><label>分类<select data-field="categoryId">' + categories.map(c => '<option value="' + escape(c.id) + '"' + (c.id === item.categoryId ? ' selected' : '') + '>' + escape(c.name) + '</option>').join('') + '</select></label><label>标签<input data-field="tags" value="' + escape(item.tags.join(', ')) + '"></label><label><input type="checkbox" data-field="isPublic"' + (item.isPublic ? ' checked' : '') + '> 公开稳定链接</label><label><input type="checkbox" data-field="isListed"' + (item.isListed ? ' checked' : '') + '> 展示在公开图库</label><button type="button" data-copy data-url="' + escape(item.url) + '">复制链接</button><button type="button" data-delete class="warn">删除对象</button><small>' + escape(item.filename) + ' · ' + (item.size / 1024 / 1024).toFixed(2) + ' MB</small></article>'; }).join('') || '<p class="quiet">这个分类还没有媒体。</p>';
    document.getElementById('gallery-page').textContent = page.total ? `${offset + 1}–${Math.min(offset + page.items.length, page.total)} / ${page.total}` : '0 / 0';
    } finally { loading = false; sync(); }
  }
  root.addEventListener('input', event => {
    const field = event.target.dataset.field; if (!field) return;
    const id = event.target.closest('[data-id]').dataset.id;
    const update = { ...pending.get(id), id }; update[field] = event.target.type === 'checkbox' ? event.target.checked : field === 'tags' ? event.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) : event.target.value;
    pending.set(id, update); say('有未保存的图库修改。');
  });
  root.addEventListener('click', async event => {
    const id = event.target.closest('[data-id]')?.dataset.id; if (!id || busy || loading || initializing || uploading) return;
    if (event.target.matches('[data-copy]')) { try { await navigator.clipboard.writeText(event.target.dataset.url); say('链接已复制。'); } catch { say(event.target.dataset.url); } }
    if (event.target.matches('[data-delete]') && (!pending.size || confirm('删除后会重新加载图库，放弃未保存的修改？')) && confirm('删除这个 R2 对象及图库信息？正在被引用的对象会受到保护。')) {
      busy = true; locking = true; sync();
      try { await api('/api/admin/gallery/items/' + id, { method: 'DELETE', json: { sha } }); await load(); say('已删除。'); }
      catch (error) { say(error.code === 'MEDIA_IN_USE' ? '对象被引用：' + JSON.stringify(error.details) : error.message + '。修改保留在页面；请先处理冲突。'); }
      finally { busy = false; locking = false; sync(); }
    }
  });
  async function save(updates) {
    if (busy || loading || initializing || uploading || !updates.length) return; busy = true; sync();
    const submitted = updates.map(update => ({ ...update }));
    try {
      await api('/api/admin/gallery', { method: 'PATCH', json: { sha, items: submitted } });
      submitted.forEach(saved => {
        const current = pending.get(saved.id); if (!current) return;
        const remaining = { id: saved.id };
        Object.keys(current).filter(key => key !== 'id').forEach(key => { if (JSON.stringify(current[key]) !== JSON.stringify(saved[key])) remaining[key] = current[key]; });
        if (Object.keys(remaining).length > 1) pending.set(saved.id, remaining); else pending.delete(saved.id);
      });
      await load(true); say(pending.size ? '已保存提交时的修改。后续输入仍在页面，尚未保存。' : '图库设置已保存到 GitHub。');
    }
    catch (error) { say(error.code === 'CONFIG_CONFLICT' ? '图库已被修改，当前输入已保留。请复制修改后重新加载。' : error.message); }
    finally { busy = false; sync(); }
  }
  document.getElementById('gallery-save').addEventListener('click', () => save([...pending.values()]));
  document.getElementById('gallery-batch').addEventListener('click', () => {
    const selected = [...root.querySelectorAll('[data-select]:checked')].map(node => node.closest('[data-id]').dataset.id);
    const merged = new Map(pending); selected.forEach(id => merged.set(id, { ...pending.get(id), id, categoryId: document.getElementById('batch-category').value, isPublic: document.getElementById('batch-public').checked, isListed: document.getElementById('batch-listed').checked })); save([...merged.values()]);
  });
  function changePage(next) { if (busy || loading || initializing || uploading || pending.size && !confirm('当前图库修改未保存，继续切换？')) { category.value = currentCategory; return; } load(false, next, category.value).catch(error => { category.value = currentCategory; say(error.message); }); }
  category.addEventListener('change', () => changePage(0));
  document.getElementById('gallery-prev').addEventListener('click', () => changePage(Math.max(0, offset - 24)));
  document.getElementById('gallery-next').addEventListener('click', () => changePage(offset + 24));
  function uploads(files) {
    if (busy || loading || initializing) return;
    files.forEach(file => {
      const row = document.createElement('div'); row.className = 'upload-row'; const label = document.createElement('span'); const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.hidden = true; row.append(label, retry); document.getElementById('gallery-uploads').append(row);
      const task = window.Mob.uploadTask(file, 'gallery', (percent, stage) => { label.textContent = file.name + ' · ' + stage + ' ' + percent + '%'; });
      let running = false;
      async function run() { if (running || busy) return; running = true; uploading++; sync(); retry.hidden = true; try { await task(); label.textContent = file.name + ' · 已进入私有图库'; } catch (error) { label.textContent = error.message; retry.hidden = false; } finally { running = false; uploading--; sync(); if (!uploading && !pending.size && !busy && !loading) load().catch(error => say(error.message)); } }
      retry.addEventListener('click', run); run();
    });
  }
  window.Mob.bindDrops(document.getElementById('gallery-drop'), uploads);
  document.getElementById('gallery-file').addEventListener('change', event => { uploads([...event.target.files]); event.target.value = ''; });
  document.getElementById('gallery-import').addEventListener('click', async () => {
    if (busy || loading || initializing || uploading || pending.size && !confirm('导入前会重新加载图库。放弃当前未保存的修改？')) return; busy = true; locking = true; sync(); let cursor;
    try { do { const page = await api('/api/admin/gallery/import', { method: 'POST', json: cursor ? { cursor } : {} }); cursor = page.cursor; say('正在登记历史上传，保持原 ID…'); } while (cursor); await load(); say('历史上传已登记，默认私有。'); }
    catch (error) { say(error.message); } finally { busy = false; locking = false; sync(); }
  });
  window.addEventListener('mob:gallery-storage-before-import', event => { if (pending.size || busy || loading || initializing || uploading) event.preventDefault(); });
  window.addEventListener('mob:gallery-storage-import', () => { if (!pending.size && !busy && !loading && !uploading) load().catch(error => say(error.message)); else say('新素材已纳入，当前修改保留；请保存前确认图库版本。'); });
  window.addEventListener('beforeunload', event => { if (pending.size || busy || uploading) { event.preventDefault(); event.returnValue = ''; } });
  sync();
  api('/api/admin/gallery/categories').then(result => { categories = result.value.items; [category, document.getElementById('batch-category')].forEach(select => { categories.forEach(c => { const option = document.createElement('option'); option.value = c.id; option.textContent = c.name; select.append(option); }); }); return load(); }).catch(error => say(error.message)).finally(() => { initializing = false; sync(); });
})();
