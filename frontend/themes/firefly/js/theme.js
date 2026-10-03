(function () {
  var theme = "dark";
  try { theme = localStorage.getItem("nivek-theme") === "light" ? "light" : "dark"; } catch (_) {}
  window.FireflyStatic = false;
  try { window.FireflyStatic = localStorage.getItem("firefly-static") === "true"; } catch (_) {}
  document.documentElement.classList.toggle("visitor-static", window.FireflyStatic);
  document.documentElement.dataset.theme = theme;
})();
