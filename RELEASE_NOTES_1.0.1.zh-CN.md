# Zero Mail 1.0.1 Release Notes

发布日期：2026-09-12

## 本次发布

Zero Mail 1.0.1 提供 Android 正式签名 APK、Windows x64 安装程序与便携 ZIP、macOS 通用版 ZIP/DMG，以及 Docker Compose 自托管服务端源码包。服务端和 Web 界面应先升级，客户端再连接同一个公开地址，例如 `https://zeromail.tippy.foo`。

## 主要变化

- 自托管登录改为设备配对：首台设备由服务器终端批准，后续设备可由已登录设备批准；不再开放账号密码注册。
- 新增 Android 原生客户端，支持服务器切换、配对登录、附件上传与保存、系统通知、分享文本、`mailto:` 和 `zeromail:` 深链接。
- 邮件分类增加可配置限制、并发与资源隔离，后台同步和分类服务增加健康检查与内存边界。
- 自托管连接设置可启用或关闭自定义 IMAP/SMTP 主机，并维护工作区级允许列表；预设邮箱服务不受影响。
- 改进邮件页面主题对比度、认证后导航、同步状态和分类控制。
- Windows 客户端版本更新为 1.0.1，继续提供托盘、通知、服务器隔离会话、`mailto:`/`zeromail:` 与默认邮件应用注册。

## 发布文件

### Android

- `Zero-Mail-1.0.1-android-release.apk`
- SHA-256：`c179946b491013fc7ff5afd6877e486e0322b55b3daf6c8dcc328f8d60138839`
- 包名：`com.tippye.zeromail`；versionCode：`2`；最低 Android 8.0（API 26）。
- APK 使用项目发布证书签名。已安装 Debug 版本的设备需要先卸载 Debug 版。

### Windows x64

- `Zero Mail Setup 1.0.1.exe`
- SHA-256：`3d9523bef85145ddd48c5c1412f8060d5f1fbabdd082f6c4ee9bb27d537b4b3b`
- `Zero Mail-1.0.1-win.zip`
- SHA-256：`9e71aee46822618065ff707ff778ecc784ce355e0ad3cb0d409c16be69e000fb`
- Windows 可执行文件尚未使用商业 Authenticode 证书签名，系统可能显示“未知发布者”。

### macOS 13+

- `Zero-Mail-1.0.1-macos-universal.zip`
- `Zero-Mail-1.0.1-macos-universal.dmg`
- 同时包含 Apple Silicon（arm64）与 Intel（x86_64）架构。
- 当前 Linux 工作区不能运行 Xcode，因此最终文件大小与 SHA-256 需在 macOS 执行 `bash native/apple/scripts/package-macos.sh` 后补入 Release；未签名包会被 Gatekeeper 拦截，公开发布建议使用 Developer ID 签名并完成 Apple 公证。

### Docker Compose 服务端

- `Zero-Mail-Server-1.0.1-source.tar.gz`
- SHA-256：`f6ae6b58dea0cd72ee4d3b3ab290177c659dc7c2ed1cf912851fcfe01642616a`
- 包内不包含 `deploy/.env`、TLS 私钥、数据库、邮件凭据或 Docker 数据卷。

## Docker 升级

保留现有 `deploy/.env` 和 Docker 卷，将源码包解压到新的目录后执行：

```sh
docker compose --env-file deploy/.env up -d --build
docker compose --env-file deploy/.env ps
```

若实例使用 HTTPS 附加配置或自定义项目名，升级时继续使用原有的 `-f` 和 `-p` 参数。公网访问应使用 HTTPS，并确保 `PUBLIC_URL` 与 `AUTH_ORIGINS` 包含完整公开来源。

## 已验证

- Android Debug/Release 编译、单元测试和 Lint 通过；正式 APK 签名验证通过。
- Windows 桌面链接和通知单元测试通过；ZIP 完整性检查通过；NSIS 安装程序成功生成。
- Apple Swift 核心测试及 macOS Release arm64/x86_64 应用和 Widget 构建曾在 macOS/Xcode 环境通过；1.0.1 正式包仍需在 macOS 重新归档并验证签名/公证。
- Docker API、Web、IMAP Bridge、邮件同步、分类、PostgreSQL 与 Valkey 容器已重新构建并达到健康状态。
- `https://zeromail.tippy.foo` 首页及认证 API 经 Cloudflare 访问返回 HTTP 200。

## 已知限制

- Android 与 Windows 客户端依赖可访问的 Zero 服务端，不提供完整离线收发队列。
- Android 后台通知使用定期检查，不是 FCM 实时推送，可能受系统省电策略延迟。
- Gmail OAuth 可能受嵌入式浏览器策略限制；必要时先在系统浏览器中连接 Gmail。
- Windows 安装程序当前未做 Authenticode 代码签名。
- Docker Compose 方案面向单机、单实例部署，不应给 API、同步任务或 IMAP Bridge 直接增加副本。
