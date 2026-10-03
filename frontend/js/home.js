(function () {
  const escape = window.Mob.escapeHtml;
  const recentRoot = document.getElementById("home-recent");
  const tagsRoot = document.getElementById("home-tags");
  let recentPosts = [];
  let recentIndex = 0;
  function drawRecent() {
    const post = recentPosts[recentIndex];
    if (!post) {
      recentRoot.innerHTML = '<p class="quiet">第一篇故事，正在酝酿。</p><a class="text-link" href="/archive.html">去阅读室看看 ↗</a>';
      return;
    }
    recentRoot.innerHTML = '<span class="recent-date">' + escape(window.Mob.formatDate(post.publishedAt)) + '</span><a class="recent-title" href="/post.html?slug=' + encodeURIComponent(post.slug) + '">' + escape(post.title) + '</a><div class="recent-switch"><small>' + String(recentIndex + 1).padStart(2, "0") + " / " + String(recentPosts.length).padStart(2, "0") + '</small>' + (recentPosts.length > 1 ? '<button type="button" data-recent-next aria-label="下一篇文章">→</button>' : "") + "</div>";
  }
  recentRoot.addEventListener("click", function (event) {
    if (event.target.closest("[data-recent-next]")) { recentIndex = (recentIndex + 1) % recentPosts.length; drawRecent(); }
  });
  window.Mob.publishedPosts().then(function (page) {
    const counts = new Map();
    page.items.forEach(function (post) { (post.tags || []).forEach(function (tag) { counts.set(tag, (counts.get(tag) || 0) + 1); }); });
    document.querySelectorAll("[data-post-count]").forEach(function (node) { node.textContent = page.total; });
    document.querySelectorAll("[data-tag-count]").forEach(function (node) { node.textContent = counts.size; });
    const names = Array.from(counts.keys()).sort(function (a, b) { return counts.get(b) - counts.get(a); }).slice(0, 6);
    tagsRoot.innerHTML = names.length ? names.map(function (tag) { return '<a href="/archive.html?tag=' + encodeURIComponent(tag) + '">#' + escape(tag) + '<span>' + counts.get(tag) + '</span></a>'; }).join("") : '<p class="quiet">每段记录，都会找到自己的主题。</p><a class="text-link" href="/tags.html">探索标签 ↗</a>';
    recentPosts = page.items.slice(0, 4);
    drawRecent();
  }).catch(function () {
    recentRoot.innerHTML = '<p class="quiet">笔记暂时读不出来。</p><a class="text-link" href="/archive.html">前往文章归档 ↗</a>';
    tagsRoot.innerHTML = '<a class="text-link" href="/tags.html">探索全部标签 ↗</a>';
  });

  const hero = document.querySelector(".hero-scroll");
  const stage = document.querySelector(".hero-stage");
  const grid = document.getElementById("mosaic-grid");
  const mosaic = document.querySelector(".mosaic-frame");
  const backdrop = document.querySelector(".hero-backdrop");
  const identity = document.querySelector(".hero-identity");
  const contact = document.querySelector(".hero-contact");
  const quick = document.querySelector(".hero-quick");
  const bottom = document.querySelector(".hero-bottom");
  const shade = document.querySelector(".hero-shade");
  const blinds = document.querySelector(".blinds-scroll");
  const blindLeft = document.querySelector(".blind-left");
  const blindRight = document.querySelector(".blind-right");
  const blindHeadline = document.querySelector(".blinds-headline");
  const foreground = document.querySelector(".blinds-foreground");
  const story = document.querySelector(".story-scroll");
  const track = document.querySelector(".story-track");
  const scenes = Array.from(document.querySelectorAll(".story-scene"));
  const sceneButtons = Array.from(document.querySelectorAll("[data-scene]"));
  const counter = document.querySelector(".story-counter");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  document.documentElement.classList.toggle("home-enhanced", !reduced.matches);
  const desktop = window.matchMedia("(min-width: 769px)");
  const clamp = function (value) { return Math.max(0, Math.min(1, value)); };
  const range = function (value, from, to) { return clamp((value - from) / (to - from)); };
  const smooth = function (value) { return value * value * (3 - 2 * value); };
  let heroProgress = 0;
  let activeScene = -1;
  let animationFrame = 0;
  let measurements = {};
  const tiles = [];
  const idle = [0, 4, 9, 13, 18, 23];
  for (let index = 0; index < 24; index++) {
    const row = Math.floor(index / 6), column = index % 6;
    const tile = document.createElement("span");
    tile.className = "mosaic-tile";
    tile.style.left = (column / 6 * 100) + "%";
    tile.style.top = (row / 4 * 100) + "%";
    tile.style.backgroundPosition = (column / 5 * 100) + "% " + (row / 3 * 100) + "%";
    grid.appendChild(tile);
    tiles.push({ node: tile, x: Math.sin(index * 3.47) * 180, y: Math.cos(index * 4.87) * 95, rotation: Math.sin(index * 2.13) * 13, scale: .35 + (index % 4) * .1, idle: idle.includes(index) });
  }
  function measure() {
    function region(node) {
      const rect = node.getBoundingClientRect();
      return { top: rect.top + window.scrollY, distance: Math.max(1, node.offsetHeight - window.innerHeight) };
    }
    measurements.hero = region(hero);
    measurements.blinds = region(blinds);
    measurements.story = region(story);
    measurements.step = scenes.length > 1 ? scenes[1].offsetLeft - scenes[0].offsetLeft : 0;
    requestUpdate();
  }
  function paintHero(progress) {
    heroProgress = progress;
    const assemble = smooth(range(progress, .02, .52));
    tiles.forEach(function (tile, index) {
      const show = tile.idle ? .56 + assemble * .44 : range(progress, .07 + (index % 6) * .025, .32 + (index % 6) * .025);
      tile.node.style.opacity = String(show * (1 - range(progress, .62, .78)));
      tile.node.style.transform = "translate3d(" + (tile.x * (1 - assemble)).toFixed(2) + "px," + (tile.y * (1 - assemble)).toFixed(2) + "px,0) rotate(" + (tile.rotation * (1 - assemble)).toFixed(2) + "deg) scale(" + (tile.scale + (1 - tile.scale) * assemble).toFixed(3) + ")";
      tile.node.style.filter = progress < .3 && index % 5 === 4 ? "blur(" + (4 * (1 - assemble)).toFixed(2) + "px)" : "none";
    });
    mosaic.style.transform = "translateX(-50%) scale(" + (1 + range(progress, .4, .75) * .15).toFixed(3) + ")";
    const titleExit = smooth(range(progress, .32, .66));
    identity.style.opacity = String(1 - titleExit);
    identity.style.transform = "translateY(" + (-70 * titleExit).toFixed(1) + "px)";
    contact.style.opacity = String(1 - titleExit);
    contact.style.transform = "translateY(" + (45 * titleExit).toFixed(1) + "px)";
    contact.inert = titleExit > .95;
    backdrop.style.opacity = String(range(progress, .5, .76) * .6);
    shade.style.opacity = String(.12 + range(progress, .5, .8) * .43);
    const quickEnter = smooth(range(progress, .66, .84));
    quick.style.opacity = String(quickEnter);
    quick.inert = quickEnter < .9;
    bottom.style.opacity = String(1 - range(progress, .75, .95));
    bottom.inert = progress > .92;
    canvas.style.opacity = String(range(progress, .62, .85) * .4);
    syncRain();
  }
  function paintBlinds(progress) {
    const open = smooth(range(progress, .08, .8));
    blindLeft.style.transform = "translateX(" + (-open * 100).toFixed(2) + "%)";
    blindRight.style.transform = "translateX(" + (open * 100).toFixed(2) + "%)";
    blindHeadline.style.opacity = String(1 - range(progress, .25, .72));
    blindHeadline.style.transform = "scale(" + (1 - open * .12).toFixed(3) + ")";
    foreground.style.transform = "translateY(" + (-open * 45).toFixed(1) + "px) scale(" + (1.05 + open * .06).toFixed(3) + ")";
  }
  function paintStory(progress) {
    track.style.transform = "translate3d(" + (-progress * measurements.step * (scenes.length - 1)).toFixed(2) + "px,0,0)";
    const next = Math.round(progress * (scenes.length - 1));
    if (next !== activeScene) {
      activeScene = next;
      counter.textContent = String(next + 1).padStart(2, "0") + " / 05";
      sceneButtons.forEach(function (button, index) { if (index === next) button.setAttribute("aria-current", "step"); else button.removeAttribute("aria-current"); });
      scenes.forEach(function (scene, index) { scene.classList.toggle("is-active", index === next); });
    }
  }
  function update() {
    animationFrame = 0;
    if (reduced.matches) { syncRain(); return; }
    const y = window.scrollY;
    if (desktop.matches) {
      const target = clamp((y - measurements.hero.top) / measurements.hero.distance);
      const next = Math.abs(target - heroProgress) < .001 ? target : heroProgress + (target - heroProgress) * .16;
      paintHero(next);
      if (Math.abs(next - target) >= .001) requestUpdate();
      paintStory(clamp((y - measurements.story.top) / measurements.story.distance));
    } else { syncRain(); }
    paintBlinds(clamp((y - measurements.blinds.top) / measurements.blinds.distance));
  }
  function requestUpdate() { if (!animationFrame) animationFrame = requestAnimationFrame(update); }
  sceneButtons.forEach(function (button, index) {
    button.addEventListener("click", function () {
      window.scrollTo({ top: measurements.story.top + measurements.story.distance * index / (scenes.length - 1), behavior: reduced.matches ? "instant" : "smooth" });
    });
  });

  const canvas = document.querySelector(".hero-rain");
  const context = canvas.getContext("2d");
  let rainFrame = 0, lastRain = 0;
  let droplets = [];
  function sizeRain() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    if (context) context.setTransform(dpr, 0, 0, dpr, 0, 0);
    droplets = Array.from({ length: Math.min(55, Math.floor(window.innerWidth / 28)) }, function () {
      return { x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight, speed: 180 + Math.random() * 180, length: 8 + Math.random() * 18 };
    });
  }
  function rain(now) {
    rainFrame = 0;
    if (!context || !rainVisible()) return;
    const delta = Math.min(.04, (now - lastRain) / 1000);
    lastRain = now;
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    context.strokeStyle = "rgba(235,235,235,.24)";
    context.lineWidth = .6;
    context.beginPath();
    droplets.forEach(function (drop) {
      drop.y += drop.speed * delta;
      if (drop.y > window.innerHeight) { drop.y = -30; drop.x = Math.random() * window.innerWidth; }
      context.moveTo(drop.x, drop.y);
      context.lineTo(drop.x - 2, drop.y + drop.length);
    });
    context.stroke();
    rainFrame = requestAnimationFrame(rain);
  }
  function rainVisible() {
    return context && !reduced.matches && desktop.matches && !document.hidden && heroProgress > .63 && measurements.hero && window.scrollY < measurements.hero.top + hero.offsetHeight;
  }
  function syncRain() {
    if (rainVisible()) { if (!rainFrame) { lastRain = performance.now(); rainFrame = requestAnimationFrame(rain); } }
    else if (rainFrame) { cancelAnimationFrame(rainFrame); rainFrame = 0; }
  }
  const dialogue = document.querySelector(".dialogue");
  const dialogueText = document.getElementById("dialogue-text");
  const dialogueLink = document.querySelector(".dialogue-link");
  let typingTimer = 0;
  let dialogueOpener = null;
  function typeLine(text) {
    clearTimeout(typingTimer);
    const accessible = document.createElement("span"); accessible.className = "sr-only"; accessible.textContent = text;
    const visual = document.createElement("span"); visual.setAttribute("aria-hidden", "true");
    dialogueText.replaceChildren(accessible, visual);
    let index = 0;
    function tick() {
      visual.textContent = text.slice(0, ++index);
      if (index < text.length) typingTimer = setTimeout(tick, 32);
    }
    if (reduced.matches) visual.textContent = text;
    else tick();
  }
  document.querySelectorAll("[data-dialogue-open]").forEach(function (button) {
    button.addEventListener("click", function () {
      dialogueOpener = button;
      dialogue.hidden = false;
      typeLine("欢迎来到 Nivek 的小屋。代码、笔记、日常，都放在这里。想先看看什么？");
      document.querySelector("[data-dialogue-close]").focus({ preventScroll: true });
    });
  });
  function closeDialogue() {
    dialogue.hidden = true;
    clearTimeout(typingTimer);
    if (dialogueOpener) dialogueOpener.focus({ preventScroll: true });
  }
  document.querySelector("[data-dialogue-close]").addEventListener("click", closeDialogue);
  document.addEventListener("keydown", function (event) { if (event.key === "Escape" && !dialogue.hidden) closeDialogue(); });
  const topics = {
    about: ["这里是 Nivek 的个人空间。写下学到的东西、做过的尝试，也留一点位置给生活。", "/about.html", "认识一下 Nivek ↗"],
    reading: ["阅读室里放着已经发布的笔记。可以按时间翻阅，也可以从感兴趣的标签开始。", "/archive.html", "去阅读室看看 ↗"],
    contact: ["你可以在 GitHub 找到 Nivek。欢迎看看正在做的项目，或打个招呼。", "https://github.com/Nivek-Z", "打开 GitHub ↗"]
  };
  document.querySelectorAll("[data-topic]").forEach(function (button) {
    button.addEventListener("click", function () {
      const topic = topics[button.dataset.topic];
      typeLine(topic[0]);
      dialogueLink.href = topic[1];
      dialogueLink.textContent = topic[2];
      dialogueLink.rel = "noopener noreferrer";
      if (topic[1].startsWith("https:")) dialogueLink.target = "_blank"; else dialogueLink.removeAttribute("target");
    });
  });
  const wishes = ["一直有星光", "岁岁皆欢愉", "所念皆星河", "热爱不打烊"];
  let wishIndex = 0;
  const wishNode = document.querySelector(".wish");
  const wishTimer = setInterval(function () {
    if (document.hidden || reduced.matches) return;
    const y = window.scrollY;
    if (y + window.innerHeight < measurements.blinds.top || y > measurements.blinds.top + blinds.offsetHeight) return;
    wishIndex = (wishIndex + 1) % wishes.length;
    wishNode.textContent = wishes[wishIndex];
    wishNode.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 450, easing: "ease-out" });
  }, 2800);
  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", function () { measure(); sizeRain(); });
  document.addEventListener("visibilitychange", syncRain);
  reduced.addEventListener("change", function () {
    document.documentElement.classList.toggle("home-enhanced", !reduced.matches);
    if (reduced.matches) {
      quick.inert = false;
      [identity, contact, bottom, mosaic, backdrop, shade, quick, blindLeft, blindRight, blindHeadline, foreground, track].forEach(function (node) { node.removeAttribute("style"); });
      contact.inert = false; bottom.inert = false;
    }
    measure(); syncRain();
  });
  desktop.addEventListener("change", measure);
  if ("ResizeObserver" in window) new ResizeObserver(measure).observe(document.body);
  window.addEventListener("pagehide", function (event) {
    if (event.persisted) { if (rainFrame) cancelAnimationFrame(rainFrame); rainFrame = 0; return; }
    cancelAnimationFrame(animationFrame); cancelAnimationFrame(rainFrame);
    clearTimeout(typingTimer); clearInterval(wishTimer);
  });
  window.addEventListener("pageshow", function (event) { if (event.persisted) { measure(); syncRain(); } });
  quick.inert = !reduced.matches;
  measure(); sizeRain();
})();
