# 共用资料

settings.json 是所有主题共用的站点名称、介绍、个人资料、社交链接、友链及导航。后台经 /api/admin/settings/site 保存，带当前 SHA；媒体使用 R2 稳定 URL。主题不能保存另一份社交/友链数据。不要写秘密。遵守 ../../docs/PLATFORM.md。

activity 声明 GitHub 仓库活动：enabled、title、days（30–366）、timezone（IANA 时区）和 github.enabled/title。数据来源由 Worker 的 GITHUB_OWNER、GITHUB_REPO、GITHUB_BRANCH 固定，不接受访客指定仓库或令牌。未声明时默认关闭。两套主题均在公共资料设置中编辑，保存写回本文件；统计与缓存规则见 ../../docs/ACTIVITY.md。
