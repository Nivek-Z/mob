(function () {
  const api = window.Mob.api;
  const text = (selector, value) => document.querySelectorAll(selector).forEach(node => { node.textContent = value || ''; });
  window.Mob.siteReady = api('/api/site').then(result => {
    const site = result.value; window.Mob.site = site;
    text('[data-site-title], .brand > span:last-child', site.title);
    text('[data-profile-name], .hero-identity h1 span, .mobile-profile h2, .about-profile h2', site.profile.name);
    text('.brand-mark', site.profile.name.slice(0, 1));
    text('[data-profile-bio], .mobile-bio, .site-footer > div > p, .about-page .page-heading > p:last-child', site.profile.bio);
    text('.footer-name', site.profile.name + '.');
    const avatar = window.Mob.safeUrl(site.profile.avatar);
    document.querySelectorAll('[data-profile-avatar], .profile-avatar img').forEach(node => { if (avatar) node.src = avatar; else node.removeAttribute('src'); node.alt = site.profile.name; });
    const primary = site.socials[0];
    document.querySelectorAll('.hero-contact, .contact-card, a[href="https://github.com/Nivek-Z"]').forEach(node => {
      if (!primary) { node.hidden = true; return; }
      node.href = primary.url;
      if (node.matches('.hero-contact')) { node.querySelector('span').textContent = primary.label; node.querySelector('strong').textContent = site.profile.name; }
      else if (node.matches('.contact-card')) node.querySelector('.contact-handle').textContent = primary.label + ' / ' + site.profile.name;
      else node.textContent = primary.label + ' ↗';
    });
    document.querySelectorAll('[data-socials], [data-friends]').forEach(root => {
      const items = root.hasAttribute('data-friends') ? site.friends : site.socials;
      root.replaceChildren(...items.map(item => { const a = document.createElement('a'); a.textContent = item.label; a.href = item.url; a.rel = 'noopener noreferrer'; a.target = '_blank'; return a; }));
    });
    if (site.navigation) document.querySelectorAll('.nav-pill, .mobile-menu, .paper-header nav').forEach(root => {
      const picker = root.querySelector('.layout-picker');
      const links = site.navigation.map(item => { const a = document.createElement('a'); a.textContent = item.label; a.href = item.url; return a; });
      root.replaceChildren(...links); if (picker) root.append(picker);
    });
    const title = document.querySelector('title'); if (title && !location.pathname.includes('post')) title.textContent = site.title;
    const description = document.querySelector('meta[name="description"]'); if (description) description.content = site.description;
    document.dispatchEvent(new CustomEvent('mob:site', { detail: site })); return site;
  }).catch(() => null);
  api('/api/themes').then(registration => {
    if (!registration.allowVisitorSwitch || registration.themes.length < 2) return;
    const label = document.createElement('label'); label.className = 'layout-picker'; label.textContent = '主题 ';
    const select = document.createElement('select'); select.setAttribute('aria-label', '选择页面主题');
    registration.themes.forEach(theme => { const option = document.createElement('option'); option.value = theme.id; option.textContent = theme.name; select.append(option); });
    select.value = document.documentElement.dataset.layout || registration.defaultTheme;
    select.addEventListener('change', () => { const url = new URL(location.href); url.searchParams.set('theme', select.value); location.assign(url.href); });
    label.append(select); (document.querySelector('.header-actions') || document.querySelector('header nav') || document.body).append(label);
  }).catch(() => {});
})();
