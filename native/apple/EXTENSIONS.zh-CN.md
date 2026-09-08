# 小组件、Watch 表盘组件与系统分享

## 工程与签名

`scripts/generate-extensions.rb` 为主工程生成并嵌入：

| 扩展 | 所属应用 | 最低系统 | 用途 |
| --- | --- | --- | --- |
| ZeroIOSShare | ZeroIOS | iOS/iPadOS 16 | 从系统分享面板导入文字、网页 URL、文件和图片 |
| ZeroIOSWidgets | ZeroIOS | iOS/iPadOS 16 | 主屏幕小组件、锁屏附件组件、写邮件入口 |
| ZeroMacWidgets | ZeroMac | macOS 13 | 通知中心/受系统支持位置的小组件与写邮件入口 |
| ZeroWatchWidgets | ZeroWatch | watchOS 9 | WidgetKit 圆形、矩形、行内表盘组件 |

iPad 锁屏小组件由系统从 iPadOS 17 起提供。扩展使用现有原生应用的 `zeromail://inbox` / `zeromail://compose` 路由；进入应用后仍需配对，写邮件入口不会发送。

所有应用与扩展使用 `group.org.zero.mail` App Group。开发团队必须在 Apple Developer / Xcode 注册该组，并让每个应用及扩展的 provisioning profile 包含该组。macOS 同样支持且推荐 `group.` 格式；`TeamID.groupName` 是仅限 macOS 的另一种形式，此工程没有混用。模拟器/未签名构建能够验证代码编译，但不能证明正式签名、App Group 容器访问和扩展注册正确。

未配置共享容器时，主邮件功能继续运行；分享扩展会显示配置错误，小组件显示待配对状态。凭据始终留在原应用钥匙串，未设置 Keychain Sharing，也未把服务器、账户 ID、令牌或邮件正文写入小组件快照。

## 分享流程

1. 在其他 iPhone/iPad 应用的分享面板选择 Zero Mail。
2. 查看并编辑导入主题、正文，核对附件列表，选择「保存」。接受普通文字、无用户名/密码的 HTTP(S) 网页 URL，以及系统提供的文件/图片副本。
3. 打开 Zero Mail。配对完成、存在已连接邮箱、当前编辑器为空时，应用询问是否导入。
4. 选择「导入草稿」后在完整编辑器中核对发件邮箱，填写收件人，再明确保存/发送或放弃。当前编辑中的草稿不会被覆盖。

收件人、抄送、密送初始为空。扩展不访问邮箱服务，不尝试在后台发送，也不使用非公开手段唤起主应用。分享来源保持为 App Group 内受文件保护的待导入文件，应用只在编辑器经明确保存到服务器/发送/放弃操作关闭后确认删除。主应用将后续编辑和附件保存为按服务器隔离的加密本机恢复草稿；进程意外退出后会先提示恢复，保留原稿 UUID 和分享关联，恢复操作不会发送。发送结果不确定的草稿只允许检查并保存，不自动重试。选择「稍后」会留存来源，下一次应用进程启动可再提示。

首次明确导入时，主应用把分享 ID 绑定到当前服务器，绑定记录以原子写入方式保存在主应用私有目录，不进入小组件快照。重启或切换服务器后不会将已导入内容提示给另一台服务器。同一份分享和恢复草稿由一个活动窗口持有；窗口关闭后释放占用。尚未明确导入的来源保持未绑定，等待用户选择。

最多 20 个附件，合计 15 MiB；正文不超过 200 KiB，主题不超过 1000 UTF-8 字节。文件名规范化，文件读取有上限，解码后再次核对附件长度和数量。待导入队列最多 3 份，超过 24 小时清理；退出/撤销配对清理该服务器已绑定的分享、本机恢复草稿和小组件状态，保留其他服务器及尚未导入的来源。

## 小组件数据

小组件只读取本机快照，包含配对状态、连接账户数、本次检查页面中的未读数量、结果是否部分成功、最后检查时间。当前原生邮件接口每账户返回最多 20 个会话，因此显示「最近未读」而非邮箱的总未读数。数字标记为隐私敏感，供系统在锁屏/常亮显示时遮盖。

应用检查邮件时写入快照，在状态或数量改变时请求 WidgetKit 更新；状态不变时最多每 15 分钟请求一次。WidgetKit 决定实际刷新时间。扩展没有独立网络同步、APNs 或后台持续执行能力；过期快照可能保留最后数值，用户可查看更新时间并打开应用刷新。

## 验证

自动测试：`swift test --package-path native/apple --filter AppGroupBridgeTests`。覆盖持久化读取与明确确认、空收件人、容量和过期、按服务器清理、重启后绑定隔离、损坏绑定拒绝导入、快照字段白名单、附件篡改、路径与符号链接拒绝、无效快照回退。加密恢复另由 `DraftRecoveryStoreTests` 覆盖。

实际签名设备验收仍需逐项执行：系统分享面板发现扩展；Safari/照片/文件导入并核对附件内容；超过大小限制的错误；现有编辑器不被覆盖；退出重启恢复待导入内容；明确关闭后不再重复导入；锁屏快照隐私；小组件点击收件箱/写邮件；Watch 表盘添加、布局、更新及点击；退出账户后快照清除。编译通过不能代替这些系统流程。

参考：[App Groups](https://developer.apple.com/documentation/xcode/accessing-app-group-containers)、[WidgetKit 数据共享](https://developer.apple.com/documentation/WidgetKit/Developing-a-WidgetKit-strategy)、[锁屏与 Watch 表盘组件](https://developer.apple.com/documentation/widgetkit/creating-accessory-widgets-and-watch-complications)、[分享扩展配置](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/AppExtensionKeys.html)。
