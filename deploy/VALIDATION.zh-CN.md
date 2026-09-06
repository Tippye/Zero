# 本地部署与 Windows 验收

日期：2026-09-06。使用独立项目 `zero-compose-test` 和新生成的测试账号；未修改原有本机邮件服务，未向真实邮箱发送邮件，未推送远程。

环境：WSL Ubuntu、Docker Engine 29.1.3 / Compose 5.0.1；Windows 11（NT 10.0.22631），原生 Windows x64 构建并安装 Electron 44.2.0 / NSIS 客户端。

| 项目 | 结果与证据 |
| --- | --- |
| Compose 空库部署 | API、Web、同步任务、IMAP 桥接、PostgreSQL、Valkey、Redis HTTP 适配器成功启动；迁移和初始账号创建成功 |
| HTTP 与 HTTPS | 18080 / 18443 同时登录成功；HTTPS 使用本机测试证书、只在测试进程信任；两种协议 Cookie 分开，HTTPS 带 Secure |
| 多设备身份 | 两次独立登录得到同一工作区用户 ID |
| 网页使用 | Chromium 实际填写登录表单，跳转后保留写信参数；连接设置页面正常，未出现内部 IMAP 桥接 HTTPS 误拦截 |
| 重启持久化 | 重启数据库、缓存、API、桥接、同步和 Web 后，原有服务端会话和保存的用户设置仍可用；测试设置已恢复 |
| 通知后端 | 数据库模拟邮件验证首次历史导入抑制、近期未读收件事件、用户隔离、已读过滤；模拟记录已清理 |
| Windows 安装 | NSIS 在当前用户目录成功安装，路径含空格；生成安装程序和便携 ZIP |
| 原生通知 | Windows `Notification.isSupported()` 为 true；测试通知收到系统 show 事件；模拟新邮件经 API 轮询后也收到非测试的原生 show 事件 |
| 协议冷启动 | 按注册处理程序命令启动 `mailto:`；实际登录后写信页面显示测试收件人、主题和正文 |
| 协议热启动 | Windows Shell 打开 `zeromail:`，已有客户端跳转，实际输入框显示正确主题与收件人 |
| 关闭到托盘 | 关闭测试窗口后进程继续运行；`zeromail://inbox` 可再次唤起 |
| 默认邮件应用 | MAILTO ProgID、Capabilities、RegisteredApplications 和引号均检查通过；Windows 默认应用界面实际显示 Zero Mail 及 MAILTO 项；末次关联键为 ZeroMail.mailto，Windows Shell 直接打开 mailto 已唤起应用并进入写信页；客户端默认状态检测也返回 true；测试脚本未写入 UserChoice |
| 回归 | 桥接与同步共 51 项测试通过；协议解析与通知轮询测试通过；邮件阅读 AI、翻译及重试测试通过 |

以下没有宣称通过：真实供应商的 IMAP/SMTP/OAuth 收发（未提供本次专用测试邮箱）；其他第三方软件的邮件调用兼容性；Windows 通知中心中的人工点击、勿扰策略、重启 Windows 后自动启动。通知点击路径有单元测试，系统 show 事件不能替代点击验收。客户端未实现 MAPI/COM 或完整离线收发。安装程序未签名。

Compose 是单实例 workerd / Miniflare 部署；定时发送和延迟撤回在此模式关闭，后端拒绝定时请求。Cloudflare AI/Vectorize 和托管推送订阅不在本地复刻。以上边界也列在部署和客户端文档中。源码 lint 为 0 警告、0 错误；打包仍有上游 source map 定位、第三方 PURE 注释和包体大小提示，构建成功且浏览器验收未发现运行时错误。

## 复跑

先依照 [部署说明](README.zh-CN.md) 为独立测试项目配置 origin 和端口。以下测试默认使用 localhost:18080，不应对生产账号运行模拟数据测试。

```sh
node deploy/tests/smoke.mjs
ZERO_TEST_URL=https://localhost:18443 NODE_EXTRA_CA_CERTS=deploy/tls/fullchain.pem node deploy/tests/smoke.mjs
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome node deploy/tests/browser.cjs
node deploy/tests/notifications.cjs
node deploy/tests/persistence.mjs
node --test integrations/imap-bridge/test/*.test.mjs integrations/mail-sync/test/*.test.mjs
npm test --prefix native/desktop
pnpm dlx oxlint@1.9.0 --deny-warnings
```

Windows 安装后的注册检查见 [客户端说明](../native/desktop/README.zh-CN.md)。协议验收使用合成的 `example.invalid` 地址，不发送邮件。调试端口仅用于本机验收，结束后退出测试客户端，正常启动不带调试参数。

## 本次 Windows 产物 SHA-256

- `Zero Mail Setup 0.2.0.exe`：`4d3d770487fe14d06c446830f8a7edb218b301948685fbbd37a087cbac62c569`
- `Zero Mail-0.2.0-win.zip`：`8ea70be7a9088739e75929fdf729f9e19e3e15d7eb8ae0331d800caa6ea53f08`
