# 配对认证验收记录

日期：2026-09-07。测试使用独立 `zero-pairing-test` Compose 项目和合成工作区；未更新现有服务，未连接真实邮箱或发送邮件。

| 检查                                                                   | 结果                                                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 前端生产构建，`ZERO_COMPOSE_BUILD=true pnpm --filter @zero/mail build` | 通过；另对本次 Git 提交快照独立构建通过                                                                                                    |
| 服务端 Wrangler dry-run bundle                                         | 通过；提交快照独立构建通过，没有发布到 Cloudflare                                                                                          |
| `deploy/tests/pairing.mjs`                                             | 通过：禁用密码入口、来源校验、私密值绑定、批准／拒绝／过期、轮询限流、并发一次性兑换、Cookie 和原生 Bearer、立即撤销、重启、恢复           |
| `deploy/tests/pairing-migration.mjs`                                   | 通过：无需登录密码配置、多工作区歧义时停止并保留状态、明确选择原用户 ID、保留原数据、旧会话只失效一次                                      |
| `deploy/tests/pairing-https.mjs`                                       | 通过：进程级信任合成证书、HTTPS 二维码来源、Secure／HttpOnly Cookie、HTTP 与 HTTPS Cookie 隔离；没有关闭 TLS 验证                          |
| `deploy/tests/pairing-browser.cjs`，Chromium 与 WebKit                 | 均通过：桌面与手机尺寸、二维码渲染、刷新恢复待配对请求、首台设备终端授权、扫码仅预填、用户明确批准、设备撤销；最终测试使用提交快照构建产物 |
| `deploy/tests/smoke.mjs`，独立测试服务                                 | 通过：跨设备同一工作区、Cookie 属性、私有通知接口、注册禁用、SPA 路由                                                                      |
| `deploy/tests/persistence.mjs`，独立测试服务                           | 通过：重启 API、PostgreSQL、Redis 和 Web 后保留会话及设置                                                                                  |
| 桌面端 `npm test`                                                      | 8 项通过                                                                                                                                   |
| 移动端 `npm test`                                                      | 7 项通过，包括已有附件和资源准备检查                                                                                                       |
| `pairing-auth-policy.test.ts`                                          | 通过：匿名／已登录请求均不能使用密码、社交登录、手机号、邮件验证和 JWT 入口；邮箱连接回调需要已配对会话                                    |
| `native/apple`，Swift 6.0 Linux `swift test`                           | 5 项通过：来源校验、原生配对与不透明令牌、按服务器隔离、撤销后清理凭据、离线退出行为                                                       |
| 提交快照 `oxlint@1.9.0 --deny-warnings`                                | 475 个文件，0 warning、0 error                                                                                                             |

浏览器测试使用 1280×900 和 390×844 视口。WebKit 在隔离 Playwright 容器内执行，通过本地网络转发访问合成测试服务。它验证浏览器兼容性，不等同于 iPhone／iPad 真机验收。

苹果 SwiftUI 和 Security.framework 分支尚未在当前 Linux 环境编译或进行真实 Keychain 验证。新增 `apple-auth.yml` 提供 macOS 测试及 iOS／iPadOS、watchOS 模拟器编译流程，该远程工作流尚未运行。本次交付是共用认证模块和登录界面，完整苹果邮件应用工程仍需后续适配。

仓库全量 `tsc --noEmit` 仍有 Env 类型、Outlook 驱动和聊天等既有模块的错误；本次新增认证文件未出现类型错误。工作区整体 lint 还会命中另一个未提交 Android 附件文件中的 `alert`，因此本次代码在独立提交快照中运行同一 lint 检查和提交钩子，未修改或夹带该附件文件。

重跑方式见 [部署文档](README.zh-CN.md#验证)和[认证说明](AUTHENTICATION.zh-CN.md)。HTTPS 测试需为 `localhost` 生成临时证书，放在 `/tmp/zero-pairing-tls/{fullchain.pem,privkey.pem}`，使用 `compose.pairing-https.yaml` 覆盖文件启动，并以 `NODE_EXTRA_CA_CERTS=/tmp/zero-pairing-tls/fullchain.pem node deploy/tests/pairing-https.mjs` 运行。重建前端资源后，应重新创建测试 Web 容器以更新目录挂载。
