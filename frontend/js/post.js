(function () {
  const slug = new URLSearchParams(location.search).get("slug") || "";
  const root = document.getElementById("article");
  const escapeHtml = window.Mob.escapeHtml;
  if (!slug) {
    root.innerHTML = '<p class="quiet">缺少文章地址。</p>';
    return;
  }
  window.Mob.api("/api/posts/" + encodeURIComponent(slug)).then(function (post) {
    document.title = post.title + " - " + window.Mob.name;
    const tags = (post.tags || []).map(function (tag) {
      return '<a href="/archive.html?tag=' + encodeURIComponent(tag) + '">#' + escapeHtml(tag) + "</a>";
    }).join(" ");
    const cover = post.cover ? '<img class="cover" alt="" src="' + escapeHtml(post.cover) + '">' : "";
    root.innerHTML =
      '<p class="kicker">' + window.Mob.formatDate(post.publishedAt) + "</p>" +
      "<h1>" + escapeHtml(post.title) + "</h1>" +
      (post.description ? '<p class="excerpt">' + escapeHtml(post.description) + "</p>" : "") +
      '<p class="tags">' + tags + "</p>" + cover +
      '<div class="markdown">' + window.Mob.renderMarkdown(post.markdown || "") + "</div>";
  }).catch(function () {
    root.innerHTML = '<p class="quiet">这篇文章不存在，或还没有发布。</p>';
  });
})();
