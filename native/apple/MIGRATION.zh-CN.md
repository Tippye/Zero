# Apple 原生客户端：开发与设备验收

2026-09-08 已在 macOS/Xcode 环境继续开发并运行原生测试。各项实际结果见 [验证记录](VALIDATION.zh-CN.md)。

## 运行

1. 安装 Xcode 16 或更新版本及 iOS、watchOS 模拟器运行时，打开 `ZeroMail.xcodeproj`。正常构建无需生成工程或安装第三方 Swift 库。
2. 运行 `bash scripts/validate-macos.sh`，验证共享代码和三个应用目标。
3. 选择 `ZeroMac`（macOS 13+）、`ZeroIOS`（iPhone/iPad，iOS 16+）或 `ZeroWatch`（独立 watchOS 9+）。每台设备分别配对，凭据不经 iCloud 或 Handoff 同步。
4. 输入 HTTPS 根地址，不加 `/api`、路径或账户密码。Debug 构建也接受精确本机 HTTP 地址，例如 `http://localhost:18080`；Release 无此例外。真机的 localhost 指向真机自身，访问 Mac 上的服务需提供设备可达的 HTTPS 地址。
5. 生成配对码，在已登录网页 `/pair` 批准；首次设备可由管理员在服务器运行配对 CLI。

```sh
cd native/apple
bash scripts/validate-macos.sh
# 合成邮件 UI 测试，不访问真实邮箱；使用实际安装设备的 UDID。
bash scripts/test-ui.sh ZeroIOS 'platform=iOS Simulator,id=UDID' "$PWD/.derived/my-ui-run"
```

`test-ui.sh` 自动启动 19280 合成服务，每次使用新的结果目录。可用 `ZERO_UI_BUILD_DIR` 复用构建缓存。Mac 本地 ad hoc UI 测试暂时去掉 App Group entitlement，保留 sandbox；正式工程和 Release 权限不变。验证扩展需已配置团队与 profiles 的构建，可传 `ZERO_DEVELOPMENT_TEAM`。

## 服务端

原生 API 使用已配对设备的 bearer，由现有统一邮箱路由检查所有权和执行 IMAP/OAuth 操作。Apple 客户端没有邮箱密码或第二套 IMAP 实现。邮箱、同步和 BYOK 模型设置仍在网页管理。

当前源码增加 `ai-status`、`ai-read`、`ai-translation`、`ai-compose` 和 `events` 原生适配，见 [API.md](API.md)。`events` 与 Windows 共用查询，使用该新接口须更新服务器。AI 已兼容既有 Web 路由，参见 [AI 兼容修复](AI-COMPATIBILITY.zh-CN.md)，已有 Web AI 功能的旧部署可以直接使用更新后的 Apple 客户端。本轮没有更新用户经 18080 访问的服务；该地址是已有隧道入口，不等同于本机可管理的 Docker 部署。

部署负责人应按原流程更新 API/web，保留数据库、`BETTER_AUTH_SECRET`、BYOK 密钥与原有 HTTPS 配置。本次没有新增数据库表。已有 Compose 部署的更新示例（有 override 时保留原来的 `-f` 参数）：

```sh
docker compose --env-file deploy/.env build api web
docker compose --env-file deploy/.env up -d api web
```

## 功能与平台边界

| 功能 | Mac、iPhone、iPad | Apple Watch |
| --- | --- | --- |
| 配对、设备管理、钥匙串恢复、撤销 | 已实现 | 已实现，独立配对 |
| 多邮箱、文件夹、分页、搜索 | 已实现 | 文件夹、分页和紧凑列表 |
| 阅读、已读、星标、归档、废纸篓 | 已实现 | 已实现 |
| 写信、回复、回复全部、转发正文、Cc/Bcc | 完整编辑器 | 短回复 |
| 服务端草稿、附件添加/导出 | 已实现，20 个/15 MiB | 不提供完整附件编辑器 |
| 受限 HTML 阅读 | 禁脚本、远程资源、导航、表单 | 文字阅读 |
| AI 总结、翻译、问答 | 复用已有服务端 BYOK | 紧凑阅读助手 |
| AI 写作 | 明确生成→检查应用→确认发送 | 使用短回复流程 |
| 崩溃后的未保存草稿恢复 | 本机加密，稳定操作 ID | 短回复加密恢复 |
| Handoff / mailto / zeromail | 路由与编辑器保护 | 紧凑路由 |
| App Intent、Mac 菜单快捷键 | 打开并预填草稿，手动发送 | 紧凑原生界面 |
| 通知 | 运行期间查询服务器事件 | 前台查询服务器事件 |
| WidgetKit | Mac/iOS/iPadOS 小组件 | 表盘组件 |
| 其他 App 分享到 Zero | iOS/iPadOS 分享扩展 | 不适用 |

通知不是 APNs，iOS/Watch 退到后台后不保证新邮件提醒。Widget 显示最近查询页面的未读数，不是整个邮箱总数。详见 [通知](NOTIFICATIONS.zh-CN.md)和 [扩展](EXTENSIONS.zh-CN.md)。

未保存草稿使用设备专属钥匙串密钥加密，按服务器和所属邮箱隔离。保存、成功发送、明确放弃后移除本机恢复副本；退出/撤销同步清理该服务器的所有窗口。它不是完整离线邮箱或后台发送队列。见 [恢复设计](DRAFT-RECOVERY.md)。

发送不自动重试；结果不确定时保留同一操作 ID，恢复后禁止再次发送，提示先检查“已发送”。IMAP 幂等保证不能推断为所有 OAuth 供应商都有。转发附件须手动添加；供应商未返回完整附件的草稿会拒绝编辑，以免保存时丢失附件。

## 工程与发布配置

共享库在 `Sources`，主应用状态/界面在 `Apps/Shared`，Mac/iOS 入口在 `Apps/Mail`，手表在 `Apps/Watch`，扩展在 `Extensions`。`Configuration` 包含分开的 Debug/Release plist、图标、隐私清单和 entitlements。

需调整生成配置时，用 Ruby `xcodeproj` 1.27.0 运行 `scripts/generate-project.rb`；它会覆盖工程和生成配置，先将变更写进脚本。原有 Zero 品牌图标可用 `swift scripts/generate-icons.swift` 重新生成。

所有应用和扩展共用 App Group `group.org.zero.mail`。团队须注册组和各 bundle ID，并使用匹配 provisioning profile；没有共享 Keychain 或复制 bearer 给扩展。未配置 App Group 时基础邮箱仍能运行，扩展显示配置问题。模拟器编译不代表真机签名和扩展注册成功。

本轮未执行发布签名、TestFlight、Mac notarization 或 APNs 部署。GitHub 工作流覆盖共享测试及 Mac/iPhone/iPad/Watch 构建矩阵，保留日志和 xcresult；未推送或触发远程 CI。

## 真实环境验收

以下项目需要设备、匹配签名和专用测试邮箱；未经执行不能标为通过。

1. 更新测试服务器后，在每个平台验证新 AI/events 接口及配对、拒绝/过期、重启、离线、撤销。
2. 使用实际 IMAP/OAuth 供应商和专用收件人完成发信、回信、Cc/Bcc、草稿附件、15 MiB 代理传输、重复点击与断线后的已发送核对。
3. 真机验证 VoiceOver、听写、不同语言、iPad 分屏/多窗口、Mac 菜单键盘、Watch 小屏，记录系统版本与截图。
4. 匹配团队签名、同一 Apple ID 并开启 Handoff，两端各自配对后验证接续阅读、冷启动与现有草稿保护。
5. 从 Safari/照片/文件分享到 Zero，核对内容与附件；添加主屏幕/锁屏/Watch 表盘组件，检查路由、过期数据和退出清理。
6. 授权本地通知，验证预览选择、专注模式、锁屏、点击路由、多账户和撤销。如需后台实时提醒，另需 APNs token 注册、provider、撤销/到期清理及真实设备测试。
