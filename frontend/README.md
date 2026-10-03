# 前端与主题

先阅读 [平台守则](../docs/PLATFORM.md)、[主题协议](../docs/THEMES.md) 和本目录 `AGENTS.md`。GitHub 保存文本配置，R2 保存图片、音频和视频；个人资料、社交链接、友链、导航、文章封面及图库分类全站共用。

`themes.json` 声明可用主题、默认主题和访客切换。每个主题在 `themes/<id>/` 提供自己的 `theme.json`、静态前台、`admin/` 管理界面与 `config/`。主题自由决定字段、表单、技术栈和动效；`core/` 只是可选的同域 API、上传、Markdown 和公共信息读取助手，不是唯一后台模板。

目前有两套完整主题：`firefly`（萤火小屋，个人展示、碎片拼合首屏与滚动叙事）和 `paper`（纸间，排版与阅读）。访客通过首页选择器切换整套前台和后台，明暗模式由主题自行决定。两套后台均提供文章、图床、公共资料及自身配置管理。

`npm run build` 检查主题路由、可编辑文件边界和媒体种子摘要，再复制到 `dist/client/`。README、AGENTS、隐藏文件与 node_modules 不发布；不要直接修改 dist。框架项目通过 `mob.config.json` 输出完整静态目录，仍需保留主题声明。

主题自带图片作为部署种子，在 `/theme-media/<id>/<filename>` 第一次读取时写入 R2，以后从 R2 提供。原始 `assets/images/` 入口被 Worker 阻止。自定义图片从后台上传图床，把稳定 URL 保存到对应配置即可。图床上传不进入 GitHub。

新主题接入步骤、接口和验证要求见 [THEMES.md](../docs/THEMES.md)、[FRONTEND.md](../docs/FRONTEND.md)。参考素材与解析器许可保留在 Firefly 的 `assets/` 中。

仓库活动来自共用 `/api/activity` 和 `config/site/settings.json`，两套首页分别使用自身样式呈现每日提交与区间统计，可选助手为 `core/activity.js`。统计状态、日期和后台字段规则见 [ACTIVITY.md](../docs/ACTIVITY.md)；不能把上游故障显示为零提交。

图床后台通过 `/api/admin/gallery/storage` 发现 R2 中未登记素材。可选 `core/storage.js` 负责扫描、私有预览及显式纳入，主题定义面板样式；纳入前派发可取消的 `mob:gallery-storage-before-import`，成功后派发 `mob:gallery-storage-import`，用于保护未保存输入并刷新图库。主题/旧文件创建副本，保留原文件；历史上传保留原 ID。
