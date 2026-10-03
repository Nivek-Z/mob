(function () {
  const params = new URLSearchParams(location.search);
  const who = document.getElementById("who");
  const list = document.getElementById("post-list");
  const form = document.getElementById("editor");
  const note = document.getElementById("note");
  const preview = document.getElementById("preview");
  const remove = document.getElementById("remove");
  const file = document.getElementById("file");
  const extraMedia = document.getElementById("media-refs");
  const fields = {
    title: document.getElementById("title"),
    slug: document.getElementById("slug"),
    description: document.getElementById("description"),
    tags: document.getElementById("tags"),
    cover: document.getElementById("cover"),
    markdown: document.getElementById("markdown")
  };
  let currentSha = null;
  let editing = "";
  let uploading = 0;
  let saving = false;
  let loading = true;
  let deleting = false;
  let dirty = false;
  let revision = 0;
  const escapeHtml = window.Mob.escapeHtml;

  function say(message, isError) {
    note.textContent = message || "";
    note.className = isError ? "note error" : "note";
  }
  function renderPreview() {
    const text = fields.markdown.value.replace(/(?:https?:)?\/\/[^\s<>"')\]]+|\/media\/[^\s<>"')\]]+/g, value => {
      const id = managedId(value); return id ? '/api/admin/media/' + id + '/file' : value;
    });
    preview.innerHTML = window.Mob.renderMarkdown(text);
    const cover = fields.cover.value.trim();
    const id = managedId(cover);
    const previewCover = window.Mob.safeUrl(id ? '/api/admin/media/' + id + '/file' : cover);
    if (previewCover) {
      const image = document.createElement("img"); image.className = "cover"; image.alt = "封面预览"; image.src = previewCover;
      preview.prepend(image);
    }
  }
  function syncActions() {
    form.inert = loading || deleting;
    form.querySelectorAll(".actions button").forEach(function (button) { button.disabled = loading || deleting || saving || uploading > 0; });
    Object.values(fields).forEach(function (field) { field.disabled = loading || deleting; });
    extraMedia.disabled = loading || deleting;
    fields.slug.readOnly = Boolean(editing) || saving;
    file.disabled = loading || deleting || saving || uploading > 0;
  }
  function detectedIds() {
    const found = (fields.markdown.value + "\n" + fields.cover.value).match(/(?:https?:)?\/\/[^\s<>"')\]]+|\/media\/[^\s<>"')\]]+/g) || [];
    const ids = [];
    found.forEach(function (item) {
      const id = managedId(item);
      if (id && ids.indexOf(id) < 0) ids.push(id);
    });
    return ids;
  }
  function collectIds() {
    return [...new Set([...extraMedia.value.split(/[,，\s]+/).filter(Boolean), ...detectedIds()])];
  }
  function managedId(value) {
    try { const url = new URL(value, location.origin); return url.origin === location.origin ? /^\/media\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/[^/]+$/.exec(url.pathname)?.[1] || null : null; }
    catch { return null; }
  }
  function fill(post) {
    editing = post ? post.slug : "";
    currentSha = post ? post.sha : null;
    fields.title.value = post ? post.title : "";
    fields.slug.value = post ? post.slug : "";
    fields.slug.readOnly = Boolean(post);
    fields.description.value = post ? post.description || "" : "";
    fields.tags.value = post ? (post.tags || []).join(", ") : "";
    fields.cover.value = post ? post.cover || "" : "";
    fields.markdown.value = post ? post.markdown || "" : "";
    const detected = new Set(detectedIds());
    extraMedia.value = (post?.mediaIds || []).filter(id => !detected.has(id)).join(", ");
    dirty = false; revision++;
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
  function enqueue(files) {
    if (loading || deleting || saving) return;
    files.forEach(function (blob) {
      const row = document.createElement('div'); row.className = 'upload-row';
      const label = document.createElement('span'); const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.hidden = true;
      row.append(label, retry); document.getElementById('upload-queue').append(row);
      const run = window.Mob.uploadTask(blob, 'editor', function (percent, stage) { label.textContent = blob.name + ' · ' + stage + ' ' + percent + '%'; });
      let running = false;
      async function attempt() {
        if (running || loading || deleting || saving) return; running = true;
        retry.hidden = true; uploading++; syncActions();
        try {
          const record = await run();
          const markdown = (record.contentType.startsWith('image/') ? '![' : '[') + record.filename + '](' + record.url + ')';
          const box = fields.markdown; const at = box.selectionStart;
          box.setRangeText(markdown, at, box.selectionEnd, 'end');
          if (!fields.cover.value && record.contentType.startsWith('image/')) fields.cover.value = record.url;
          renderPreview(); dirty = true; revision++; label.textContent = record.filename + ' · 已插入文章插图';
        } catch (error) { label.textContent = blob.name + ' · ' + error.message; retry.hidden = false; }
        finally { running = false; uploading--; syncActions(); }
      }
      retry.addEventListener('click', attempt); attempt();
    });
  }
  const queue = document.createElement('div'); queue.id = 'upload-queue'; file.closest('.editor-toolbar').after(queue);
  window.Mob.bindDrops(fields.markdown, enqueue);
  fields.markdown.addEventListener('input', renderPreview);
  fields.cover.addEventListener('input', renderPreview);
  file.addEventListener('change', function () { enqueue(Array.from(file.files || [])); file.value = ''; });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (loading || deleting || uploading || saving) { say("请等待当前操作完成。"); return; }
    const status = event.submitter && event.submitter.dataset.status || "draft";
    const slug = fields.slug.value.trim();
    const tags = fields.tags.value.split(/[,，]/).map(function (item) { return item.trim(); }).filter(Boolean);
    say("正在保存…");
    const submittedRevision = revision;
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
      dirty = revision !== submittedRevision;
      currentSha = result.post.sha;
      editing = result.post.slug;
      fields.slug.value = result.post.slug;
      fields.slug.readOnly = true;
      remove.hidden = false;
      document.getElementById("mode").textContent = result.post.status === "published" ? "已发布" : "草稿";
      say(dirty ? "已保存提交时的内容。后续修改尚未保存。" : status === "published" ? "已发布。" : "草稿已保存。");
      history.replaceState(null, "", "/admin/?slug=" + encodeURIComponent(result.post.slug));
      return loadList();
    }).catch(function (error) {
      say(error.code === "POST_CONFLICT" ? "文章已被改过。重新打开后再保存，当前内容先留在页面上。" : error.message, true);
    }).finally(function () { saving = false; syncActions(); });
  });
  remove.addEventListener("click", function () {
    if (loading || deleting || saving || uploading || !editing || !confirm("删除这篇文章及页面上的未保存修改？媒体对象会保留。")) return;
    deleting = true; syncActions();
    window.Mob.api("/api/admin/posts/" + encodeURIComponent(editing), {
      method: "DELETE",
      json: { sha: currentSha }
    }).then(function () {
      dirty = false; deleting = false;
      location.href = "/admin/?new=1";
    }).catch(function (error) { say(error.message, true); }).finally(function () { deleting = false; syncActions(); });
  });

  form.addEventListener('input', () => { dirty = true; revision++; });
  window.addEventListener('beforeunload', event => { if (dirty || uploading || saving || deleting) { event.preventDefault(); event.returnValue = ''; } });
  syncActions();
  window.Mob.api("/api/admin/session").then(function (session) {
    who.textContent = session.email;
    return loadList().then(openRequested);
  }).catch(function (error) {
    who.textContent = error.message || "还没有登录。";
    form.hidden = true;
  }).finally(function () { loading = false; syncActions(); });
})();
