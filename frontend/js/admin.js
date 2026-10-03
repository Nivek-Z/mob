(function () {
  const params = new URLSearchParams(location.search);
  const who = document.getElementById("who");
  const list = document.getElementById("post-list");
  const form = document.getElementById("editor");
  const note = document.getElementById("note");
  const preview = document.getElementById("preview");
  const remove = document.getElementById("remove");
  const file = document.getElementById("file");
  const fields = {
    title: document.getElementById("title"),
    slug: document.getElementById("slug"),
    description: document.getElementById("description"),
    tags: document.getElementById("tags"),
    cover: document.getElementById("cover"),
    markdown: document.getElementById("markdown")
  };
  let currentSha = null;
  let mediaIds = [];
  let editing = "";
  let uploading = 0;
  let saving = false;
  const escapeHtml = window.Mob.escapeHtml;
  const types = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", mp4: "video/mp4", webm: "video/webm"
  };

  function say(message, isError) {
    note.textContent = message || "";
    note.className = isError ? "note error" : "note";
  }
  function renderPreview() {
    const text = fields.markdown.value.replace(/https?:\/\/[^)\s]+\/media\/([0-9a-f-]{36})\/[^)\s]+/gi, "/api/admin/media/$1/file");
    preview.innerHTML = window.Mob.renderMarkdown(text);
    const cover = fields.cover.value.trim();
    const previewCover = window.Mob.safeUrl(cover.indexOf("/media/") >= 0 ? cover.replace(/https?:\/\/[^/]+\/media\/([0-9a-f-]{36})\/[^?\s]+/i, "/api/admin/media/$1/file") : cover);
    if (previewCover) {
      const image = document.createElement("img"); image.className = "cover"; image.alt = "封面预览"; image.src = previewCover;
      preview.prepend(image);
    }
  }
  function syncActions() {
    form.querySelectorAll("button").forEach(function (button) { button.disabled = saving || uploading > 0; });
    file.disabled = saving || uploading > 0;
  }
  function collectIds() {
    const found = (fields.markdown.value + "\n" + fields.cover.value).match(/\/media\/([0-9a-f-]{36})\//gi) || [];
    const ids = mediaIds.slice();
    found.forEach(function (item) {
      const id = item.split("/")[2];
      if (ids.indexOf(id) < 0) ids.push(id);
    });
    return ids.slice(0, 200);
  }
  function fill(post) {
    editing = post ? post.slug : "";
    currentSha = post ? post.sha : null;
    mediaIds = post ? (post.mediaIds || []).slice() : [];
    fields.title.value = post ? post.title : "";
    fields.slug.value = post ? post.slug : "";
    fields.slug.readOnly = Boolean(post);
    fields.description.value = post ? post.description || "" : "";
    fields.tags.value = post ? (post.tags || []).join(", ") : "";
    fields.cover.value = post ? post.cover || "" : "";
    fields.markdown.value = post ? post.markdown || "" : "";
    document.getElementById("mode").textContent = post ? (post.status === "published" ? "已发布" : "草稿") : "新建";
    remove.hidden = !post;
    renderPreview();
  }
  async function loadList() {
    const data = await window.Mob.api("/api/admin/posts");
    list.innerHTML = data.items.map(function (post) {
      const badge = post.status === "published" ? "已发布" : "草稿";
      const kind = post.status === "published" ? "badge live" : "badge";
      return '<a href="/admin/?slug=' + encodeURIComponent(post.slug) + '">' + escapeHtml(post.title) + '<span class="' + kind + '">' + badge + "</span></a>";
    }).join("") || '<p class="quiet">还没有文章</p>';
  }
  async function openRequested() {
    const slug = params.get("slug");
    if (!slug) { fill(null); return; }
    fill(await window.Mob.api("/api/admin/posts/" + encodeURIComponent(slug)));
  }
  async function upload(blob) {
    const name = blob.name || "image";
    const ext = (name.split(".").pop() || "").toLowerCase();
    const contentType = types[ext] || blob.type;
    if (!contentType || !Object.values(types).includes(contentType)) throw new Error("只支持 jpeg、png、gif、webp、avif、mp4、webm。");
    say("正在上传…");
    const session = await window.Mob.api("/api/admin/uploads", {
      method: "POST",
      json: { filename: name, contentType: contentType, size: blob.size }
    });
    const base = "/api/admin/uploads/" + encodeURIComponent(session.id);
    let record;
    if (session.mode === "single") {
      record = await window.Mob.api(base + "/body", { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: blob });
    } else {
      for (let number = 1; number <= session.partCount; number += 1) {
        const start = (number - 1) * session.partSize;
        const end = Math.min(start + session.partSize, blob.size);
        await window.Mob.api(base + "/parts/" + number, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: blob.slice(start, end) });
      }
      record = await window.Mob.api(base + "/complete", { method: "POST", json: {} });
    }
    if (mediaIds.indexOf(record.id) < 0) mediaIds.push(record.id);
    const markdown = (contentType.indexOf("video/") === 0 ? "[" + record.filename + "](" : "![" + record.filename + "](") + record.url + ")";
    const box = fields.markdown;
    const at = box.selectionStart;
    box.value = box.value.slice(0, at) + markdown + box.value.slice(box.selectionEnd);
    if (!fields.cover.value && contentType.indexOf("image/") === 0) fields.cover.value = record.url;
    renderPreview();
    say("已插入 " + record.filename);
  }

  fields.markdown.addEventListener("input", renderPreview);
  fields.cover.addEventListener("input", renderPreview);
  file.addEventListener("change", function () {
    const chosen = file.files && file.files[0];
    file.value = "";
    if (chosen) {
      uploading += 1; syncActions();
      upload(chosen).catch(function (error) { say(error.message, true); }).finally(function () { uploading -= 1; syncActions(); });
    }
  });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (uploading || saving) { say("请等待当前上传或保存完成。"); return; }
    const status = event.submitter && event.submitter.dataset.status || "draft";
    const slug = fields.slug.value.trim();
    const tags = fields.tags.value.split(/[,，]/).map(function (item) { return item.trim(); }).filter(Boolean);
    say("正在保存…");
    saving = true; syncActions();
    window.Mob.api("/api/admin/posts/" + encodeURIComponent(slug), {
      method: "PUT",
      json: {
        sha: currentSha,
        title: fields.title.value.trim(),
        markdown: fields.markdown.value,
        status: status,
        description: fields.description.value.trim(),
        tags: tags,
        cover: fields.cover.value.trim() || null,
        mediaIds: collectIds()
      }
    }).then(function (result) {
      currentSha = result.post.sha;
      editing = result.post.slug;
      fields.slug.readOnly = true;
      remove.hidden = false;
      document.getElementById("mode").textContent = result.post.status === "published" ? "已发布" : "草稿";
      say(status === "published" ? "已发布。" : "草稿已保存。");
      history.replaceState(null, "", "/admin/?slug=" + encodeURIComponent(result.post.slug));
      return loadList();
    }).catch(function (error) {
      say(error.code === "POST_CONFLICT" ? "文章已被改过。重新打开后再保存，当前内容先留在页面上。" : error.message, true);
    }).finally(function () { saving = false; syncActions(); });
  });
  remove.addEventListener("click", function () {
    if (!editing || !confirm("删除这篇文章？图片不会一起删除。")) return;
    window.Mob.api("/api/admin/posts/" + encodeURIComponent(editing), {
      method: "DELETE",
      json: { sha: currentSha }
    }).then(function () {
      location.href = "/admin/?new=1";
    }).catch(function (error) { say(error.message, true); });
  });

  window.Mob.api("/api/admin/session").then(function (session) {
    who.textContent = session.email;
    return loadList().then(openRequested);
  }).catch(function (error) {
    who.textContent = error.message || "还没有登录。";
    form.hidden = true;
  });
})();
