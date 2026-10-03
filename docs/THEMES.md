# 主题接入协议 v1

平台边界见 [PLATFORM.md](PLATFORM.md)。主题自行设计前台、后台与专属配置；协议只规定身份、路由、可编辑文件、公共 API与权限。

## 注册清单

`frontend/themes.json` 包含 `schemaVersion: 1`、`defaultTheme`、`allowVisitorSwitch` 和 `themes`。每项含唯一 `id`、`name`、相对 frontend 的 `root`（如 `themes/firefly`）及 `enabled`。ID使用小写字母、数字、连字符；路径不能含上级目录或链接。

每个 root 提供 `theme.json`，包含 `schemaVersion: 1`、匹配的 id、`routes` 与 `configs`。routes 将站内路径映射为主题内部 HTML，如 `/` → `index.html`、`/admin/` → `admin/index.html`。至少提供首页和管理入口；不能覆盖 API与媒体路径。管理 HTML即使通过资产直达也需要鉴权。

## 自由配置

configs 是主题自定义的文档数组，每项含 `id`、`label`、`path`，可含 `defaultPath` 与 `schemaPath`。可编辑 path 为主题 `config/` 内的 JSON；内部子目录、字段和根结构自由。可选 JSON Schema 仅校验数据，不强制生成管理表单；无 Schema 也校验合法 JSON、大小、路径和媒体引用。

保存目标为 `frontend/<root>/<path>`。主题自己的管理界面可以实现普通表单、可视化编辑或 JSON 编辑。默认配置随主题提供；恢复默认也携带当前 SHA。Schema 与默认文件不能被当作自由保存目标。

配置文件最多 512 KiB；每套主题最多 8 个配置文档、最多 8 套主题，全站最多 31 个主题配置文档。字段与 JSON 根结构仍由主题自己决定。

配置请求为 `{ sha, value, mediaIds? }`，value 原样保存，不注入后端保留字段。mediaIds 登记不能从 URL 识别的额外引用；管理 GET 也只返回这些额外引用，避免已移除 URL 的旧自动引用被再次提交。后端将自动与额外引用合并，在同目录 `<name>.references.json` 侧文件中记录（此文件不能声明为编辑目标），与配置原子提交。

公共资料、社交/友链、导航、文章封面与图库分类由核心管理，主题仅决定展示；不要在主题独有配置中建立重复副本。全部公开配置不能包含秘密。

## 公共接口

- `/api/site` 与 `/api/admin/settings/site`：共用资料、社交链接、友链和导航。
- `/api/activity`：绑定仓库与分支的按日提交统计；设置属于公共资料的 `activity`。主题自行呈现热力图与统计卡片，遵守 [ACTIVITY.md](ACTIVITY.md) 的缺失/缓存状态和日期口径。
- `/api/themes`：可用主题、默认主题；访客选择使用 theme 查询参数和 mob-layout Cookie。
- `/api/themes/<id>/config/<document>` 与 `/api/admin/themes/<id>/config/<document>`：读写主题配置。
- `/api/posts`、`/api/admin/posts`：核心文章模型与封面。
- `/api/gallery`、`/api/gallery/categories`：公开图库；管理接口位于 `/api/admin/gallery`。
- `/api/admin/uploads`：R2上传；`/media/<id>/<filename>`：稳定链接；`/api/admin/media/<id>/file`：私有预览。

注册表编辑、图库管理和配置保存的完整请求结构见 API.md。主题后台自己实现文章编辑、图库、公共设置和自身设置，通过同域接口保存。

## 浏览与部署

首页提供图库入口与主题选择；选择只影响访客，后台设置全站默认。所有选择经过注册列表校验，按主题返回的 HTML不能被共享缓存混用。明暗配色是主题内部设置。

运行时配置通过 API读取；注册清单、源码、静态资源和入口变化需 Cloudflare 构建部署。注册只允许已安装的本地主题，不加载任意网络代码。框架应输出静态文件，SSR不属于本协议。

## 内置媒体种子（可选）

`theme.json` 可额外声明 `bundledMedia: [{filename,path,sha256,contentType}]`。path 位于主题 `assets/images/`，仅支持 JPEG/PNG/GIF/WebP/AVIF，单文件最多 16 MiB；构建验证 SHA-256。公开入口 `/theme-media/<id>/<filename>` 将已部署种子惰性写入私有 R2，再从 R2 读取，原始种子路径不能通过 Worker 直接访问。种子是部署初始化材料，R2 是运行时对象存储；新增自定义媒体用图床 API。已注册主题的种子可供公共头像等共用配置使用，停用布局不会移除这些公共资源。

后台与配置 UI无统一样式要求。两个内置主题分别实现自己的页面与设置表单；主题可复用传输助手，也可以完全不用 `frontend/core/`。

后台脚本与专属资产通过 `/admin/assets/<theme>/<file>` 加载，Worker 将其映射到主题 admin/；这样沿用现有 `/admin/*` Access 范围即可注入 JWT。原始 `/themes/<id>/admin/` 直达同样经过 Worker 鉴权，但主题 HTML应使用 canonical 管理资产地址，避免未覆盖的网关路径造成 401。
