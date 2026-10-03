# 部署与日常维护

维护前阅读 [平台守则](PLATFORM.md) 和 [主题协议](THEMES.md)：文本配置写 GitHub，媒体资源写 R2；公共资料、社交链接和友链统一管理；主题自行定义专属配置与前台/后台实现。


推荐全程控制台部署：见 [云端环境变量部署](CLOUD-DEPLOY.md)。下文仓库配置/本地引导仍可用；云端构建参数优先覆盖仓库默认值。

## 当前状态

仓库提供 Worker 代码、前端预留目录、构建配置、Cloudflare 资源同步脚本、CI 和接口文档。邮箱与域名尚未确定，当前配置保留占位值。

没有 Cloudflare 账号管理凭证时，资源同步只能 dry-run；本地测试和 Wrangler dry-run 不是生产部署。请按下面步骤完成一次引导。之后修改前端、代码和可版本化配置都通过仓库进行，无需本地服务器常驻。

## 1. GitHub 仓库与运行凭证

项目仓库是 `Nivek-Z/mob`，文章目录 `content/posts`，默认分支 main。

创建 fine-grained PAT：

- Resource owner：Nivek-Z。
- Repository access：只授权 mob。
- Repository permissions：Contents → Read and write。
- 设置有效期，过期前轮换 Worker Secret。

PAT 让 Worker 在运行时读取/保存 Markdown。列表使用 GraphQL 批量读取，公开仓库也必须配置这个 runtime GITHUB_TOKEN，不能依赖匿名 GitHub 读取。SSH 密钥只让你的开发环境拉取/推送 Git，不会自动赋予 Worker GitHub API 权限。Cloudflare GitHub App 的仓库构建授权也是另一层权限。

如仓库或分支保护规则禁止 PAT 直接提交，需调整为允许该凭证身份提交文章，或后续实现 PR 发布流程；当前 API 直接写配置分支。

不要将 PAT 放在 frontend、wrangler vars、mob.config.json、Cloudflare Builds 的编译变量里。它的最终位置是 Worker runtime Secret `GITHUB_TOKEN`。

## 2. 填仓库配置

编辑 `wrangler.jsonc` 中的 vars：

| 配置 | 要填什么 |
| --- | --- |
| SITE_ORIGIN | 最终博客 origin，例如 https://blog.example.com，无子路径、查询参数 |
| ADMIN_EMAILS | 具体管理员邮箱；多个以逗号分隔 |
| ACCESS_TEAM_DOMAIN | Zero Trust 团队域名，如 my-team.cloudflareaccess.com，不含 https:// |
| ACCESS_AUD | 先留占位；资源同步创建/更新 Access 应用后回写 |
| GITHUB_OWNER / REPO / BRANCH | 默认 Nivek-Z / mob / main |
| POSTS_DIRECTORY | 默认 content/posts |
| APP_ENV | 生产始终 production |
| INDEX_CACHE_SECONDS | 同一 GitHub commit 的索引缓存时间，默认 30；0 关闭缓存 |
| MAX_MEDIA_BYTES | 默认 1073741824（1 GiB），代码上限 5 GiB |

`r2_buckets[0].bucket_name` 默认 mob-media。不用 S3 API key，只用 MEDIA binding。

编辑 `config/cloudflare.json`：填写 Cloudflare accountId；Access 应用参数、Builds trigger 参数、分支/路径筛选及命令都在此文件。R2 桶名、域名、邮箱、团队域名从 wrangler.jsonc 读取，不在两处重复维护。

自定义域名可在 wrangler.jsonc 声明：

```json
"routes": [
  { "pattern": "blog.example.com", "custom_domain": true }
]
```

域名必须归你所有并按 Cloudflare 的要求接入账号。域名注册和区域接入不是本脚本自动购买/授权的部分。Wrangler 部署管理上述 route；资源同步负责 R2、Access 和 Builds。

先确定 SITE_ORIGIN 再正式上传媒体，返回的永久 URL 包含它。以后换域名时保留旧地址重定向，或迁移文章中的媒体链接。

## 3. Cloudflare 一次性引导

在 Cloudflare 启用 R2 与 Zero Trust。选择邮箱验证码或你的身份提供方。资源同步生成 Access 的具体邮箱 Allow policy，但首次启用团队/身份提供方仍需账号设置。

在 Workers Builds 的 GitHub 连接入口授权 Cloudflare GitHub App 访问 Nivek-Z/mob。账号级连接授权不能由公开仓库替你完成。

创建 Cloudflare 管理 API token，通过终端环境/CI Secret 注入 `CLOUDFLARE_API_TOKEN`。令牌限定到本账号，完整同步需要 Workers Builds Configuration Edit（API 名 Workers CI Write）、Workers Scripts Read、Workers R2 Storage Edit、Access: Apps and Policies Edit（API 名 Write）。如果同一令牌还用于 npm run deploy，将 Workers Scripts 升为 Edit。仅 --resources-only 需要 R2 和 Access 权限，不需要 Builds 权限；不需要 Cloudflare Pages 权限。不把 token 值写进配置。

Builds 使用自己的 user-scoped build token。它与当前终端用的 CLOUDFLARE_API_TOKEN、Worker 的 GITHUB_TOKEN 都不同。如果完整同步需要 `buildTokenUuid`，先在 Worker Settings → Builds → API token 选择/创建部署 API token，然后把其非秘密 UUID 填入 config/cloudflare.json；脚本也会尝试复用已存在 trigger 的 build token。不要填 token 明文。

私有仓库同步需要查询仓库身份，另用只授权 mob、Contents: read 的 PAT，注入 `GITHUB_BOOTSTRAP_TOKEN`。它与 Worker 写入用的 GITHUB_TOKEN 分开；不会写入仓库。同步脚本兼容旧的 GITHUB_TOKEN 环境变量作为回退，但新配置推荐独立只读令牌。

## 4. 预览并同步资源

仓库根目录运行：

```sh
npm ci
node scripts/cloudflare-sync.mjs --dry-run
```

dry-run 默认不请求网络、不创建资源，列出声明和占位项。默认无参数也是 dry-run。

首次尚未部署 Worker，用：

```sh
node scripts/cloudflare-sync.mjs --apply --resources-only
```

创建/更新私有 R2 桶及 Access 应用/邮箱策略。Access 覆盖：

```text
/admin
/admin/*
/api/admin
/api/admin/*
```

只保护管理入口，公开文章与媒体路径保持读者可访问。应用的 AUD 与 account_id 会回写 wrangler.jsonc，确认后提交这些非秘密配置。

脚本拒绝匹配到别的站点或别的仓库的资源，拒绝 R2 公共 r2.dev/对象域名配置，不执行资源删除。它不能替代账号级 GitHub App 连接或自动获得部署凭证。

## 5. 首次 Worker 部署与 Secret

完成资源同步后部署：

```sh
npm run deploy
npx wrangler secret put GITHUB_TOKEN
```

Secret 命令从交互输入接收 PAT，勿把值直接写在命令行或提交。也可以在 Worker 的 Settings → Variables and Secrets 添加 secret 类型 GITHUB_TOKEN；这是运行环境 Secret，不是 Builds 的编译 secret。

首次本地 Worker 部署读取 Wrangler custom build，再依据 mob.config.json 构建前端，同时部署 MUTATIONS → BlogMutations 的 SQLite Durable Object（wrangler exports 声明）。当前没有 UI，所以首页可能 404；`/api/health` 应能返回 JSON。

添加前端后仍使用 npm run deploy 或通过 GitHub 云端构建，不需要单独上传 dist。Windows 若 PowerShell 执行策略拦截 npm/npx，可改用 npm.cmd/npx.cmd。

## 6. 同步 Builds

首次 Worker 已存在、GitHub App 已授权、build token 已准备后：

```sh
node scripts/cloudflare-sync.mjs --apply
```

完整同步把声明的仓库、分支/路径筛选、build/deploy 命令和 Worker 连接写入 Cloudflare Builds；不自动触发首次构建，之后推送 main 或在控制台触发发布。默认配置：

| 配置 | 值 |
| --- | --- |
| 仓库 | Nivek-Z/mob |
| 生产分支筛选 | main |
| Root directory | /（仓库根目录） |
| Build command | npm run check && npm test |
| Deploy command | npm run deploy:cloudflare |
| 前端构建入口 | wrangler.jsonc build.command → scripts/build.mjs → mob.config.json |

仓库 .node-version 声明构建 Node 版本，GitHub CI 与 Cloudflare Builds 读取它；更换 Node 版本也通过仓库提交。Build command 验证代码。deploy:cloudflare 顺序执行：同步 R2/Access → 显式 node scripts/build.mjs → wrangler deploy → 同步 Builds 自身配置。

[Workers Builds 官方配置说明](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#build-settings)指出，它不自动遵循 Wrangler custom builds，所以 wrapper 显式执行仓库构建脚本，仍由 mob.config.json 决定前端编译命令和输出目录。本地 npm run deploy 继续使用 Wrangler custom build。

以后改框架只需修改 frontend 与 mob.config.json；修改邮箱策略、R2 绑定、云端构建/触发命令，提交对应配置即可在下一次部署时同步。若修改触发分支/路径筛选，需要一次原有规则会触发的提交，或手动运行同步。builds.enabled=false 会在完整同步后暂停自动触发；再改 true 需要手动同步/触发一次，才能恢复。

在 Cloudflare Builds 的 Build variables and secrets 初始化：

| 名字 | 用途 |
| --- | --- |
| CLOUDFLARE_SYNC_TOKEN | 用户级资源管理 token，允许本账号 R2/Access/Builds 配置写入及 Worker Scripts Read；不要假设平台部署 token 已有这些权限 |
| GITHUB_BOOTSTRAP_TOKEN | 私有仓库身份查询的 Contents: read PAT；公开仓库可不填 |

平台 Builds API token 继续负责部署 Worker；wrapper 只给资源同步子进程映射 SYNC_TOKEN，不替换 Wrangler 的部署 token。本地 wrapper 可回退使用 CLOUDFLARE_API_TOKEN；直接运行 cloudflare-sync.mjs 时仍用 CLOUDFLARE_API_TOKEN。

Worker Settings → Variables and Secrets 的 GITHUB_TOKEN 是运行时 Secret，必须另外设置；它与上面的 Build Secret 互不共享。GitHub App 安装授权、部署 token 和 Secret 的值都需要一次外部初始化，仓库只保存配置及需要的名字。

GitHub Actions CI 是只读验证（Contents: read），不持有生产 PAT，也不另建发布流程。Cloudflare Builds 是唯一自动发布流程。只给可信分支部署权；wrapper 失败会停止后续步骤，已成功步骤不会自动回滚，修复后重试。

如果你选择只用控制台创建连接，也要使用同样的配置并保持与仓库声明一致；避免下次同步被仓库值覆盖。

## 7. 域名与权限检查

使用最终域名验证公开 API、后台登录、文章保存和媒体上传。所有请求由 Worker 验证，公开媒体允许已发布文章、有效配置引用或显式图库公开。

Worker 默认开启 workers.dev 与 preview_urls 方便首次部署。它们不自动继承自定义域名的 Access 登录入口；Worker 的 JWT 校验会拒绝未经认证的后台请求。正式运行建议在仓库关闭这两个入口，或给每个仍启用的入口配置相同 Access 保护。不要为绕过登录把 APP_ENV 改成 development。

未配置 Access 时管理接口返回 503 CONFIGURATION_REQUIRED；没有页面时 /admin/ 完成鉴权后可能仍是 404。后端已预留这一入口，页面由对应 frontend/themes/<id>/admin/ 提供。

## 8. 验收一次完整流程

1. 匿名 GET /api/posts 能读取已发布列表，读取草稿返回 404。
2. 匿名访问 /admin/ 触发 Access 登录，后台 API 不能写入。
3. 用管理员邮箱登录，GET /api/admin/session 返回正确身份。
4. 上传图片，保存 draft，GitHub content/posts 出现只有媒体链接的 Markdown。
5. 草稿媒体的公开 URL 返回 404，后台预览可读。
6. 改为 published，公开正文和图片可读；视频播放器能请求 Range。
7. 同时打开两个编辑窗口，旧 SHA 保存应返回 409，不能静默覆盖。
8. 仍有文章引用的媒体不能删除；解除全部引用后可删。
9. 撤回发布后公开媒体重新检查当前 GitHub HEAD；读者已下载到本地的文件无法收回。
10. 把前端修改推送 main，确认 Cloudflare Builds 日志成功，静态页面更新。

## 日常维护

文章正文是 GitHub 权威数据，R2 私有索引按当前 commit SHA 缓存。每次公开列表/媒体授权先检查最新 GitHub HEAD，不会因为旧的 30 秒缓存重新公开已撤回文章。索引缓存不替代 GitHub 可用性；GitHub 限流时可能影响公开读取。当前索引上限 500 篇，文章源文件总大小与序列化索引大小都分别限制为 32 MiB。批量 GraphQL 读取降低外部请求数量，但上限不代表任意文章规模都能满足免费计划 CPU 限额；验证包括 mock 与本地 Wrangler，没有声称已做生产环境远程负载/性能验收。

R2 的 .mob/ 前缀是后端元数据，不作为媒体路径公开。可给 .mob/index/ 配置短期 lifecycle 清理旧 commit 的缓存。不要自动清理整个 .mob/uploads/：终态记录用于阻止延迟重试重新完成已取消/已删除上传。取消/失败的 multipart 用 API 终止，超时临时对象按 R2 lifecycle 管理。

更新 GitHub PAT 或管理员邮箱后部署并检查登录。从 R2 删除媒体会影响历史文章，先解除引用。GitHub 提供文章版本记录，但不等于 R2 媒体备份；需要媒体备份时另配置备份流程。

这套项目调用 Worker、R2 和 GitHub API，具体请求/存储/构建费用按账号套餐计费；资源与页面先经过 Worker，不能把全部访问都按“仅静态资源免费”估算。

## 官方参考

- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents)：仓库内容读写权限与 SHA。
- [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)：runtime Secret 与本地开发 Secret。
- [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) / [Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)。
- [Cloudflare 构建镜像与 .node-version](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。
- [Wrangler 自定义构建](https://developers.cloudflare.com/workers/wrangler/custom-builds/) / [Durable Object exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)。
- [Access 路径规则](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) / [JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)。

现有主题后台入口无需新增 Access范围：其脚本通过 /admin/assets/<id>/ 加载。主题切换、图床及配置新增功能仍使用已有 MEDIA和 MUTATIONS 绑定，不需要新的对象桶或数据库。保存配置写 GitHub，注册表/源码变更会按原 Builds 触发规则部署。
