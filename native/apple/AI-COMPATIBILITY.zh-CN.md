# Web AI 正常、Apple AI 不可用的兼容修复

2026-09-08 后续修复。此前 Mac 在 18080 后端读取原生 AI 状态返回 `NOT_FOUND`。Web 使用已有 `/api/trpc` AI 路由，Apple 先前只调用新增 `/api/native/v1/ai-*` 路由；只更新 Apple 应用而没有部署新接口，会出现 Web 正常、Apple 不可用。

## 修复行为

- Apple 先查询原生状态；仅在明确返回 `NOT_FOUND` 时，用配对 bearer 查询同一 Zero 服务器的 `llm.list`。成功后，该客户端会话使用已有 Web AI 接口。
- 总结、翻译、问答调用 `ai.read`，缓存调用 `ai.translation`，写作调用 `imap.generate`。输入和响应遵循已有 SuperJSON 格式。
- 只开放上述四个固定过程，模型地址、API key 和邮件所有权检查仍由后端管理。
- 生成请求不会因为超时、404、配置或服务商错误切换路径重发。写作结果仍经检查、应用和发送确认。
- 旧接口 HTML 译文在本机被动转换成文字，不通过 WebKit 请求资源；原排版仍使用已有受限查看器。
- 缓存不可用时保留总结、翻译、问答；迟到的缓存响应不会覆盖新生成的译文。

## Docker 与 LLM 位于同一设备

调用链仍为 Apple → Zero Docker 后端 → LLM，与 Web 共用服务器配置。客户端不直接访问 LLM，无需将模型 localhost 改成 Apple 设备地址或复制 API key。

如果 Web 真实生成已经正常，保留目前有效配置。项目已有 `LLM_LOOPBACK_HOST` 宿主机映射，见 [部署说明](../../deploy/README.zh-CN.md)。同一物理设备不等于同一容器；这不改变本次客户端接口修复。

本次 AI 修复需要重新构建并安装 Apple 客户端。刷新网页不会更新 Swift 应用。对于已存在上述 Web AI 接口的部署，不要求先升级 Docker 后端；新增通知事件接口仍按原部署要求处理。

## 验证记录

- 18080 只读探测确认四个 Web 路由已注册：无凭据 query 返回 401，向 mutation 发送 GET 返回 405。未因此生成内容。
- 19180 隔离后端实际协议测试 14/14 通过：配对 bearer、请求/响应格式、缓存、所有权、输入校验及服务器模型选择。没有配置模型，未调用真实 AI Provider。
- Swift 完整 Debug/Release 各 70 项通过，其中新增旧接口兼容专项 8 项和迟到 tRPC 401 凭据专项 1 项。
- Mac Debug、iOS/iPadOS Release、Watch Release 构建通过。修复后的 Mac 使用现有 18080 配对，AI 写作已识别服务器当前模型并启用“生成正文”按钮。

实际协议证据：`.derived/validation/backend/legacy-ai-wire.json`、`legacy-ai-integration.log`、`live-18080-legacy-routes.json`。本轮界面回归：iPhone 9 项邮件用例中 7 项首轮通过，2 项因 SwiftUI 标识传播失败，修正后分别定向复测通过；iPad 旧接口总结、翻译和缓存故障恢复用例通过。旧接口写作只提交一次请求、须应用后再手动发送，已由界面断言验证。

Mac 真实模型已被识别；点击生成测试时 CUA 自动化连接中断，后续只读重连仍失败，因此未确认真实生成结果，也未重复提交。没有发送真实邮件。记录位于 `.derived/validation/ai-compatibility/live-mac-observation.json`。

```sh
swift test --package-path native/apple --filter LegacyAICompatibilityTests
node deploy/tests/apple-legacy-ai.mjs
```

第二条命令只针对已有 19180 隔离栈，不应使用真实环境配置。其他平台边界见 [验证记录](VALIDATION.zh-CN.md)。

## 本机更新包

最终 Mac 调试包：`.derived/final-mac/Build/Products/Debug/ZeroMac.app`。它包含本次 AI 修复，支持开发用本机 HTTP 地址；采用本机 ad hoc 签名，未配置 App Group provisioning，不能作为正式分发包验证系统分享/小组件。iPhone/iPad/Watch 使用更新后的 `ZeroMail.xcodeproj` 重新构建安装，保留已有配对。

回归结果包：`.derived/ui-ai-iphone/results.xcresult`（首轮及失败证据）、`.derived/ui-ai-reader-iphone2/results.xcresult`、`.derived/ui-ai-native-reader-iphone2/results.xcresult`、`.derived/ui-ai-reader-ipad/results.xcresult`。核心与构建日志在 `.derived/validation/ai-compatibility/`。
