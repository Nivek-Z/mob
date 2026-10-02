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
  if (input) input.value = q;
  if (tag) title.textContent = "#" + tag;
  const escapeHtml = window.Mob.escapeHtml;
  window.Mob.publishedPosts(query).then(function (page) {
    note.textContent = "共 " + page.total + " 篇";
    if (!page.items.length) {
      list.innerHTML = '<p class="quiet">没有符合的文章。</p>';
      return;
    }
    list.innerHTML = page.items.map(function (post) {
      const tags = (post.tags || []).map(function (item) {
        return '<a href="/archive.html?tag=' + encodeURIComponent(item) + '">#' + escapeHtml(item) + "</a>";
      }).join(" ");
      return '<article class="archive-item"><div class="archive-top"><div><h2><a href="/post.html?slug=' + encodeURIComponent(post.slug) + '">' + escapeHtml(post.title) + "</a></h2><p class=\"excerpt\">" + escapeHtml(post.description || "") + '</p><p class="tags">' + tags + '</p></div><p class="date">' + window.Mob.formatDate(post.publishedAt) + "</p></div></article>";
    }).join("");
  }).catch(function (error) {
    note.textContent = error.message || "读取失败";
  });
})();
