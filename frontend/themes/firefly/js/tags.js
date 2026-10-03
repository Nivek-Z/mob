(function () {
  const root = document.getElementById("tags"), note = document.getElementById("page-note");
  const escape = window.Mob.escapeHtml;
  window.Mob.publishedPosts().then(function (page) {
    const counts = new Map();
    page.items.forEach(function (post) { (post.tags || []).forEach(function (tag) { counts.set(tag, (counts.get(tag) || 0) + 1); }); });
    const names = Array.from(counts.keys()).sort(function (a,b) { return counts.get(b)-counts.get(a) || a.localeCompare(b); });
    note.textContent = "共 " + names.length + " 个主题 · " + page.total + " 篇笔记";
    root.innerHTML = names.length ? names.map(function (tag) { return '<a href="/archive.html?tag=' + encodeURIComponent(tag) + '"><strong>#' + escape(tag) + '</strong><span>' + counts.get(tag) + ' 篇 ↗</span></a>'; }).join("") : '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">✳</span><h2>新的主题，正在萌芽。</h2><p>文章有了标签，就会出现在这里。</p></div>';
  }).catch(function () {
    note.textContent = "标签暂时读不出来。";
    root.innerHTML = '<a href="/tags.html"><strong>重新读取</strong><span>↻</span></a>';
  });
})();
