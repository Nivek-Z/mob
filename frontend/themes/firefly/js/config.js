(function () {
  window.Mob.api('/api/themes/firefly/config/appearance').then(result => {
    const config = result.value; window.Mob.themeConfig = config;
    const text = (selector, value) => { if (value === undefined) return; document.querySelectorAll(selector).forEach(node => { node.textContent = value; }); };
    const image = (selector, value) => { const url = window.Mob.safeUrl(value); if (url) document.querySelectorAll(selector).forEach(node => { if (!node.closest('.profile-avatar')) node.src = url; }); };
    text('.hero-eyebrow', config.hero.eyebrow); text('.hero-occupation, .mobile-profile > p:first-of-type, .about-profile > p', config.hero.occupation);
    image('.hero-backdrop', config.hero.cover);
    const hero = window.Mob.safeUrl(config.hero.cover); if (hero) document.documentElement.style.setProperty('--hero-image', 'url(' + JSON.stringify(hero) + ')');
    Object.entries(config.images).forEach(([key, url]) => image('img[data-image="' + key.replace(/[^a-z0-9-]/g, '') + '"]', url));
    image('.hero-backdrop', config.hero.cover);
    const cycle = window.Mob.safeUrl(config.images['scene-cycle']); if (cycle) document.documentElement.style.setProperty('--cycle-image', 'url(' + JSON.stringify(cycle) + ')');
    text('#guide-title', config.guide.title); text('.intro-card h3', config.guide.introTitle); text('.intro-card > p:last-of-type', config.guide.introText);
    text('#journey-title', config.journey.title); text('.story-heading h2', config.journey.heading); text('.wish', config.journey.wishes[0]);
    document.querySelectorAll('.story-scene').forEach((scene, i) => { const item = config.journey.scenes[i]; if (!item) return; scene.querySelector('h3').textContent = item.title; scene.querySelector('.postcard-caption > p:last-of-type').textContent = item.description; const url = window.Mob.safeUrl(item.image); if (url) scene.querySelector('img').src = url; });
    text('.dialogue-head > span', config.dialogue.name); text('#dialogue-text', config.dialogue.welcome);
    const outro = document.querySelector('.home-outro h2'); if (outro) { const span = document.createElement('span'); span.textContent = config.outro.subtitle; outro.replaceChildren(document.createTextNode(config.outro.title), document.createElement('br'), span); }
    document.querySelectorAll('.hero-stage').forEach(root => { const layer = document.createElement('div'); layer.className = 'custom-stickers'; layer.setAttribute('aria-hidden', 'true'); config.stickers.forEach(item => { const node = document.createElement('span'); node.textContent = item.text; node.style.cssText = `left:${Number(item.x)}%;top:${Number(item.y)}%;transform:rotate(${Number(item.rotation)}deg);font-size:${Number(item.size)}px`; const url = window.Mob.safeUrl(item.image); if (url) { const img = document.createElement('img'); img.src = url; img.alt = ''; img.style.width = Number(item.size) + 'px'; node.replaceChildren(img); } layer.append(node); }); root.append(layer); });
    document.documentElement.classList.toggle('motion-disabled', !config.motion.enabled);
    document.documentElement.classList.toggle('rain-disabled', !config.motion.rain);
    document.documentElement.classList.toggle('ticker-disabled', !config.motion.ticker);
    document.documentElement.style.setProperty('--hero-scroll-height', config.motion.heroScrollVh + 'vh');
    document.documentElement.style.setProperty('--story-scroll-height', config.motion.storyScrollVh + 'vh');
    // This selector map belongs to Firefly alone; the backend never interprets it.
    Object.entries(config.copy || {}).forEach(([selector, value]) => { try { text(selector, String(value)); } catch (_) {} });
    Object.entries(config.styles || {}).forEach(([selector, declarations]) => { try { document.querySelectorAll(selector).forEach(node => { Object.entries(declarations).forEach(([property, value]) => node.style.setProperty(property, String(value))); }); } catch (_) {} });
    document.dispatchEvent(new CustomEvent('mob:theme-config', { detail: config }));
  }).catch(() => {});
})();
