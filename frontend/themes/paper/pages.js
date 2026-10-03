(async function () {
  const root = document.getElementById('paper-content'); if (!root) return;
  const page = document.body.dataset.page; const escape = window.Mob.escapeHtml;
  try {
    if (page === '404') { root.innerHTML = '<a href="/">回到首页</a>'; return; }
    if (page === 'post') {
      const slug = new URLSearchParams(location.search).get('slug'); if (!slug) throw new Error('请选择一篇文章。');
      const post = await window.Mob.api('/api/posts/' + encodeURIComponent(slug));
      document.querySelector('main > h1').textContent = post.title;
      root.innerHTML = '<p class="byline">' + escape(window.Mob.formatDate(post.publishedAt)) + '</p>' + window.Mob.renderMarkdown(post.markdown); return;
    }
    const data = await window.Mob.publishedPosts();
    if (page === 'tags') {
      const tags = [...new Set(data.items.flatMap(post => post.tags))]; root.innerHTML = tags.map(tag => '<a class="paper-tag" href="/archive.html?tag=' + encodeURIComponent(tag) + '">' + escape(tag) + '</a>').join('') || '还没有标签。'; return;
    }
    const tag = new URLSearchParams(location.search).get('tag'); const posts = data.items.filter(post => !tag || post.tags.includes(tag));
    root.innerHTML = (page === 'home' ? posts.slice(0, 6) : posts).map(post => '<article class="paper-entry"><time>' + escape(window.Mob.formatDate(post.publishedAt)) + '</time><h2><a href="/post.html?slug=' + encodeURIComponent(post.slug) + '">' + escape(post.title) + '</a></h2><p>' + escape(post.description) + '</p></article>').join('') || '<p>第一篇记录正在酝酿。</p>';
  } catch (error) { root.textContent = error.message; }
})();
