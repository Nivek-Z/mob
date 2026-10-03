# 测试维护约定

遵守根 AGENTS.md 与 docs/PLATFORM.md。所有 GitHub/Access 出站请求使用本地替身；不能使用生产凭据或操作真实文章、配置与媒体。

workerd 集成测试统一通过 runtime.test.ts 的 dispatchRequest 发送请求。它立即消费网络响应体，再保留字节、状态与头供断言；仅检查状态码也不能留下未读取的流。保持 MINIFLARE_ASSERT_BODIES_CONSUMED 检查开启。

清理必须 await Miniflare.dispose()，异常必须让套件失败。仅清理 hook 允许 30 秒，不能吞掉异常、跳过清理、缩减测试或全局放宽超时来掩盖泄漏。Cloudflare 构建日志的“所有测试通过”不等于整个套件成功，还须确认 hook 与构建退出码。

保持 Miniflare 版本和实际 workerd/R2/协调器覆盖；本地模拟禁止联网访问真实服务。修改构建相关测试后运行类型检查、完整测试和静态构建。
