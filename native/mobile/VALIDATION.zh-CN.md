# 推送前复查 — 2026-09-07

- 邮件同步模块 11 项测试、移动端 JavaScript 7 项测试及 PostgreSQL 临时 schema 回归通过；数据库测试使用虚构邮件和模拟 LLM。
- 网页 Compose 生产构建、后端 dry-run 打包、桌面/手机浏览器回归与仓库 oxlint 通过。
- Gradle Wrapper 在线下载超时后，使用已缓存的 Gradle 8.11.1、JDK 17 和 Android SDK 35 离线完成 `testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest`，构建通过。
- 本轮未重跑模拟器和真机用例，也未连接实际邮箱或 LLM 服务。下面保留 2026-09-06 的历史验收与 APK 校验值，不代表本轮重新生成的 APK。

# Android 1.0.1 与共用邮件界面回归

日期：2026-09-06。应用 ID 保持 `com.tippye.zeromail`，versionCode=2，可覆盖安装同一开发密钥签名的旧包。

- 6 项 JVM 测试、Android Lint、debug APK 与设备测试 APK 构建通过。
- Android 11 / API 30 软件模拟器 **7/7 设备用例通过**（122.897 秒）：新增无原生顶部按钮、返回不进入登录页；设置入口/清理、会话恢复、链接与分享、附件上传下载、通知和分块校验通过。
- 首轮触摸失败时截图确认被 System UI 无响应弹窗遮挡；关闭系统弹窗后整套 7 项重新通过。设置用例同时改为先完成页面导航再调用桥接，并滚动到清理按钮。
- Android 附件 JS 3 项和原有资源准备 4 项测试通过；分类/数据模型 11 项、桌面链接/通知 8 项测试通过。
- 桌面 1440px / 手机 390px 浏览器回归通过：分类进度、暂停/刷新/继续/完成、过期分页恢复、重试触发真实同步 API 并自动刷新警示、正文 HTML/纯文本深色对比、应用主题与系统相反时的媒体查询、图片未反转、已读列表文字对比度及标题竖线移除。
- PostgreSQL 临时 schema 测试通过：人工分类保留、账户隔离、暂停后丢弃在途结果、恢复进度、文件夹错误隔离。使用虚构邮件和模拟 LLM，结束即清理。
- 当前配置的 LLM 通过新版请求对 10 条虚构标题的分类测试。未以真实邮件做外发测试；当前本地实例分类保留暂停，可从设置按钮继续。
- 当前本地实例正常同步重试已完成，账户状态为 ready、无文件夹错误；分类仍保持暂停。
- 网页生产构建与后端 dry-run 打包通过。仓库整体 TypeScript 检查仍有既存 Zod、环境绑定及路由类型错误，不能称为整体类型检查通过；本次分类/缓存/渲染逻辑没有新增对应类型错误。

APK：`release/Zero-Mail-1.0.1-android-debug.apk`，v2 签名验证通过，开发签名。
SHA-256：`66ddc9c375589a4d49ad75af210b6ad4ac8ace8d27bd578f25ec8d2905198acf`。

构建、设备与浏览器记录位于 `release/validation/`。共用界面检查脚本为 `deploy/tests/mail-fixes.cjs`。

---

# Android 1.0.0 开发版验收记录

日期：2026-09-06。范围为 `native/mobile/android` 中的 Zero Compose 安卓客户端；不包含 iOS 或应用商店发行。

## 构建与静态检查

- JDK 17、Android SDK 35 / Build Tools 35.0.0、Gradle 8.11.1、AGP 8.9.2。
- 6 项 JVM 测试通过：服务器标准化与拒绝规则、来源隔离、邮件字段解码、无效链接、分享和文件名。
- 3 项 Android 附件 JavaScript 测试通过；4 项原有 iOS 静态资源准备测试通过。
- Android Lint 通过，0 错误；保留固定依赖有更新版本的提示。
- `assembleDebug`、`assembleRelease`、`bundleRelease` 通过；设备测试 APK 编译通过。
- `git diff --check` 与新增 JavaScript 语法检查通过。
- 已验证正式签名 npm 入口在缺少签名环境变量时拒绝构建。

## 设备测试

设备测试使用应用内合成 HTTP 服务，不连接真实邮箱、不发送邮件。测试覆盖 HTTP 授权、Cookie 会话重建、冷/热写信链接、文本分享、附件分块、系统选择/保存接口、缓存清理及后台通知基线/去重/隐私。

本机 WSL 缺少 KVM。首次 Android 35 软件模拟器未在测试超时前完成初始化，Gradle 报设备 API 未就绪；这次运行不计为测试通过。随后改用 Android 11 / API 30 AOSP x86_64 软件模拟器，成功安装应用与测试 APK。

**6 项设备用例均已通过。** 首轮 4/6 通过；缓存清理用例被模拟器启动时遗留的 System UI 无响应弹窗遮挡，附件用例使用脚本点击没有触发真实用户手势。关闭系统弹窗、将附件测试改为按实际控件位置触摸后，两项复核均通过（44.637 秒）：

| 用例                                                           | 结果 |
| -------------------------------------------------------------- | ---- |
| HTTP 显式授权、同源 HttpOnly Cookie、Activity 重建会话         | 通过 |
| 冷启动 / 热启动写信、中文、加号、换行、文本分享                | 通过 |
| 原生附件分块顺序、大小限制、临时文件清理                       | 通过 |
| 系统文档选择接口上传、另存为接口保存，逐字节核对中文与特殊字符 | 通过 |
| 本机会话清理后 localStorage 与通知状态移除                     | 通过 |
| JobScheduler 后台通知基线、事件去重、通知内容隐私              | 通过 |

附件测试使用真实 WebView、MediaStore 文档和原生文件结果回调；系统选择器的返回值由 Android Instrumentation 注入，不等于已验收每一种第三方文件管理器界面。测试没有发送邮件。

本次设备日志保存在 `release/validation/`。测试结束后已清除模拟器中的测试账号配置。

仓库的 GitHub Actions 工作流配置了带 KVM 的 Android 35 模拟器；本次没有触发远程工作流，不宣称远程 CI 已通过。

## 产物与边界

应用 ID `com.tippye.zeromail`，`versionName=1.0.0`，`versionCode=1`，最低 API 26，目标 API 35。debug APK 通过 `apksigner verify`（v2 签名），使用开发密钥。release APK / AAB 在未配置自有签名时仅用于构建验证。

交付副本及校验文件位于 `native/mobile/release/`。这些文件不提交到 Git。不得将开发签名 APK 当作已完成商店发行的正式包。

`Zero-Mail-1.0.0-android-debug.apk` 的 SHA-256：

```text
09131d0188a3b3b4a6f0f8034c87dd4e15d657ce820db2c19a324671509d606a
```

尚未在用户真机上验收实际邮箱收发、系统厂商省电限制、真实附件提供器和签名升级。没有实现 Gmail 原生 OAuth 回传、FCM 实时推送或完整离线收发；后台通知依赖服务器同步及 Android 定期调度。功能与操作说明见[安卓使用说明](README.zh-CN.md)。
