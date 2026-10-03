# 测试维护约定

遵守根 AGENTS.md 与 docs/PLATFORM.md。所有 GitHub/Access 出站请求使用本地替身；不能使用生产凭据或操作真实文章、配置与媒体。

后台可编辑的 config/、content/gallery/ 与主题配置属于真实站点状态，不能直接作为场景的初始测试数据。使用 platform-fixtures.ts 和 test/fixtures/platform/ 的固定样本；非空图库、媒体引用、默认主题或开关状态由具体测试显式构造。真实主题代码、manifest、Schema 与媒体种子仍须验证。用户日常编辑不得改变测试默认预期。

workerd 集成测试统一通过 runtime.test.ts 的 dispatchRequest 发送请求。它立即消费网络响应体，再保留字节、状态与头供断言；仅检查状态码也不能留下未读取的流。保持 MINIFLARE_ASSERT_BODIES_CONSUMED 检查开启。

清理必须 await Miniflare.dispose()，异常必须让套件失败。仅清理 hook 允许 30 秒，不能吞掉异常、跳过清理、缩减测试或全局放宽超时来掩盖泄漏。Cloudflare 构建日志的“所有测试通过”不等于整个套件成功，还须确认 hook 与构建退出码。

保持 Miniflare 版本和实际 workerd/R2/协调器覆盖；本地模拟禁止联网访问真实服务。修改构建相关测试后运行类型检查、完整测试和静态构建。

仓库活动覆盖固定 HEAD 分页、时区归日、连续天数、配置禁用与 stale/unavailable；不能把上游异常伪装零提交。R2 发现/纳入覆盖私有预览、原 ID/原图保留、条件读取、默认私有及 GitHub 登记失败重试；真实 workerd 验证流式副本与原链接。两主题前端应验证键盘查看日期、公共配置写回以及未保存输入保护。
