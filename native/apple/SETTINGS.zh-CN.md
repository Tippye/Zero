# Apple 设置

macOS 使用独立的 SwiftUI `Settings` 窗口，可从 Zero Mail 菜单的「设置…」、`⌘,` 或侧栏打开。顶部按「通用、账户、查看、通知、设备」分类，阅读和显示偏好使用对齐的原生表单；账户和设备列表可滚动。

iOS / iPadOS 将常用偏好放在系统「设置 → App → Zero Mail」中（较早系统直接在「设置 → Zero Mail」）。应用内「设置 → 打开系统设置」使用 Apple 的公开设置入口。账户管理、设备配对、撤销、通知授权和通知测试仍在应用内。

## 可用偏好

| 偏好 | 默认值 | 实际行为 |
| --- | --- | --- |
| 预览 | 2 行 | 邮件列表摘要可设为无或 1–5 行；「无」移除摘要 |
| 显示所属邮箱 | 开 | 控制每封邮件下方的所属邮箱地址 |
| 打开邮件时标记为已读 | 开 | 关闭后阅读不会自动发出标为已读请求，手动操作仍可用 |
| 移到废纸篓前询问 | 关 | 开启后，列表菜单和阅读工具栏的删除操作需要确认；取消不发出请求 |
| 在通知中显示发件人与主题 | 关 | 关闭时只显示通用新邮件提示 |
| 播放新邮件提示音 | 开 | 控制新邮件和测试通知的声音；仍受系统通知授权和静音策略约束 |

偏好保存在当前应用的标准 `UserDefaults` 域，启动时注册缺省值，不覆盖已保存的选择。应用收到偏好变更通知、或从系统设置返回前台时重新读取，现有窗口同步更新。设置资源不保存服务器地址、邮箱密码、配对令牌，也不使用凭据所在的 App Group。

实测发现 iOS 系统设置可能把预览选项 `0` 保存为布尔 `false`。读取层兼容系统对 `0` / `1` 的这种表示，同时保留原始偏好，避免选择「无」后错误回退到 2 行。

账户页显示当前服务器、连接的邮箱与状态，并链接到该服务器的网页账户管理。退出和撤销设备均保留确认，并验证当前会话仍与建立确认时相同。

## 工程与复测

- `Sources/ZeroMail/MailPreferences.swift` 定义共享偏好键、默认值和读取校验。
- `Configuration/Settings.bundle` 包含系统设置分组和中英文标签，仅进入 ZeroIOS 应用资源；生成器与工程校验脚本检查其结构。
- `Tests/ZeroMailTests/MailPreferencesTests.swift` 覆盖默认值、持久选择、启动参数、异常值和 Settings.bundle 一致性。
- `Tests/AppUITests/SettingsFlowTests.swift` 使用 19280 端口的合成邮箱，验证显示、自动已读、删除确认和系统设置往返。

```sh
cd native/apple
ruby scripts/validate-project.rb
swift test
ZERO_UI_ONLY_TESTING=ZeroIOSUITests/SettingsFlowTests \
  bash scripts/test-ui.sh ZeroIOS 'platform=iOS Simulator,id=SIMULATOR_ID' "$PWD/.derived/ui-settings"
```

## 2026-09-08 验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Swift Debug / Release | 各 79 项通过，无跳过；含 9 项偏好回归 | `.derived/validation/settings/swift-{debug,release}-verified.log` |
| macOS Debug | 构建、嵌套签名完整性检查通过 | `.derived/validation/settings/mac-build.log` |
| iPhone / iPad Release | 真机目标编译与 Settings.bundle 打包通过 | `.derived/validation/settings/ios-build.log` |
| watchOS Release | 共享代码与扩展编译通过 | `.derived/validation/settings/watch-build.log` |
| iPhone 16 Pro，iOS 18.5 模拟器 | 7 项设置行为覆盖；其中系统设置往返在修复后独立复测通过 | `.derived/ui-settings-iphone2/results.xcresult`（6 项行为通过）、`.derived/ui-settings-iphone5/results.xcresult`（系统设置往返通过） |
| iPad Pro 13 M5，iPadOS 26.5 模拟器 | 完整 7 项通过，无跳过 | `.derived/ui-settings-ipad2/results.xcresult` |
| 最新 iPhone 应用的旧后端 AI 兼容 UI | 阅读和写作 2 项通过；使用合成响应，生成后须审阅 | `.derived/ui-settings-ai-final/results.xcresult` |

两种模拟器均实际从系统「设置」修改预览：2 行 → 无 → 2 行；返回同一个运行中的邮件应用后，摘要消失并恢复，未重启应用。删除测试验证了取消不请求后端、确认仅请求一次；iPad 使用系统原生弹出框的外部点按取消。

系统设置截图已经人工检查。iPhone 的通过轮附件捕获到导航动画边缘，较早轮的干净截图只作为布局证据；iPad 通过轮截图没有此问题。早期失败记录保留，用于复现系统将预览 `0` 保存为布尔值的问题。iPad 的 XCTest 报告附带 UIKitToolbar 框架运行时警告，但测试摘要为 7 通过、0 失败。

Mac 的实际界面自动化连接连续超时，未将设置窗口交互、多窗口切换或 macOS 13 菜单兼容路径记为实测通过。本机 Mac 应用使用保留沙盒的临时签名，未包含需要正式配置的 App Group 权限；真机、分发签名与跨设备功能验收范围见主验证说明。

设备配对与邮件服务的生产端配置沿用现有实现；本次设置改动不要求升级 Docker 后端。测试只操作合成邮箱，没有发送真实邮件。

实现参考 Apple 的 [Settings scene](https://developer.apple.com/documentation/swiftui/settings) 和 [Settings bundle 文档](https://developer.apple.com/documentation/Foundation/building-a-settings-bundle-for-your-app)。
