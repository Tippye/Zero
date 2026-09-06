# Docker Compose 自托管

[中文首页](../README.zh-CN.md) · [1.0.0 更新说明](../CHANGELOG.zh-CN.md) · [Windows 客户端](../native/desktop/README.zh-CN.md)

本部署将 API、后台邮件同步、IMAP/SMTP 桥接、PostgreSQL、Valkey、Redis HTTP 适配器和 Web 入口放在同一个 Compose 项目中。不需要 Cloudflare 账号，不启动 `wrangler dev`。API 使用固定版本 Miniflare 管理 workerd 及本地 Workers 绑定；这是单机、单实例部署，不等同于 Cloudflare 的多区域托管平台。不要给 API、同步任务或桥接直接增加副本。

## 启动

需要 Docker Engine 和 Compose v2.20+，以及用于首次生成配置的 Node.js 22.12+。在仓库根目录：

```sh
node deploy/init.mjs http://localhost:8080
# 编辑 deploy/.env，设置 ADMIN_EMAIL 和至少 12 位的 ADMIN_PASSWORD。
docker compose --env-file deploy/.env up -d --build
docker compose --env-file deploy/.env ps
```

打开配置的 PUBLIC_URL，以上述账号密码登录。其他设备使用同一账号，访问同一工作区。默认禁止公开注册，首次初始化不会重置数据库里已有账号的密码。旧本机访客工作区不会自动归并；迁移已有数据前需要备份并明确账号归属。

生成脚本拒绝覆盖已有 deploy/.env。其中包含随机密钥、数据库密码和初始登录密码，不要提交 Git。网页中的 LLM 设置仍可直接配置服务商，不必填写服务器 AI 环境变量。

默认只将 Web 的 HTTP 8080 映射到宿主机 127.0.0.1。局域网使用时，在 deploy/.env 中设置：

```dotenv
PUBLIC_URL=http://192.168.1.10:8080
AUTH_ORIGINS=http://192.168.1.10:8080
HTTP_BIND=0.0.0.0
HTTP_PORT=8080
```

API 8787、桥接 3033、PostgreSQL 5432 和 Redis 都只在 Docker 网络内通信，不发布到宿主机。连接邮箱需要出站 IMAPS 993、SMTP 465/587；Gmail/AI 等需要出站 HTTPS。无需开放入站 SMTP 25。

## HTTP 与 HTTPS 同时使用

准备证书文件 deploy/tls/fullchain.pem 和 deploy/tls/privkey.pem，私钥仅管理员可读。在 deploy/.env 中列出每个实际访问地址，协议、域名和端口必须准确：

```dotenv
PUBLIC_URL=https://mail.example.com
AUTH_ORIGINS=https://mail.example.com,http://192.168.1.10:8080
HTTP_BIND=0.0.0.0
HTTP_PORT=8080
HTTPS_BIND=0.0.0.0
HTTPS_PORT=443
```

```sh
docker compose --env-file deploy/.env -f compose.yaml -f deploy/compose.https.yaml up -d --build
```

HTTP 入口保留，不强制跳转。前端使用当前页面来源访问 API；后端只为 AUTH_ORIGINS 中的地址生成认证回调。HTTP 与 HTTPS 使用不同 Cookie 名称，HTTPS Cookie 带 Secure。HTTP 连接传输明文，仅用于可信内网或加密 VPN；公网使用 HTTPS。桌面端需明确勾选才接受 HTTP，HTTPS 证书错误不会自动降级。

也可以将入口交给现有反向代理终止 TLS；应由代理覆盖 Host / X-Forwarded-Proto，不接受客户端伪造的转发头，并将外部 origin 加入 AUTH_ORIGINS。

## 邮箱与开放配置

- 兼容 Gmail OAuth 和 QQ、163、126、iCloud、自定义 IMAP/SMTP。自定义服务器在 BRIDGE_ALLOWED_MAIL_HOSTS 中按逗号列出明确的主机名。
- Google 可选；配置 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET，并登记 `PUBLIC_URL/api/auth/callback/google`。邮箱连接和 Zero 登录是两件事。
- AI 使用网页里的自有服务商配置；系统不依赖一个固定 AI 厂商，普通收发不需要 AI。模型请求由服务器发起。
- Compose 模式关闭上游 Dub、PostHog 初始化和 Sentry 会话回放。外部邮件图片仍按用户设置加载。
- Windows 客户端连接用户指定的服务器，支持标准 mailto: 和 zeromail: 链接；无需注册集中式 Zero 云账号。

当前保留上游的 Gmail 专属功能，但 Cloudflare AI/Vectorize、托管推送订阅等外部服务不是本地仿真实现。Compose 模式关闭定时发送和延迟撤回入口，后端拒绝定时请求，旧的撤回设置不会让立即发送进入临时队列。不能把本地队列模拟器当作跨进程可靠的定时发送保证。

## 数据和升级

持久卷分别为 postgres-data、redis-data、bridge-data、worker-data。邮件凭据在桥接卷，设置/邮件索引在 PostgreSQL，Workers 的对象、KV、R2 和工作流状态在 worker-data。必须连同 deploy/.env 中的加密密钥备份；丢失密钥无法恢复已加密的凭据。

```sh
# 更新源码后重新构建，迁移容器在 API 前执行。
docker compose --env-file deploy/.env up -d --build
# 停止并保留数据
docker compose --env-file deploy/.env stop
# 仅查看状态，避免将含敏感变量的完整 config 输出分享出去。
docker compose --env-file deploy/.env ps
```

如果实例同时使用 HTTPS、额外的 Compose 文件或自定义项目名，升级时沿用相同的 `-f`、`-p` 和环境文件参数。例如双协议实例：

```sh
docker compose --env-file deploy/.env -f compose.yaml -f deploy/compose.https.yaml up -d --build
```

邮件界面和 LLM 设置由这里的 Web/API 服务提供。只重打包 Windows 客户端不会更新这些页面；服务端升级后，刷新网页或在客户端按 `Ctrl+R`。桌面标题栏和系统集成的更新则需要安装新的客户端。

不要用 down -v 做日常升级。数据库迁移以事务执行并记录版本，初始化由数据库锁串行保护；迁移失败时 API 不会启动。初次部署支持空数据库，直接迁移旧的非标准 db:push 数据库前应先在备份副本上核对迁移历史。

## 本机 LLM 服务

在「设置 → LLM 服务商」填写 OpenAI 兼容的 API 基础地址（例如 `http://localhost:20128/v1`）。Compose 默认通过 `LLM_LOOPBACK_HOST=host.docker.internal` 将本机 HTTP 地址转向 Docker 宿主机，模型列表、测试消息、邮件 AI 和后台分类共用此映射。保存的地址和密钥无需修改。

服务商配置卡片和编辑表单均有「测试模型」按钮，发送一条简短消息并显示结果及耗时；编辑表单可在保存前测试。测试不使用邮件内容。

自托管环境也支持直接填写 `http://host.docker.internal:20128/v1` 或局域网 HTTP 地址，例如 `http://192.168.1.20:8080/v1`。局域网范围包括 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` 和 IPv6 ULA；这些地址保持原样连接。

若模型服务实际运行在 API 容器内，可在 `deploy/.env` 中设置空的 `LLM_LOOPBACK_HOST=` 关闭映射。Linux Docker 若无法解析 `host.docker.internal`，可为 `api` 和 `mail-sync` 增加 `extra_hosts: ['host.docker.internal:host-gateway']`。远程部署的 Zero 需要可从服务器访问的模型地址；这里的 localhost 不指向远程使用者的电脑。

## 通知

桌面端每 15 秒读取自己的通知事件。默认只显示“收到新邮件”，可选择显示发件人与主题；点击通知打开对应邮件。首次连接不通知历史邮件；后台同步首次导入、旧邮件重新缓存不应形成历史通知风暴。当前收件提醒限已同步、未读、收件箱中的近期邮件，收信延迟还受邮箱同步周期影响。应用退出、电脑休眠或网络断开时无法实时通知。

通知事件接口：`GET /api/desktop/events`，使用登录会话。第一次请求不带 after，取得当前游标；之后传 after 读取增量。该接口不是公共邮箱接口。`GET /api/desktop/info` 提供非敏感的客户端兼容信息。

## 验证

测试使用独立 Compose 项目、生成的账号和模拟邮件，不读取现有邮箱，不发送邮件：

```sh
HTTP_PORT=18080 docker compose --env-file deploy/.env -p zero-compose-test up -d --build
node deploy/tests/smoke.mjs
# 浏览器需要 Playwright Chromium；也可指定已有 Chrome 路径。
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome node deploy/tests/browser.cjs
npm test --prefix native/desktop
```

HTTPS 测试用进程级 NODE_EXTRA_CA_CERTS 信任测试证书，不关闭 TLS 验证或修改全局系统信任。最终验收结果见 VALIDATION.zh-CN.md。
