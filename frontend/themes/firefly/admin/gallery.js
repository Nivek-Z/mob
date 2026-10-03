(function () {
  const api = window.Mob.api; const escape = window.Mob.escapeHtml; const root = document.getElementById('gallery-items');
  const note = document.getElementById('gallery-note'); const category = document.getElementById('gallery-category');
  let sha = null, offset = 0, categories = [], pending = new Map(), busy = false;
  const say = message => { note.textContent = message; };
  function preview(item) {
    const url = '/api/admin/media/' + item.id + '/file';
    if (item.contentType.startsWith('image/')) return '<img src="' + url + '" alt="' + escape(item.title) + '" loading="lazy">';
    if (item.contentType.startsWith('audio/')) return '<audio controls preload="none" src="' + url + '"></audio>';
    return '<video controls preload="none" playsinline src="' + url + '"></video>';
  }
  async function load() {
    const params = new URLSearchParams({ limit: '24', offset: String(offset) }); if (category.value) params.set('category', category.value);
    const page = await api('/api/admin/gallery?' + params); sha = page.sha; pending.clear();
    root.innerHTML = page.items.map(item => '<article class="media-card" data-id="' + item.id + '"><label class="batch-check"><input type="checkbox" data-select> 选择</label>' + preview(item) + '<label>标题<input data-field="title" value="' + escape(item.title) + '" maxlength="200"></label><label>说明<textarea data-field="description" maxlength="4000">' + escape(item.description) + '</textarea></label><label>分类<select data-field="categoryId">' + categories.map(c => '<option value="' + escape(c.id) + '"' + (c.id === item.categoryId ? ' selected' : '') + '>' + escape(c.name) + '</option>').join('') + '</select></label><label>标签<input data-field="tags" value="' + escape(item.tags.join(', ')) + '"></label><label><input type="checkbox" data-field="isPublic"' + (item.isPublic ? ' checked' : '') + '> 公开稳定链接</label><label><input type="checkbox" data-field="isListed"' + (item.isListed ? ' checked' : '') + '> 展示在公开图库</label><button type="button" data-copy data-url="' + escape(item.url) + '">复制链接</button><button type="button" data-delete class="warn">删除对象</button><small>' + escape(item.filename) + ' · ' + (item.size / 1024 / 1024).toFixed(2) + ' MB</small></article>').join('') || '<p class="quiet">这个分类还没有媒体。</p>';
    document.getElementById('gallery-page').textContent = `${offset + 1}–${Math.min(offset + page.items.length, page.total)} / ${page.total}`;
    document.getElementById('gallery-prev').disabled = offset === 0; document.getElementById('gallery-next').disabled = offset + page.limit >= page.total;
  }
  root.addEventListener('input', event => {
    const field = event.target.dataset.field; if (!field) return;
    const id = event.target.closest('[data-id]').dataset.id;
    const update = pending.get(id) || { id }; update[field] = event.target.type === 'checkbox' ? event.target.checked : field === 'tags' ? event.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) : event.target.value;
    pending.set(id, update); say('有未保存的图库修改。');
  });
  root.addEventListener('click', async event => {
    const id = event.target.closest('[data-id]')?.dataset.id; if (!id || busy) return;
    if (event.target.matches('[data-copy]')) { try { await navigator.clipboard.writeText(event.target.dataset.url); say('链接已复制。'); } catch { say(event.target.dataset.url); } }
    if (event.target.matches('[data-delete]') && (!pending.size || confirm('删除后会重新加载图库，放弃未保存的修改？')) && confirm('删除这个 R2 对象及图库信息？正在被引用的对象会受到保护。')) {
      busy = true;
      try { await api('/api/admin/gallery/items/' + id, { method: 'DELETE', json: { sha } }); await load(); say('已删除。'); }
      catch (error) { say(error.code === 'MEDIA_IN_USE' ? '对象被引用：' + JSON.stringify(error.details) : error.message + '。修改保留在页面；请先处理冲突。'); }
      finally { busy = false; }
    }
  });
  async function save(updates) {
    if (busy || !updates.length) return; busy = true;
    try { await api('/api/admin/gallery', { method: 'PATCH', json: { sha, items: updates } }); await load(); say('图库设置已保存到 GitHub。'); }
    catch (error) { say(error.code === 'CONFIG_CONFLICT' ? '图库已被修改，当前输入已保留。请复制修改后重新加载。' : error.message); }
    finally { busy = false; }
  }
  document.getElementById('gallery-save').addEventListener('click', () => save([...pending.values()]));
  document.getElementById('gallery-batch').addEventListener('click', () => {
    const selected = [...root.querySelectorAll('[data-select]:checked')].map(node => node.closest('[data-id]').dataset.id);
    const merged = new Map(pending); selected.forEach(id => merged.set(id, { ...pending.get(id), id, categoryId: document.getElementById('batch-category').value, isPublic: document.getElementById('batch-public').checked, isListed: document.getElementById('batch-listed').checked })); save([...merged.values()]);
  });
  function changePage(next) { if (pending.size && !confirm('当前图库修改未保存，继续切换？')) return; offset = next; load().catch(error => say(error.message)); }
  category.addEventListener('change', () => changePage(0));
  document.getElementById('gallery-prev').addEventListener('click', () => changePage(Math.max(0, offset - 24)));
  document.getElementById('gallery-next').addEventListener('click', () => changePage(offset + 24));
  function uploads(files) {
    files.forEach(file => {
      const row = document.createElement('div'); row.className = 'upload-row'; const label = document.createElement('span'); const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.hidden = true; row.append(label, retry); document.getElementById('gallery-uploads').append(row);
      const task = window.Mob.uploadTask(file, 'gallery', (percent, stage) => { label.textContent = file.name + ' · ' + stage + ' ' + percent + '%'; });
      async function run() { retry.hidden = true; try { await task(); label.textContent = file.name + ' · 已进入私有图库'; if (!pending.size) await load(); } catch (error) { label.textContent = error.message; retry.hidden = false; } }
      retry.addEventListener('click', run); run();
    });
  }
  window.Mob.bindDrops(document.getElementById('gallery-drop'), uploads);
  document.getElementById('gallery-file').addEventListener('change', event => { uploads([...event.target.files]); event.target.value = ''; });
  document.getElementById('gallery-import').addEventListener('click', async () => {
    if (busy || pending.size && !confirm('导入前会重新加载图库。放弃当前未保存的修改？')) return; busy = true; let cursor;
    try { do { const page = await api('/api/admin/gallery/import', { method: 'POST', json: cursor ? { cursor } : {} }); cursor = page.cursor; say('正在导入已有 R2 媒体，保持原 ID…'); } while (cursor); await load(); say('已有 R2 媒体已导入，默认私有。'); }
    catch (error) { say(error.message); } finally { busy = false; }
  });
  window.addEventListener('beforeunload', event => { if (pending.size) { event.preventDefault(); event.returnValue = ''; } });
  api('/api/admin/gallery/categories').then(result => { categories = result.value.items; [category, document.getElementById('batch-category')].forEach(select => { categories.forEach(c => { const option = document.createElement('option'); option.value = c.id; option.textContent = c.name; select.append(option); }); }); return load(); }).catch(error => say(error.message));
})();
