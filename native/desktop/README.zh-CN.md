# Zero Mail Windows 客户端

Electron 桌面客户端，连接自己的 Zero Compose 服务器。安装后从“服务器与桌面设置”填写完整 HTTP(S) 地址，并在邮件页面使用服务器账号登录。每个服务器使用独立浏览器会话；密码由认证页面处理，不通过桌面设置 IPC。

## 功能

- Windows x64 NSIS 安装程序和便携 ZIP。
- 托盘后台运行、启动时自动运行选项、重新连接和服务器切换。
- 原生系统通知、通知内容隐私选项、通知测试按钮、点击定位邮件。
- 标准 `mailto:`：收件人、cc、bcc、subject、body；支持中文、换行、百分号和加号，参数只解码一次。
- `zeromail://compose?to=person@example.com&subject=Hello` 和 `zeromail://inbox`。
- 单实例：冷启动和应用运行中收到协议链接均处理。未登录时保留写信链接，登录后继续；离开有编辑内容的邮件前显示确认。
- NSIS 注册 MAILTO 能力、RegisteredApplications 和自定义协议，入口引号支持带空格的安装路径。
- 设置中可打开 Windows 默认应用设置，用户决定是否将 MAILTO 关联到 Zero Mail；不会写入受保护的 UserChoice 来强行设置默认值。

便携 ZIP 不安装注册表关联或开始菜单快捷方式，不作为默认应用和完整通知验收对象。设置为 MAILTO 处理程序不代表实现 Outlook 的 MAPI/COM 接口；依赖 MAPI 的旧软件“发送到邮件收件人”集成不在本版支持范围。mailto 标准没有附件参数，本版忽略未知字段，链接不自动读取本地附件或发送邮件。

远程邮件页面没有 Node.js 权限或 Electron preload；只有随包提供的设置页面具有限定 IPC。外部链接交给系统浏览器。没有自动发布或自动更新到未知服务器。

## 构建

推荐在 Windows 10/11 x64 和 Node.js 22+ 上：

```powershell
cd native/desktop
npm ci
npm test
npm run dist:win
```

产物位于 release/。Linux 上构建 NSIS 还需要 Wine；Windows 原生构建不需要。构建命令明确使用 `--publish never`。仓库提供手动触发的 Windows 构建工作流，但不会自行触发或推送。

当前安装程序未进行商业代码签名，Windows 可能显示未识别发布者提示。正式公开发行前应配置自己的代码签名证书和更新签名，不要把开发构建称为已签名发行版。

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
