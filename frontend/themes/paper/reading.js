(function () {
  window.Mob.api('/api/themes/paper/config/reading').then(({ value }) => {
    if (/^#[0-9a-fA-F]{6}$/.test(value.accent)) document.documentElement.style.setProperty('--accent', value.accent);
    document.documentElement.style.setProperty('--reading-width', Number(value.readingWidth) + 'px');
    document.documentElement.style.setProperty('--reading-size', Number(value.fontSize) + 'px');
    document.querySelectorAll('[data-intro-heading]').forEach(node => { node.textContent = value.intro.heading; });
    document.querySelectorAll('[data-intro-subtitle]').forEach(node => { node.textContent = value.intro.subtitle; });
    document.querySelectorAll('[data-gallery-link]').forEach(node => { node.hidden = !value.showGallery; });
  }).catch(() => {});
})();
