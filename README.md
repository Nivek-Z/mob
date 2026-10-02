# mob

GitHub 保存文章，Cloudflare Workers 提供 API 和前端静态托管，私有 R2 保存图片与视频。登录和管理员权限由 Cloudflare Access + Worker 校验完成。

本项目不绑定前端框架，也没有生成编辑器 UI。你可以直接提交 HTML/CSS/JS，或使用能输出静态文件的任意前端工具。文章和代码都在这个仓库，文章目录为 `content/posts/`。

## 目录

```text
frontend/                你维护的前端源码
content/posts/           GitHub 文章 Markdown（由 API 写入）
src/                     Worker API、鉴权、GitHub/R2 服务
mob.config.json          前端构建模式、命令、输出目录
wrangler.jsonc           Worker、运行配置、资源绑定、构建入口
config/cloudflare.json   Cloudflare 基础设施声明
scripts/                 构建与基础设施同步脚本
docs/                    接口、部署、架构、前端接入文档
dist/client/             生成的静态文件，不提交 GitHub
```

推荐部署方式：[全程 Cloudflare 控制台部署](docs/CLOUD-DEPLOY.md)，配置与 Secret 在构建环境填写，无需本地 PowerShell。

## 先阅读

- [架构与数据流](docs/ARCHITECTURE.md)：文章、媒体、鉴权如何协作。
- [声明式配置](docs/DECLARATIVE.md)：哪些配置由仓库管理，哪些是外部秘密。
- [部署说明](docs/DEPLOYMENT.md)：GitHub / Cloudflare 的首次设置与后续部署。
- [前端接入](docs/FRONTEND.md)：纯 HTML/CSS/JS 放哪里、登录、保存与上传示例。
- [API](docs/API.md) / [OpenAPI](docs/openapi.yaml)：请求、响应、权限、错误和约束。

## 开发与验证

需要 Node.js 22 或更新版本；仓库 .node-version 固定 CI 与 Cloudflare Builds 的默认构建 Node 版本。

```sh
npm ci
npm run verify
```

本地调试把 `.dev.vars.example` 复制成 `.dev.vars`，填写本地开发令牌和 GitHub PAT，再运行：

```sh
npm run dev
```

默认使用本地 R2 模拟数据。GitHub API 仍会操作配置指定的真实仓库与分支；调试文章写入建议另设测试分支。`.dev.vars` 已忽略，不能提交。

生产默认关闭开发登录绕过。邮箱、域名和 Access 参数还需要替换占位值；配置与验证通过不代表 Cloudflare 账号中的资源已经创建或网站已经上线。
