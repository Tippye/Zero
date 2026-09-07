# Apple 原生客户端：迁移到 macOS 与继续开发

本轮已建立原生应用工程和主要邮件流程，供迁移到 Mac 后继续开发。当前环境是 Linux，尚未实际编译 Apple SDK 或运行模拟器；本交付还不是已验收、可上架的四端成品。

## 架构决定

Apple 客户端统一使用 **Xcode + SwiftUI + Swift Package**。macOS 使用原生 Mac target，iPhone 和 iPad 共用 universal iOS target，Apple Watch 使用独立 watchOS target。共享认证、邮件模型和请求逻辑，按设备分别组织界面。

服务端已经统一处理 IMAP、OAuth 邮箱和同步，无需重新实现邮件协议。Mac 保留菜单、快捷键和多栏阅读；iPad 使用系统分栏和多窗口；iPhone 收拢为导航层级；手表侧重阅读、星标、归档和短回复。[Apple 跨平台导航说明](https://developer.apple.com/documentation/technotes/tn3154-adopting-swiftui-navigation-split-view)和 [watchOS 单 target 结构](https://developer.apple.com/documentation/watchkit/wkapplication)支持这一方向。

Xcode 不会自动完成所有生态功能。Handoff、通知、Widget、分享扩展和 iCloud 仍需分别实现、配置和验收。本轮已接入 Handoff 路由、系统邮件链接、附件分享和打开写信窗口的 App Intent；其余工作见最后一节。

## 带到 Mac 的内容

建议迁移**整个项目目录，包括 `.git` 和其他尚未提交的源文件**。当前工作区另有网页、Android 和邮件同步的未提交工作，只迁移新提交或重新 clone 会遗漏这些内容。本轮提交不会打包或覆盖这些改动。

可排除 `node_modules`、`native/apple/.build`、`native/apple/.derived`、构建产物和缓存。Mac 重新安装依赖，不要复用 Linux 依赖目录。原生客户端开发只需服务器 HTTPS 地址，不需要将服务器的 `deploy/.env`、TLS 私钥、邮箱密码或 Docker 数据卷复制到应用工程。

原生客户端的最小源码集合是整个 `native/apple` 目录；服务器须同时具备本轮 `/api/native/v1/*` 接口。单独复制 Swift 文件无法补齐旧服务器的接口。

## Mac 上第一次启动

1. 安装 **Xcode 16 或更新版本**，在 Settings → Locations 选择完整 Xcode 的 Command Line Tools，在 Platforms / Components 安装 iOS 和 watchOS 模拟器运行时。
2. 打开 `native/apple/ZeroMail.xcodeproj`。工程和共享 schemes 已经入库，正常编译不需要 Ruby、CocoaPods 或 XcodeGen。
3. 先运行共享测试和三个无签名构建：

   ```sh
   cd native/apple
   bash scripts/validate-macos.sh
   ```

4. 在 Xcode 依次选 `ZeroMac`、`ZeroIOS`、`ZeroWatch`。`ZeroIOS` 分别选择 iPhone、iPad 模拟器；`ZeroWatch` 选择 watchOS 模拟器。以真实编译结果为准修复 SDK 可用性和 SwiftUI 类型问题，再进入真机测试。
5. 首次运行输入服务器 **HTTPS 根地址**，如 `https://mail.example.com`，不要输入 `/api`、路径、用户名或密码。证书须被设备正常信任；应用没有关闭 TLS 验证，也没有 HTTP 绕过开关。
6. 生成配对码，在已登录网页的 `/pair` 或另一台原生设备的“设置与设备”中批准。首次设备可在原服务器执行：

   ```sh
   docker compose --env-file deploy/.env exec api node pairing.mjs approve ABCD-EFGH
   ```

7. 每台设备单独配对，包括手表。Mac、iPhone、iPad、Watch 之间不复制登录令牌。继续使用服务器中的用户和邮箱数据，不需要新建账号。

| Scheme    | 设备             | 最低版本        |
| --------- | ---------------- | --------------- |
| ZeroMac   | 原生 Mac         | macOS 13        |
| ZeroIOS   | iPhone、iPad     | iOS / iPadOS 16 |
| ZeroWatch | 独立 Apple Watch | watchOS 9       |

当前 Watch 应用自己访问 HTTPS 服务器，尚未实现 WatchConnectivity 中继，也未嵌入 iOS App。独立运行是本轮选择，相关机制见 [Apple 文档](https://developer.apple.com/documentation/watchos-apps/creating-independent-watchos-apps)。

## 服务器配合

本轮没有更新正在运行的服务。需按原部署流程更新 API 和网页镜像；网页镜像中的反向代理请求上限已调整，以容纳 15 MiB 附件经 Base64 编码后的体积。若此前尚未升级到配对认证，须先完成 [认证迁移](../../deploy/AUTHENTICATION.zh-CN.md)。本轮原生邮件接口没有新增数据库表。

对于已运行配对版本的服务器，可在安排好更新后执行；使用 HTTPS override 的部署继续带上原来的 `-f` 参数：

```sh
docker compose --env-file deploy/.env build api web
docker compose --env-file deploy/.env up -d api web
```

保留原 `BETTER_AUTH_SECRET` 和数据库，已有配对才能继续有效；不要重新生成部署配置。新增邮箱、OAuth 连接、AI 模型与同步设置仍在网页中管理。“打开网页设置”会打开系统浏览器，浏览器有自己的会话，需要单独配对。

## 工程地图

| 位置                                       | 用途                                              |
| ------------------------------------------ | ------------------------------------------------- |
| `ZeroMail.xcodeproj`                       | 三个应用、Mac/iOS UI 测试 targets 和 schemes      |
| `Sources/ZeroPairing`                      | 配对、二维码、签名 bearer、钥匙串和设备撤销       |
| `Sources/ZeroMail`                         | 邮件 API、模型、附件、回复和链接；可在 Linux 测试 |
| `Apps/Shared/MailStore.swift`              | 会话、列表与阅读状态，过滤和请求切换处理          |
| `Apps/Shared`                              | 登录、设备设置、多栏邮箱、写信、受限 HTML 阅读器  |
| `Apps/Mail`                                | macOS/iOS 入口、Mac 菜单、App Intent              |
| `Apps/Watch`                               | 手表入口、阅读、确认发送的短回复                  |
| `Configuration`                            | Info.plist、Mac 沙盒权限和隐私清单                |
| `Tests`                                    | 核心、真实 API 响应解码、原生登录 UI 测试         |
| `../../apps/server/src/lib/native-mail.ts` | JSON 接口与既有统一邮箱路由的适配                 |
| `../../apps/server/src/routes/native.ts`   | bearer 认证、请求限制和错误响应                   |

若需重新生成工程，安装 `gem install xcodeproj -v 1.27.0` 后运行 `ruby scripts/generate-project.rb`。**它会覆盖工程配置与生成的 plist**，包括手动签名设置；先把需要保留的变化反映到生成脚本。正常新增 Swift 文件可通过 Xcode 添加到对应 targets。

## 已实现功能与边界

| 功能                                     | 当前源码                                                 |
| ---------------------------------------- | -------------------------------------------------------- |
| 配对码/二维码、批准/拒绝、设备列表、撤销 | 四端共享；Watch 显示配对码                               |
| 多邮箱、文件夹、分页、搜索、部分失败提示 | Mac/iPhone/iPad；Watch 提供文件夹与分页                  |
| 阅读、已读/未读、星标、归档、废纸篓      | 四端，无永久删除                                         |
| 写信、回复/回复全部、正文转发、抄送/密送 | Mac/iPhone/iPad；Watch 提供短回复                        |
| 草稿保存/编辑、附件上传和导出分享        | Mac/iPhone/iPad，20 个文件 / 15 MiB 总量                 |
| 邮件原排版                               | Mac/iPhone/iPad；禁止脚本、远程资源、链接跳转和表单      |
| Handoff、`mailto:` / `zeromail:`         | 已接路由；Handoff 只携带服务器和邮件 ID，双方须配对      |
| Siri / 快捷指令                          | 打开编辑器并预填，仍需手动确认发送；无固定自托管域名要求 |
| Mac 菜单                                 | ⌘N 写信、⌘R 刷新、⌘E 归档、⌘, 设备设置                   |

转发附件需手动添加。未修改正文的草稿保留原 HTML，修改后按纯文字生成 HTML。Gmail 草稿如果包含当前供应商接口未返回的附件或内嵌图片，会拒绝编辑，以免保存时丢失内容；后续可补齐内嵌附件下载。编辑器中尚未保存的内容只在内存中，请“保存草稿”后再退出应用。

发送不会自动重试。超时可能发生在邮件已送出之后，界面会阻止再次发送并提示检查“已发送”。IMAP 操作保留稳定 operation ID，不能假定 OAuth 供应商也有相同去重机制。接近上限的附件还需在真实代理和供应商上验收。

## Mac 上的验收顺序

下列 Apple SDK / 真机项目尚未在当前 Linux 环境执行，迁移后须逐项记录结果。

1. **编译和登录**：运行构建脚本；Mac/iPhone/iPad/Watch 配对，关闭重开恢复登录。拒绝、过期、离线、错误地址和撤销后均可恢复；日志无令牌。
2. **邮件闭环**：连接专用测试邮箱；收件、搜索、跨页、切换账户/文件夹、长线程。快速切换检查旧请求不覆盖新列表/详情。分别验收 IMAP 与实际使用的 OAuth 供应商。
3. **草稿和发送**：空收件人校验、抄送/密送、回复全部不带原 Bcc、Gmail 草稿与 message ID 区分、HTML 保留、附件字节一致、重复操作/网络断开、已发送副本。只向测试收件人实发。
4. **界面**：iPhone 小屏/横屏，iPad 分屏/横屏/多窗口，Mac 窗口/菜单/键盘，Watch 小屏/听写；检查 VoiceOver、最大字体、深色模式和不同系统语言。
5. **生态接续**：同一 Apple ID、同一开发团队签名、系统 Handoff 开启，两端各自配对后接续阅读。不同服务器链接不能自动携带凭据。测试冷启动、已有草稿时的邮件链接和快捷指令。
6. **隐私和附件**：追踪图片不发远程请求，脚本/表单不能运行；附件可以保存分享，关闭详情后临时文件清理。真实钥匙串访问与撤销须在 Apple 环境验证。

原生登录 UI 测试已加入 `ZeroIOS` / `ZeroMac` schemes，选择设备后执行 Product → Test。GitHub 的 `Apple native applications` 工作流配置了三端构建和 iPhone 登录 UI 测试；**本轮没有推送或触发工作流**。

## 继续开发顺序

1. **完成 Apple SDK 验收**：执行上述编译、模拟器和真机检查，修复实际 SDK/布局问题，再标记发布版本。
2. **后台通知**：服务端 push token 注册/撤销、APNs provider、重试与到期清理；客户端授权和通知点击路由。iOS 与独立 Watch 分别注册。当前只有前台刷新，不承诺后台实时到信。APNs 密钥与 Team ID 由服务器配置，不打包到 App。
3. **Widget 和分享扩展**：增加 WidgetKit、必要 App Group、经过筛选的摘要缓存；分享扩展接收文字/链接/文件并保存为待编辑草稿。当前 `ShareLink` 是向外分享附件，不是“其他 App 分享到 Zero”的扩展。
4. **离线和草稿恢复**：实现受保护的本地存储、容量清理、账户隔离、撤销清理、发送队列与冲突处理。需要跨设备同步客户端偏好时再引入 iCloud/CloudKit，邮件内容和登录令牌不自动写入 iCloud。
5. **发布**：补 AppIcon（当前工程未配置图标资产）、本地化、隐私说明、包名、开发团队、签名/provisioning；Mac 完成 notarization，iOS/Watch 完成 TestFlight/真机分发。已有 `PrivacyInfo.xcprivacy` 声明本 App 的 UserDefaults 用途，增加新 API 后须复核。

后续参考：[Handoff](https://developer.apple.com/documentation/foundation/implementing-handoff-in-your-app)、[Watch 通知要求](https://developer.apple.com/documentation/watchos-apps/enabling-and-receiving-notifications)、[隐私 API 理由](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)。
