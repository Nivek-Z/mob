(function () {
  const api = window.Mob.api,
    ui = window.Mob.firefly,
    node = ui.node;
  const select = document.getElementById("settings-document"),
    root = document.getElementById("settings-fields"),
    raw = document.getElementById("settings-json"),
    refs = document.getElementById("settings-refs"),
    note = document.getElementById("settings-note"),
    saveButton = document.getElementById("settings-save"),
    nav = document.getElementById("settings-sections");
  const docs = {
    appearance: [
      "/api/admin/themes/firefly/config/appearance",
      "frontend/themes/firefly/config/appearance.json",
    ],
    site: ["/api/admin/settings/site", "config/site/settings.json"],
    themes: ["/api/admin/themes", "frontend/themes.json"],
    categories: [
      "/api/admin/gallery/categories",
      "config/gallery/categories.json",
    ],
  };
  const names = {
    title: "标题",
    description: "说明",
    profile: "个人资料",
    name: "名称",
    bio: "个人简介",
    avatar: "头像",
    socials: "社交链接",
    friends: "友链",
    navigation: "全站导航",
    label: "显示名称",
    url: "链接",
    hero: "首屏",
    eyebrow: "眉题",
    occupation: "身份描述",
    cover: "首屏封面",
    images: "展示图片",
    stickers: "贴纸",
    text: "文字",
    x: "横向位置 %",
    y: "纵向位置 %",
    rotation: "旋转角度",
    size: "大小 px",
    motion: "动效",
    enabled: "启用",
    rain: "雨幕",
    ticker: "滚动标语",
    heroScrollVh: "首屏滚动距离 vh",
    storyScrollVh: "故事滚动距离 vh",
    guide: "导览",
    introTitle: "介绍标题",
    introText: "介绍文案",
    journey: "旅程",
    wishes: "轮播祝福",
    heading: "章节标题",
    scenes: "故事章节",
    image: "图片",
    dialogue: "对话向导",
    welcome: "欢迎语",
    topics: "对话选项",
    about: "关于我",
    reading: "阅读",
    contact: "联系",
    outro: "结尾",
    subtitle: "副标题",
    defaultTheme: "默认主题 ID",
    allowVisitorSwitch: "允许访客切换",
    themes: "主题列表",
    items: "分类",
    id: "唯一 ID",
    root: "目录",
    copy: "自定义文字",
    styles: "自定义样式",
    activity: "仓库活动",
    github: "GitHub 提交活动",
    days: "显示天数（30–366）",
    timezone: "统计时区",
    hero: "首屏",
    foreground: "前景",
    character: "人物",
    stand: "立牌",
    "card-archive": "阅读室卡片",
    "card-notes": "笔记卡片",
    "card-contact": "联系卡片",
    "scene-cycle": "循环背景",
  };
  const hints = {
    appearance: {
      hero: "封面铺满首屏；个人姓名与简介在「全站 · 公共资料」中设置。",
      images: "不同展示区域使用独立素材。更换后保存，再刷新前台查看。",
      stickers: "贴纸支持文字或图片。位置按百分比计算，拖动顺序决定叠放顺序。",
      motion:
        "控制整个主题的动效。访客仍可自行选择简洁浏览，系统减少动效设置始终生效。",
      journey: "五个故事章节对应滚动展示，可以调整顺序和内容。",
      dialogue: "每个选项依次填写回复文案、跳转链接、按钮文字。",
      custom: "保留主题自由扩展空间。CSS 选择器和样式适合熟悉前端的使用者。",
    },
    site: {
      identity: "资料由全部主题共用。",
      socials: "顺序会同步到首页与个人介绍。",
      friends: "友链统一管理，所有主题读取同一份数据。",
      navigation: "控制全站导航链接。",
      activity:
        "只统计绑定仓库、绑定分支的 GitHub 提交。时区决定每日活动归属。",
    },
    themes: {
      registry:
        "访客选择只影响自己。注册与默认主题变更在部署完成后生效，ID 和目录保持固定。",
    },
    categories: {
      categories:
        "分类 ID 用于关联现有素材，不建议更改。仍有素材的分类不能删除。",
    },
  };
  let current,
    key = select.value,
    section = "",
    dirty = false,
    busy = false,
    uploading = 0,
    rawEditing = false;
  function say(text) {
    note.textContent = text;
  }
  function state() {
    ui.setDirty(dirty, busy || uploading > 0);
    saveButton.disabled = !current || busy || uploading > 0;
    select.disabled = busy || uploading > 0;
    document.getElementById("settings-reload").disabled = busy || uploading > 0;
    root.inert = busy || rawEditing || uploading > 0;
    raw.readOnly = busy;
    refs.disabled = busy;
  }
  function changed() {
    dirty = true;
    raw.value = JSON.stringify(current.value, null, 2);
    state();
  }
  function urlIds(value, result = new Set()) {
    if (typeof value === "string") {
      const id = ui.mediaId(value);
      if (id) result.add(id);
    } else if (value && typeof value === "object")
      Object.values(value).forEach((v) => urlIds(v, result));
    return result;
  }
  function get(path) {
    return path.reduce((v, part) => v[part], current.value);
  }
  function set(path, value) {
    const parent = get(path.slice(0, -1));
    parent[path.at(-1)] = value;
    changed();
  }
  function groups() {
    const value = current.value,
      known =
        key === "appearance"
          ? [
              ["hero", ["hero"]],
              ["images", ["images"]],
              ["stickers", ["stickers"]],
              ["motion", ["motion"]],
              ["guide", ["guide"]],
              ["journey", ["journey"]],
              ["dialogue", ["dialogue"]],
              ["outro", ["outro"]],
              ["custom", ["copy", "styles"]],
            ]
          : key === "site"
            ? [
                ["identity", ["title", "description", "profile"]],
                ["socials", ["socials"]],
                ["friends", ["friends"]],
                ["navigation", ["navigation"]],
                ["activity", ["activity"]],
              ]
            : key === "themes"
              ? [["registry", ["defaultTheme", "allowVisitorSwitch", "themes"]]]
              : [["categories", ["items"]]];
    const used = known.flatMap((g) => g[1]);
    const extra = Object.keys(value).filter(
      (k) => !used.includes(k) && k !== "schemaVersion",
    );
    if (extra.length) known.push(["extra", extra]);
    return known;
  }
  const sectionNames = {
    hero: "首屏",
    images: "展示图片",
    stickers: "贴纸",
    motion: "动效",
    guide: "导览",
    journey: "故事与旅程",
    dialogue: "对话向导",
    outro: "结尾",
    custom: "自定义扩展",
    identity: "站点与个人资料",
    socials: "社交链接",
    friends: "友链",
    navigation: "导航",
    activity: "GitHub 活动",
    registry: "主题切换",
    categories: "图床分类",
    extra: "其他字段",
  };
  function showSection(id) {
    section = id;
    root.querySelectorAll("[data-section]").forEach((el) => {
      el.hidden = el.dataset.section !== id;
    });
    nav
      .querySelectorAll("button")
      .forEach((b) =>
        b.setAttribute(
          "aria-current",
          b.dataset.section === id ? "page" : "false",
        ),
      );
    document.getElementById("settings-section-title").textContent =
      sectionNames[id] || id;
    document.getElementById("settings-section-hint").textContent =
      hints[key]?.[id] || "修改后点击保存，配置会写回对应文件。";
  }
  function button(text, fn, cls) {
    const b = node("button", text, cls);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }
  function imageControls(label, input, path) {
    const image = node("img", undefined, "image-preview");
    image.alt = "当前图片预览";
    image.loading = "lazy";
    function preview() {
      const url = ui.previewUrl(input.value);
      image.hidden = !url;
      if (url) image.src = url;
      else image.removeAttribute("src");
    }
    input.addEventListener("input", preview);
    preview();
    const actions = node("div", undefined, "image-actions"),
      status = node("small");
    status.setAttribute("role", "status");
    const choose = button("从图床选择", async () => {
      const item = await ui.chooseImage();
      if (item) {
        input.value = item.url;
        set(path, item.url);
        preview();
      }
    });
    const uploadLabel = node("label", "上传图片", "button"),
      file = node("input");
    file.type = "file";
    file.hidden = true;
    file.accept = "image/jpeg,image/png,image/gif,image/webp,image/avif";
    uploadLabel.append(file);
    file.addEventListener("change", () => {
      const blob = file.files[0];
      if (!blob) return;
      const task = window.Mob.uploadTask(blob, "theme", (percent, stage) => {
        status.textContent = stage + " " + percent + "%";
      });
      const retry = button("重试", run);
      retry.hidden = true;
      actions.append(retry);
      async function run() {
        retry.hidden = true;
        file.disabled = choose.disabled = true;
        uploading++;
        state();
        try {
          const record = await task();
          input.value = record.url;
          set(path, record.url);
          preview();
          status.textContent = "已上传，保存后生效。";
        } catch (e) {
          status.textContent = ui.humanError(e);
          retry.hidden = false;
        } finally {
          uploading--;
          file.disabled = choose.disabled = false;
          file.value = "";
          state();
        }
      }
      run();
    });
    actions.append(choose, uploadLabel);
    label.append(image, actions, status);
  }
  function field(value, path, parent, labelKey) {
    if (value && typeof value === "object") {
      const box = node("fieldset"),
        legend = node("legend", names[labelKey] || labelKey);
      box.append(legend);
      parent.append(box);
      if (Array.isArray(value)) {
        value.forEach((child, i) => {
          const card = node("div", undefined, "array-item");
          const tools = node("div", undefined, "array-item-tools");
          tools.append(
            node(
              "strong",
              (labelKey === "topics" ? "" : "第 ") + (i + 1) + " 项",
            ),
          );
          if (!path.includes("topics") && labelKey !== "themes") {
            const up = button("↑", () => {
              [value[i - 1], value[i]] = [value[i], value[i - 1]];
              changed();
              render();
            });
            up.disabled = i === 0;
            up.setAttribute("aria-label", "上移第 " + (i + 1) + " 项");
            const down = button("↓", () => {
              [value[i + 1], value[i]] = [value[i], value[i + 1]];
              changed();
              render();
            });
            down.disabled = i === value.length - 1;
            down.setAttribute("aria-label", "下移第 " + (i + 1) + " 项");
            tools.append(up, down);
            if (labelKey !== "scenes")
              tools.append(
                button(
                  "移除",
                  () => {
                    value.splice(i, 1);
                    changed();
                    render();
                  },
                  "quiet-button danger",
                ),
              );
          }
          card.append(tools);
          box.append(card);
          field(
            child,
            path.concat(i),
            card,
            path.includes("topics")
              ? ["回复文案", "跳转链接", "按钮文字"][i] || String(i)
              : String(i),
          );
          if (labelKey === "stickers" && child && !("image" in child))
            card.append(
              button("改用图片贴纸", () => {
                child.image = "";
                changed();
                render();
              }),
            );
        });
        if (
          !["scenes", "themes"].includes(labelKey) &&
          !path.includes("topics")
        )
          box.append(
            button("＋ 添加一项", () => {
              const templates = {
                socials: { label: "", url: "" },
                friends: { label: "", url: "" },
                navigation: { label: "", url: "" },
                stickers: { text: "✳", x: 50, y: 50, rotation: 0, size: 24 },
                items: {
                  id: "category-" + Date.now().toString(36),
                  name: "新分类",
                },
              };
              value.push(templates[labelKey] || "");
              changed();
              render();
            }),
          );
      } else
        Object.entries(value).forEach(([k, v]) =>
          field(v, path.concat(k), box, k),
        );
      return;
    }
    const label = node(
      "label",
      undefined,
      "field" + (typeof value === "boolean" ? " is-switch" : ""),
    );
    label.append(
      node(
        "span",
        names[labelKey] ||
          (/^scene-\d$/.test(labelKey)
            ? "故事场景 " + labelKey.slice(-1)
            : labelKey),
      ),
    );
    const input = node(
      typeof value === "string" &&
        (value.length > 140 ||
          /bio|description|introText|welcome/.test(labelKey))
        ? "textarea"
        : "input",
    );
    input.type =
      typeof value === "boolean"
        ? "checkbox"
        : typeof value === "number"
          ? "number"
          : "text";
    if (input.type === "checkbox") input.checked = value;
    else input.value = value ?? "";
    const readonly =
      key === "themes" &&
      path[0] === "themes" &&
      ["id", "root"].includes(labelKey);
    input.readOnly = readonly;
    if (typeof value === "number") {
      const bounds =
        labelKey === "days" && path.includes("activity")
          ? [30, 366, 1]
          : {
              x: [0, 100, 1],
              y: [0, 100, 1],
              rotation: [-180, 180, 1],
              size: [8, 100, 1],
              heroScrollVh: [100, 700, 10],
              storyScrollVh: [100, 1000, 10],
            }[labelKey];
      input.step = "any";
      if (bounds) [input.min, input.max, input.step] = bounds.map(String);
    }
    input.dataset.path = path.join(".");
    input.addEventListener("input", () =>
      set(
        path,
        input.type === "checkbox"
          ? input.checked
          : input.type === "number"
            ? Number(input.value)
            : input.value,
      ),
    );
    label.append(input);
    parent.append(label);
    if (
      typeof value === "string" &&
      (["avatar", "cover", "image"].includes(labelKey) || path[0] === "images")
    )
      imageControls(label, input, path);
  }
  function render() {
    root.replaceChildren();
    nav.replaceChildren();
    const list = groups();
    list.forEach(([id, keys]) => {
      const b = button(sectionNames[id] || id, () => showSection(id));
      b.dataset.section = id;
      nav.append(b);
      const container = node("div");
      container.dataset.section = id;
      root.append(container);
      keys.forEach((k) => {
        if (k in current.value) field(current.value[k], [k], container, k);
        else if (k === "activity")
          container.append(
            button("配置 GitHub 活动", () => {
              current.value.activity = {
                enabled: false,
                title: "代码足迹",
                github: { enabled: true, title: "GitHub 提交活动" },
                days: 365,
                timezone: "Asia/Hong_Kong",
              };
              changed();
              render();
            }),
          );
      });
    });
    showSection(list.some((g) => g[0] === section) ? section : list[0][0]);
    state();
  }
  async function load() {
    busy = true;
    state();
    say("正在读取仓库配置…");
    try {
      const result = await api(docs[select.value][0]);
      current = result;
      key = select.value;
      raw.value = JSON.stringify(result.value, null, 2);
      const automatic = urlIds(result.value);
      refs.value = (result.mediaIds || [])
        .filter((id) => !automatic.has(id))
        .join(", ");
      dirty = rawEditing = false;
      section = "";
      render();
      document.getElementById("settings-path").textContent = docs[key][1];
      say(
        key === "themes"
          ? "注册变更在部署后生效。"
          : "已读取。修改后保存即可生效。",
      );
    } catch (e) {
      select.value = key;
      say(ui.humanError(e));
    } finally {
      busy = false;
      state();
    }
  }
  select.addEventListener("change", () => {
    if (
      uploading ||
      busy ||
      (dirty && !confirm("有未保存的配置，继续切换？"))
    ) {
      select.value = key;
      return;
    }
    load();
  });
  document.getElementById("settings-reload").addEventListener("click", () => {
    if (!dirty || confirm("重新读取会放弃当前修改，继续？")) load();
  });
  raw.addEventListener("input", () => {
    dirty = true;
    rawEditing = true;
    state();
    say("JSON 有修改，请应用到表单或直接保存。");
  });
  refs.addEventListener("input", () => {
    dirty = true;
    state();
  });
  function applyRaw() {
    const value = JSON.parse(raw.value);
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error("配置须为 JSON 对象。");
    current.value = value;
    rawEditing = false;
    render();
  }
  document
    .getElementById("settings-apply-json")
    .addEventListener("click", () => {
      try {
        applyRaw();
        dirty = true;
        state();
        say("已应用，尚未保存。");
      } catch (e) {
        say("JSON 格式有误：" + e.message);
      }
    });
  async function save() {
    if (busy || uploading || !current) return;
    try {
      if (rawEditing) applyRaw();
      const invalid = root.querySelector("input:invalid,textarea:invalid");
      if (invalid) {
        showSection(invalid.closest("[data-section]").dataset.section);
        invalid.reportValidity();
        say("请检查字段范围。");
        return;
      }
      const mediaIds = refs.value
        .split(/[,，]/)
        .map((id) => id.trim())
        .filter(Boolean);
      busy = true;
      state();
      say("正在保存…");
      const saved = await api(docs[key][0], {
        method: "PUT",
        json: { sha: current.sha, value: current.value, mediaIds },
      });
      current = { ...saved, mediaIds };
      raw.value = JSON.stringify(current.value, null, 2);
      dirty = false;
      render();
      say(
        "已保存 · " +
          (saved.commitSha || "").slice(0, 8) +
          (key === "themes" ? " · 部署完成后生效。" : " · 刷新前台查看。"),
      );
    } catch (e) {
      say(ui.humanError(e));
    } finally {
      busy = false;
      state();
    }
  }
  saveButton.addEventListener("click", save);
  document.addEventListener("firefly:save", save);
  ui.session.then((session) => {
    if (session) load();
    else {
      saveButton.disabled = true;
      say("请通过管理员入口登录后重试。");
    }
  });
})();
