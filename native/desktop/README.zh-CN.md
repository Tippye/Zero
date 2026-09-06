# Zero Mail Windows 客户端

当前版本：**1.0.0**，首个可用版本。

[中文首页](../../README.zh-CN.md) · [更新说明](../../CHANGELOG.zh-CN.md) · [服务端部署](../../deploy/README.zh-CN.md)

Electron 桌面客户端，连接自己的 Zero Compose 服务器。安装后从“服务器与桌面设置”填写完整 HTTP(S) 地址，并在邮件页面使用服务器账号登录。每个服务器使用独立浏览器会话；密码由认证页面处理，不通过桌面设置 IPC。

## 安装与首次连接

本次 1.0.0 产物位于 `native/desktop/release-windows/`：

- `Zero Mail Setup 1.0.0.exe`：运行安装向导，可选择安装路径。
- `Zero Mail-1.0.0-win.zip`：解压后运行 `Zero Mail.exe`。

安装前请从旧客户端菜单选择“退出”，确保托盘进程也已结束。安装包不会部署或更新邮件服务器。

1. 按[服务端说明](../../deploy/README.zh-CN.md)启动 Zero。
2. 在客户端的“服务器与桌面设置”填写完整的服务端地址，例如 `http://localhost:8080`；HTTP 需要勾选“允许 HTTP”。
3. 使用服务端账号登录，并在邮件页面的“设置 → 连接”添加邮箱。
4. 按需进入“设置 → LLM 服务商”添加服务商、获取模型列表并测试模型。

客户端连接地址是 **Zero 服务端** 地址；LLM API 地址应在邮件页面的 LLM 设置中填写。两者用途不同。

## 顶部菜单与快捷键

左上角 Zero Mail 按钮打开应用菜单，提供收件箱、写邮件、服务器与桌面设置、重新连接、编辑、视图和退出操作。中间空白区域可拖动窗口，右侧保留 Windows 原生窗口按钮。

| 快捷键              | 操作                |
| ------------------- | ------------------- |
| `Ctrl+N`            | 新建邮件            |
| `Ctrl+R`            | 刷新邮件页面        |
| `Ctrl++` / `Ctrl+-` | 放大 / 缩小邮件页面 |
| `Ctrl+0`            | 恢复默认缩放        |

关闭按钮是否退出应用由“关闭窗口后留在托盘”决定；彻底退出请使用 Zero Mail 菜单或托盘菜单中的“退出”。

## 功能

- Windows x64 NSIS 安装程序和便携 ZIP。
- 简洁的自定义标题栏：左侧 Zero Mail 下拉菜单、可拖动区域、Windows 原生最小化/最大化/关闭按钮，随系统切换明暗主题；支持 Ctrl+N、Ctrl+R 和缩放快捷键。
- 托盘后台运行、启动时自动运行选项、重新连接和服务器切换。
- 原生系统通知、通知内容隐私选项、通知测试按钮、点击定位邮件。
- 标准 `mailto:`：收件人、cc、bcc、subject、body；支持中文、换行、百分号和加号，参数只解码一次。
- `zeromail://compose?to=person@example.com&subject=Hello` 和 `zeromail://inbox`。
- 单实例：冷启动和应用运行中收到协议链接均处理。未登录时保留写信链接，登录后继续；离开有编辑内容的邮件前显示确认。
- NSIS 注册 MAILTO 能力、RegisteredApplications 和自定义协议，入口引号支持带空格的安装路径。
- 设置中可打开 Windows 默认应用设置，用户决定是否将 MAILTO 关联到 Zero Mail；不会写入受保护的 UserChoice 来强行设置默认值。

便携 ZIP 不安装注册表关联或开始菜单快捷方式，不作为默认应用和完整通知验收对象。设置为 MAILTO 处理程序不代表实现 Outlook 的 MAPI/COM 接口；依赖 MAPI 的旧软件“发送到邮件收件人”集成不在本版支持范围。mailto 标准没有附件参数，本版忽略未知字段，链接不自动读取本地附件或发送邮件。

远程邮件页面在独立 WebContentsView 中加载，没有 Node.js 权限或 Electron preload；随包提供的本地标题栏仅可打开应用菜单，设置页面具有限定 IPC。外部链接交给系统浏览器。没有自动发布或自动更新到未知服务器。

## 构建

使用 Windows 10/11 x64 和 **64 位 Node.js 22.12+**。先用 `node -p "process.arch"` 确认结果为 `x64`，然后运行：

```powershell
cd native/desktop
npm ci
npm test
npm run dist:win
```

默认产物位于 `native/desktop/release/`。若要使用本次构建的输出目录：

```powershell
npm run dist:win -- --config.directories.output=release-windows
```

Linux 上构建 NSIS 还需要 Wine；Windows 原生构建不需要。WSL 环境可调用 Windows 的 64 位 Node.js 进行原生构建；若旧的 Node.js 22.11 提示 CommonJS 无法加载 ES Module，可临时使用 `--experimental-require-module`，或更新到 22.12+。本次打包没有改变系统 Node.js 安装。

构建命令使用 `--publish never`。仓库提供手动触发的 Windows 构建工作流；本地产物不会自动上传或提交到 Git。当前构建文件的校验值见[验收记录](../../deploy/VALIDATION.zh-CN.md#100-构建产物-sha-256)。

当前安装程序未进行商业代码签名，Windows 可能显示未识别发布者提示。正式公开发行前应配置自己的代码签名证书和更新签名，不要把开发构建称为已签名发行版。

## 更新与常见问题

### 安装新版后邮件页面没有变化

邮件界面和 LLM 设置来自所连接的服务端。更新这些功能时，应先重建并更新服务器，再在客户端按 `Ctrl+R`。修改标题栏、托盘和协议注册等桌面功能时，才需要重新安装客户端。版本号可在“服务器与桌面设置”中查看。

### 获取 LLM 模型失败

模型请求由 Zero 服务端发起。Compose 默认把 `http://localhost:端口` 映射到 Docker 宿主机；也可以直接使用 `http://host.docker.internal:端口/v1` 或私有局域网 IP。完整规则和 Linux Docker 配置见[本机 LLM 服务](../../deploy/README.zh-CN.md#本机-llm-服务)。

“获取模型列表”和“测试模型”分别检查列表接口和实际聊天响应。列表不可用时可以手动填写模型 ID，再测试模型；失败提示会区分网络、认证、权限、限流、配额与返回格式问题。

## Windows 验收

安装 NSIS 版本后运行：

```powershell
.\scripts\verify-windows.ps1 -Executable 'C:\path\to\Zero Mail.exe' -LaunchLinks
```

脚本检查注册表声明、命令引号和当前 MAILTO 默认处理程序，并可打开测试写信链接，不发送邮件。人工确认：

1. 输入服务器地址并登录，可以读取、写信和手动添加附件。
2. 从设置发送测试通知，观察系统通知并点击返回应用；Windows 勿扰模式和通知总开关可能抑制横幅。
3. 完全退出后打开 mailto 链接，再在运行中打开 zeromail 链接，确认收件人/主题/正文。
4. 在 Windows 设置中自愿选择 Zero Mail 为 MAILTO 默认应用，再从其他软件点击 mailto 链接。测试脚本不修改当前默认值。
5. 关闭窗口后确认托盘存在；从托盘退出后进程结束；更换服务器后重新登录。

应用需要网络和运行中的服务器。现有查询缓存不等于完整离线同步引擎，未缓存邮件或断网发送不能保证可用。Gmail OAuth 还受服务商的嵌入式浏览器策略影响，必要时先在 Web 浏览器内给同一服务器账号添加 Gmail，再回到桌面端使用。

开发验收可在隔离测试配置下启动已安装程序，加 `--remote-debugging-port=9333`，登录并停留在空的收件箱。设置 `ZERO_DESKTOP_TEST_PROFILE` 为同一个隔离目录，然后运行 `node scripts/acceptance.cjs`，通过 Windows Shell 验证热启动写信字段。该脚本会打开合成测试邮件，不发送邮件；结束后退出调试实例。

### 自定义标题栏自动检查

在 Windows 的本地磁盘目录安装开发依赖，并确保隔离验收服务运行在 `http://localhost:18080`。在 `native/desktop` 目录执行：

```powershell
$env:ZERO_TEST_ELECTRON = (Resolve-Path '.\node_modules\electron\dist\electron.exe').Path
node scripts/check-titlebar.cjs
```

脚本使用临时客户端配置，检查菜单、邮件区域尺寸、最大化、缩放、明暗样式、关闭到托盘和退出；截图保存在输出的临时目录中。它不会登录真实工作区或发送邮件。邮件收发和协议注册仍按上面的独立步骤验收。
