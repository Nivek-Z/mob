# 配置归属

`site/settings.json` 保存共用资料、社交链接、友链和导航；`gallery/categories.json` 保存图库分类。所有主题共用。`cloudflare.json` 是基础设施声明，不允许运行时后台修改。

主题独有配置在 `frontend/themes/<id>/config/`。全部文本配置以 GitHub 为准，上传资源字节位于 R2。媒体引用侧文件由后端与配置原子提交，不向主题的自由配置注入保留字段。

详见 [平台守则](../docs/PLATFORM.md) 与 [主题协议](../docs/THEMES.md)。
