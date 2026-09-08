# 资源隔离与内存排查验收（2026-09-08）

本次目标是限制 AI/邮件处理的并发与容器占用，并查清通知轮询下 API 内存增长的来源。资源配置见 [部署说明](README.zh-CN.md#资源上限与普通邮件优先)。

## 发现与修复

- 实例在 2026-09-07 21:35:10（UTC+8）报 `JavaScript heap out of memory`，workerd 子进程退出，但 Node 父进程继续存活，网关持续返回 502。后台分类仍继续完成。
- 次日现场 API 占用约 1.23 GiB。最近 15 分钟 124 个请求中，120 个来自桌面通知：旧客户端每 15 秒做一次账号/游标探测，再做一次增量读取，因此一个客户端空闲时也会产生每分钟 8 个请求。
- `createAuthConfig()` 每次创建 Postgres 连接池而未保留关闭句柄。已改为请求内复用、最多一个连接，并在最外层 `finally` 中关闭；异常与未授权路径同样清理。请求 trace 也在结束时移除。自托管模式关闭认证遥测，并移除未配置可选 OAuth 服务商时每次请求重复输出的警告。
- 幂等/单次在途合并只会共享同时发生的同一读取，不会合并已经结束后的下一轮轮询，也不会回收数据库连接或运行时对象。
- 后台分类已从同步进程中拆出，使用独立容器、数据库连接池、advisory lock 和健康状态。API 阅读 AI、模型 HTTP 和普通邮件读取增加独立并发控制；不在 API 内维护无界等待队列。
- 分类按配置限制单批大小、请求总时长和成功后间隔。默认优先近 7 天待分类邮件；每 5 批安排一次等待较久邮箱的最旧邮件。手动同步优先于定时同步。分类成功和错误响应均限制 256 KiB，修补了兼容参数错误分支原先 `clone().json()` 无大小上限的问题。
- 活跃分类/同步每 5 秒轮询，空闲/错误时每 30 秒轮询。Windows 新包在账号不变时每轮仅请求增量一次；账号切换仍核对归属并使用独立游标。

## 合成负载证据与边界

所有压力、堆快照及分类 SQL 测试均在 `zero-pairing-test` 独立实例运行，不读取真实邮件、不请求真实模型。`resource-load.mjs` 通过真实配对流程取得临时测试会话，顺序调用通知接口；数据库连接数包含采样查询本身。

| 版本/测试 | 请求量与观察 |
| --- | --- |
| 原版 | 400 次通知请求，workerd RSS 399 → 557 MiB；另一轮触发 `sorry, too many clients already` / HTTP 500 |
| 应用连接清理后、原运行时 | 连续两轮共 4,000 次请求全部成功；采样连接数均为 1。但不主动 GC 时 RSS 仍从 276 MiB 增长到约 870 MiB |
| 应用清理后、原运行时的堆对比 | 额外 1,000 次请求后，GC 后已用 JS 堆约 91.0 → 97.1 MB（十进制）；快照增加约 2,002 个 `workerd / Socket` 及对应流/请求对象，表明还有运行时保留 |
| 最终稳定运行时 | Miniflare `4.20260730.0`，workerd 锁定 `1.20260908.1`。1,000 次请求全部成功，GC 后 JS 堆 90.57 → 95.47 MB；workerd RSS 259 → 285 MiB，采样数据库连接数均为 1 |

**没有把 RSS 增长全部归因于泄漏，也没有宣称残余运行时保留已完全消除。** GC 后仍可测到少量增长；仅减少 AI 并发不会解决通知请求的生命周期问题。稳定版运行时降低了本次测量的保留量，另以资源硬限额和实际子进程 RSS 监控限制长期影响。默认 RSS 连续三次超过 768 MiB 时退出并自动重启；容器硬上限 2 GiB。回收可能短暂中断正在进行的 API 请求。

## 验证

- 并发读取：不同邮件达到上限后拒绝新读取；相同邮件仍合并；完成、错误后释放槽位。
- AI HTTP：持续持有槽位直到流结束/取消；超限响应、请求错误、超时均释放槽位，过载返回 429 和 Retry-After。
- 分类真实 SQL：单批配置 2 封，先选最近两封，再按历史优先选最旧两封；冷却配置 17 秒生效，运行标记清理，四封均正常写入分类。
- Windows 通知：重复通知、并发 poll、账号切换、失败后重试及单轮单请求测试通过。
- 配对验收：口令入口禁用、来源校验、审批、私密设备凭据、轮询限额、一次性交换、拒绝/过期、Cookie 与原生 bearer、撤销、重启、迁移及恢复全部通过。
- 故障注入：在隔离实例中于 02:21:19 UTC 向 workerd 发送 SIGSTOP；02:21:49 监控记录 `reason=health`，容器重启计数从 0 变为 1，恢复后 `/health` 返回 200。持续超过内存阈值的行为由 watchdog 测试验证，未在真实实例中制造内存故障。
- 前端生产构建与 Worker bundle 构建通过。仓库完整 `tsc --noEmit` 仍受现有 Env、Outlook driver 和依赖类型错误阻塞；本次修改文件没有新增诊断。

## 当前实例与 Windows 交付

2026-09-08 10:23（UTC+8）已将新镜像及默认限额应用到实际使用的 `zero-compose-test` 项目，保留原数据库与持久卷。API、网页、邮件同步、分类、IMAP 桥接均健康；HTTPS 首页返回 200，未带凭据的通知 API 返回预期的 401。

Docker 实际限额核对：API 2 GiB / 2 CPU；同步 512 MiB / 0.5 CPU；分类 256 MiB / 0.5 CPU；桥接 512 MiB / 0.75 CPU，四者 memory+swap 总限额均与内存上限相同。启动后采样 API 容器约 333 MiB、同步约 24 MiB、分类约 16 MiB、桥接约 46 MiB；后续 workerd RSS 采样为 286 MiB，线上回收阈值 768 MiB。以上是部署验收快照，不代表长期稳定性已经得到证明。

上线复查修正了分类与数据库迁移的 advisory lock 编号冲突：同步占用 `(20260906,1)`，迁移使用 `(20260906,2)`，分类占用 `(20260906,3)`；已在当前数据库确认后台只持有 1 和 3。

新版 Windows 便携包位于 `native/desktop/release-resources/Zero Mail-1.0.0-win.zip`，ZIP 完整性检查通过，包内通知代码与已测源码一致。需要用户更新客户端后，桌面轮询减少才会生效。本环境缺少 Wine，NSIS 安装程序构建未完成；未交付不完整的 EXE。

运行方式：

```sh
# 同部署说明先构建 Worker 并启动合成实例；heap-probe 只连容器内部调试端口。
ZERO_PAIRING_WORKER=/tmp/zero-resource-final docker compose -f deploy/tests/compose.pairing.yaml up -d --build
docker cp deploy/tests/heap-probe.mjs zero-pairing-test-api-1:/tmp/heap-probe.mjs
ZERO_LOAD_HEAP=true node deploy/tests/resource-load.mjs
node deploy/tests/pairing.mjs
node --test deploy/tests/watchdog.test.mjs integrations/mail-sync/test/*.test.mjs
node --import tsx --test apps/server/src/lib/single-flight.test.ts apps/server/src/lib/limited-fetch.test.ts
```

Docker 限额行为参考 [Compose 服务配置](https://docs.docker.com/reference/compose-file/services/)。数据库资源关闭语义参考 [Postgres.js](https://github.com/porsager/postgres#teardown--cleanup)。运行时保留结论来自本项目合成堆快照；[workerd 已有 GC/RSS 问题报告](https://github.com/cloudflare/workerd/issues/6824)只提供相关背景，不作为“本例与该问题完全相同”的证明。

## 设置页补充验收（2026-09-08）

分类上限现可在“设置 → LLM 服务商”或“设置 → 视图”的“分类处理上限”中修改。六项工作区设置独立持久化，覆盖部署默认值；新批次读取新设置，在途批次正常结束。容器 CPU/内存硬限额仍保持部署侧保护。

- API：未登录读写返回 401；零、超范围、小数及额外工作区字段被拒绝；保存后回读一致，重启 API 后仍保留。
- 浏览器：中文字段正常显示，非法值禁用保存，保存并刷新保留修改；390 px 窄屏没有横向溢出。分类进度读取失败时仍能编辑上限。
- 实际分类调度器配合隔离模拟模型：读取保存的并发 2、批次 3 和最近/最旧排序；运行中改为并发 1、批次 1，既有批次完成后按新值继续，全程无需重启分类进程。
- SQL：新邮箱一次实际处理 25 封，验证用户上调值不会被旧默认 10 封限制；输出错误后的缩批以实际批次数量计算。
- 原分类测试、资源配置测试、前后端生产构建通过。完整类型检查仍存在仓库既有 Env/Outlook/依赖等诊断；分类设置组件及 API 未出现类型诊断。

复现新增验收：先启动前述隔离实例并构建 `zero-classification-settings-sync:test` 同步镜像，再运行 `node deploy/tests/classification-settings.mjs`。浏览器可通过 `ZERO_TEST_CHROMIUM` 指定本机 Chromium 可执行文件。测试仅使用合成工作区与模拟模型，不读取真实邮件，也不调用用户配置的模型。

本次设置页更新已于 2026-09-08 10:42（UTC+8）完成当前实例部署验收：API、网页、邮件同步及分类均健康，HTTPS 设置页返回 200；新增设置表已迁移，分类心跳正常。隔离测试实例已停止。
