# 前端如何接入

## 文件放哪里

纯 HTML/CSS/JS 直接放仓库 `frontend/`：

```text
frontend/index.html         博客首页
frontend/css/site.css       公共样式
frontend/js/site.js         公共页面逻辑
frontend/admin/index.html   管理页面
frontend/admin/editor.js    编辑逻辑
```

默认不编译，部署时复制到 `dist/client/`。`frontend/admin/index.html` 对应 `/admin/`；`frontend/index.html` 对应 `/`。README、隐藏文件、node_modules 不发布。不要直接改 dist，它会在下一次构建被替换。

使用框架时，在 frontend 添加 package.json 与锁文件，通过 `mob.config.json` 配置安装、构建命令及输出目录。必须输出静态 HTML/CSS/JS；纯 CSR 或 SSG 都可以，SSR 不能直接放静态目录运行。默认前端 package 的 npm run build 输出 frontend/dist。

当前不提供 SPA history fallback：路径没有静态文件时返回 404。可以使用 hash 路由，或输出真实 HTML 路径。管理界面应放在 /admin/ 下，使 Access 和 Worker 的权限规则覆盖它。

## 登录与 fetch

管理员先在浏览器打开 `/admin/`。Access 登录成功后，前端调用 `/api/admin/session` 判断身份。管理 API 和前端同域，不需要手动保存 Access JWT。

下面代码可以放进你自己的 editor.js；它只是接入示例，项目不会自动生成 UI。

```js
// 生产留空。仅本地调试时填 .dev.vars 中的 DEV_AUTH_TOKEN。
// 不要把开发令牌提交到仓库或打包进生产前端。
let localDevToken = "";

async function api(path, { method = "GET", json, binary } = {}) {
  const headers = new Headers();
  if (localDevToken) headers.set("Authorization", "Bearer " + localDevToken);
  let body;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  } else if (binary !== undefined) {
    headers.set("Content-Type", "application/octet-stream");
    body = binary;
  }

  const response = await fetch(path, {
    method, headers, body, credentials: "same-origin"
  });
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("请打开 /admin/ 完成登录，然后重试。");
  }
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || "请求失败");
    error.status = response.status;
    error.code = payload.error?.code;
    error.details = payload.error?.details;
    error.requestId = payload.requestId || response.headers.get("X-Request-Id");
    throw error;
  }
  return payload.data;
}

const identity = await api("/api/admin/session");
console.log(identity.email);
```

不要用 fetch 模拟用户名密码登录。Access 可能将未登录 API 请求重定向到登录 HTML；上面 helper 会提示打开管理页面。写请求的 Origin 由浏览器自动设置，不在 JavaScript 中手工伪造。

## 粘贴或拖放媒体

把 input.files、drop 事件的 dataTransfer.files、paste 事件的 clipboardData.files 中的 File 交给上传函数。上传成功后用 MediaRecord.url 替换编辑器中的占位链接，用 MediaRecord.id 更新文章 mediaIds。

```js
async function uploadMedia(file, onProgress = () => {}) {
  const session = await api("/api/admin/uploads", {
    method: "POST",
    json: {
      filename: file.name,
      contentType: file.type,
      size: file.size
    }
  });
  const base = "/api/admin/uploads/" + encodeURIComponent(session.id);

  // 把 session.id 保存到编辑器临时状态，以便网络失败后重试或取消。
  if (session.mode === "single") {
    const record = await api(base + "/body", { method: "PUT", binary: file });
    onProgress(1);
    return record;
  }

  // 顺序上传示例，进度按已确认字节统计；避免把整个视频读到内存。
  for (let number = 1; number <= session.partCount; number++) {
    const start = (number - 1) * session.partSize;
    const end = Math.min(start + session.partSize, file.size);
    await api(base + "/parts/" + number, {
      method: "PUT",
      binary: file.slice(start, end)
    });
    onProgress(end / file.size);
  }
  return api(base + "/complete", { method: "POST", json: {} });
}

const record = await uploadMedia(file, progress => {
  console.log("上传进度", Math.round(progress * 100) + "%");
});
const imageMarkdown = "![" + record.filename + "](" + record.url + ")";
const videoMarkdown = "[" + record.filename + "](" + record.url + ")";
mediaIds = [...new Set([...mediaIds, record.id])];
```

如果 file.type 为空，先根据允许的文件类型确定 MIME，再创建会话。支持 JPEG/PNG/GIF/WebP/AVIF/MP4/WebM，详见 API。不要把多文件 FormData 直接交给 body 接口。

这个例子省略重试 UI。实际编辑器应保留正文、上传 id 和已完成的媒体记录：PUT 分片失败可重传该编号，complete 请求超时可重试；409 UPLOAD_INCOMPLETE 会告知缺失分片。24 小时过期后才重新创建会话。取消未完成会话：

```js
await api("/api/admin/uploads/" + uploadId, { method: "DELETE" });
```

上传成功但文章提交失败时保留 record，重新提交文章即可，不要再次上传同一文件。

## 草稿预览

草稿正文里的稳定媒体 URL 在发布前会返回 404，这是访问规则。编辑器预览时将展示地址换为：

```js
const previewUrl = "/api/admin/media/" + encodeURIComponent(record.id) + "/file";
```

生产同域图片/video 可以直接使用这个地址，Cookie 会随请求发送。永久正文仍使用 record.url，不能保存 previewUrl。

本地 Bearer 登录不能通过 img/video 的 src 自动附带 Authorization；可先带令牌 fetch 私有文件，再创建 Blob URL 用于预览，离开页面时 URL.revokeObjectURL。大视频本地预览也可以直接使用原始 File 的 Blob URL。

## 保存与再次编辑

新建时 sha=null；编辑已存在文章时先 GET 管理单篇，再使用返回的 sha。提交时仅发送接口接受的字段：

```js
const slug = "my-first-post";
let currentSha = null; // 编辑旧文章时取 GET 返回的 sha

async function saveArticle({ title, markdown, status, description, tags, cover, mediaIds }) {
  // 调用之前先 await 编辑器中的所有媒体上传并替换占位 URL。
  const result = await api("/api/admin/posts/" + encodeURIComponent(slug), {
    method: "PUT",
    json: { sha: currentSha, title, markdown, status, description, tags, cover, mediaIds }
  });
  currentSha = result.post.sha;
  return result.post;
}

// 再次编辑：
const post = await api("/api/admin/posts/" + encodeURIComponent(slug));
currentSha = post.sha;
```

status=draft 保存草稿，published 直接发布。保存会生成同仓库 content/posts/<slug>.md，不需要前端处理 Git、Base64 或 YAML。

409 POST_CONFLICT 表示其他窗口/提交改过文章。保留当前编辑内容，读取最新文章并让用户合并后再提交。不要获取新 SHA 后静默覆盖。

删除：

```js
await api("/api/admin/posts/" + encodeURIComponent(slug), {
  method: "DELETE", json: { sha: currentSha }
});
```

## 博客公开读取

```js
const page = await api("/api/posts?limit=20&offset=0");
console.log(page.items, page.total);

const article = await api("/api/posts/" + encodeURIComponent(slug));
document.querySelector("h1").textContent = article.title;
// article.markdown 用你选择的 Markdown 渲染器处理。
// 若渲染出 HTML，先用可信的 HTML 清理器过滤，再插入 DOM。
```

公开单篇提供 Markdown，不返回已渲染 HTML。原生 Markdown 视频链接默认是链接；可以让你的渲染器将受信任的媒体视频 URL 转成 video controls，或提供编辑器的视频组件。原生 video 使用稳定的 record.url，Range 请求由 API 支持。

GitHub/R2/Access 凭证始终留在云端。前端只需要同域 API 和返回的媒体 URL。全部字段、状态码和上传限制见 [API.md](API.md)。
