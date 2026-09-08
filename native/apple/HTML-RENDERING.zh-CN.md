# HTML 邮件正文修复（2026-09-08）

## 原因与改动

后端已返回 `html` 和 `text`，但 Apple 阅读页原先只显示 `text`；HTML 需要另外点击“查看邮件排版”。现在 macOS、iOS、iPadOS 阅读页默认使用隔离的 WKWebView 显示 HTML，保留独立排版窗口和纯文本切换。没有 HTML 的邮件仍使用可选择的原生文本。

内嵌正文根据内容高度调整，窗口宽度或设备方向变化后重新测量；超过 8,000 点的正文使用网页内部滚动。相同 HTML 不会因 SwiftUI 普通状态更新而重新加载。WebKit 加载失败时显示纯文本及重试入口。

测量代码使用应用的独立 `WKContentWorld.defaultClient`。邮件脚本、远程图片、外部资源和网页导航继续禁用，网页数据使用非持久化存储。应用测量脚本与禁用邮件脚本可以共存，参见 [Apple WKWebView 说明](https://developer.apple.com/videos/play/wwdc2020/10188/)。watchOS 继续使用原生文本阅读，不包含 WKWebView。

## 回归验证

`Tests/AppUITests/HTMLMailTests.swift` 使用 `scripts/ui-fixture.mjs` 的合成邮件，覆盖：

- 带颜色、背景、表格的 HTML 默认渲染，以及纯文本切换。
- 只有 HTML、没有纯文本的邮件。
- 只有纯文本的邮件。
- 长正文高度、横竖屏变化、滚动后回复入口，以及不会自动发送。
- 邮件脚本未执行、远程图片没有向测试服务器发起请求。

上述 4 个测试分别在 iPhone 16 Pro（iOS 18.5）与 iPad Pro 13（iPadOS 26.5）通过，均为 4/4、0 失败。记录位于 `.derived/ui-html-iphone3/results.xcresult` 与 `.derived/ui-html-ipad1/results.xcresult`。已检查实际截图：[iPhone](Documentation/Screenshots/html-mail-iphone.png)、[iPad](Documentation/Screenshots/html-mail-ipad.png)。前两次 iPhone 运行受到遗留测试草稿弹窗干扰；测试现等待弹窗完整关闭，不涉及删除用户邮件或草稿。

另在 iPhone 通过 `testExpandedHTMLAndAttachmentRemainAvailable`（1/1），验证独立排版窗口和附件下载，记录位于 `.derived/ui-html-expanded1/results.xcresult`。本次最终回归合计 9 次通过。

macOS Debug 与 iOS Release 构建通过，项目引用检查和测试服务器脚本语法检查通过。macOS 原生界面自动化仍受当前环境限制，不能视为已通过交互实测。此次验证使用隔离的合成邮件服务，不代表真实邮箱全部 HTML 模板均已实测。

iPadOS 26.5 测试日志还包含 UIKitToolbar 与 UIHostingController 的系统层次警告，测试与布局截图均通过；这次没有修改工具栏实现。
