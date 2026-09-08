# Docker Compose 自托管

[中文首页](../README.zh-CN.md) · [1.0.0 更新说明](../CHANGELOG.zh-CN.md) · [Windows 客户端](../native/desktop/README.zh-CN.md)

本部署将 API、后台邮件同步、IMAP/SMTP 桥接、PostgreSQL、Valkey、Redis HTTP 适配器和 Web 入口放在同一个 Compose 项目中。不需要 Cloudflare 账号，不启动 `wrangler dev`。API 使用固定版本 Miniflare 管理 workerd 及本地 Workers 绑定；这是单机、单实例部署，不等同于 Cloudflare 的多区域托管平台。不要给 API、同步任务或桥接直接增加副本。

## 启动

需要 Docker Engine 和 Compose v2.20+，以及用于首次生成配置的 Node.js 22.12+。在仓库根目录：

```sh
node deploy/init.mjs http://localhost:8080
docker compose --env-file deploy/.env up -d --build
docker compose --env-file deploy/.env ps
```

打开配置的 PUBLIC_URL，填写设备名称并生成配对码。首台设备在服务器终端授权：

```sh
docker compose --env-file deploy/.env exec api node pairing.mjs approve ABCD-EFGH
```

将示例替换为设备显示的配对码，核对设备信息后输入 `yes`。后续设备在已登录设备上扫码，或进入「设置 → 安全」输入配对码并确认。所有设备访问同一工作区，各自拥有可撤销的会话。账号密码登录和公开注册均关闭。

升级会保留现有工作区 ID 和邮箱／LLM 配置，一次性使旧登录会话失效，重新配对后继续使用。旧访客工作区不自动归并；发现多个现有工作区且不能确定归属时，迁移停止，需配置 `PAIRING_OWNER_ID`。完整流程、恢复和各端接入见[配对认证说明](AUTHENTICATION.zh-CN.md)。

生成脚本拒绝覆盖已有 deploy/.env。其中包含数据库密码和加密密钥，不要提交 Git。新部署无需设置 `ADMIN_EMAIL` 或 `ADMIN_PASSWORD`；旧 `ADMIN_EMAIL` 仅用于首次升级识别工作区，`ADMIN_PASSWORD` 不再读取。网页中的 LLM 设置仍可直接配置服务商，不必填写服务器 AI 环境变量。

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

若模型服务实际运行在 API 容器内，可在 `deploy/.env` 中设置空的 `LLM_LOOPBACK_HOST=` 关闭映射。Linux Docker 若无法解析 `host.docker.internal`，可为 `api`、`mail-sync` 和 `mail-classifier` 增加 `extra_hosts: ['host.docker.internal:host-gateway']`。远程部署的 Zero 需要可从服务器访问的模型地址；这里的 localhost 不指向远程使用者的电脑。

## 通知

桌面端每 15 秒读取自己的通知事件。默认只显示“收到新邮件”，可选择显示发件人与主题；点击通知打开对应邮件。首次连接不通知历史邮件；后台同步首次导入、旧邮件重新缓存不应形成历史通知风暴。当前收件提醒限已同步、未读、收件箱中的近期邮件，收信延迟还受邮箱同步周期影响。应用退出、电脑休眠或网络断开时无法实时通知。

通知事件接口：`GET /api/desktop/events`，使用登录会话。第一次请求不带 after，取得当前游标；之后传 after 读取增量。该接口不是公共邮箱接口。`GET /api/desktop/info` 提供非敏感的客户端兼容信息。

## 验证

认证测试使用独立 Compose 项目和合成数据，不读取现有邮箱，不发送邮件：

```sh
pnpm --filter @zero/server exec wrangler deploy --dry-run --config wrangler.compose.json --outdir /tmp/zero-pairing-worker
ZERO_COMPOSE_BUILD=true pnpm --filter @zero/mail build
docker compose -f deploy/tests/compose.pairing.yaml up -d --build
node deploy/tests/pairing.mjs
# 浏览器需要 Playwright Chromium；也可指定已有 Chrome 路径。
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome node deploy/tests/pairing-browser.cjs
npm test --prefix native/desktop
```

HTTPS 测试用进程级 NODE_EXTRA_CA_CERTS 信任测试证书，不关闭 TLS 验证或修改全局系统信任。最终验收结果见 VALIDATION.zh-CN.md。

## 资源上限与普通邮件优先

日常修改分类上限，请打开 **设置 → LLM 服务商**（或 **设置 → 视图**）中的“分类处理上限”。可修改同时分类的邮箱数、每批邮件数、批次间隔、请求超时、近期邮件天数及历史邮件处理频率，点击“保存分类上限”后持久保存在当前工作区。后台在新批次开始时读取设置，无需重启或重新配对；已经开始的批次正常完成，调低并发后等待在途批次释放名额。“使用默认值”会填入部署默认值，仍需点击保存。

未在页面保存时，分类使用 `deploy/.env` 的默认值；页面保存值优先于对应的 `AI_CLASSIFY_*`、`AI_RECENT_DAYS`、`AI_HISTORY_EVERY_BATCHES` 环境变量。容器 CPU/内存硬限额仍由部署配置管理：修改后沿用原项目名及 Compose 文件执行 `docker compose ... up -d --build`。以下是默认值；CPU 的 `0.5` 表示最多使用半个逻辑核心的计算时间。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `API_MEMORY_LIMIT` / `API_CPU_LIMIT` | `2g` / `2.0` | API 容器硬上限 |
| `API_MEMORY_RESTART_MB` | `768` | workerd RSS 连续三次超过此值时回收重启，须低于容器上限并留出启动余量 |
| `MAIL_SYNC_MEMORY_LIMIT` / `MAIL_SYNC_CPU_LIMIT` | `512m` / `0.5` | 邮件同步容器硬上限 |
| `IMAP_BRIDGE_MEMORY_LIMIT` / `IMAP_BRIDGE_CPU_LIMIT` | `512m` / `0.75` | 邮箱桥接容器硬上限 |
| `AI_MEMORY_LIMIT` / `AI_CPU_LIMIT` | `256m` / `0.5` | 独立后台分类容器硬上限 |
| `AI_REQUEST_CONCURRENCY` | `2` | API 内同时进行的模型 HTTP 请求上限；AI 阅读任务也受此并发上限约束 |
| `MAIL_READ_CONCURRENCY` | `4` | API 内同时读取的不同邮件数量，相同邮件的并发读取合并 |
| `SYNC_ACCOUNT_CONCURRENCY` | `1` | 同时同步的邮箱数（1–4） |
| `SYNC_MESSAGE_CONCURRENCY` | `2` | 每个 OAuth 邮箱同时获取的邮件元数据数量（1–8） |
| `AI_CLASSIFY_CONCURRENCY` | `1` | 工作区同时分类的邮箱数默认值（1–4），可在设置中覆盖 |
| `AI_CLASSIFY_BATCH_SIZE` | `10` | 单批邮件数上限默认值（1–50），输出错误后仍可自动缩小 |
| `AI_CLASSIFY_INTERVAL_SECONDS` | `10` | 同一邮箱成功分类后到下一批的最短间隔（2–3600 秒） |
| `AI_CLASSIFY_TIMEOUT_SECONDS` | `60` | 单批模型请求总时限（5–120 秒，含兼容参数重试） |
| `AI_RECENT_DAYS` | `7` | 优先选择含近期待分类邮件的邮箱 |
| `AI_HISTORY_EVERY_BATCHES` | `5` | 每 N 批让等待较久的邮箱处理最旧邮件（1–100），防止历史邮件饥饿 |

分类与同步使用不同容器、数据库连接池及单实例锁，分类失败不占用同步槽位。每个工作区默认分类最多有 `1 × 10 = 10` 封邮件处于模型批次中，设置页显示该乘积；分类进程跨工作区最多同时处理 4 个邮箱。OAuth 同步最多有 `1 × 2 = 2` 个元数据请求同时进行。IMAP 同步使用顺序执行的有界信封窗口，不批量获取正文。用户主动要求的同步优先于定时同步；分类任务在数据库中等待，进程中不堆积无界任务队列。

交互式 AI 和读信达到并发上限时返回 429，而不是无限等待。读信沿用有界退避重试；AI 请求限制持续到响应体结束、取消或超时，响应体最多 1 MiB。分类成功和错误响应均限制在 256 KiB。资源限额适用于 Zero 进程；外部或宿主机上的模型推理服务需在其自身配置 CPU/GPU/显存限额。

容器内存与 swap 总限额相同，防止后台任务通过大量换页拖慢其他服务。资源上限不等于预留：宿主机上其他应用仍需留有余量。API 的 workerd 子进程连续三次健康探测失败时，父进程退出，由 Docker 重启策略恢复，避免外层容器存活而接口持续 502。监控同时读取 workerd 子进程的 RSS，而不是 Node 父进程的堆；连续三次超过 `API_MEMORY_RESTART_MB` 时主动回收。重启期间可能短暂中断请求，它是残余运行时保留的保护措施，不是无中断切换或“泄漏已完全消除”的保证。

分类/同步状态在活跃时每 5 秒刷新，空闲或请求错误后每 30 秒刷新，隐藏页面不持续轮询。Windows 客户端通知仍每 15 秒检查；新版客户端在账号不变时每轮只发一次增量请求（旧客户端需要更新安装包才会减少这一请求）。幂等与并发合并不替代轮询节流，也不能修复连接池或请求上下文泄漏。
