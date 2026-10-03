(function () {
  const params = new URLSearchParams(location.search);
  const tag = params.get("tag") || "", q = params.get("q") || "";
  const query = {};
  if (tag) query.tag = tag;
  if (q) query.q = q;
  const title = document.getElementById("page-title"), note = document.getElementById("page-note");
  const list = document.getElementById("list"), input = document.getElementById("q");
  const hot = document.getElementById("hot"), cloud = document.getElementById("cloud");
  const escape = window.Mob.escapeHtml;
  input.value = q;
  if (tag) title.textContent = "#" + tag;
  // Preserve the selected tag when searching within a topic.
  if (tag) { const field = document.createElement("input"); field.type = "hidden"; field.name = "tag"; field.value = tag; input.form.appendChild(field); }
  function item(post) {
    const tags = (post.tags || []).map(function (name) { return '<a href="/archive.html?tag=' + encodeURIComponent(name) + '">#' + escape(name) + "</a>"; }).join("");
    const cover = window.Mob.safeUrl(post.cover);
    return '<article class="archive-item"><div><div class="archive-meta"><time datetime="' + escape(post.publishedAt || "") + '">' + escape(window.Mob.formatDate(post.publishedAt)) + '</time><span>NOTE / ' + escape(post.slug) + '</span></div><h3><a href="/post.html?slug=' + encodeURIComponent(post.slug) + '">' + escape(post.title) + '</a></h3>' + (post.description ? '<p class="excerpt">' + escape(post.description) + '</p>' : "") + '<div class="tag-pills">' + tags + '</div></div>' + (cover ? '<a href="/post.html?slug=' + encodeURIComponent(post.slug) + '" tabindex="-1" aria-hidden="true"><img class="archive-cover" src="' + escape(cover) + '" alt="" loading="lazy" width="146" height="112"></a>' : "") + '</article>';
  }
  function draw(page) {
    note.textContent = "共 " + page.total + " 篇已发布的笔记" + (q ? " · 搜索「" + q + "」" : "");
    if (!page.items.length) {
      list.innerHTML = '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">✳</span><h2>' + (tag || q ? "这里还没有匹配的文章。" : "第一篇故事，正在酝酿。") + '</h2><p>' + (tag || q ? "换个关键词，或翻开全部笔记。" : "等一个值得写下的开始。") + '</p><a class="text-link" href="' + (tag || q ? "/archive.html" : "/") + '">' + (tag || q ? "查看全部文章 ↗" : "回到小屋 ↗") + '</a></div>';
      return;
    }
    const groups = new Map();
    page.items.forEach(function (post) {
      const year = window.Mob.formatDate(post.publishedAt).slice(0, 4) || "未标注日期";
      if (!groups.has(year)) groups.set(year, []);
      groups.get(year).push(post);
    });
    list.innerHTML = Array.from(groups.entries()).map(function (entry) { return '<section><h2 class="archive-year">' + escape(entry[0]) + '<small>' + entry[1].length + ' 篇笔记</small></h2>' + entry[1].map(item).join("") + '</section>'; }).join("");
  }
  window.Mob.publishedPosts().then(function (all) {
    const counts = new Map();
    all.items.forEach(function (post) { (post.tags || []).forEach(function (name) { counts.set(name, (counts.get(name) || 0) + 1); }); });
    hot.innerHTML = all.items.slice(0, 5).map(function (post) { return '<a href="/post.html?slug=' + encodeURIComponent(post.slug) + '">' + escape(post.title) + '</a>'; }).join("") || '<p class="quiet">等待第一篇笔记。</p>';
    cloud.innerHTML = Array.from(counts.keys()).sort(function (a,b) { return counts.get(b)-counts.get(a); }).slice(0, 12).map(function (name) { return '<a href="/archive.html?tag=' + encodeURIComponent(name) + '">#' + escape(name) + '</a>'; }).join("") || '<p class="quiet">等待新的主题。</p>';
    if (tag || q) return window.Mob.publishedPosts(query);
    return all;
  }).then(draw).catch(function () {
    note.textContent = "笔记暂时读不出来。";
    list.innerHTML = '<div class="empty-state"><h2>稍后再翻开这一页。</h2><p>暂时无法读取文章，请稍后重试。</p><a class="text-link" href="' + escape(location.pathname + location.search) + '">重新读取 ↻</a></div>';
  });
})();
