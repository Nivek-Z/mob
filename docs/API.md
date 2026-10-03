# HTTP API

维护前阅读 [平台守则](PLATFORM.md) 和 [主题协议](THEMES.md)：文本配置写 GitHub，媒体资源写 R2；公共资料、社交链接和友链统一管理；主题自行定义专属配置与前台/后台实现。


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
| GET / HEAD | `/media/:id/:filename` | 已发布文章、有效配置引用或显式图库公开的文件；否则 404 |

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

编辑已有文章时，保留原 mediaIds 中不能从正文/封面自动识别的额外引用；只有显式移除时才删除它们。两个内置编辑器提供“额外媒体引用”输入框，自动 URL 引用随正文与封面重新计算。

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
| POST | `/api/admin/uploads/cleanup` | JSON `{cursor?}`；清理过期上传状态，返回 `{cleaned,expired,cursor}` |
| GET | `/api/admin/media?cursor=...` | `{items:MediaRecord[],cursor:string|null}` |
| DELETE | `/api/admin/media/:id` | 无请求体；`{deleted:true}` |
| GET / HEAD | `/api/admin/media/:id/file` | 私有文件预览，可用于未发布文章 |

上传 body 是 Blob/ArrayBuffer，不是 FormData 或 Base64 JSON。支持 JPEG、PNG、GIF、WebP、AVIF、MP4、WebM、MP3、WAV、Ogg/Opus、M4A，对应 Content-Type：image/jpeg、image/png、image/gif、image/webp、image/avif、video/mp4、video/webm、audio/mpeg、audio/wav、audio/ogg、audio/mp4。扩展名应与类型匹配；无扩展时自动添加，文件名会规范为 ASCII。文件头检查有界，不执行完整解码或转码。

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

url 是写进正文的稳定 URL。key/owner 仅供后台元数据使用；从 Git 恢复的记录可能没有 owner。旧媒体列表仅扫描 `.mob/media/`，每页最多 25 条；它不是完整图库，已登记项目应读取 `/api/admin/gallery`。cursor 是不透明游标，下一次传回即可；null 表示结束。

已登记素材的 ID、文件名、MIME、大小、创建时间和 URL 保存在 Git 图库。`.mob/media/` 记录缺失时，读取与删除会从 Git 恢复元数据，并核对 R2 对象的大小与已有 MIME；读取不写回记录，不改变公开授权。R2 文件本身缺失时仍返回 404。数据归属和清理规则见 [MEDIA-STORAGE.md](MEDIA-STORAGE.md)。

清理每次扫描最多四个上传目录，应一直传回 cursor 直到 null。已完成/已删除会话在原 24 小时有效期结束后移除辅助记录；取消状态至少保留取消后一天。过期未完成会话先取消，其状态再保留一天，防止迟到请求重新完成。`expired` 是本次取消数，`cleaned` 是本次移除辅助目录数。清理不会删除已完成的媒体文件、媒体记录或 Git 图库条目；也不提供定时任务。清理后旧会话 GET 返回 UPLOAD_NOT_FOUND，已完成文件仍通过媒体 ID 访问。

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
| 413 | BODY_TOO_LARGE、MEDIA_TOO_LARGE、POST_INDEX_TOO_LARGE | 缩小文件或文章索引，保留未保存内容 |
| 415 | JSON_REQUIRED、UNSUPPORTED_MEDIA_TYPE | 修正 Content-Type/文件类型 |
| 422 | MEDIA_NOT_READY、PRIVATE_PREVIEW_LINK、INVALID_MEDIA_URL、TOO_MANY_MEDIA_REFERENCES、INVALID_POST_CONTENT | 完成上传、使用完整稳定 URL，或减少媒体引用 |
| 502 / 503 | GITHUB_UNAVAILABLE、GITHUB_ACCESS_DENIED、GITHUB_RATE_LIMITED、MEDIA_STORAGE_ERROR、COORDINATOR_NOT_CONFIGURED | 保留编辑内容稍后重试；管理端检查配置 |
| 503 | GITHUB_REQUEST_FAILED | Worker 无法启动 GitHub 请求，查看运行日志与调用方式 |
| 503 | MEDIA_ABORT_FAILED | R2 取消分片失败，会话保留；重试取消或过期清理 |
| 504 | GITHUB_TIMEOUT | GitHub 请求超时，保留内容后重试 |

上游错误经过脱敏，不返回 PAT。GitHub 索引最多 500 篇，源文件总大小与序列化索引大小分别最多 32 MiB，超过返回 POST_INDEX_TOO_LARGE，不静默截断。公开仓库也需要 runtime GITHUB_TOKEN（GraphQL 批量读取不能匿名）。文章 PUT/DELETE、媒体 DELETE 由全局 SQLite Durable Object 协调，前端接口不变；缺绑定时返回 COORDINATOR_NOT_CONFIGURED。GET 健康检查通过不能证明外部服务或协调器可写。

文章 PUT 在提交前读取固定 HEAD 的文章快照，检查替换当前文章后的数量、源文件总大小与序列化索引大小。超限返回 413 POST_INDEX_TOO_LARGE，不写 Git；读取既有超限仓库仍返回 502。达到数量上限时仍可编辑已有文章；直接在 GitHub 写入造成的大小超限，可以通过缩小文章或删除文章恢复。

GraphQL 读取按文章数量和源文件字节数共同分批，给 JSON 转义预留空间。GitHub 请求失败日志只记录错误类别、HTTP 方法及上游状态码，不记录凭据、响应正文或原始异常消息。

机器可读规范见 [openapi.yaml](openapi.yaml)。

## 公共资料与主题配置

| 方法 | 路径 | 返回 / 保存位置 |
| --- | --- | --- |
| GET | `/api/site` | `{value}`；`config/site/settings.json` |
| GET | `/api/activity` | 共用仓库活动：`{enabled,title,timezone,range,github}`；不接受查询参数 |
| GET / PUT | `/api/admin/settings/site` | `{sha,value,mediaIds}` / `{sha,value,commitSha}` |
| GET | `/api/themes` | 已启用的注册清单；包含默认主题和访客切换开关 |
| GET / PUT | `/api/admin/themes` | `{sha,value}`；`frontend/themes.json`，修改需部署 |
| GET | `/api/themes/:id/config/:document` | `{value}`，仅启用主题 |
| GET / PUT | `/api/admin/themes/:id/config/:document` | `{sha,value,mediaIds,declaration}` / `{sha,value,commitSha}`；主题声明目录 |

PUT 请求仅接受 `{sha,value,mediaIds?}`；新文件 sha=null，已存在文件使用其当前 blob SHA。配置与 `<name>.references.json` 同 commit 保存。JSON 最多 512 KiB，嵌套最多 40 层，引用最多 200 个对象。`CONFIG_CONFLICT` 表示仓库或目标文件已变化；保留输入并重新加载合并。可选主题 JSON Schema 在 Workers 内校验，仅支持本地片段 `$ref`，不执行主题代码。

配置 GET 的 `mediaIds` 仅返回无法从当前配置中的本站媒体 URL 自动识别的额外引用。PUT 传回这些额外引用即可；后端会重新检测 URL，并把合并后的引用写入侧文件。删除头像等 URL 时，不要把旧的自动引用当作额外 ID 再提交，否则它仍是有效授权。

共用站点对象要求 `title/description/profile:{name,bio,avatar}/socials/friends`；链接项为 `{label,url}`，社交与友链允许 HTTP(S)、mailto。可选 navigation 数组包含 `{label,url}`，允许站内相对路径或 HTTP(S)。不接受用户名/密码 URL。更多非秘密字段可由核心扩展，不允许复制成主题专属社交/友链。

可选 activity 配置控制所有主题的 GitHub 仓库热力图；只统计绑定仓库与分支，不统计个人全站贡献。显示区间、时区、五项统计与 ok/stale/unavailable/disabled 状态的定义见 [ACTIVITY.md](ACTIVITY.md)。读取失败不能伪装零活动，不返回提交消息、作者或凭据。

## 图床

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/gallery` | `{items,total,limit,offset}`，仅公开且展示的项目 |
| GET | `/api/gallery/categories` | `{value:{items:[{id,name}]}}` |
| GET | `/api/admin/gallery` | 同上并含索引 `sha`，包括私有项目 |
| PATCH | `/api/admin/gallery` | `{sha,items:[{id,title?,description?,categoryId?,tags?,isPublic?,isListed?}]}` |
| POST | `/api/admin/gallery/items` | `{id,source?}`，幂等登记已完成 R2 对象；返回 `{item,sha,commitSha?}` |
| DELETE | `/api/admin/gallery/items/:id` | `{sha}`；检查全部文章和配置后删除展示记录与对象 |
| POST | `/api/admin/gallery/import` | `{cursor?}`，每次最多 25 个已有上传记录；保留原 ID，返回 `{imported,cursor,sha,commitSha?}` |
| GET | `/api/admin/gallery/storage` | `{cursor?}` 查询；扫描每页最多 100 个 R2 键，返回未登记的受支持素材 `{items,cursor}` |
| GET / HEAD | `/api/admin/gallery/storage/file?key=...` | 已发现素材的私有预览，支持 Range/ETag；拒绝内部和不支持的文件 |
| POST | `/api/admin/gallery/storage/import` | `{key,etag}`；校验当前对象并幂等纳入，返回 `{item,sha,commitSha?}` |
| GET / PUT | `/api/admin/gallery/categories` | `{sha,value}`，写回 `config/gallery/categories.json` |

列表参数为 `category/q/limit/offset`；limit 1–100 默认 40，offset 0–1000。管理界面每页 24 项。索引 `content/gallery/items.json` 最多 1000 项、512 KiB；一次 PATCH 最多 100 项，成功或失败整个提交保持一致。

source 为 editor/gallery/theme/import，默认为 gallery；editor 默认归入 `article-images`，其余默认 gallery。新上传默认 `isPublic:false/isListed:false`。公开稳定链接不要求展示；展示要求同时公开。已发布文章或有效配置引用仍可公开链接；草稿正文不会随图库公开。

分类 ID唯一；保留 `article-images`、`gallery` 两个默认 ID，可自由改显示名称。移除仍有项目的分类返回 `CATEGORY_IN_USE`。直接用旧 media DELETE 删除已登记项目返回 `GALLERY_MANAGED`，应使用图库删除接口。

图库登记失败可重试同一 ID。删除先保留可供重试的媒体记录、撤销 Git 图库记录，再删除 R2 管理对象；R2 删除失败时返回错误，可以携带当前图库 SHA 重试同一删除接口，也可从已有媒体导入继续处理。theme/legacy 的原始文件与链接保留。被文章（含草稿）或任何配置（含停用主题）引用时返回 `MEDIA_IN_USE`，details 给出 articles/configs。

R2 有字节不代表已经进入 GitHub 图床索引。storage 扫描只读，不自动登记或公开；排除 `.mob/`、`cache/`、进行中的上传与不支持的类型。某页 items 为空但 cursor 非空时应继续扫描。候选包含 key/etag/id/filename/contentType/size/createdAt/kind，kind 为 managed/theme/legacy。managed 保留原 ID；theme/legacy 创建有独立 ID 的受管理副本，保留原对象和链接。纳入时校验文件头及 ETag，对象变化返回 STORAGE_CONFLICT；默认私有不展示。复制完成而登记失败可重试，不重复复制。此接口仅管理员可用。

## 音频与媒体种子

上传额外支持 `audio/mpeg`（mp3）、`audio/wav`（wav）、`audio/ogg`（ogg/opus，保存为 ogg）、`audio/mp4`（m4a），均做有界文件头校验。上传会话 GET 在原字段外返回 `status` 及完成后的 `record`，便于网络中断后恢复。

`GET/HEAD /theme-media/:id/:filename` 为可选主题预置图入口：根据已部署 `bundledMedia` 声明验证种子摘要，写 R2 后提供。原始主题 `assets/images/` 路径返回 404；新用户上传使用普通媒体 API。
