(function () {
  const root = document.getElementById('public-gallery'); const select = document.getElementById('public-category'); const note = document.getElementById('gallery-message'); let offset = 0, total = 0;
  async function load() {
    note.textContent = '正在收集光影…'; const params = new URLSearchParams({ limit: '24', offset: String(offset) }); if (select.value) params.set('category', select.value);
    const page = await window.Mob.api('/api/gallery?' + params); total = page.total;
    const nodes = page.items.map(item => { const article = document.createElement('article'); article.className = 'media-card'; const media = document.createElement(item.contentType.startsWith('image/') ? 'img' : item.contentType.startsWith('audio/') ? 'audio' : 'video'); media.src = window.Mob.safeUrl(item.url); media.alt = item.title; media.loading = 'lazy'; if (media.tagName !== 'IMG') { media.controls = true; media.preload = 'none'; } const title = document.createElement('h2'); title.textContent = item.title; const description = document.createElement('p'); description.textContent = item.description; article.append(media, title, description); return article; });
    root.replaceChildren(...nodes); note.textContent = total ? `${offset + 1}–${Math.min(offset + page.items.length, total)} / ${total}` : '还没有公开展示的影像。';
    document.getElementById('public-prev').disabled = offset === 0; document.getElementById('public-next').disabled = offset + 24 >= total;
  }
  select.addEventListener('change', () => { offset = 0; load().catch(error => { note.textContent = error.message; }); });
  document.getElementById('public-prev').addEventListener('click', () => { offset = Math.max(0, offset - 24); load().catch(error => { note.textContent = error.message; }); });
  document.getElementById('public-next').addEventListener('click', () => { offset += 24; load().catch(error => { note.textContent = error.message; }); });
  window.Mob.api('/api/gallery/categories').then(result => { result.value.items.forEach(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; select.append(option); }); return load(); }).catch(error => { note.textContent = error.message; });
})();
