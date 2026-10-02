(function () {
  const root = document.getElementById("tags");
  const note = document.getElementById("page-note");
  const escapeHtml = window.Mob.escapeHtml;
  window.Mob.publishedPosts().then(function (page) {
    const counts = {};
    page.items.forEach(function (post) {
      (post.tags || []).forEach(function (tag) { counts[tag] = (counts[tag] || 0) + 1; });
    });
    const names = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
    note.textContent = "共 " + names.length + " 个标签";
    root.innerHTML = names.length ? names.map(function (tag) {
      return '<a href="/archive.html?tag=' + encodeURIComponent(tag) + '">' + escapeHtml(tag) + " " + counts[tag] + "</a>";
    }).join("") : '<p class="quiet">还没有标签。</p>';
  }).catch(function (error) {
    note.textContent = error.message || "读取失败";
  });
})();
