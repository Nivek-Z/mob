# 仓库是配置来源

维护前阅读 [平台守则](PLATFORM.md) 和 [主题协议](THEMES.md)：文本配置写 GitHub，媒体资源写 R2；公共资料、社交链接和友链统一管理；主题自行定义专属配置与前台/后台实现。


推荐全程控制台部署：见 [云端环境变量部署](CLOUD-DEPLOY.md)。下文仓库配置/本地引导仍可用；云端构建参数优先覆盖仓库默认值。

可版本化的配置放进 GitHub，Cloudflare 执行这些声明。前端编译命令也由仓库决定，不需要每换一次框架就在 Cloudflare 面板改一遍。

## 配置归属

| 内容 | 文件或位置 |
| --- | --- |
| 云端/CI 构建 Node 版本 | .node-version |
| 前端模式、依赖安装命令、编译命令、输出目录 | `mob.config.json` |
| Worker 名称、入口、构建入口、ASSETS/R2/MUTATIONS binding、SQLite DO exports、运行变量 | `wrangler.jsonc` |
| Access/R2 等基础设施的同步目标 | `config/cloudflare.json` |
| 文章与元数据 | `content/posts/*.md` |
| 自动代码验证 | `.github/workflows/ci.yml` |
| GitHub PAT | Worker runtime Secret `GITHUB_TOKEN` |
| Cloudflare 资源管理令牌 | 终端 CLOUDFLARE_API_TOKEN，云端 Build Secret CLOUDFLARE_SYNC_TOKEN；不提交仓库 |
| 私有仓库查询令牌 | Build Secret GITHUB_BOOTSTRAP_TOKEN，仅 Contents: read |
| Cloudflare Worker 部署令牌 | Builds 自带部署凭证，与 SYNC 管理令牌独立 |
| 本地开发变量与令牌 | 忽略的 `.dev.vars` |

不要在 Cloudflare 面板再维护另一份同名运行变量：下一次 Wrangler 部署以仓库的 vars 为准。Secret 的值不属于公开配置，部署脚本不把它们写入 GitHub。

## 前端配置

```json
{
  "schemaVersion": 1,
  "frontend": {
    "mode": "auto",
    "installCommand": ["npm", "ci"],
    "buildCommand": ["npm", "run", "build"],
    "outputDirectory": "dist"
  }
}
```

- `auto`：有 `frontend/package.json` 则执行安装与构建；没有则直接复制。
- `raw`：始终复制 `frontend/`，不安装依赖、不编译。
- `build`：必须有 `frontend/package.json`，执行指定命令并复制输出目录。
- `installCommand` 可以是 null，表示跳过安装；默认 npm ci 在没有锁文件时会退回 npm install。建议提交锁文件以固定版本。
- `buildCommand` 是“可执行程序 + 参数”的数组。需要多步流水线时，在前端 package.json 中定义脚本，再让这里调用它。
- `outputDirectory` 相对 `frontend/`，必须是其子目录，比如 `dist` 或 `build`。

命令通过无 shell 的 spawn 执行，不把配置拼成 shell 字符串。Windows 上 npm/npx 映射到 Node 执行对应 CLI；其他 batch 文件需改为 exe 或 `["node", "path/to/cli.js", "..."]`。

不要填写 `"npm run build && ..."` 这类字符串，也不要在命令参数中放凭证。自定义安装/编译命令由仓库内容控制，应只在可信代码分支部署。

构建复制会拒绝 symlink/junction、输出目录越界，清理前核对目标确实是本仓库 `dist/client`。README、AGENTS、隐藏文件、node_modules 不上传。空前端只生成说明文本资源，首页会返回 404，直到你放入页面。

## Cloudflare 构建入口

Cloudflare Workers Builds 使用：

| 项目 | 值 |
| --- | --- |
| 连接仓库 | Nivek-Z/mob |
| 生产分支 | main |
| 根目录 | 仓库根目录 |
| Build command | npm run check && npm test |
| Deploy command | npm run deploy:cloudflare |

本地 npm run deploy/dev 使用 Wrangler 的 `build.command = "node scripts/build.mjs"`。[官方 Builds 说明](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#build-settings)指出，云端不自动遵循 Wrangler custom builds，所以 deploy:cloudflare 显式执行仓库 build.mjs，再执行 wrangler deploy；Wrangler 会按自身配置再次运行 build.command。两条路径都读取 mob.config.json，换框架或输出目录只需改仓库。

Cloudflare Builds 的命令和触发筛选由 config/cloudflare.json 声明，再由同步脚本写入平台。Build command 验证代码；部署 wrapper 显式执行仓库前端构建。GitHub Actions 的 CI 只负责验证，不持有生产部署或 GitHub 写入令牌。

## 第一次引导与外部状态

账号、GitHub 连接授权、域名归属及 Secret 的值无法仅靠公开仓库声明生成。首次需要你授权 Cloudflare 管理令牌/连接 GitHub、确定域名和管理员邮箱，然后按 [部署文档](DEPLOYMENT.md) 同步资源、设置 runtime Secret 并连接 Builds。

首次用基础设施同步脚本读取配置并 dry-run/apply；Access AUD 等平台 id 回写运行配置。完成 Builds 引导后，每次云端部署的 wrapper 自动应用声明。修改只提交仓库，避免另在面板维护重复值。

域名路由、预览入口和 Access 覆盖范围都要与最终域名一致。正式部署前将占位值替换为真实值；当前默认生产配置会拒绝占位 Access 登录。

## 官方参考

- [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)：云端部署入口、根目录、build 与 runtime 变量的区别。
- [Wrangler 自定义构建](https://developers.cloudflare.com/workers/wrangler/custom-builds/)：仓库 build.command 的执行方式。
- [Static Assets 配置](https://developers.cloudflare.com/workers/static-assets/binding/)：前端资源目录和 Worker 优先路由。


## 每次提交的自动闭环

```text
GitHub main 提交
  → Cloudflare Builds 检查代码与测试
  → npm run deploy:cloudflare
      → cloudflare-sync --apply --resources-only（R2、Access）
      → node scripts/build.mjs（读取 mob.config.json）
      → wrangler deploy（运行变量、静态资产、Worker、SQLite DO）
      → cloudflare-sync --apply（Builds 自身配置）
```

首次引导先同步资源、用 npm run deploy 创建 Worker、完成 GitHub App/构建令牌授权，再完整同步 Builds；后续由上述流水线执行。

云端注入独立 CLOUDFLARE_SYNC_TOKEN 管理资源。wrapper 只在同步子进程中将它映射为 CLOUDFLARE_API_TOKEN，Wrangler 和前端构建子进程保留原有部署环境，避免用资源管理令牌替换平台的部署令牌。私有仓库的身份核对另用 GITHUB_BOOTSTRAP_TOKEN；Worker runtime 的 GITHUB_TOKEN 不会自动成为构建环境变量。

凭证名字在代码/文档中声明，值必须在 Cloudflare 构建 Secret 与 Worker runtime Secret 中分别初始化。仓库不能自动批准 GitHub App 安装或凭空生成账号凭证。

所有步骤顺序执行，失败停止后续操作，已成功步骤不会自动回滚。同步不删除资源；更换 R2 桶名不会迁移旧媒体。新增/调整资源、管理员邮箱或 Builds 命令，提交对应配置即可在下一次云端部署中应用。

当 builds.enabled=false 时，完整同步会暂停已有所属 trigger 的全部分支自动触发，保留资源。暂停后将配置改回 true 的提交不会自行唤醒旧 trigger，需手动 cloudflare-sync --apply 或手动触发一次部署；恢复后继续按声明筛选。--resources-only 不修改 Builds。

构建会保留 dist/client 根目录，只清理经过路径检查的子项并重试短暂文件占用，兼容 Windows 本地开发的目录 watcher；旧资源不会残留。

主题注册及可编辑文档在 frontend/themes.json 与各主题 theme.json 声明；公共资料、导航和图库分类由 config/site、config/gallery 共用管理。声明规则和扩展自由见 THEMES.md。声明默认值/Schema不能与可编辑文件重叠，构建拒绝缺失入口、不安全路径和未匹配的媒体种子摘要。
