(function () {
  const slug = new URLSearchParams(location.search).get("slug") || "";
  const root = document.getElementById("article"), toc = document.getElementById("toc");
  const escape = window.Mob.escapeHtml;
  function unavailable(message) {
    root.innerHTML = '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">✳</span><h1>还没找到这篇笔记。</h1><p>' + escape(message) + '</p><a class="pill-button" href="/archive.html">去文章归档 ↗</a></div>';
    toc.textContent = "";
  }
  if (!slug) { unavailable("缺少文章地址，请从文章归档选择一篇笔记。"); return; }
  window.Mob.api("/api/posts/" + encodeURIComponent(slug)).then(function (post) {
    window.Mob.postTitle = post.title;
    document.title = post.title + " · " + (window.Mob.site?.title || "Firefly-Mod");
    document.dispatchEvent(new CustomEvent("mob:post"));
    const description = document.querySelector('meta[name="description"]');
    if (description) description.content = post.description || post.title;
    const tags = (post.tags || []).map(function (tag) { return '<a href="/archive.html?tag=' + encodeURIComponent(tag) + '">#' + escape(tag) + '</a>'; }).join("");
    const cover = window.Mob.safeUrl(post.cover);
    const reading = Math.max(1, Math.ceil((post.markdown || "").replace(/\s/g, "").length / 450));
    root.innerHTML = '<p class="eyebrow">NOTES / ' + escape(window.Mob.site?.profile.name || 'Firefly-Mod') + '</p><h1>' + escape(post.title) + '</h1>' + (post.description ? '<p class="excerpt">' + escape(post.description) + '</p>' : "") + '<div class="post-meta"><time datetime="' + escape(post.publishedAt || "") + '">' + escape(window.Mob.formatDate(post.publishedAt)) + '</time><span>约 ' + reading + ' 分钟阅读</span>' + (post.updatedAt && post.updatedAt !== post.publishedAt ? '<span>更新于 ' + escape(window.Mob.formatDate(post.updatedAt)) + '</span>' : "") + '</div><div class="tag-pills">' + tags + '</div>' + (cover ? '<img class="cover" src="' + escape(cover) + '" alt="文章封面" decoding="async">' : "") + '<div class="markdown">' + window.Mob.renderMarkdown(post.markdown) + '</div><footer class="post-ending"><span>谢谢你读到这里。</span><a href="/archive.html">继续阅读 ↗</a></footer>';
    const headings = Array.from(root.querySelectorAll(".markdown h1,.markdown h2,.markdown h3,.markdown h4"));
    headings.forEach(function (heading, index) { heading.id = "section-" + index; });
    toc.innerHTML = headings.length ? headings.map(function (heading, index) { return '<a href="#section-' + index + '"' + (/H[34]/.test(heading.tagName) ? ' class="sub"' : "") + '>' + escape(heading.textContent) + '</a>'; }).join("") : '<p class="quiet">随文字慢慢往下读。</p>';
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          toc.querySelectorAll("a").forEach(function (link) { link.classList.toggle("active", link.hash === "#" + entry.target.id); });
        });
      }, { rootMargin: "-100px 0px -65% 0px", threshold: 0 });
      headings.forEach(function (heading) { observer.observe(heading); });
    }
    root.querySelectorAll("pre").forEach(function (pre) {
      const code = pre.querySelector("code");
      if (!code) return;
      const language = document.createElement("span"); language.className = "code-language";
      language.textContent = (code.className.match(/language-([\w+-]+)/) || ["", "CODE"])[1].toUpperCase();
      const button = document.createElement("button"); button.type = "button"; button.className = "code-copy"; button.textContent = "复制";
      button.addEventListener("click", function () {
        if (!navigator.clipboard) { button.textContent = "请选中复制"; return; }
        navigator.clipboard.writeText(code.textContent).then(function () { button.textContent = "已复制"; setTimeout(function () { button.textContent = "复制"; }, 1800); }).catch(function () { button.textContent = "请选中复制"; });
      });
      pre.prepend(language, button);
    });
    if (location.hash && /^#section-\d+$/.test(location.hash)) {
      const heading = document.getElementById(location.hash.slice(1));
      if (heading) heading.scrollIntoView();
    }
  }).catch(function (error) {
    unavailable(error.status === 404 ? "这篇文章不存在，或还没有发布。" : "暂时无法读取这篇文章，请稍后重试。");
  });
})();
