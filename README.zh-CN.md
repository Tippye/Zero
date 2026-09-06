# Zero Mail

[English](README.md) · **中文** · [1.0.0 更新说明](CHANGELOG.zh-CN.md)

Zero Mail 是可自托管的邮件客户端，支持连接多个邮箱，通过网页和 Windows 应用使用同一工作区，并接入自选的 OpenAI 兼容 LLM 服务。

当前 Windows 客户端版本为 **1.0.0**，作为本分支的首个可用版本。客户端需要连接运行中的 Zero 服务端；普通邮件收发不要求配置 LLM。

## 文档导航

| 文档                                             | 内容                                               |
| ------------------------------------------------ | -------------------------------------------------- |
| [Docker Compose 部署](deploy/README.zh-CN.md)    | 首次启动、账号、局域网访问、HTTP/HTTPS、数据与升级 |
| [Windows 客户端](native/desktop/README.zh-CN.md) | 安装、服务器连接、标题栏、托盘、默认邮件应用和打包 |
| [1.0.0 更新说明](CHANGELOG.zh-CN.md)             | 当前版本功能、升级方法及已知限制                   |
| [验收记录](deploy/VALIDATION.zh-CN.md)           | 已完成的检查、验证边界及安装包校验值               |
| [本机开发环境](SELF_HOSTING_LOCAL.zh-CN.md)      | 原有本机开发部署，不等同于 Compose 账号模式        |
| [早期 IMAP 集成记录](SELF_HOSTING_IMAP.zh-CN.md) | 历史阶段设计与实现说明，不作为当前版本功能清单     |

## 当前功能

- 多邮箱与统一邮件界面：连接 Gmail OAuth 或 IMAP/SMTP 邮箱，按邮箱分组查看邮件。
- 简洁侧边栏：顶部保留“新建邮件”，底部设置按钮与更多菜单同一行显示；同步状态放在更多菜单中。
- 自选 LLM：添加、编辑、激活服务商配置，获取模型列表，或手动填写模型 ID。
- 测试模型：已保存的配置和编辑表单均可测试，显示结果与耗时；测试使用简短消息，不读取邮件内容。
- Windows 桌面体验：自定义标题栏、应用下拉菜单、原生窗口按钮、托盘、系统通知及邮件协议链接。
- 中文界面：支持简体中文、繁体中文与英语等界面语言。

邮箱供应商的认证、IMAP/SMTP 能力及限制仍由各服务商决定。具体功能与验收情况以对应文档为准。

## 快速启动服务端

准备 Docker Engine、Compose v2.20+ 和 Node.js 22.12+，在仓库根目录执行：

```sh
node deploy/init.mjs http://localhost:8080
```

编辑生成的 `deploy/.env`，设置 `ADMIN_EMAIL` 和至少 12 位的 `ADMIN_PASSWORD`，然后启动：

```sh
docker compose --env-file deploy/.env up -d --build
docker compose --env-file deploy/.env ps
```

浏览器打开 `http://localhost:8080`，使用上述账号登录。在“设置 → 连接”添加邮箱，在“设置 → LLM 服务商”按需配置 AI。

初始化脚本不会覆盖现有配置。已有实例直接按[升级说明](deploy/README.zh-CN.md#数据和升级)操作；保留数据卷以及原有加密密钥。

默认端口只绑定服务器本机。其他设备访问时，需要同时配置 `PUBLIC_URL`、`AUTH_ORIGINS` 和监听地址，详见[局域网部署](deploy/README.zh-CN.md#启动)。

## 使用 Windows 客户端

本次构建产物位于 `native/desktop/release-windows/`：

- `Zero Mail Setup 1.0.0.exe`：安装程序，支持安装路径选择、快捷方式和邮件协议注册。
- `Zero Mail-1.0.0-win.zip`：解压运行版本，不注册默认邮件处理程序。

产物是本机构建文件，不随 Git 源码提交；从源码生成安装包请参阅[构建步骤](native/desktop/README.zh-CN.md#构建)。

安装后在“服务器与桌面设置”填写 Zero 服务端地址，例如 `http://localhost:8080`。HTTP 连接需勾选允许 HTTP；连接后使用服务端账号登录。服务端与客户端不在同一台电脑时，应填写服务端的局域网地址或域名。

左上角 **Zero Mail** 菜单提供收件箱、写邮件、服务器设置、重新连接、编辑、视图和退出操作。右上角是 Windows 原生窗口按钮；中间区域可拖动窗口。

| 快捷键              | 操作                |
| ------------------- | ------------------- |
| `Ctrl+N`            | 新建邮件            |
| `Ctrl+R`            | 刷新邮件页面        |
| `Ctrl++` / `Ctrl+-` | 放大 / 缩小邮件页面 |
| `Ctrl+0`            | 恢复默认缩放        |

## 配置 LLM

进入“设置 → LLM 服务商”，填写名称、API 基础地址、密钥和模型。基础地址通常以 `/v1` 结尾，不要填写完整的 `/chat/completions` 路径。先获取模型列表或手动填写模型 ID，再点击“测试模型”。测试成功后保存并按需激活。

| 地址示例                               | 使用场景                                     |
| -------------------------------------- | -------------------------------------------- |
| `https://api.openai.com/v1`            | OpenAI API；其他兼容服务填写其提供的基础地址 |
| `http://localhost:20128/v1`            | Compose 模式默认转向 Docker 宿主机的本机服务 |
| `http://host.docker.internal:20128/v1` | 直接访问 Docker 宿主机服务                   |
| `http://192.168.1.20:8080/v1`          | 访问可从 Zero 服务端连接的局域网服务         |

自托管模式允许本机、私有局域网 IP 和 `host.docker.internal` 使用 HTTP。API 地址不能包含登录信息、查询参数或片段。局域网服务须监听 Docker 或 Zero 服务端可达的地址。

模型请求由 **Zero 服务端** 发起。若 Zero 运行在远程机器上，`localhost` 不表示你正在使用的 Windows 电脑。Docker 的本机映射由 `LLM_LOOPBACK_HOST` 控制，Linux Docker 的配置方法见[本机 LLM 服务](deploy/README.zh-CN.md#本机-llm-服务)。

获取模型列表成功只表示列表接口可访问；“测试模型”会实际调用所选模型。错误会区分连接失败、超时、认证失败、权限不足、限流、配额不足、接口或模型不存在、返回格式异常等情况。

## 更新后看不到变化

Windows 安装包包含标题栏、托盘和系统集成；邮件界面与 LLM 设置由所连接的服务端提供。

- 修改邮件界面或 API：重新构建并更新服务端，再刷新网页或在客户端按 `Ctrl+R`。
- 修改标题栏或桌面功能：重新打包，完全退出旧客户端（包括托盘进程），再安装新版。
- 安装客户端不会自动部署服务器上的新代码。

## 开发与验证

前端使用 React、React Router、Vite、TypeScript 和 Tailwind CSS；API 使用 Hono、tRPC、Drizzle 与 Workers 运行时；自托管部署通过 Miniflare/workerd 提供本地绑定。Windows 客户端使用 Electron。

源码开发使用仓库指定的 `pnpm@10.15.0`。可针对当前改动运行以下检查：

```sh
npm test --prefix native/desktop
node --import tsx --test apps/server/src/lib/llm-http.test.ts
node --test integrations/mail-sync/test/classify.test.mjs
```

完整部署、浏览器和 Windows 检查见[验收记录](deploy/VALIDATION.zh-CN.md)。

## 使用边界

当前部署为单机、单实例；Windows 安装程序尚未进行代码签名。客户端需要网络及服务端，不提供完整离线收发或 Outlook MAPI/COM 兼容。Compose 模式关闭定时发送与延迟撤回；移动端仍为开发脚手架，不包含在 1.0.0 Windows 验收范围内。

邮件 AI 功能会根据操作向你配置的服务商发送必要内容。请按自身需求选择邮箱与 LLM 服务商，并备份数据库、桥接数据、Workers 数据和加密配置。
