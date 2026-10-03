(function () {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const themeButton = document.querySelector("[data-theme-toggle]");
  function syncTheme() {
    const light = document.documentElement.dataset.theme === "light";
    themeButton.setAttribute("aria-pressed", String(light));
    themeButton.setAttribute("aria-label", light ? "切换到暗色主题" : "切换到亮色主题");
  }
  if (themeButton) {
    syncTheme();
    themeButton.addEventListener("click", function () {
      const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = theme;
      try { localStorage.setItem("nivek-theme", theme); } catch (_) {}
      syncTheme();
    });
  }
  const menuButton = document.querySelector(".menu-toggle");
  const menu = document.getElementById("mobile-menu");
  function closeMenu() {
    if (!menu) return;
    menu.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "打开导航");
  }
  if (menuButton && menu) {
    menuButton.addEventListener("click", function () {
      menu.hidden = !menu.hidden;
      menuButton.setAttribute("aria-expanded", String(!menu.hidden));
      menuButton.setAttribute("aria-label", menu.hidden ? "打开导航" : "关闭导航");
    });
    menu.addEventListener("click", function (event) { if (event.target.closest("a")) closeMenu(); });
    document.addEventListener("click", function (event) {
      if (!menu.hidden && !menu.contains(event.target) && !menuButton.contains(event.target)) closeMenu();
    });
    document.addEventListener("keydown", function (event) { if (event.key === "Escape") closeMenu(); });
    window.addEventListener("resize", function () { if (window.innerWidth > 1100) closeMenu(); });
  }
  document.querySelectorAll("[data-year]").forEach(function (node) { node.textContent = new Date().getFullYear(); });
  if (!reduced.matches && "IntersectionObserver" in window) {
    document.documentElement.classList.add("js-motion");
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target); }
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -20px 0px" });
    document.querySelectorAll(".reveal").forEach(function (node) { observer.observe(node); });
  }
  reduced.addEventListener("change", function () {
    if (reduced.matches) document.documentElement.classList.remove("js-motion");
  });
  const progress = document.querySelector(".scroll-progress");
  const topButton = document.querySelector(".back-top");
  let scrollFrame = 0;
  function updateScroll() {
    scrollFrame = 0;
    const distance = document.documentElement.scrollHeight - window.innerHeight;
    if (progress) progress.style.transform = "scaleX(" + (distance > 0 ? window.scrollY / distance : 0) + ")";
    if (topButton) topButton.hidden = window.scrollY < window.innerHeight;
  }
  window.addEventListener("scroll", function () { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll); }, { passive: true });
  window.addEventListener("resize", updateScroll);
  if (topButton) topButton.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: reduced.matches ? "instant" : "smooth" }); });
  updateScroll();
})();
