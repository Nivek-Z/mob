# 前端预留位置

你的前端文件放在这个目录。项目不提供 UI，也不规定框架。

纯静态示例布局：

```text
frontend/
  index.html
  css/site.css
  js/site.js
  admin/index.html
  admin/editor.js
```

没有 `frontend/package.json` 时，默认把本目录的静态文件复制到 `dist/client/`。README、隐藏文件、node_modules 不发布。

使用框架时，在本目录提供 package.json、依赖锁文件和构建脚本，修改仓库根目录的 `mob.config.json`，指定构建命令和相对本目录的输出目录。后端只接受静态产物；SSR 需要另做适配。

管理界面放 `admin/` 下，并调用同域 `/api/admin/*`。公开界面调用 `/api/posts`。不要在前端代码里放 GitHub PAT、Cloudflare API token 或 R2 凭证。

完整代码示例及接口连接方法见 [docs/FRONTEND.md](../docs/FRONTEND.md)。

构建会保留 dist/client 根目录，只清理经过路径检查的子项并重试短暂文件占用，兼容 Windows 本地开发的目录 watcher；旧资源不会残留。
