# Apple 原生客户端交付验证

验证日期：2026-09-07。环境：Linux、Swift 6.0（Docker）、Node 24、PostgreSQL / Miniflare / Nginx 隔离测试栈。未使用真实邮箱，也未更新正在运行的业务服务。

| 检查                                                       | 结果                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Swift 认证和邮件核心测试                                   | 15 项通过，包含真实 API 响应的 Swift 解码                                                                         |
| 原生 API 适配层单元测试                                    | 8 项通过，含草稿附件缺失时拒绝编辑，避免保存造成附件丢失                                                          |
| 原生 API 集成测试                                          | 配对、签名 bearer、拒绝 cookie-only / 伪造凭据、账户隔离、分页/搜索/游标隔离、已读/星标、附件、草稿/发送/撤销通过 |
| 15 MiB 附件经 Nginx 到 API / 模拟邮件桥                    | 通过；HTTP/HTTPS 代理上限均调整为 24 MiB，HTTP 路径实际测试                                                       |
| 服务端 Worker 构建                                         | 通过                                                                                                              |
| 新增 TypeScript / JavaScript 文件 lint                     | 0 警告、0 错误                                                                                                    |
| 服务端全量 TypeScript                                      | 仍有原有 Env、Outlook、chat 等错误；本轮新增接口文件无错误                                                        |
| Swift 应用源码语法解析                                     | 通过；不等同于 Apple SDK 类型检查                                                                                 |
| Xcode 工程静态检查                                         | 三个应用目标、源文件引用、共享 scheme 引用和 HTTPS 配置通过                                                       |
| macOS/iOS/iPadOS/watchOS Xcode 编译                        | 未执行，当前环境无 Xcode                                                                                          |
| Apple Keychain、SwiftUI、Handoff、App Intent、模拟器与真机 | 未执行，须迁移到 Mac 验收                                                                                         |
| macOS CI                                                   | 已配置；未推送、未触发、无远程通过声明                                                                            |
| 签名、推送、TestFlight / notarization                      | 未完成，见迁移说明                                                                                                |

## 在 Linux 重现核心验证

在项目根目录运行；测试栈使用固定的 `zero-pairing-test` 项目名和本地 19180 端口，勿复用生产部署配置。

```sh
pnpm --filter @zero/server exec vitest run src/lib/native-mail.test.ts
pnpm --filter @zero/server exec wrangler deploy --dry-run --config wrangler.compose.json --outdir /tmp/zero-apple-worker
ZERO_PAIRING_WORKER=/tmp/zero-apple-worker docker compose -p zero-pairing-test -f deploy/tests/compose.pairing.yaml -f deploy/tests/compose.apple.yaml up -d --build
```

等测试 API 启动后执行：

```sh
node deploy/tests/apple-native.mjs
docker run --rm -v "$PWD/native/apple:/src" -v /tmp/zero-apple-fixtures:/fixtures:ro -e ZERO_APPLE_FIXTURES=/fixtures -w /src swift:6.0-bookworm swift test
```

集成测试会在 `/tmp/zero-apple-fixtures` 写入合成响应，不写登录令牌，Swift 测试直接读取这些响应验证跨语言字段契约。未设置 `ZERO_APPLE_FIXTURES` 时，仅该项被显式跳过。Mac 上另有真正的 Keychain 测试。

检查应用源码和工程：

```sh
docker run --rm -v "$PWD/native/apple:/src" -w /src swift:6.0-bookworm bash -c 'swiftc -frontend -parse Apps/Shared/*.swift Apps/Mail/*.swift Apps/Watch/*.swift Tests/AppUITests/*.swift'
gem install xcodeproj -v 1.27.0
ruby native/apple/scripts/validate-project.rb
```

完成后只删除隔离测试栈：

```sh
docker compose -p zero-pairing-test -f deploy/tests/compose.pairing.yaml -f deploy/tests/compose.apple.yaml down --volumes
```

真实邮件供应商行为、Apple SDK 可用性、界面交互与系统集成仍需按 [迁移验收说明](MIGRATION.zh-CN.md)执行。全量旧 TypeScript 错误没有用放宽类型检查掩盖，其他端未提交的改动也未纳入本轮提交。
