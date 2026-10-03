(function () {
  const root = document.getElementById("public-gallery"),
    select = document.getElementById("public-category"),
    note = document.getElementById("gallery-message"),
    prev = document.getElementById("public-prev"),
    next = document.getElementById("public-next");
  let offset = 0,
    total = 0,
    active = "",
    busy = false;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "重新读取";
  retry.className = "pill-button";
  retry.hidden = true;
  note.after(retry);
  async function load(target = offset, category = active) {
    if (busy) return;
    busy = true;
    prev.disabled = next.disabled = select.disabled = true;
    retry.hidden = true;
    note.textContent = "正在收集光影…";
    try {
      const params = new URLSearchParams({
        limit: "24",
        offset: String(target),
      });
      if (category) params.set("category", category);
      const page = await window.Mob.api("/api/gallery?" + params);
      offset = target;
      active = category;
      total = page.total;
      select.value = active;
      root.replaceChildren(
        ...page.items.map((item) => {
          const article = document.createElement("article");
          article.className = "media-card";
          const media = document.createElement(
              item.contentType.startsWith("image/")
                ? "img"
                : item.contentType.startsWith("audio/")
                  ? "audio"
                  : "video",
            ),
            url = window.Mob.safeUrl(item.url);
          if (url) media.src = url;
          media.alt = item.title;
          media.loading = "lazy";
          media.decoding = "async";
          if (media.tagName !== "IMG") {
            media.controls = true;
            media.preload = "none";
            media.playsInline = true;
          }
          const title = document.createElement("h2");
          title.textContent = item.title;
          const description = document.createElement("p");
          description.textContent = item.description;
          article.append(media, title, description);
          return article;
        }),
      );
      note.textContent = total
        ? `${offset + 1}–${Math.min(offset + page.items.length, total)} / ${total}`
        : "还没有公开展示的影像。";
    } catch {
      select.value = active;
      note.textContent = "暂时无法读取图库，已保留当前内容。";
      retry.hidden = false;
    } finally {
      busy = false;
      select.disabled = false;
      prev.disabled = offset === 0;
      next.disabled = offset + 24 >= total;
    }
  }
  select.addEventListener("change", () => load(0, select.value));
  prev.addEventListener("click", () => load(Math.max(0, offset - 24)));
  next.addEventListener("click", () => load(offset + 24));
  retry.addEventListener("click", () => init());
  let categoriesLoaded = false;
  async function init() {
    try {
      if (!categoriesLoaded) {
        const result = await window.Mob.api("/api/gallery/categories");
        result.value.items.forEach((item) => {
          const option = document.createElement("option");
          option.value = item.id;
          option.textContent = item.name;
          select.append(option);
        });
        categoriesLoaded = true;
      }
      await load();
    } catch {
      note.textContent = "暂时无法读取图库分类，请重试。";
      retry.hidden = false;
    }
  }
  init();
})();
