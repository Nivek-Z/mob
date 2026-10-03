(function () {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)"),
    header = document.querySelector(".header-actions"),
    menu = document.getElementById("mobile-menu");
  function placePicker() {
    const picker = document.querySelector(".layout-picker");
    if (!picker || !header || !menu) return;
    const parent = innerWidth <= 1100 ? menu : header;
    if (picker.parentElement !== parent) parent.append(picker);
  }
  if (header && menu) {
    const observer = new MutationObserver(placePicker);
    observer.observe(header, { childList: true });
    observer.observe(menu, { childList: true });
    window.addEventListener("resize", placePicker);
    placePicker();
  }
  const pageNames = {
    "archive.html": "文章归档",
    "tags.html": "标签",
    "about.html": "关于",
    "gallery.html": "图库",
    "404.html": "页面未找到",
  };
  function syncSite() {
    const site = window.Mob?.site;
    const page = location.pathname.split("/").pop();
    document.title = window.Mob?.postTitle
      ? window.Mob.postTitle + " · " + (site?.title || "Firefly-Mod")
      : pageNames[page]
        ? pageNames[page] + " · " + (site?.title || "Firefly-Mod")
        : site?.title || document.title;
    document.querySelectorAll(".nav-pill a,#mobile-menu a").forEach((a) => {
      const url = new URL(a.href);
      const active =
        !url.hash &&
        (url.pathname === location.pathname ||
          (location.pathname === "/post.html" &&
            url.pathname === "/archive.html") ||
          (location.pathname === "/index.html" && url.pathname === "/"));
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    placePicker();
  }
  document.addEventListener("mob:site", syncSite);
  document.addEventListener("mob:post", syncSite);
  window.Mob?.siteReady?.then(syncSite);
  const motions = [...document.querySelectorAll("[data-motion-toggle]")];
  function syncMotion() {
    motions.forEach((motion) => {
      const forced =
        reduced.matches || window.Mob?.themeConfig?.motion?.enabled === false;
      motion.disabled = forced;
      motion.setAttribute(
        "aria-pressed",
        String(Boolean(window.FireflyStatic)),
      );
      motion.textContent = forced
        ? "简洁浏览已启用"
        : window.FireflyStatic
          ? "启用滚动动效"
          : "简洁浏览";
      motion.title = forced
        ? "已跟随系统或站点的减少动效设置"
        : "仅影响你的浏览体验";
    });
    document.documentElement.classList.toggle(
      "visitor-static",
      Boolean(window.FireflyStatic),
    );
  }
  if (motions.length) {
    motions.forEach((motion) =>
      motion.addEventListener("click", () => {
        window.FireflyStatic = !window.FireflyStatic;
        try {
          localStorage.setItem("firefly-static", String(window.FireflyStatic));
        } catch {}
        document.dispatchEvent(new CustomEvent("mob:motion"));
        syncMotion();
      }),
    );
    reduced.addEventListener("change", syncMotion);
    document.addEventListener("mob:theme-config", syncMotion);
    syncMotion();
  }
  function lightbox(img) {
    const images = [
      ...document.querySelectorAll(
        "#public-gallery img,.markdown img,#article > .cover",
      ),
    ].filter((el) => el.getAttribute("src"));
    let index = images.indexOf(img);
    if (index < 0) return;
    const opener = document.activeElement,
      dialog = document.createElement("dialog");
    dialog.className = "image-lightbox";
    dialog.setAttribute("aria-label", "查看图片");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "lightbox-close";
    close.textContent = "关闭 ×";
    const figure = document.createElement("figure"),
      full = document.createElement("img"),
      caption = document.createElement("figcaption");
    figure.append(full, caption);
    const prev = document.createElement("button"),
      next = document.createElement("button");
    prev.type = next.type = "button";
    prev.textContent = "← 上一张";
    next.textContent = "下一张 →";
    prev.className = "lightbox-prev";
    next.className = "lightbox-next";
    dialog.append(close, figure, prev, next);
    document.body.append(dialog);
    function draw() {
      const image = images[index];
      full.src = image.currentSrc || image.src;
      full.alt = image.alt;
      caption.textContent =
        (image.closest(".media-card")?.querySelector("h2")?.textContent ||
          image.alt ||
          "图片") +
        " · " +
        (index + 1) +
        " / " +
        images.length;
      prev.hidden = next.hidden = images.length < 2;
    }
    function done() {
      dialog.remove();
      document.documentElement.classList.remove("lightbox-open");
      if (opener?.isConnected) opener.focus();
    }
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", done);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    prev.addEventListener("click", () => {
      index = (index - 1 + images.length) % images.length;
      draw();
    });
    next.addEventListener("click", () => {
      index = (index + 1) % images.length;
      draw();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        prev.click();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        next.click();
      }
    });
    draw();
    dialog.showModal();
    document.documentElement.classList.add("lightbox-open");
  }
  function makeZoomable() {
    document
      .querySelectorAll("#public-gallery img,.markdown img,#article > .cover")
      .forEach((img) => {
        if (img.dataset.zoomReady) return;
        img.dataset.zoomReady = "true";
        if (img.closest("a")) return;
        img.tabIndex = 0;
        img.setAttribute("role", "button");
        img.setAttribute("aria-label", "放大图片：" + (img.alt || "图片"));
        img.addEventListener("click", () => lightbox(img));
        img.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            lightbox(img);
          }
        });
      });
  }
  const imageRoot =
    document.getElementById("public-gallery") ||
    document.getElementById("article");
  if (imageRoot) {
    new MutationObserver(makeZoomable).observe(imageRoot, {
      childList: true,
      subtree: true,
    });
    makeZoomable();
  }
  const toc = document.getElementById("toc");
  if (toc) {
    const box = toc.closest("aside") || toc.parentElement,
      button = document.createElement("button");
    button.className = "toc-toggle";
    button.type = "button";
    button.textContent = "文章目录";
    button.setAttribute("aria-controls", "toc");
    button.setAttribute("aria-expanded", "false");
    box.prepend(button);
    button.addEventListener("click", () => {
      const open = box.classList.toggle("toc-open");
      button.setAttribute("aria-expanded", String(open));
    });
    toc.addEventListener("click", (event) => {
      if (event.target.closest("a")) {
        box.classList.remove("toc-open");
        button.setAttribute("aria-expanded", "false");
      }
    });
  }
})();
