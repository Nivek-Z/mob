(function () {
  var theme = "dark";
  try { theme = localStorage.getItem("nivek-theme") === "light" ? "light" : "dark"; } catch (_) {}
  document.documentElement.dataset.theme = theme;
})();
