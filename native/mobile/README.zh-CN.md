# Zero Mail 安卓客户端

Android **1.0.1**，支持 Android 8.0（API 26）及以上和更新的 Android System WebView。连接已有的 Zero Compose 服务器，使用与网页、Windows 相同的服务器账号和邮箱工作区。

## 安装与连接

开发 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。本次交付副本与 SHA-256 放在 `release/`，不提交到 Git。

1. 将 APK 复制到手机并安装，按系统提示允许当前文件管理器安装应用。
2. 填写服务器地址，例如 `https://mail.example.com` 或 `http://192.168.1.20:8080`；HTTP 需勾选允许 HTTP。
3. 生成配对码，由已登录设备扫码或在“设置 → 安全”输入配对码批准；首台设备由服务器终端批准，详见[配对认证](../../deploy/AUTHENTICATION.zh-CN.md)。登录后在邮件界面的“设置 → 连接”管理邮箱。
4. 邮件界面不再有常驻原生返回/菜单栏。「设置 → 通用 → 安卓应用设置」可修改服务器、通知或清理本机会话；登录页和连接失败页也可进入服务器设置。

手机的 `localhost` 是手机本身。Compose 的 `PUBLIC_URL`、`AUTH_ORIGINS` 和端口监听需要支持实际访问地址，详见[局域网部署](../../deploy/README.zh-CN.md)。无效或自签名 HTTPS 证书不会被跳过，应配置受系统信任的证书。LLM 配置仍在邮件界面设置中完成。

## 功能

- 原生服务器设置，HTTP 显式授权；同源配对登录与会话保留，无需默认用户名密码。
- 服务器提供的收件箱、阅读、写信、邮箱连接和 LLM 设置；系统返回键、键盘避让、安全区域、明暗主题。
- 网络/证书错误与重试；网页编辑器的离开确认；从服务器设置返回时保留当前页面。
- 冷/热启动 `mailto:`、`zeromail://compose?to=a@example.com&subject=Hello`、`zeromail://inbox`；未登录写信通过服务端 `next` 返回。
- Android“分享 → Zero Mail”将文本/网址放入邮件正文，可接受分享方主题。
- 系统文件选择器上传附件；Blob/Data URL 附件分块传输到系统“另存为”，单个文件最多 25 MB；一次上传最多选择 30 个文件。
- 可选后台新邮件检查，首次检查建立游标，不通知历史邮件；事件去重、会话隔离。通知隐藏邮件内容，点击打开对应邮件。
- 切换服务器及“清除本机登录与缓存”清理 Cookie、网页存储、缓存、临时附件和通知记录；私有数据不参与云备份或设备迁移。

附件不需要全盘存储权限。原生消息接口只注入配置服务器的来源，只接受顶层页面消息；WebView 不授予摄像头、麦克风或定位权限。应用不单独保存密码、API Key 或 IMAP 授权码。Cookie 保存在 Android 应用私有目录，并不是另行实现的 Keystore Token 库。清理本机不等于撤销服务器上的其他会话。

## 使用边界

通知默认关闭，Android 13+ 开启时需要通知权限。后台检查最短约 15 分钟，省电、强制停止、网络或厂商限制可能延迟检查；这是定期检查，不是 FCM 实时推送。首次基线检查后收到的未读邮件才会提醒。

客户端需要网络与服务器，不提供完整离线收发或断网发送队列。Gmail 的系统浏览器 OAuth 回传尚未实现：请先在浏览器登录同一个 Zero 账号并添加 Gmail，再回安卓端使用。浏览器与应用分别登录。“分享文件给 Zero Mail”、相机拍摄附件、App Links 域名验证和商店发布不在此版范围内。

较旧 WebView 使用旧版网页存储清理 API；更新后可使用带完成回调的完整清理。需要彻底移除旧 WebView 数据时，可在 Android 系统设置中清除 Zero Mail 存储。

## 构建

安装 JDK 17、Android SDK Platform 35、Build Tools 35.0.0，设置 `ANDROID_HOME`，或在 `android/local.properties` 填写 `sdk.dir`。源码包含 Gradle 8.11.1 Wrapper 和官方校验值；Android Gradle Plugin 为 8.9.2。

```sh
cd native/mobile
npm test
npm run android:check
npm run android:debug
```

Android 不需要 `npm install`、前端打包或 Capacitor。Android Studio 直接打开 `native/mobile/android`。Windows 支持上述 npm 命令，或在 `android` 内运行 `gradlew.bat`；Linux/macOS 使用 `./gradlew`。不要运行 `cap add android` / `cap sync android` 覆盖工程。本目录保留旧 Capacitor iOS 脚手架；Apple 原生开发使用 `native/apple` 下的 SwiftUI/Xcode 工程，见[迁移说明](../apple/MIGRATION.zh-CN.md)。

正式签名构建配置以下环境变量，不要写进 Git 或日志：

| 变量                          | 内容                       |
| ----------------------------- | -------------------------- |
| `ZERO_ANDROID_KEYSTORE`       | 自有签名 keystore 绝对路径 |
| `ZERO_ANDROID_STORE_PASSWORD` | keystore 密码              |
| `ZERO_ANDROID_KEY_ALIAS`      | 签名别名                   |
| `ZERO_ANDROID_KEY_PASSWORD`   | 签名密钥密码               |

执行 `npm run android:release`，生成 `android/app/build/outputs/apk/release/app-release.apk` 和 `android/app/build/outputs/bundle/release/app-release.aab`。缺少签名配置时该命令报错。直接运行 Gradle `assembleRelease` 可生成未签名 APK 以检查构建。升级需要相同应用 ID、相同签名和更高 `versionCode`。

## 验证

```sh
npm test
npm run android:check
# 专门测试设备/模拟器；会重置设备中的 Zero 应用测试配置。
npm run android:device-test
```

JVM 测试覆盖服务器地址、来源隔离、中文/百分号/加号解码及邮件路由；JavaScript 测试检查分块附件字节、URL 立即撤销、传输失败和大小上限。设备测试使用合成 HTTP 页面，不发送真实邮件。

本次执行结果见[安卓验收记录](VALIDATION.zh-CN.md)。Android 工作流构建、运行模拟器测试并上传 debug APK 与报告，不自动上架。正式发行前需在目标手机和实际服务器检查中文收发、附件、断网、键盘/返回键、通知/省电和签名升级。

官方接口依据：[AGP/Gradle](https://developer.android.com/build/releases/agp-8-9-0-release-notes)、[WebView 来源约束](https://developer.android.com/reference/androidx/webkit/WebViewCompat)、[完整存储清理](https://developer.android.com/reference/androidx/webkit/WebStorageCompat)、[后台任务](https://developer.android.com/reference/android/app/job/JobInfo.Builder)。
