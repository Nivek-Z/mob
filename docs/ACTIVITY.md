# GitHub 仓库活动

当前只接入 GitHub 仓库提交活动。热力图用于展示此博客所绑定仓库的代码足迹，不包含其他仓库、个人全站贡献或 OpenAI/Token 用量。

## 通用配置

配置统一保存在 `config/site/settings.json` 的 `activity`，两套主题的公共资料后台通过带 SHA 的 `/api/admin/settings/site` 写回，沿用 Access、Origin 和多文件原子提交保护。主题不保存另一份配置。

```json
{
  "enabled": true,
  "title": "代码足迹",
  "days": 365,
  "timezone": "Asia/Hong_Kong",
  "github": { "enabled": true, "title": "GitHub 提交活动" }
}
```

days 为 30–366，timezone 为有效 IANA 时区，两个标题非空且不超过 100 字符。未声明 activity 的旧配置默认关闭；关闭整个活动或 github 时，不抓取提交历史。仓库及分支来自 Worker 绑定的 `GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH`，浏览器不能指定其他仓库或提供 GitHub 凭据。

## 统计口径

- 显示截至请求时配置时区“今天”的连续 days 个自然日。按 commit.committer.date 转换时区，再按日归类。
- 读取绑定分支可达的提交历史，包含合并提交；不包含其他分支独有提交。同一次读取固定分支 HEAD，分页按 SHA 去重。
- 总提交、活跃天数、单日最高和最长连续天数均只针对显示区间，不宣称是历史累计或个人贡献数。
- 当前连续天数在今天无提交、昨天有提交时从昨天向前计算；昨天也无提交则为零。
- 空仓库可以显示真实零活动；权限、网络、分页上限和响应格式错误不能转换成零活动。

## 接口与缓存

`GET /api/activity` 返回 `{data:{enabled,title,timezone,range,github}}`。range 含 from/to/days；github 含 status、title、repository、branch、url、updatedAt、daily 和 stats。daily 是 `{date,count}` 数组。stats 含 total、activeDays、peakDaily、longestStreakDays、currentStreakDays。接口不输出提交消息、作者或凭据，不接受仓库覆盖参数。

status 为 `ok`、`stale`、`unavailable` 或 `disabled`。unavailable 时 daily/stats 为 null，前端显示读取失败与重试；disabled 不渲染图表。stale 保留缓存原来的统计区间与更新时间，前端必须提示“上次同步的数据”。

聚合缓存保存在私有 R2 `cache/github-activity/`，成功缓存有效 10 分钟；上游异常最多使用 24 小时内的旧统计，并显式标记 stale。失败重试间隔 60 秒。GitHub 配置读取仍以仓库为准，不能用旧缓存恢复已关闭的活动。缓存不可用时仍可返回即时统计；统计读取设置整体超时和 20 页上限（每页 100 条），超过上限返回 unavailable，不发布截断结果。

## 主题实现与验证

Firefly 使用自身的深浅色、圆角卡片与强调色；Paper 使用阅读排版和纸张色彩。两套首页显示热力图、统计卡片、仓库/分支、区间、时区和同步状态。可复用可选 `frontend/core/activity.js`，主题仍自由决定实现与样式。

方块支持触摸查看、鼠标提示和方向键导航，手机水平滚动保留全年布局。验证至少覆盖分页与去重、时区跨日、连续天数、禁用、缓存状态、权限与错误不伪造零数据，以及真实 workerd/R2 和两个主题的交互。
