# Nivek 个人博客前端

本目录提供可直接部署的 HTML/CSS/JS 静态页面。首页以个人展示为主，视觉和交互参考 [MmzMing/my-blog](https://github.com/MmzMing/my-blog) 的 Firefly-Mod，包括碎片拼合首屏、站点导览、场景揭示和五幕滚动叙事。手机使用独立个人介绍和纵向故事布局；减少动画模式关闭固定滚动和循环动效。

公开页通过同域 `/api/posts` 读取真实文章，写作台 `/admin/` 继续使用现有 Access 登录和管理 API。没有示例文章、虚构访问统计或第三方分析代码。Markdown 阅读与编辑预览使用本地 Marked 和 DOMPurify，支持表格、代码块、图片和站内媒体视频。

纯静态模式无需前端安装或编译。运行仓库根目录的 `npm run build` 会复制到 `dist/client/`；不要编辑生成目录。所有图片、样式和脚本均在本目录，不依赖 CDN。

个人介绍与场景文案位于 `index.html`、`about.html`，黑猫对话位于 `js/home.js`。主题由 `css/site.css` 管理，首页动效样式位于 `css/home.css`。GitHub 链接已设置为 `Nivek-Z`。

参考素材和许可见 `assets/Firefly-Mod-LICENSE.txt`；本地解析器许可见 `assets/marked-LICENSE.txt`、`assets/DOMPurify-LICENSE.txt`。未使用 Live2D 或 Spine 模型。

## 构建约定

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
