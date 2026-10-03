(function () {
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return "&" + ({ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" })[char] + ";";
    });
  }
  function safeUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text, location.origin);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
    } catch (_) {}
    return "";
  }
  function renderMarkdown(source) {
    const text = String(source || "");
    if (!window.marked || !window.DOMPurify) return "<p>" + escapeHtml(text).replace(/\n/g, "<br>") + "</p>";
    const wrapper = document.createElement("div");
    wrapper.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: false }), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "button", "audio"],
      FORBID_ATTR: ["style", "id", "name"],
      ALLOW_DATA_ATTR: false
    });
    wrapper.querySelectorAll("a").forEach(function (link) {
      const raw = link.getAttribute("href") || "";
      const href = raw.startsWith("#") ? raw : safeUrl(raw);
      if (!href) { link.removeAttribute("href"); return; }
      link.href = href;
      if (!raw.startsWith("#")) {
        const url = new URL(href);
        const isAudio = /\.(mp3|wav|ogg|m4a)$/i.test(url.pathname) || (/^\/api\/admin\/media\/[^/]+\/file$/.test(url.pathname) && /\.(mp3|wav|ogg|m4a)$/i.test(link.textContent));
        const isVideo = /\.(mp4|webm)$/i.test(url.pathname) || (/^\/api\/admin\/media\/[^/]+\/file$/.test(url.pathname) && /\.(mp4|webm)$/i.test(link.textContent));
        if (url.origin === location.origin && /^\/(?:media\/|api\/admin\/media\/)/.test(url.pathname) && (isVideo || isAudio)) {
          const video = document.createElement(isAudio ? "audio" : "video");
          video.src = href; video.controls = true; video.preload = "metadata";
          video.setAttribute("playsinline", "");
          video.setAttribute("aria-label", link.textContent || "文章视频");
          link.replaceWith(video);
          return;
        }
        if (url.origin !== location.origin) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
      }
    });
    wrapper.querySelectorAll("img").forEach(function (image) {
      const url = safeUrl(image.getAttribute("src"));
      if (url) image.src = url; else image.removeAttribute("src");
      image.loading = "lazy"; image.decoding = "async";
    });
    wrapper.querySelectorAll("video").forEach(function (video) {
      video.removeAttribute("autoplay"); video.controls = true; video.preload = "metadata";
      video.setAttribute("playsinline", "");
    });
    wrapper.querySelectorAll("table").forEach(function (table) {
      const scroller = document.createElement("div"); scroller.className = "table-wrap";
      table.replaceWith(scroller); scroller.appendChild(table);
    });
    return wrapper.innerHTML;
  }
  window.Mob = window.Mob || {};
  window.Mob.renderMarkdown = renderMarkdown;
  window.Mob.escapeHtml = escapeHtml;
  window.Mob.safeUrl = safeUrl;
})();
