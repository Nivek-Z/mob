# 前端与主题

先阅读 [平台守则](../docs/PLATFORM.md)、[主题协议](../docs/THEMES.md) 和本目录 `AGENTS.md`。GitHub 保存文本配置，R2 保存图片、音频和视频；个人资料、社交链接、友链、导航、文章封面及图库分类全站共用。

`themes.json` 声明可用主题、默认主题和访客切换。每个主题在 `themes/<id>/` 提供自己的 `theme.json`、静态前台、`admin/` 管理界面与 `config/`。主题自由决定字段、表单、技术栈和动效；`core/` 只是可选的同域 API、上传、Markdown 和公共信息读取助手，不是唯一后台模板。

目前有两套完整主题：`firefly`（萤火小屋，个人展示、碎片拼合首屏与滚动叙事）和 `paper`（纸间，排版与阅读）。访客通过首页选择器切换整套前台和后台，明暗模式由主题自行决定。两套后台均提供文章、图床、公共资料及自身配置管理。

`npm run build` 检查主题路由、可编辑文件边界和媒体种子摘要，再复制到 `dist/client/`。README、AGENTS、隐藏文件与 node_modules 不发布；不要直接修改 dist。框架项目通过 `mob.config.json` 输出完整静态目录，仍需保留主题声明。

主题自带图片作为部署种子，在 `/theme-media/<id>/<filename>` 第一次读取时写入 R2，以后从 R2 提供。原始 `assets/images/` 入口被 Worker 阻止。自定义图片从后台上传图床，把稳定 URL 保存到对应配置即可。图床上传不进入 GitHub。

新主题接入步骤、接口和验证要求见 [THEMES.md](../docs/THEMES.md)、[FRONTEND.md](../docs/FRONTEND.md)。参考素材与解析器许可保留在 Firefly 的 `assets/` 中。
