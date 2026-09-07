# 配对认证

Zero Compose 使用配对码／二维码建立设备会话，不再使用默认账号密码。网页、Electron 桌面端和 Android 的服务端登录页使用同一套流程；苹果原生认证模块位于 `native/apple`。

## 首次使用

1. 启动服务器，在设备中填写 Zero 服务器地址，打开登录页面。
2. 填写本机名称，点击「生成配对码」。配对码为 8 位随机字符，5 分钟有效；二维码包含服务器批准页面地址和同一个配对码。
3. 首台设备由服务器管理员批准。在仓库根目录运行：

   ```sh
   docker compose --env-file deploy/.env exec api node pairing.mjs approve ABCD-EFGH
   ```

4. 核对终端显示的服务器、设备名称和有效期，输入 `yes`。新设备会在下一次检查时登录，并继续原先的写信／阅读链接。

`ABCD-EFGH` 是格式示例，应替换为设备当前显示的配对码。使用自定义 Compose 项目名或配置文件时，命令应带上相同的 `-p`／`-f` 参数。

## 添加设备和扫码

新设备显示二维码；用已登录设备打开二维码链接，在页面中查看请求并点击「确认登录」。二维码只预填配对码，不会自动批准。也可在已登录设备的「设置 → 安全」手动输入配对码。桌面应用菜单另有「设备配对与登录」入口。

系统相机通常在浏览器中打开链接，浏览器与原生 WebView 的登录状态互相独立。如果打开的浏览器尚未登录，请在已经登录的 Zero 客户端「设置 → 安全」输入配对码，或先为浏览器完成一次配对。Android 不需要授予相机权限即可使用手动配对码。

设备名称由请求方填写，仅用于帮助识别；批准前核对它是否就是本人正在登录的新设备。配对码不能直接兑换登录凭据，兑换还需要发起设备持有的 256 位私密随机值。两者在服务器中只保存哈希；长期会话凭据不会写进二维码。

## 会话和恢复

每台设备拥有独立的 30 天会话，按现有认证库策略续期。会话存储在 PostgreSQL，服务器重启后保留；每次请求验证服务器会话，不使用旧的 Redis 登录缓存、长期 Cookie 用户缓存或无状态 JWT 作为配对会话。网页／WebView 使用 HttpOnly Cookie，原生 API 客户端使用独立的签名 Bearer 值。

「设置 → 安全」可查看当前设备、登录时间并退出任意设备。退出本机后返回登录页，其他设备的会话不受影响。终端同样可以管理设备：

```sh
docker compose --env-file deploy/.env exec api node pairing.mjs devices
docker compose --env-file deploy/.env exec api node pairing.mjs revoke SESSION_ID
# 所有设备丢失时：撤销会话及尚未兑换的批准，再批准新设备。
docker compose --env-file deploy/.env exec api node pairing.mjs revoke-all --yes
docker compose --env-file deploy/.env exec api node pairing.mjs approve ABCD-EFGH
```

服务器终端是首次授权和恢复入口，需要管理服务器的权限。没有可用会话且无法管理服务器时，不能仅凭公开网页自行认领工作区。

## 从密码版本升级

- 保留数据库、桥接数据卷和原有 `BETTER_AUTH_SECRET`／加密密钥。无需重新添加邮箱或 LLM 密钥。
- 首次迁移优先使用显式 `PAIRING_OWNER_ID`，其次识别旧 `ADMIN_EMAIL`，否则选择唯一的非访客工作区。全新数据库建立内部工作区身份；内部邮箱字段不作为登录凭据。
- 多个工作区无法确定归属时，迁移报错并保留原状态。管理员需明确选择 `PAIRING_OWNER_ID`。访客工作区不自动归并。
- 首次启用配对时旧会话失效，各设备重新配对。之后重启或再次运行迁移不会反复退出设备。
- `ADMIN_PASSWORD` 不再读取；新配置不生成用户名或登录密码。密码登录、重置、公开注册、手机号登录和通过邮件验证自动登录均关闭。已有邮箱服务商的凭据保留；连接 Gmail 等邮箱仍需在已配对的工作区内完成 OAuth。

## 各端接口

`GET /api/desktop/info` 返回 `authentication.type = "pairing"` 和协议版本 `1`。

| 接口                                | 用途                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /api/pairing/start`           | `{deviceName, mode: "cookie" 或 "native"}`，返回配对码、私密值、请求 ID、有效期及批准页面地址 |
| `POST /api/pairing/exchange`        | `{requestId, deviceSecret}`，发起设备每 5 秒检查一次；批准后只能成功兑换一次                  |
| `POST /api/pairing/preview`         | 已登录设备提交 `{code}`，获取待批准请求的信息                                                 |
| `POST /api/pairing/approve`／`deny` | 已登录设备明确提交 `{code, requestId}`                                                        |
| `GET /api/pairing/devices`          | 查看本工作区设备，结果不含令牌                                                                |
| `POST /api/pairing/revoke`          | `{sessionId}`，撤销本工作区的一个会话                                                         |

接口使用 JSON，请求和响应均不应记录配对私密值或登录凭据。`authorization_pending` 表示等待批准，`slow_down` 表示检查过于频繁；拒绝、过期、重复兑换和限流分别返回错误。配对私密值绑定生成它的服务器来源，不能跨来源兑换。反向代理必须覆盖 `X-Forwarded-For` 和 `X-Forwarded-Proto`；仓库 Nginx 配置已这样处理。

`cookie` 模式不会在 JSON 中返回令牌。`native` 模式返回的 `token` 是不透明值，必须原样放入 `Authorization: Bearer …`，不要进行 URL 解码。Apple 模块按服务器来源将其存入本机 Keychain，禁止云同步／设备迁移；每个苹果设备独立配对，不通过 WatchConnectivity 复制 iPhone 的长期凭据。

正式连接使用 HTTPS。现有可信内网 HTTP 选项仍保留，二维码不会为 HTTP 提供传输加密。原生 Swift 模块默认拒绝 HTTP，需要调用方显式开启后才能连接。

## 验证

完整测试命令见 [部署文档](README.zh-CN.md#验证)。`deploy/tests/compose.pairing.yaml` 使用独立合成数据库和测试密钥，不需要 `deploy/.env`。测试覆盖批准、拒绝、过期、并发一次性兑换、密码入口禁用、来源校验、原生 Bearer、设备撤销、重启和恢复。

苹果模块的 `swift test` 可在 Linux 验证网络协议和凭据存储接口；SwiftUI 和真实 Keychain 分支需要 macOS／Xcode。仓库提供 `apple-auth.yml`，在 macOS 上测试，并编译 iOS／iPadOS 和 watchOS 模拟器目标。本认证模块不等于已经完成苹果邮件应用的打包、推送或上架。
