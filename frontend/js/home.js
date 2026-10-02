(function () {
  const root = document.getElementById("bento");
  const escapeHtml = window.Mob.escapeHtml;
  function tags(list) {
    return (list || []).slice(0, 8).map(function (tag) {
      return '<a href="/archive.html?tag=' + encodeURIComponent(tag) + '">#' + escapeHtml(tag) + "</a>";
    }).join("");
  }
  window.Mob.publishedPosts().then(function (page) {
    const posts = page.items;
    if (!posts.length) {
      root.innerHTML = '<article class="card"><p class="quiet">还没有发布的文章。</p></article>';
      return;
    }
    const first = posts[0];
    const rest = posts.slice(1, 6);
    const tagSet = {};
    posts.forEach(function (post) { (post.tags || []).forEach(function (tag) { tagSet[tag] = (tagSet[tag] || 0) + 1; }); });
    const tagHtml = Object.keys(tagSet).sort(function (a, b) { return tagSet[b] - tagSet[a]; }).slice(0, 12).map(function (tag) {
      return '<a href="/archive.html?tag=' + encodeURIComponent(tag) + '">#' + escapeHtml(tag) + " " + tagSet[tag] + "</a>";
    }).join("");
    const cover = first.cover ? '<img class="cover" alt="" src="' + escapeHtml(first.cover) + '">' : "";
    const rows = rest.map(function (post, index) {
      return '<a class="row" href="/post.html?slug=' + encodeURIComponent(post.slug) + '"><span class="num">0' + (index + 2) + '</span><strong>' + escapeHtml(post.title) + '</strong><span class="date">' + window.Mob.formatDate(post.publishedAt) + "</span></a>";
    }).join("");
    root.innerHTML =
      '<article class="card feature"><p class="kicker">最新</p>' + cover +
      '<h2><a href="/post.html?slug=' + encodeURIComponent(first.slug) + '">' + escapeHtml(first.title) + "</a></h2>" +
      '<p class="excerpt">' + escapeHtml(first.description || "") + "</p>" +
      '<p class="tags">' + tags(first.tags) + "</p>" +
      '<p class="date">' + window.Mob.formatDate(first.publishedAt) + "</p></article>" +
      '<div class="stack"><article class="card"><p class="kicker">档案</p><p class="metric">' + page.total + "<span>篇已发布</span></p></article>" +
      '<article class="card"><p class="kicker">标签</p><p class="tags">' + (tagHtml || '<span class="quiet">还没有标签</span>') + "</p></article></div>" +
      (rows ? '<article class="card latest"><p class="kicker">更多</p>' + rows + "</article>" : "");
  }).catch(function (error) {
    root.innerHTML = '<article class="card"><p class="quiet">' + escapeHtml(error.message || "文章暂时读不出来") + "</p></article>";
  });
})();
