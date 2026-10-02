# 全程在 Cloudflare 控制台部署

连接 Nivek-Z/mob GitHub 仓库，Worker 名 mob，分支 main，根目录 /。
Build command：npm run check && npm test；Deploy command：npm run deploy:cloudflare。
先在 Cloudflare 启用 R2 和 Zero Trust，并授权 Cloudflare GitHub App 访问 mob。

在 **Build variables and secrets（构建环境）** 填以下内容：

| 名字 | 类型 | 值 |
|---|---|---|
| CLOUDFLARE_ACCOUNT_ID | 普通变量 | 你的 32 位账户 ID |
| SITE_ORIGIN | 普通变量 | https://你的博客域名；也可以用已确定的 mob.账号子域.workers.dev 地址 |
| ADMIN_EMAILS | 普通变量 | 管理员邮箱；多个用逗号分隔 |
| ACCESS_TEAM_DOMAIN | 普通变量 | nivekz.cloudflareaccess.com |
| CLOUDFLARE_SYNC_TOKEN | Secret | 用户级 Cloudflare 管理令牌，需 R2 Storage Edit、Access Apps and Policies Edit、Workers Builds Configuration Edit、Workers Scripts Read |
| WORKER_GITHUB_TOKEN | Secret | GitHub fine-grained PAT：仅 mob，Contents Read and write |

Cloudflare Builds 平台的部署 API token 单独选择/创建，需 Workers Scripts Edit、R2 权限；自有域名还需目标 Zone Read 与 Workers Routes Edit。平台注入的部署 token 保持不变。
公开仓库不需 GITHUB_BOOTSTRAP_TOKEN；私有仓库额外设置这个只读 PAT 构建 Secret。
可选普通变量：R2_BUCKET_NAME、GITHUB_OWNER、GITHUB_REPO、GITHUB_BRANCH、POSTS_DIRECTORY、BUILDS_TRIGGER_NAME。不填则沿用仓库声明。

脚本在云端将参数映射到配置，创建私有 R2 / Access，自动取得 AUD，构建前端，并随首次部署将 WORKER_GITHUB_TOKEN 安装为运行时 GITHUB_TOKEN Secret。不需本地终端，也不需另手工添加运行时 PAT。生成配置只存在于本次构建工作目录，不回传仓库；密钥不写入配置，临时秘密文件完成或失败后删除。
首次从控制台连接产生唯一 Builds trigger 时，脚本核对它属于同一 Worker/GitHub 仓库后复用并同步仓库声明，不另建重复 trigger；有多个 trigger 时需指定 BUILDS_TRIGGER_NAME。

变量设置完成后触发部署；若连接时已开始构建，填写完变量再 Retry。检查 /api/health；当前没有前端，首页 404 正常。
以后推送 main 自动部署。控制台构建参数覆盖仓库默认值，构建命令、资源结构和前端编译流程仍由仓库代码定义。
不要仅在 Worker 运行时添加这些构建参数：构建与运行时环境相互独立。

官方：[Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)；[随部署上传 Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
