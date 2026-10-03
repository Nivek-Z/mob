(function () {
  const api = window.Mob.api;
  let dirty = false,
    busy = false;
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  function setDirty(value, working = false) {
    dirty = value;
    busy = working;
    document.querySelectorAll("[data-save-state]").forEach((el) => {
      el.textContent = working
        ? "正在处理…"
        : value
          ? "有未保存修改"
          : "已同步";
      el.classList.toggle("is-dirty", value);
    });
  }
  function mediaId(value) {
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin
        ? /^\/media\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\//i.exec(
            url.pathname,
          )?.[1] || null
        : null;
    } catch {
      return null;
    }
  }
  function previewUrl(value) {
    const id = mediaId(value);
    return id ? "/api/admin/media/" + id + "/file" : window.Mob.safeUrl(value);
  }
  function humanError(error) {
    if (error.code === "MEDIA_IN_USE") {
      const articles = error.details?.articles || [],
        configs = error.details?.configs || [];
      return (
        "素材仍被引用，请先移除：" +
        [
          articles.length ? "文章「" + articles.join("、") + "」" : "",
          configs.length ? "配置 " + configs.join("、") : "",
        ]
          .filter(Boolean)
          .join("；")
      );
    }
    const messages = {
      CONFIG_CONFLICT: "配置已被修改。你的输入已保留，请重新读取后合并。",
      POST_CONFLICT: "文章已被修改。你的正文已保留，请核对最新版本。",
      GITHUB_UNAVAILABLE: "暂时无法连接 GitHub，请稍后重试。",
      GITHUB_TIMEOUT: "GitHub 响应超时，请重试。",
      MEDIA_TOO_LARGE: "文件超过上传大小限制。",
      UNSUPPORTED_MEDIA_TYPE: "请选择受支持的图片、音频或视频。",
      MEDIA_IN_USE: "素材正在被文章或配置使用，请先移除对应引用。",
      INVALID_SITE: "请检查站点资料、必填名称和链接格式。",
      INVALID_ACTIVITY: "请检查活动图标题、30–366 天的范围和有效时区。",
      INVALID_CATEGORY: "请保留必需分类，使用唯一的分类 ID 与名称。",
      INVALID_CONFIG: "配置未通过声明的格式校验，请检查字段。",
    };
    return messages[error.code] || error.message || "操作失败，请重试。";
  }
  function modal(title, content) {
    const dialog = node("dialog", undefined, "admin-dialog");
    const header = node("div", undefined, "dialog-heading");
    const heading = node("h2", title);
    heading.id = "dialog-" + Math.random().toString(36).slice(2);
    dialog.setAttribute("aria-labelledby", heading.id);
    const close = node("button", "关闭 ×", "quiet-button");
    close.type = "button";
    header.append(heading, close);
    dialog.append(header, content);
    document.body.append(dialog);
    const opener = document.activeElement;
    const finish = () => {
      dialog.remove();
      if (opener?.isConnected) opener.focus();
    };
    close.addEventListener("click", () => {
      if (
        !dialog.dispatchEvent(
          new CustomEvent("firefly:dialog-before-close", { cancelable: true }),
        )
      )
        return;
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else {
        dialog.dispatchEvent(new Event("close"));
      }
    });
    dialog.addEventListener("close", finish);
    dialog.addEventListener("cancel", (event) => {
      if (
        !dialog.dispatchEvent(
          new CustomEvent("firefly:dialog-before-close", { cancelable: true }),
        )
      )
        event.preventDefault();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) close.click();
    });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return {
      dialog,
      close: (force = false) => {
        if (!force) close.click();
        else if (dialog.open && typeof dialog.close === "function")
          dialog.close();
        else dialog.dispatchEvent(new Event("close"));
      },
    };
  }
  function chooseImage() {
    return new Promise((resolve) => {
      const content = node("div");
      const form = node("form", undefined, "actions");
      const input = node("input");
      input.type = "search";
      input.placeholder = "搜索图片标题、标签";
      input.setAttribute("aria-label", "搜索图床图片");
      const search = node("button", "搜索");
      form.append(input, search);
      const list = node("div", undefined, "picker-grid");
      const note = node("p", "", "muted");
      note.setAttribute("role", "status");
      const pager = node("div", undefined, "actions");
      const prev = node("button", "上一页"),
        next = node("button", "下一页");
      prev.type = next.type = "button";
      pager.append(prev, next);
      content.append(form, note, list, pager);
      const view = modal("选择图床图片", content);
      let offset = 0,
        query = "",
        serial = 0,
        chosen = false;
      view.dialog.addEventListener("close", () => {
        if (!chosen) resolve(null);
      });
      async function load() {
        const version = ++serial;
        prev.disabled = next.disabled = true;
        note.textContent = "正在加载图片…";
        try {
          const params = new URLSearchParams({
            limit: "24",
            offset: String(offset),
            q: query,
          });
          const page = await api("/api/admin/gallery?" + params);
          if (version !== serial || !view.dialog.isConnected) return;
          const pictures = page.items.filter((item) =>
            item.contentType.startsWith("image/"),
          );
          list.replaceChildren(
            ...pictures.map((item) => {
              const button = node("button", undefined, "picker-item");
              button.type = "button";
              const img = node("img");
              img.src = "/api/admin/media/" + item.id + "/file";
              img.alt = item.title;
              img.loading = "lazy";
              button.append(img, node("span", item.title || item.filename));
              button.addEventListener("click", () => {
                chosen = true;
                resolve(item);
                view.close();
              });
              return button;
            }),
          );
          note.textContent = pictures.length
            ? "私有图片也可选择，保存配置后生效。"
            : "这页没有图片。可换个关键词、翻页，或先去图床上传。";
          prev.disabled = offset === 0;
          next.disabled = offset + page.limit >= page.total;
        } catch (error) {
          if (version === serial) {
            note.textContent = humanError(error);
            prev.disabled = offset === 0;
            next.disabled = true;
          }
        }
      }
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        query = input.value.trim();
        offset = 0;
        load();
      });
      prev.addEventListener("click", () => {
        offset = Math.max(0, offset - 24);
        load();
      });
      next.addEventListener("click", () => {
        offset += 24;
        load();
      });
      load();
    });
  }
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (
      !link ||
      event.defaultPrevented ||
      link.target === "_blank" ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.button !== 0
    )
      return;
    const url = new URL(link.href);
    if (url.pathname === location.pathname && url.search === location.search)
      return;
    if (busy) {
      event.preventDefault();
      return;
    }
    if (dirty && !confirm("有未保存的修改，确定离开当前页面？"))
      event.preventDefault();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      document.dispatchEvent(new CustomEvent("firefly:save"));
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty || busy) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  const session = api("/api/admin/session")
    .then((value) => {
      const el = document.getElementById("who");
      if (el) el.textContent = value.email;
      return value;
    })
    .catch((error) => {
      const el = document.getElementById("who");
      if (el) el.textContent = humanError(error);
      return null;
    });
  window.Mob.firefly = {
    node,
    setDirty,
    mediaId,
    previewUrl,
    humanError,
    modal,
    chooseImage,
    session,
  };
})();
