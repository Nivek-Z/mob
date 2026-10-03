(function () {
  const api = window.Mob.api,
    ui = window.Mob.firefly,
    node = ui.node,
    form = document.getElementById("editor"),
    list = document.getElementById("post-list"),
    note = document.getElementById("note"),
    preview = document.getElementById("preview");
  const fields = Object.fromEntries(
    ["title", "slug", "description", "tags", "cover", "markdown"].map((k) => [
      k,
      document.getElementById(k),
    ]),
  );
  let sha = null,
    editing = "",
    status = "draft",
    posts = [],
    dirty = false,
    saving = false,
    uploading = 0,
    revision = 0,
    slugManual = false,
    previewTimer,
    uploadCounter = 0,
    loading = false;
  const say = (text) => {
    note.textContent = text;
  };
  function state() {
    fields.slug.disabled = saving;
    ui.setDirty(dirty, saving || uploading > 0 || loading);
    form.querySelectorAll(".save-bar button").forEach((b) => {
      b.disabled = saving || uploading > 0 || loading;
    });
    document.getElementById("new-post").disabled =
      loading || saving || uploading > 0;
    document.getElementById("save-publish").textContent =
      status === "published" ? "保存更新" : "发布文章";
    document.getElementById("save-draft").textContent =
      status === "published" ? "转为草稿" : "保存草稿";
  }
  function privateText(text) {
    return text.replace(
      /(?:(?:https?:)?\/\/[^\s)<>"']+)?\/media\/[a-f0-9-]{36}\/[^\s)<>"']+/gi,
      (value) => (ui.mediaId(value) ? ui.previewUrl(value) : value),
    );
  }
  function renderPreview() {
    clearTimeout(previewTimer);
    preview.innerHTML = window.Mob.renderMarkdown(
      privateText(fields.markdown.value),
    );
    const url = ui.previewUrl(fields.cover.value.trim());
    const cover = document.getElementById("cover-preview");
    cover.hidden = !url;
    if (url) cover.src = url;
    else cover.removeAttribute("src");
    document.getElementById("editor-stats").textContent =
      fields.markdown.value.replace(/\s/g, "").length.toLocaleString() + " 字";
  }
  function changed(immediate = false) {
    dirty = true;
    revision++;
    state();
    clearTimeout(previewTimer);
    if (immediate) renderPreview();
    else previewTimer = setTimeout(renderPreview, 180);
  }
  function collectIds() {
    return [
      ...new Set(
        (fields.markdown.value + "\n" + fields.cover.value)
          .match(
            /(?:(?:https?:)?\/\/[^\s)<>"']+)?\/media\/[a-f0-9-]{36}\/[^\s)<>"']+/gi,
          )
          ?.map(ui.mediaId)
          .filter(Boolean) || [],
      ),
    ].slice(0, 200);
  }
  function fill(post) {
    editing = post?.slug || "";
    sha = post?.sha || null;
    status = post?.status || "draft";
    Object.entries(fields).forEach(([key, input]) => {
      input.value = post
        ? key === "tags"
          ? (post.tags || []).join(", ")
          : post[key] || ""
        : "";
    });
    fields.slug.readOnly = Boolean(post);
    slugManual = Boolean(post);
    dirty = false;
    revision = 0;
    document.getElementById("mode").textContent = post
      ? status === "published"
        ? "已发布"
        : "草稿"
      : "新文章";
    document.getElementById("remove").hidden = !post;
    const link = document.getElementById("post-link");
    link.hidden = status !== "published";
    link.href = "/post.html?slug=" + encodeURIComponent(editing);
    document.getElementById("upload-queue").replaceChildren();
    renderPreview();
    renderList();
    state();
  }
  function renderList() {
    const q = document.getElementById("post-search").value.trim().toLowerCase(),
      filter = document.getElementById("post-filter").value;
    const visible = posts.filter(
      (p) =>
        (filter === "all" || p.status === filter) &&
        (p.title + " " + (p.tags || []).join(" ")).toLowerCase().includes(q),
    );
    list.replaceChildren(
      ...visible.map((post) => {
        const b = node("button", undefined, "post-list-item");
        b.type = "button";
        b.setAttribute(
          "aria-current",
          post.slug === editing ? "page" : "false",
        );
        b.append(
          node("strong", post.title),
          node(
            "span",
            post.status === "published" ? "已发布" : "草稿",
            "badge",
          ),
        );
        b.addEventListener("click", () => open(post.slug));
        return b;
      }),
    );
    if (!visible.length)
      list.append(
        node(
          "p",
          posts.length ? "没有匹配的文章。" : "还没有文章，写下第一篇吧。",
          "muted",
        ),
      );
  }
  async function loadList() {
    try {
      posts = (await api("/api/admin/posts")).items;
      renderList();
    } catch (e) {
      list.replaceChildren(node("p", ui.humanError(e), "error"));
    }
  }
  function canSwitch() {
    if (saving || uploading || loading) {
      say("请等待当前操作完成。");
      return false;
    }
    return !dirty || confirm("当前文章有未保存修改，继续切换？");
  }
  async function open(slug, initial = false) {
    if (!initial && !canSwitch()) return;
    loading = true;
    state();
    try {
      const post = slug
        ? await api("/api/admin/posts/" + encodeURIComponent(slug))
        : null;
      fill(post);
      history.replaceState(
        null,
        "",
        slug ? "/admin/?slug=" + encodeURIComponent(slug) : "/admin/",
      );
      say("");
    } catch (e) {
      say(ui.humanError(e));
    } finally {
      loading = false;
      state();
    }
  }
  function insert(text) {
    const box = fields.markdown;
    box.setRangeText(text, box.selectionStart, box.selectionEnd, "end");
    box.focus();
    changed(true);
  }
  const linkText = (name) => name.replace(/[\[\]\\\r\n]/g, " ");
  function enqueue(blobs, cover = false) {
    blobs.forEach((blob) => {
      const row = node("div", undefined, "upload-row"),
        label = node("span"),
        retry = node("button", "重试"),
        cancel = node("button", "移除占位");
      retry.type = cancel.type = "button";
      retry.hidden = true;
      row.append(label, retry, cancel);
      document.getElementById("upload-queue").append(row);
      const marker =
        "[" +
        linkText(blob.name) +
        " · 上传中](#firefly-upload-" +
        ++uploadCounter +
        ")";
      if (!cover) insert((blob.type.startsWith("image/") ? "!" : "") + marker);
      else cancel.hidden = true;
      const task = window.Mob.uploadTask(blob, "editor", (percent, stage) => {
        label.textContent = blob.name + " · " + stage + " " + percent + "%";
      });
      let running = false;
      cancel.addEventListener("click", () => {
        fields.markdown.value = fields.markdown.value
          .replace("!" + marker, "")
          .replace(marker, "");
        row.remove();
        changed(true);
      });
      async function attempt() {
        if (running) return;
        running = true;
        retry.hidden = true;
        cancel.disabled = true;
        uploading++;
        state();
        try {
          const record = await task();
          if (cover) {
            fields.cover.value = record.url;
            changed(true);
          } else if (fields.markdown.value.includes(marker)) {
            fields.markdown.value = fields.markdown.value.replace(
              marker,
              "[" + linkText(record.filename) + "](" + record.url + ")",
            );
            changed(true);
          }
          label.textContent = record.filename + " · 上传完成";
          retry.hidden = true;
          cancel.hidden = true;
        } catch (e) {
          label.textContent = blob.name + " · " + ui.humanError(e);
          retry.hidden = false;
        } finally {
          uploading--;
          running = false;
          cancel.disabled = false;
          state();
        }
      }
      retry.addEventListener("click", attempt);
      attempt();
    });
  }
  window.Mob.bindDrops(fields.markdown, (files) => enqueue(files));
  document.getElementById("file").addEventListener("change", (event) => {
    enqueue([...event.target.files]);
    event.target.value = "";
  });
  document.getElementById("cover-file").addEventListener("change", (event) => {
    if (event.target.files[0]) enqueue([event.target.files[0]], true);
    event.target.value = "";
  });
  document
    .getElementById("insert-media")
    .addEventListener("click", async () => {
      const start = fields.markdown.selectionStart,
        end = fields.markdown.selectionEnd;
      const item = await ui.chooseImage();
      if (item) {
        fields.markdown.setSelectionRange(start, end);
        insert(
          "![" + linkText(item.title || item.filename) + "](" + item.url + ")",
        );
      }
    });
  document
    .getElementById("cover-choose")
    .addEventListener("click", async () => {
      const item = await ui.chooseImage();
      if (item) {
        fields.cover.value = item.url;
        changed(true);
      }
    });
  document.getElementById("cover-clear").addEventListener("click", () => {
    fields.cover.value = "";
    changed(true);
  });
  document.querySelectorAll("[data-format]").forEach((b) =>
    b.addEventListener("click", () => {
      const text = fields.markdown.value.slice(
        fields.markdown.selectionStart,
        fields.markdown.selectionEnd,
      );
      const formats = {
        heading: "\n## " + (text || "标题") + "\n",
        bold: "**" + (text || "文字") + "**",
        italic: "*" + (text || "文字") + "*",
        link: "[" + (text || "链接文字") + "](https://)",
        code: "\n```\n" + text + "\n```\n",
        quote: "\n> " + (text || "引用") + "\n",
        list: "\n- " + (text || "列表项") + "\n",
      };
      insert(formats[b.dataset.format]);
    }),
  );
  document.querySelectorAll(".pane-switch button").forEach((b) =>
    b.addEventListener("click", () => {
      document.getElementById("editor-panes").dataset.view = b.dataset.view;
      document
        .querySelectorAll(".pane-switch button")
        .forEach((el) => el.setAttribute("aria-pressed", String(el === b)));
      renderPreview();
    }),
  );
  fields.slug.addEventListener("input", () => {
    slugManual = true;
  });
  fields.title.addEventListener("input", () => {
    if (!slugManual && !editing) {
      fields.slug.value =
        fields.title.value
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 80)
          .replace(/-$/, "") ||
        "note-" +
          new Date().toISOString().slice(0, 10).replace(/-/g, "") +
          "-" +
          Math.random().toString(36).slice(2, 7);
    }
  });
  form.addEventListener("input", (event) => {
    if (event.target.matches("input:not([type=file]),textarea")) changed();
  });
  async function save(nextStatus) {
    if (saving || uploading || loading) return;
    if (!form.reportValidity()) return;
    if (/#firefly-upload-\d+/.test(fields.markdown.value)) {
      say("正文里有未完成的上传，请重试或移除占位。");
      return;
    }
    if (
      status === "published" &&
      nextStatus === "draft" &&
      !confirm("转为草稿后，访客将无法访问这篇文章。继续？")
    )
      return;
    saving = true;
    state();
    say("正在保存…");
    const snapshot = revision;
    try {
      const result = await api(
        "/api/admin/posts/" + encodeURIComponent(fields.slug.value.trim()),
        {
          method: "PUT",
          json: {
            sha,
            title: fields.title.value.trim(),
            markdown: fields.markdown.value,
            status: nextStatus,
            description: fields.description.value.trim(),
            tags: fields.tags.value
              .split(/[,，]/)
              .map((t) => t.trim())
              .filter(Boolean),
            cover: fields.cover.value.trim() || null,
            mediaIds: collectIds(),
          },
        },
      );
      sha = result.post.sha;
      editing = result.post.slug;
      status = result.post.status;
      fields.slug.value = editing;
      fields.slug.readOnly = true;
      dirty = revision !== snapshot;
      document.getElementById("remove").hidden = false;
      document.getElementById("mode").textContent =
        status === "published" ? "已发布" : "草稿";
      const link = document.getElementById("post-link");
      link.hidden = status !== "published";
      link.href = "/post.html?slug=" + encodeURIComponent(editing);
      history.replaceState(
        null,
        "",
        "/admin/?slug=" + encodeURIComponent(editing),
      );
      say(
        dirty
          ? "已保存提交时的内容。保存期间的新修改仍待保存。"
          : status === "published"
            ? "文章已发布。"
            : "草稿已保存。",
      );
      await loadList();
    } catch (e) {
      say(ui.humanError(e));
    } finally {
      saving = false;
      state();
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.submitter?.dataset.status || status);
  });
  document.addEventListener("firefly:save", () => save(status));
  document.getElementById("remove").addEventListener("click", async () => {
    if (
      saving ||
      uploading ||
      !editing ||
      !confirm("删除这篇文章？已上传素材保留在图床。")
    )
      return;
    saving = true;
    state();
    try {
      await api("/api/admin/posts/" + encodeURIComponent(editing), {
        method: "DELETE",
        json: { sha },
      });
      fill(null);
      history.replaceState(null, "", "/admin/");
      await loadList();
      say("文章已删除。");
    } catch (e) {
      say(ui.humanError(e));
    } finally {
      saving = false;
      state();
    }
  });
  document.getElementById("new-post").addEventListener("click", () => open(""));
  document.getElementById("posts-reload").addEventListener("click", loadList);
  ["post-search", "post-filter"].forEach((id) =>
    document.getElementById(id).addEventListener("input", renderList),
  );
  ui.session.then(async (session) => {
    if (!session) {
      form.hidden = true;
      return;
    }
    fill(null);
    await loadList();
    const slug = new URLSearchParams(location.search).get("slug");
    if (slug) await open(slug, true);
  });
})();
