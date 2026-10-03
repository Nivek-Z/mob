(function () {
  const api = window.Mob.api,
    ui = window.Mob.firefly,
    node = ui.node,
    root = document.getElementById("gallery-items"),
    note = document.getElementById("gallery-note"),
    category = document.getElementById("gallery-category"),
    search = document.getElementById("gallery-search");
  let sha = null,
    offset = 0,
    categories = [],
    items = [],
    pending = new Map(),
    selected = new Set(),
    busy = false,
    uploading = 0,
    query = "",
    activeCategory = "",
    total = 0,
    loaded = false,
    dialogDirty = false,
    categoriesLoaded = false;
  const say = (text) => {
    note.textContent = text;
  };
  function state() {
    ui.setDirty(pending.size > 0 || dialogDirty, busy || uploading > 0);
    document.getElementById("gallery-save").disabled =
      !pending.size || busy || uploading > 0;
    document.getElementById("gallery-batch").disabled =
      !selected.size || busy || uploading > 0;
    document.getElementById("gallery-selected").textContent =
      "已选 " + selected.size + " 项";
    const all = document.getElementById("gallery-select-all");
    all.checked = items.length > 0 && selected.size === items.length;
    all.indeterminate = selected.size > 0 && selected.size < items.length;
    document
      .querySelectorAll(
        ".gallery-filters button,.gallery-filters select,#gallery-file,#gallery-import",
      )
      .forEach((el) => {
        el.disabled = busy || uploading > 0;
      });
    document.getElementById("gallery-prev").disabled =
      busy || uploading > 0 || offset === 0;
    document.getElementById("gallery-next").disabled =
      busy || uploading > 0 || offset + 24 >= total;
  }
  function preview(item) {
    const media = node(
      item.contentType.startsWith("image/")
        ? "img"
        : item.contentType.startsWith("audio/")
          ? "audio"
          : "video",
    );
    media.src = "/api/admin/media/" + item.id + "/file";
    if (media.tagName === "IMG") {
      media.alt = item.title || item.filename;
      media.loading = "lazy";
    } else {
      media.controls = true;
      media.preload = "none";
      media.playsInline = true;
    }
    return media;
  }
  function button(text, fn, cls) {
    const b = node("button", text, cls);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }
  function render() {
    root.replaceChildren(
      ...items.map((original) => {
        const item = { ...original, ...pending.get(original.id) },
          card = node(
            "article",
            undefined,
            "media-card" + (pending.has(item.id) ? " is-pending" : ""),
          );
        card.dataset.id = item.id;
        const checkLabel = node("label", "选择", "batch-check"),
          check = node("input");
        check.type = "checkbox";
        check.checked = selected.has(item.id);
        check.setAttribute("aria-label", "选择 " + item.title);
        check.addEventListener("change", () => {
          check.checked ? selected.add(item.id) : selected.delete(item.id);
          state();
        });
        checkLabel.prepend(check);
        const body = node("div", undefined, "media-card-body");
        body.append(node("h3", item.title || item.filename));
        const badges = node("div", undefined, "media-badges");
        badges.append(
          node(
            "span",
            categories.find((c) => c.id === item.categoryId)?.name ||
              item.categoryId,
            "badge",
          ),
          node(
            "span",
            item.isListed ? "图库展示" : item.isPublic ? "链接公开" : "私有",
            "badge",
          ),
        );
        if (pending.has(item.id))
          badges.append(node("span", "待保存", "badge"));
        body.append(
          badges,
          node(
            "small",
            item.filename +
              " · " +
              (item.size / 1024 / 1024).toFixed(2) +
              " MB",
          ),
        );
        const actions = node("div", undefined, "actions");
        actions.append(
          button("编辑", () => edit(item)),
          button("复制链接", async () => {
            try {
              await navigator.clipboard.writeText(item.url);
              say("链接已复制" + (item.isPublic ? "。" : "；此素材目前私有。"));
            } catch {
              say(item.url);
            }
          }),
        );
        body.append(actions);
        card.append(checkLabel, preview(item), body);
        return card;
      }),
    );
    if (!items.length)
      root.append(
        node(
          "p",
          query
            ? "没有匹配的素材，试试其他关键词。"
            : "这里还没有素材，可上传或从 R2 纳入。",
          "muted",
        ),
      );
    state();
  }
  async function load(
    nextOffset = offset,
    nextCategory = activeCategory,
    nextQuery = query,
  ) {
    busy = true;
    state();
    say("正在加载…");
    try {
      const params = new URLSearchParams({
        limit: "24",
        offset: String(nextOffset),
        q: nextQuery,
      });
      if (nextCategory) params.set("category", nextCategory);
      const page = await api("/api/admin/gallery?" + params);
      sha = page.sha;
      items = page.items;
      total = page.total;
      offset = nextOffset;
      activeCategory = nextCategory;
      query = nextQuery;
      category.value = activeCategory;
      search.value = query;
      pending.clear();
      selected.clear();
      loaded = true;
      render();
      document.getElementById("gallery-page").textContent = total
        ? `${offset + 1}–${Math.min(offset + items.length, total)} / ${total}`
        : "0 / 0";
      say("已读取 " + total + " 项素材。");
    } catch (e) {
      category.value = activeCategory;
      search.value = query;
      say(ui.humanError(e) + " 点击刷新可重试。");
    } finally {
      busy = false;
      state();
    }
  }
  function canLoad() {
    if (busy || uploading) return false;
    return !pending.size || confirm("当前图库修改未保存，继续切换并放弃修改？");
  }
  function patch(id, update) {
    pending.set(id, { ...pending.get(id), id, ...update });
    render();
    say("有 " + pending.size + " 项修改待保存。");
  }
  function edit(item) {
    if (busy || uploading) return;
    const content = node("form", undefined, "dialog-fields");
    const media = preview(item);
    media.classList.add("dialog-preview");
    content.append(media);
    const inputs = {};
    function input(key, label, type = "text", value = item[key]) {
      const wrapper = node("label", undefined, "field");
      wrapper.append(node("span", label));
      const el = node(
        type === "textarea"
          ? "textarea"
          : type === "select"
            ? "select"
            : "input",
      );
      if (type === "select")
        categories.forEach((c) => {
          const o = node("option", c.name);
          o.value = c.id;
          el.append(o);
        });
      else if (type !== "textarea") el.type = type;
      if (type === "checkbox") el.checked = value;
      else el.value = Array.isArray(value) ? value.join(", ") : value || "";
      if (key === "title") el.maxLength = 200;
      if (key === "description") el.maxLength = 4000;
      wrapper.append(el);
      content.append(wrapper);
      inputs[key] = el;
    }
    input("title", "标题");
    input("description", "说明", "textarea");
    input("categoryId", "分类", "select");
    input("tags", "标签（逗号分隔）");
    input("isPublic", "公开稳定链接", "checkbox");
    input("isListed", "展示在公开图库", "checkbox");
    inputs.isListed.addEventListener("change", () => {
      if (inputs.isListed.checked) inputs.isPublic.checked = true;
    });
    inputs.isPublic.addEventListener("change", () => {
      if (!inputs.isPublic.checked) inputs.isListed.checked = false;
    });
    content.append(
      node(
        "p",
        "勾选图库展示会同时公开链接。取消公开后也会停止展示。",
        "muted",
      ),
    );
    const actions = node("div", undefined, "actions"),
      apply = node("button", "应用修改", "primary"),
      remove = button("删除对象", () => deleteItem(item, view), "danger");
    actions.append(apply, remove);
    content.append(actions);
    const view = ui.modal("编辑素材", content);
    let localDirty = false;
    content.addEventListener("input", () => {
      localDirty = dialogDirty = true;
      state();
    });
    view.dialog.addEventListener("close", () => {
      dialogDirty = false;
      state();
    });
    view.dialog.addEventListener("firefly:dialog-before-close", (event) => {
      if (busy) {
        event.preventDefault();
        return;
      }
      if (localDirty && !confirm("放弃这次尚未应用的修改？"))
        event.preventDefault();
    });
    content.addEventListener("submit", (event) => {
      event.preventDefault();
      patch(item.id, {
        title: inputs.title.value.trim(),
        description: inputs.description.value,
        tags: inputs.tags.value
          .split(/[,，]/)
          .map((v) => v.trim())
          .filter(Boolean),
        categoryId: inputs.categoryId.value,
        isPublic: inputs.isPublic.checked,
        isListed: inputs.isListed.checked,
      });
      localDirty = dialogDirty = false;
      view.close(true);
    });
  }
  async function deleteItem(item, view) {
    if (busy || uploading) return;
    if (
      pending.size &&
      !confirm("删除后重新读取图库，会放弃待保存修改。继续？")
    )
      return;
    if (
      !confirm(
        "删除「" +
          (item.title || item.filename) +
          "」及其 R2 对象？正在被引用的素材会受到保护。",
      )
    )
      return;
    busy = true;
    state();
    view.dialog.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await api("/api/admin/gallery/items/" + item.id, {
        method: "DELETE",
        json: { sha },
      });
      view.close(true);
      await load(Math.max(0, items.length === 1 ? offset - 24 : offset));
      say("对象已删除。");
    } catch (e) {
      say(ui.humanError(e));
      const message = node("p", ui.humanError(e), "error");
      view.dialog.append(message);
    } finally {
      busy = false;
      state();
      if (view.dialog.isConnected)
        view.dialog
          .querySelectorAll("button")
          .forEach((b) => (b.disabled = false));
    }
  }
  async function save() {
    if (dialogDirty) {
      say("请先在素材窗口中应用修改。");
      return;
    }
    if (busy || uploading || !pending.size) return;
    busy = true;
    state();
    say("正在保存…");
    try {
      const result = await api("/api/admin/gallery", {
        method: "PATCH",
        json: { sha, items: [...pending.values()] },
      });
      sha = result.sha;
      items = items.map((item) => ({ ...item, ...pending.get(item.id) }));
      pending.clear();
      render();
      say("图库修改已保存。");
    } catch (e) {
      say(ui.humanError(e));
    } finally {
      busy = false;
      state();
    }
  }
  document.getElementById("gallery-save").addEventListener("click", save);
  document.addEventListener("firefly:save", save);
  document.getElementById("gallery-batch").addEventListener("click", () => {
    const cat = document.getElementById("batch-category").value,
      pub = document.getElementById("batch-public").value,
      listed = document.getElementById("batch-listed").value;
    if (!cat && !pub && !listed) {
      say("先选择要修改的分类或权限。");
      return;
    }
    if (pub === "false" && listed === "true") {
      say("私有链接无法展示在公开图库，请调整批量选项。");
      return;
    }
    selected.forEach((id) => {
      const update = {};
      if (cat) update.categoryId = cat;
      if (pub) update.isPublic = pub === "true";
      if (listed) update.isListed = listed === "true";
      if (listed === "true") update.isPublic = true;
      if (pub === "false") update.isListed = false;
      pending.set(id, { ...pending.get(id), id, ...update });
    });
    render();
    say("已应用到 " + selected.size + " 项，点击保存修改后生效。");
  });
  document
    .getElementById("gallery-select-all")
    .addEventListener("change", (event) => {
      selected = event.target.checked
        ? new Set(items.map((i) => i.id))
        : new Set();
      render();
    });
  category.addEventListener("change", () => {
    if (canLoad()) load(0, category.value, query);
    else category.value = activeCategory;
  });
  document
    .getElementById("gallery-search-form")
    .addEventListener("submit", (event) => {
      event.preventDefault();
      if (canLoad()) load(0, category.value, search.value.trim());
    });
  document.getElementById("gallery-prev").addEventListener("click", () => {
    if (canLoad()) load(Math.max(0, offset - 24));
  });
  document.getElementById("gallery-next").addEventListener("click", () => {
    if (canLoad()) load(offset + 24);
  });
  document.getElementById("gallery-reload").addEventListener("click", () => {
    if (canLoad()) init();
  });
  function uploads(files) {
    if (busy || pending.size) {
      say("请先保存图库修改，再上传素材。");
      return;
    }
    files.forEach((file) => {
      const row = node("div", undefined, "upload-row"),
        label = node("span"),
        retry = button("重试", run);
      retry.hidden = true;
      row.append(label, retry);
      document.getElementById("gallery-uploads").append(row);
      const task = window.Mob.uploadTask(file, "gallery", (percent, stage) => {
        label.textContent = file.name + " · " + stage + " " + percent + "%";
      });
      async function run() {
        if (pending.size || busy) {
          say("请先保存图库修改。");
          return;
        }
        retry.hidden = true;
        uploading++;
        state();
        try {
          await task();
          label.textContent = file.name + " · 已进入私有图床";
        } catch (e) {
          label.textContent = file.name + " · " + ui.humanError(e);
          retry.hidden = false;
        } finally {
          uploading--;
          state();
          if (!uploading && !pending.size) await load(0);
        }
      }
      run();
    });
  }
  window.Mob.bindDrops(document.getElementById("gallery-drop"), uploads);
  document
    .getElementById("gallery-file")
    .addEventListener("change", (event) => {
      uploads([...event.target.files]);
      event.target.value = "";
    });
  document
    .getElementById("gallery-import")
    .addEventListener("click", async () => {
      if (!canLoad()) return;
      busy = true;
      state();
      let cursor;
      try {
        do {
          const page = await api("/api/admin/gallery/import", {
            method: "POST",
            json: cursor ? { cursor } : {},
          });
          cursor = page.cursor;
          say("正在登记历史上传…");
        } while (cursor);
        await load(0);
        say("历史上传已登记，默认私有。");
      } catch (e) {
        say(ui.humanError(e));
      } finally {
        busy = false;
        state();
      }
    });
  window.addEventListener("mob:gallery-storage-before-import", (event) => {
    if (pending.size || dialogDirty || busy || uploading || !loaded)
      event.preventDefault();
  });
  window.addEventListener("mob:gallery-storage-import", () => {
    if (!pending.size && !busy && !uploading) load(0);
    else say("素材已纳入；请保存当前修改后刷新。");
  });
  async function init() {
    try {
      if (!categoriesLoaded) {
        categories = (await api("/api/admin/gallery/categories")).value.items;
        [category, document.getElementById("batch-category")].forEach((el) =>
          categories.forEach((c) => {
            const option = node("option", c.name);
            option.value = c.id;
            el.append(option);
          }),
        );
        categoriesLoaded = true;
      }
      await load();
    } catch (e) {
      say(ui.humanError(e) + " 点击刷新可重试。");
    }
  }
  ui.session.then((session) => {
    if (session) init();
  });
})();
