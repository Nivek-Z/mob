# HTTP API

同域地址：`https://你的博客域名`。本地默认 `http://localhost:8787`。接口路径不随前端框架变化，JSON 为 UTF-8。

## 通用规则

成功：

```json
{"data":{"status":"ok"}}
```

错误：

```json
{
  "error": {"code":"POST_CONFLICT","message":"Article changed; reload before saving."},
  "requestId": "用于定位请求的 UUID"
}
```

所有响应携带 `X-Request-Id`。error.details 在部分错误中包含结构化提示。二进制媒体 GET/HEAD 直接返回文件，不套 JSON。HEAD 没有响应体。

`/api/admin/*` 需要管理员登录。生产浏览器经 Access 登录后，同域 fetch 会发送会话 Cookie，Access 传递 JWT，Worker再次验证并核对邮箱。所有后台写操作必须携带与 `SITE_ORIGIN` 相等的 Origin；浏览器同域写请求自动发送。curl 等非浏览器调试需要自己设置 Origin 和有效 Access JWT。

不提供用户名密码注册、登录 API；先在浏览器打开 `/admin/` 完成 Access 登录。本地可使用开发 Bearer 令牌，仅限 development + localhost/回环地址。默认不开放跨域 CORS，前端和 API 部署在同域。

不要在浏览器中配置 GitHub PAT 或 Cloudflare API token。

## 公开接口

| 方法 | 路径 | data |
| --- | --- | --- |
| GET | `/api/health` | `{"status":"ok"}`，只表示 Worker 可响应，不检查 GitHub/R2/Access 配置 |
| GET | `/api/posts` | `{items,total,limit,offset}`，已发布文章元数据，不含正文和 SHA |
| GET | `/api/posts/:slug` | 已发布单篇正文；不含 SHA；草稿和不存在的文章均为 404 |
| GET / HEAD | `/media/:id/:filename` | 至少被一篇已发布文章引用的文件；否则 404 |

列表参数：

| 参数 | 默认/范围 | 行为 |
| --- | --- | --- |
| limit | 20；1–100 | 每页数量 |
| offset | 0；0–500 | 偏移量 |
| tag | 不筛选 | 标签精确匹配，区分大小写 |
| q | 不筛选；最多 200 字符 | 标题、描述、Markdown 正文的子串搜索，不区分大小写 |

`total` 是筛选后的文章数量。列表按首次发布时间倒序，时间相同按 slug 排序。公开接口从当前 GitHub HEAD 读取，只输出 published。

## 管理文章

| 方法 | 路径 | data |
| --- | --- | --- |
| GET | `/api/admin/session` | `{email,subject}` |
| GET | `/api/admin/posts` | `{items: Post[]}`，含草稿、正文与 SHA，按 updatedAt 倒序 |
| GET | `/api/admin/posts/:slug` | 最新 Post，编辑前获取 SHA |
| PUT | `/api/admin/posts/:slug` | `{post:Post,commitSha}`；新建 201，更新 200 |
| DELETE | `/api/admin/posts/:slug` | `{commitSha}` |

slug 必须为 1–80 个小写字母、数字、短横线，首尾为字母或数字，例如 `my-first-post`。对应 GitHub 文件 `content/posts/my-first-post.md`。

PUT 请求：

```json
{
  "sha": null,
  "title": "第一篇文章",
  "markdown": "你好。\n\n![照片](https://blog.example.com/media/00000000-0000-4000-8000-000000000001/photo.webp)",
  "status": "draft",
  "description": "摘要",
  "tags": ["日常"],
  "cover": null,
  "mediaIds": ["00000000-0000-4000-8000-000000000001"]
}
```

示例 UUID 仅展示格式，实际必须用已完成上传返回的 id。新建必须 `sha:null`；更新必须使用最新 GET 返回的 SHA。不要把 Post 对象直接原样 PUT，它还含有服务器字段。

| 字段 | 必填/默认 | 约束 |
| --- | --- | --- |
| sha | 必填 | 新建 null；更新 40 位十六进制 GitHub blob SHA |
| title | 必填 | 非空，最多 200 字符 |
| markdown | 必填 | 字符串；UTF-8 最多 512 KiB；除 tab/CR/LF 外禁止控制字符 |
| status | 必填 | draft 或 published |
| description | 默认空字符串 | 最多 2000 字符 |
| tags | 默认 [] | 最多 20 个唯一非空标签，每个最多 64 字符 |
| cover | 默认 null | 绝对 HTTP(S) URL，最多 2048 字符，不能带用户名/密码 |
| mediaIds | 默认 [] | 最多 200 个唯一 UUID v4；必须都已完成上传 |

未知字段会拒绝。保存会验证 mediaIds，且自动收集正文/封面里属于本站 `/media/<id>/<filename>` 的媒体 id；前端仍应显式维护 mediaIds。合并后的引用最多 200 个，否则 422 TOO_MANY_MEDIA_REFERENCES。稳定 URL 的文件名必须与上传记录一致，否则 INVALID_MEDIA_URL（路径不匹配为 422，非法 URL 编码为 400）。后台预览 URL 写进正文会返回 422 PRIVATE_PREVIEW_LINK。

服务器管理时间字段：新建 createdAt；每次保存 updatedAt；第一次发布设置 publishedAt，转草稿及重新发布保留首次发布时间。尚未发布的草稿 publishedAt 为 null。

DELETE 请求：

```json
{"sha":"当前 GitHub blob SHA"}
```

SHA 不匹配或发生并发更新时返回 409 POST_CONFLICT。重新 GET、展示新旧内容并由用户决定如何合并，再用新 SHA 保存；不要自动覆盖。删除文章不会同时删除媒体。

## Post 结构

管理员的 Post 包含：

```text
slug, sha, title, markdown, description, tags, status,
createdAt, updatedAt, publishedAt, cover, mediaIds
```

createdAt/updatedAt/publishedAt 使用 ISO 8601 UTC 字符串，publishedAt 可以为 null。公开单篇去掉 sha，公开列表再去掉 markdown。YAML front matter 的具体格式由后端管理，前端提交 JSON 即可。

## 上传与媒体管理

| 方法 | 路径 | 请求/结果 |
| --- | --- | --- |
| POST | `/api/admin/uploads` | JSON `{filename,contentType,size}`；201 + UploadSession |
| GET | `/api/admin/uploads/:id` | UploadSession |
| DELETE | `/api/admin/uploads/:id` | 取消未完成上传；`{aborted:true}` |
| PUT | `/api/admin/uploads/:id/body` | 原始文件字节；MediaRecord；只适用 single |
| PUT | `/api/admin/uploads/:id/parts/:number` | 原始分片字节；`{partNumber,etag}`；只适用 multipart |
| POST | `/api/admin/uploads/:id/complete` | JSON `{}`；MediaRecord；服务器自行收集 ETag |
| GET | `/api/admin/media?cursor=...` | `{items:MediaRecord[],cursor:string|null}` |
| DELETE | `/api/admin/media/:id` | 无请求体；`{deleted:true}` |
| GET / HEAD | `/api/admin/media/:id/file` | 私有文件预览，可用于未发布文章 |

上传 body 是 Blob/ArrayBuffer，不是 FormData 或 Base64 JSON。支持 JPEG、PNG、GIF、WebP、AVIF、MP4、WebM，对应 Content-Type：image/jpeg、image/png、image/gif、image/webp、image/avif、video/mp4、video/webm。扩展名应与类型匹配；无扩展时自动添加，文件名会规范为 ASCII。文件头有基础检查。

默认最大文件 1 GiB，由 MAX_MEDIA_BYTES 配置；本实现上限 5 GiB。上传会话 24 小时过期，过期需重新创建。所有文件都经 Worker 分片写入 R2，没有浏览器可用的 R2 长期密钥。

UploadSession：

```json
{
  "id":"上传/媒体 UUID",
  "key":"media/<uuid>/<filename>",
  "filename":"photo.webp",
  "contentType":"image/webp",
  "size":12345,
  "owner":"Access subject",
  "createdAt":"2026-10-02T00:00:00.000Z",
  "expiresAt":"2026-10-03T00:00:00.000Z",
  "mode":"single",
  "partSize":8388608,
  "partCount":1,
  "url":"https://blog.example.com/media/<uuid>/photo.webp"
}
```

multipart 另含 uploadId（R2 标识，前端不用解析）。小于等于 8 MiB 使用 single，PUT /body 成功后已完成；可再次调用 /complete 取得同一记录。大于 8 MiB 使用 multipart：

1. 按 partSize=8 MiB 切分，分片编号从 1 起。
2. 除末片外必须恰好 partSize 字节，末片必须等于剩余字节数。
3. 全部分片成功后 POST /complete，正文为 {}。无需提交 ETag 列表。
4. 若返回 409 UPLOAD_INCOMPLETE，details.missingParts 给出缺失编号，补传后再次完成。

可以并行传不同分片，不要同时重试同一编号。会话 GET 不含已传分片状态；恢复上传可顺序重传已知分片，再 complete。single/body 和 complete 支持完成后重试；已完成的 multipart 分片接口会返回 UPLOAD_ALREADY_COMPLETED。

MediaRecord：

```text
id, key, filename, contentType, size, owner, createdAt, url
```

url 是写进正文的稳定 URL。key/owner 仅供后台元数据使用。列表每页最多 25 条，cursor 是不透明游标，下一次传回即可；null 表示结束，不代表有精确总条数。

任何文章（含草稿）仍引用媒体时，DELETE 返回 409 MEDIA_IN_USE，details.articles 列出文章 slug。先编辑文章解除引用再删除。取消上传不适用于已完成媒体，应调用媒体删除接口。

文件读取支持 GET、HEAD、单区间 Range、If-None-Match 和 If-Range。206 带 Content-Range；不合法或越界 Range 返回 416。公开媒体当前不做长期浏览器缓存，撤回发布后下次请求重新检查发布状态。

## 常见错误

| HTTP | code 示例 | 前端处理 |
| --- | --- | --- |
| 400 | INVALID_INPUT、INVALID_QUERY、INVALID_SLUG、INVALID_SHA | 修正输入 |
| 401 / 403 | 登录令牌失效、邮箱未授权、写入 Origin 不符 | 打开 /admin/ 登录；检查站点 origin 配置 |
| 404 | POST_NOT_FOUND、MEDIA_NOT_FOUND、UPLOAD_NOT_FOUND | 对象不存在或未公开 |
| 409 | POST_CONFLICT | 重新读取，处理内容冲突 |
| 409 | MEDIA_IN_USE | 先解除文章引用 |
| 409 | UPLOAD_INCOMPLETE | 补传缺失分片 |
| 410 | UPLOAD_EXPIRED、UPLOAD_CLOSED | 创建新上传会话 |
| 413 | BODY_TOO_LARGE、MEDIA_TOO_LARGE | 缩小文件或检查大小配置 |
| 415 | JSON_REQUIRED、UNSUPPORTED_MEDIA_TYPE | 修正 Content-Type/文件类型 |
| 422 | MEDIA_NOT_READY、PRIVATE_PREVIEW_LINK、INVALID_MEDIA_URL、TOO_MANY_MEDIA_REFERENCES、INVALID_POST_CONTENT | 完成上传、使用完整稳定 URL，或减少媒体引用 |
| 502 / 503 | GITHUB_UNAVAILABLE、GITHUB_ACCESS_DENIED、GITHUB_RATE_LIMITED、MEDIA_STORAGE_ERROR、COORDINATOR_NOT_CONFIGURED | 保留编辑内容稍后重试；管理端检查配置 |
| 503 | GITHUB_REQUEST_FAILED | Worker 无法启动 GitHub 请求，查看运行日志与调用方式 |
| 504 | GITHUB_TIMEOUT | GitHub 请求超时，保留内容后重试 |

上游错误经过脱敏，不返回 PAT。GitHub 索引最多 500 篇，源文件总大小与序列化索引大小分别最多 32 MiB，超过返回 POST_INDEX_TOO_LARGE，不静默截断。公开仓库也需要 runtime GITHUB_TOKEN（GraphQL 批量读取不能匿名）。文章 PUT/DELETE、媒体 DELETE 由全局 SQLite Durable Object 协调，前端接口不变；缺绑定时返回 COORDINATOR_NOT_CONFIGURED。GET 健康检查通过不能证明外部服务或协调器可写。

GraphQL 读取按文章数量和源文件字节数共同分批，给 JSON 转义预留空间。GitHub 请求失败日志只记录错误类别、HTTP 方法及上游状态码，不记录凭据、响应正文或原始异常消息。

机器可读规范见 [openapi.yaml](openapi.yaml)。
