# Apple 原生客户端验证记录

后续修复：针对“Web AI 正常、Apple AI 不可用”，客户端已兼容现有 Web AI 路由。下表保留前一轮平台验收证据；AI 的最新结果和部署边界以 [AI 兼容修复记录](AI-COMPATIBILITY.zh-CN.md)为准。

日期：2026-09-08。源码基线：`feat/imap-byok-mobile` / `102c42d3` 加当前工作区变更。环境：Apple Silicon，macOS 26.6.1，Xcode 26.6 (17F113)，Swift 6.3.3，Node 24，pnpm 10.15.0。

本轮补齐原生 AI 阅读/写作、事件通知、WidgetKit、iOS 分享扩展、加密草稿恢复和图标，并修复实际发现的 iPhone 工具栏缺失、iPad 重复操作、Watch 安装配置、回复账户/收件人、会话与草稿并发问题。核心和模拟器回归通过；正式发布及真实邮件全闭环尚未验收。最后一次大字体布局修正后，定向界面测试及 Mac/iOS Release 增量构建再次通过。

## 结果与证据

证据目录为本机 `native/apple/.derived/validation`，被 Git 忽略。XCTest 结果包保留在各 `.derived/ui-*` 目录；它们不是源代码或发布物。

| 检查 | 实际结果 | 证据（相对本目录） |
| --- | --- | --- |
| Swift Debug 核心 | 61 项通过，0 失败/跳过 | `.derived/validation/swift-debug.log` |
| Swift Release 核心 | 61 项通过，0 失败/跳过 | `.derived/validation/swift-release.log` |
| macOS Release | arm64/x86_64 应用与 Widget 扩展构建通过，无发布签名 | `.derived/validation/mac-release.log` |
| iOS/iPadOS Release | universal 应用、Share 与 Widget 扩展构建通过，模拟器目标 | `.derived/validation/ios-release.log` |
| watchOS Release | 独立应用与 Widget 扩展构建通过，模拟器目标 | `.derived/validation/watch-release.log` |
| iPhone UI | iPhone 16 Pro / iOS 18.5：6 项通过 | `.derived/ui-iphone3/results.xcresult` |
| iPhone 无障碍定向回归 | 深色、最大动态字体、横屏：1 项通过，回复按钮可达且不超出阅读区边界；测试后恢复 light/large | `.derived/ui-iphone-accessibility2/results.xcresult` |
| iPad UI | iPad Pro 13 M5 / iPadOS 26.5：7 项通过，含最终分栏与横屏回归 | `.derived/ui-ipad2/results.xcresult` |
| Watch 运行 | Series 10 46mm / watchOS 11.5：实际安装、ad hoc 签名启动、配对与合成收件箱显示成功 | `.derived/validation/screenshots/watch-mailbox.png` |
| Mac UI | 已观察到原生窗口显示 18080 邮件；XCTest 在系统自动化初始化超时，未执行用例 | `.derived/ui-mac1/results.xcresult` |
| 原生服务端单元测试 | 16 项通过 | `.derived/validation/backend/native-vitest.log` |
| 隔离原生 API 集成 | 全部通过，包含真实 Nginx→Worker→PostgreSQL 链路和合成邮件桥 | `.derived/validation/backend/native-integration.log` |
| Windows 桌面兼容基线 | 8 项通过；链接与通知逻辑回归 | `.derived/validation/backend/desktop-parity.log` |
| Worker dry run | 构建通过，未发布 | `.derived/validation/backend/worker-dry-run.log` |
| Xcode 工程/CI 配置 | 源文件、scheme、Watch 独立模式、Release HTTPS 策略检查通过；CI YAML/shell/模拟器选择检查通过 | `scripts/validate-project.rb`，`.derived/validation/backend/ci-local-validation.log` |

Swift 核心包括真实 macOS Keychain 读写、Debug 精确 loopback/Release HTTPS、令牌替换与迟到响应、设备撤销、mailto/Handoff、回复账户和 Cc/Bcc、加密草稿、共享草稿所有权、精确通知游标、真实隔离 API 响应的 Swift 解码。Debug/Release 是同一套回归在不同编译条件下执行，不应相加宣称 122 个独立用例。

6 项完整 UI 用例覆盖：外部 HTTP 拒绝；配对/钥匙串重启恢复；邮件读取及附件导出；HTML 脚本/追踪请求阻断；链接收件人、Cc/Bcc 和草稿保存；AI 明确生成与应用、不自动发送；发送确认；未保存草稿进程重启恢复。多项断言组合在同一用例中。iPad 另有第 7 项横屏回复可达性用例。

界面复查修正了 iPhone 列表缺少写信入口和 iPad 分栏重复按钮；回复操作支持窄空间/大字体改用纵向排列。部分 iPadOS 26.5 系统工具栏产生 UIKitHosting 警告，但相关用例通过；没有把系统日志警告算成应用断言失败。

Mac XCTest 报 `Timed out while enabling automation mode`，检测到本机 Developer mode 关闭。未更改系统权限，未把未执行的测试计为通过。现有 Mac 窗口的观察也不能代替完整 Mac UI 自动化验收。

## 三种测试服务

| 地址 | 用途 | 本轮证明的范围 |
| --- | --- | --- |
| `http://localhost:18080` | 用户提供的现有服务器入口 | 兼容性元数据、缺失/伪造 bearer 拒绝两项脚本检查；原生 Mac 可显示已配对邮箱。AI 接口返回 NOT_FOUND。未部署新服务器代码，未获可供脚本使用的认证会话 |
| `http://localhost:19180` | 独立 Docker 测试栈 | 已认证只读 14 项检查，完整邮件 API 合成闭环与数据库并发回归；没有配置真实 BYOK 模型 |
| `http://localhost:19280` / `19380` | iPhone/iPad/Mac UI / Watch UI 合成服务 | 确定性邮件、草稿、发送和 AI 返回值，验证原生交互与客户端行为；不会实际发送邮件或调用模型 |

19180 集成覆盖所有权、分页/搜索/游标隔离、已读/星标在列表与详情一致、草稿 To/Cc/Bcc/附件、15 MiB 附件经代理、发送幂等与改变载荷的 409、归档/废纸篓、撤销；通知覆盖首次基线、历史导入、25+5 分页、桌面/原生一致、已读/归档/过期/删除过滤、非法游标。新增数据库锁控制的竞态测试：在读取最大游标后插入新事件，旧实现复现越界；修复后本页不返回它，下一轮准确交付。

所有脚本证据均只保留状态、计数或合成内容，不包含 bearer、密码或真实邮件正文。14 项已认证检查属于 19180，不能标成 18080 的验收。没有向真实收件人发信，没有更新用户服务、推送代码或触发远程 CI。服务端全量 TypeScript 仍有既有 Env/Outlook 等错误；未通过放宽检查掩盖。

## 重现

```sh
# 已安装根工作区依赖，使用项目匹配的 pnpm 版本。
npx --yes pnpm@10.15.0 --filter @zero/server exec vitest run src/lib/native-mail.test.ts src/routes/native.test.ts
node --test native/desktop/test/*.test.mjs

# 隔离栈已有合成响应时，两个配置都运行完整 Swift 回归。
ZERO_APPLE_FIXTURES=/tmp/zero-apple-fixtures swift test --package-path native/apple
ZERO_APPLE_FIXTURES=/tmp/zero-apple-fixtures swift test --package-path native/apple --configuration release
ruby native/apple/scripts/validate-project.rb

cd native/apple
bash scripts/validate-macos.sh
python3 scripts/select-simulator.py iPhone
bash scripts/test-ui.sh ZeroIOS 'platform=iOS Simulator,id=UDID' "$PWD/.derived/new-ui-result"
```

未设置 `ZERO_APPLE_FIXTURES` 时，跨语言集成响应测试会明确跳过。UI 脚本自动开启合成 fixture；不经脚本启动的 UI 测试会明确跳过邮件用例，避免误用真实邮箱。`ZERO_UI_ONLY_TESTING` 可传 XCTest 的 target/class/method，供定向回归。完整隔离栈命令见 `deploy/tests/compose.apple.yaml` 与 `deploy/tests/apple-native.mjs`；只操作 `zero-pairing-test` 项目，不能套用真实环境配置。

## 尚未验收

- 18080 的新原生 events 接口仍需部署；AI 已增加现有 Web 接口兼容，详见后续修复记录。IMAP/OAuth 收发闭环与附件需要专用测试邮箱/收件人。
- Mac 系统自动化权限初始化、真机 VoiceOver/听写、实体设备 Handoff、iPad 多窗口实际操作需要继续验收；纯状态/路由测试不能替代这些交互。
- App Group provisioning、系统分享扩展入口、小组件/Watch 表盘实际添加和锁屏行为，需匹配签名及设备验证。
- 当前通知为运行期间轮询事件，未实现 APNs 后台实时推送。发布签名、TestFlight、Mac notarization 未完成。

工程已有开发证据，不应据此标为“Apple 生态全部验收”或“可上架”。配置与设备清单见 [开发说明](MIGRATION.zh-CN.md)。9 月 7 日 Linux 验证仅为此前基线；本表取代其未执行 Xcode 的状态。
