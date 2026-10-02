(function () {
  const params = new URLSearchParams(location.search);
  const tag = params.get("tag") || "";
  const q = params.get("q") || "";
  const query = {};
  if (tag) query.tag = tag;
  if (q) query.q = q;
  const title = document.getElementById("page-title");
  const note = document.getElementById("page-note");
  const list = document.getElementById("list");
  const input = document.getElementById("q");
  const hot = document.getElementById("hot");
  const cloud = document.getElementById("cloud");
  if (input) input.value = q;
  if (tag) title.textContent = "#" + tag;
  const escapeHtml = window.Mob.escapeHtml;
  function item(post) {
    const tags = (post.tags || []).map(function (name) {
      return '<a href="/archive.html?tag=' + encodeURIComponent(name) + '">#' + escapeHtml(name) + "</a>";
    }).join(" ");
    return '<article class="archive-item"><div class="archive-top"><div><h2><a href="/post.html?slug=' + encodeURIComponent(post.slug) + '">' + escapeHtml(post.title) + '</a></h2><p class="excerpt">' + escapeHtml(post.description || "") + '</p><p class="tags">' + tags + '</p></div><p class="date">' + window.Mob.formatDate(post.publishedAt) + "</p></div></article>";
  }
  window.Mob.publishedPosts().then(function (all) {
    const counts = {};
    all.items.forEach(function (post) { (post.tags || []).forEach(function (name) { counts[name] = (counts[name] || 0) + 1; }); });
    if (hot) {
      hot.innerHTML = all.items.slice(0, 5).map(function (post) {
        return '<a href="/post.html?slug=' + encodeURIComponent(post.slug) + '">' + escapeHtml(post.title) + "</a>";
      }).join("") || '<p class="quiet">还没有文章</p>';
    }
    if (cloud) {
      cloud.innerHTML = Object.keys(counts).slice(0, 12).map(function (name) {
        return '<a href="/archive.html?tag=' + encodeURIComponent(name) + '">#' + escapeHtml(name) + "</a>";
      }).join("") || '<span class="quiet">还没有标签</span>';
    }
    return window.Mob.publishedPosts(query);
  }).then(function (page) {
    note.textContent = "共 " + page.total + " 篇";
    list.innerHTML = page.items.length ? page.items.map(item).join("") : '<p class="quiet">没有符合的文章。</p>';
  }).catch(function (error) {
    note.textContent = error.message || "读取失败";
  });
})();
