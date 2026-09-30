# Contract Change Request — Agent 11（部署 / 运维 / 健康检查）

**Agent:** 11
**Module:** Ops（infra / compose / nginx / 运维脚本）+ 健康检查（`apps/api/src/modules/health`）
**日期:** 2026-09-30
**基线:** Development Contract v1.1 / Agent Rule v1.0

> 按 §9 / §18：本 Agent 动了**两个不属于自己的文件**（第 1、2 项），
> 另有 **2 项契约缺口**（第 4、5 项）与 **1 项真实部署风险**（第 6 项）。
>
> | #   | 事项                                              | 影响                 | 阻塞 |
> | --- | ------------------------------------------------- | -------------------- | ---- |
> | 1   | 改了 Agent 00 的 `bootstrap.ts`（加 `exclude`）   | Agent 00 / 14        | ❌   |
> | 2   | 改了 Agent 02 的 `auth-contract.spec.ts`（守卫）  | Agent 02             | ❌   |
> | 3   | `apps/api/src/modules/health/` 不在允许目录清单里 | 流程                 | ❌   |
> | 4   | `docs/04` 的 Health 段没给形状与状态码            | Agent 12 / 13 / 14   | ❌   |
> | 5   | 失败原因能不能外泄没有规定                        | **安全**（docs/14）  | ❌   |
> | 6   | ⚠ **worker 的 healthcheck 是个空壳**              | **运维**（告警盲区） | ❌   |
> | 7   | `docs/16` 的「TLS 指南」没有落点                  | 文档                 | ❌   |
> | 8   | 恢复流程里清 Redis 的时机                         | 运维                 | ❌   |
>
> **没有一项阻塞本次交付。**

---

## 1. 改了 Agent 00 的 `apps/api/src/bootstrap.ts`

### Current Problem

Agent 00 的 HANDOFF 写得很清楚：

> 「接入健康检查时请用 `setGlobalPrefix` 的 `exclude` 选项，不要改这里的前缀常量。」

但那条指令**只能由别人来执行** —— `bootstrap.ts` 是 Agent 00 的文件，
而「谁去写这个 `exclude`」在原计划里没有落点：

- Agent 11 的「允许修改」是 `infra/**` / `.github/workflows/**` /
  `docker-compose*.yml` / `Dockerfile*` / `scripts/ops/**` —— **不含** `apps/api`；
- 不写 `exclude` 的后果是**只在部署后出现**的：`/health/ready` 会变成
  `/api/v1/health/ready` → compose 的 healthcheck 打不到 →
  `depends_on: service_healthy` 卡死 → **整机起不来**，
  而 `pnpm test` 全绿（测试不读 compose）。

### 本模块的取值（**已实现**）

```ts
// apps/api/src/bootstrap.ts
export function applyApiPrefix(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX.slice(1), { exclude: HEALTH_ROUTE_EXCLUSIONS });
}
```

两处改动：

1. 加上 `exclude: HEALTH_ROUTE_EXCLUSIONS`（**从健康模块 import 常量**，
   不在 bootstrap 里手写路径）；
2. 把这一行抽成导出的 `applyApiPrefix()`，`createApiApp()` 调它。

第 2 点是**这条 CCR 真正的请求**。理由：

> `AppModule` 是空壳（根注册归 Agent 14），所以**任何测试都走不到
> `createApiApp()`**。Agent 08 / 09 / 10 的 HTTP 测试因此全都
> **手工复制**了这一行 `setGlobalPrefix`。
>
> 那正是本项目反复栽过的形状 —— 测试复制生产配置，于是**测试验的是
> 它自己那份副本**。具体到这里：删掉 `exclude` 之后生产会坏，
> 而所有测试仍然全绿。
>
> 抽出 `applyApiPrefix()` 之后，`health-routes.spec.ts` 调用**同一份
> 实现**，删掉 `exclude` 会让 5 条真 HTTP 用例立刻 404 变红。
> **反证已实测**（见 `agent-11-HANDOFF.md` 的 M1）。

### Requested Change

确认这处修改；并建议**把 `applyApiPrefix()` 的用法写进
`docs/18-multi-agent-coordination.md`**：后续 Agent 写 HTTP 测试时
不要再复制 `setGlobalPrefix`，直接调它。
（Agent 08 / 09 / 10 的现有测试仍各自复制了一份，本次**没有**去改它们 ——
那是三个文件、与本次交付无关，改与不改都不影响正确性。）

### Compatibility / Database Impact / API Impact

无。行为对等：`createApiApp()` 的前缀与 `exclude` 现在只多了一层函数调用。

**Downstream Impact：Agent 00（文件所有者）、Agent 14（集成时确认）。**

---

## 2. 改了 Agent 02 的 `apps/api/test/auth-contract.spec.ts`（安全守卫）

### Current Problem

该文件里有一条「业务模块不得绕过 ORM 写库 / 不得拼 SQL」的守卫，规则是：

```ts
/\$queryRaw(?!\s*(?:<[^>]*>)?\s*\(\s*Prisma\.sql)/; // 旧
```

即**只放行** `$queryRaw(Prisma.sql\`...\`)`这一种写法。而`$queryRaw`
有**两种**同样是参数化的标签模板写法：

```ts
await prisma.$queryRaw`SELECT 1`; // 直接用
await prisma.$queryRaw(Prisma.sql`SELECT 1`); // 显式 Prisma.sql
```

两者都把 `${}` 变成绑定参数，安全性没有区别（Prisma 官方文档把第一种
列为推荐写法）。旧正则只认第二种，于是 Agent 11 的健康探针被误报。

**第一次修法是错的**：我原本想「既然守卫只认 `Prisma.sql`，那就把
`Prisma.sql` 引进来」。那会让 `probes.ts` 依赖 `@prisma/client`，
而它本该是一个「什么 SQL 客户端都能用」的窄端口文件 ——
**为了过守卫而把设计改差**，是这次的教训。

### 本模块的取值（**已实现**）

```ts
/\$queryRaw(?!\s*(?:<[^>]*>)?\s*(?:`|\(\s*Prisma\.sql))/,   // 新
```

把真正的判据（**是不是标签模板**）写进正则：

| 写法                                    | 旧  | 新  |
| --------------------------------------- | --- | --- |
| ``$queryRaw`SELECT 1` ``                | ❌  | ✅  |
| ``$queryRaw(Prisma.sql`SELECT 1`)``     | ✅  | ✅  |
| ``$queryRaw(`… ${x}`)``（括号 + 拼接）  | ❌  | ❌  |
| `$queryRaw('… ' + x)`                   | ❌  | ❌  |
| `$queryRawUnsafe(...)` / `$executeRaw*` | ❌  | ❌  |

并且把「有牙齿」那条用例从**同义反复**改成跑**同一组正则**
（原来它用的是 `/\$(?:executeRaw|queryRaw|…)/` 那种「随便带 $queryRaw
都算」的粗正则，连真正的判据都没碰到）。**反证已实测**（M5：把正则退回旧版
→ 2 条用例变红）。

### Requested Change

确认放开第一种标签模板写法。**若维护者认为不应放开**，
替代方案是让探针改用 `Prisma.sql` —— 但那要求 `probes.ts` import
`@prisma/client`，请一并裁决是否接受那个代价。

### Compatibility / Database Impact / API Impact

无。守卫的拦截面只增不减的地方没有：新增放行的两种写法都被 Prisma
的类型系统要求为 `TemplateStringsArray | Sql`（传裸字符串编译不过），
真正的逃生口 `$queryRawUnsafe` 仍被拦。

**Downstream Impact：Agent 02（文件所有者）。**

---

## 3. `apps/api/src/modules/health/**` 不在 Agent 11 的「允许修改」目录清单里

### Current Problem

`tasks/agent-11-ops.md` 的「允许修改」只列了 `infra/**` /
`.github/workflows/**` / `docker-compose*.yml` / `Dockerfile*` /
`scripts/ops/**`；而同一份任务书的「必须」里写着 **health**。

`/health/live` 与 `/health/ready` 是 **api 进程里的 HTTP 路由**，
不可能只靠 `infra/` 实现（compose 的 healthcheck 正是打
`http://api:3001/health/ready`）。也就是说这份任务书的目录清单漏了一项。

### 本模块的取值（**已实现**）

新增 `apps/api/src/modules/health/`（8 个文件），并**没有**把它挂到
`apps/api/src/app.module.ts` —— 根注册仍归 Agent 14。

### Requested Change

把 `apps/api/src/modules/health/**` 写进 Agent 11 的「允许修改」，
或明确「health 由 Agent 14 实现、Agent 11 只提供 compose 侧」——
**但那就意味着 compose 的 healthcheck 在集成阶段之前一直打不通**，
不推荐。

### Compatibility / Database Impact / API Impact

新增 2 条路由（`docs/04` 的 Health 段本来就列了它们）。
不在 `/api/v1` 下，不影响任何现有路由。

**Downstream Impact：Agent 12 / 13（若要做健康面板）、Agent 14（挂载）。**

---

## 4. `docs/04` 的 Health 段没给响应体形状与状态码

### Current Problem

`docs/04` 的 Health 段只有两行路径：

```text
- `GET /health/live`
- `GET /health/ready`
ready 只依赖 MySQL / Redis。
```

没有响应体、没有状态码、没有封套约定。而 compose、
`scripts/ops/healthcheck.sh`、Uptime Kuma、Agent 12 的后台面板
都要读它。

### 本模块的取值（**已实现**）

```text
GET /health/live   → 永远 200
  {"status":"ok","uptimeSeconds":12345}

GET /health/ready  → 200（全部依赖 up）/ 503（任一 down）
  {"status":"ok","checks":{"mysql":{"status":"up"},"redis":{"status":"up"}}}
  {"status":"error","checks":{"mysql":{"status":"up"},
                              "redis":{"status":"down","reason":"UNREACHABLE"}}}

reason ∈ {UNREACHABLE, TIMEOUT, ERROR}   ← 只有这三个值，没有自由文本
```

三条刻意的约定，请一并确认：

1. **不用 `{data: …}` 封套。** 封套是**业务 API** 的约定（`docs/02`）；
   健康端点的消费者是 docker healthcheck 与运维脚本，要的是
   「HTTP 200 与否」和能直接读的诊断体。
2. **503 是手动设状态码，不是 `throw`。** `AppErrorFilter` 是 `@Catch()`，
   会把 `ServiceUnavailableException` 收敛成
   `{"error":{"code":"INTERNAL_ERROR"}}` → `checks` 全丢 →
   「只知道坏了、不知道谁坏了」。有真 HTTP 用例钉住这一点。
3. **不短路。** 全部探针并行跑，结果逐项都报 —— 运维需要一次看到
   「MySQL 挂了、Redis 还好」。

### Requested Change

把上面这张表写进 `docs/04` 的 Health 段（与实现逐字一致，
已有守卫钉住路径与状态码）。

### Compatibility / Database Impact / API Impact

无（新增）。

**Downstream Impact：Agent 12 / 13（若读健康数据）、Agent 14。**

---

## 5. ⚠ 失败原因能不能外泄：`docs/15` 没规定，但 `/health/` 是**对外可达**的

### Current Problem

`docs/15` 只说「`/health/ready`：MySQL + Redis 可用」。
而 `infra/nginx/nginx.conf` 有一条 `location /health/` 把它代理到公网
（`access_log off`，但仍然可达）。底层错误里最典型的两句是：

```text
connect ECONNREFUSED 10.0.0.5:3306
PrismaClientInitializationError: Can't reach database server at `10.0.0.5:3306`
```

`@signal/logger` 的 `redactString` 只覆盖**连接串里的密码段**
（`scheme://user:pass@host`）与内联 bearer 凭据 —— 它**不覆盖裸的
主机/端口**。把原始 message 放进响应体等于把内网拓扑送给任何会 curl 的人。

### 本模块的取值（**已实现**）

响应体里只有三个枚举值 `UNREACHABLE / TIMEOUT / ERROR`；
原始异常走 `onFailure` 回调进 logger（那里有脱敏与 requestId）。

两条通道**分开**，是为了让「想泄露」这件事**写不出来** ——
未来若有人把返回值直接塞进响应体，泄露的不是错误原文。
有一条用例正反两面都断言：响应体不含 `10.0.0.7` / `ECONNREFUSED`，
而日志**含**（否则等于把可诊断性也一起丢了）。

### Requested Change

在 `docs/14` 或 `docs/15` 里加一句：
「健康端点的响应体不得包含依赖的内部地址、错误原文或任何自由文本；
诊断信息只进日志。」并把 `/health/` 在 nginx 上**是否应该对公网开放**
明确一下（当前是开放的；若判定不该开放，去掉那条 location 即可，
监控改用内网地址）。

### Compatibility / Database Impact / API Impact

无。

**Downstream Impact：** 无（安全约定）。

---

## 6. ⚠⚠ **worker 的 healthcheck 是个空壳 —— 这是本次发现的真实部署风险**

### Current Problem

`docs/15` 定义的两个健康端点都是 **HTTP** 端点，而 **worker 不监听端口**。
于是 compose 里 worker 的 healthcheck 只能写成这样：

```yaml
test: ['CMD-SHELL', 'test -d /proc/1']
```

这**不是一个健康检查**：容器还在跑，`/proc/1` 就一定存在。
它检测的是「容器死没死」—— 而那件事 docker 自己本来就知道。
它**测不到**唯一值得测的那种故障：

> worker 进程活着、但**消费者卡死了**（BullMQ worker 连接僵住、
> 一个 handler 里出现死循环或未释放的 await）。
> 此时 `/proc/1` 在、docker 说 healthy、**队列在堆积、
> 日报不会生成、而所有告警都是绿的**。

`docs/15` 的告警清单里有一条「Queue backlog 超阈值」——
那是唯一的兜底，但它不是容器健康检查，且需要额外的监控系统。

### 本模块的取值（**只做了如实记录，没有偷偷糊过去**）

compose 里那条注释已经写明了它是「近似判据」，HANDOFF 的
Known Limitations 里也单列了这一条。**没有**把它伪装成 ready 语义。

### Requested Change

请裁决要不要给 worker 一个真正的健康信号。三个候选：

- **A（推荐，改动最小）**：worker 每 30 秒 touch 一个心跳文件，
  healthcheck 判它的 mtime 是否在 90 秒内。需要在 worker 的
  事件循环里挂一个 `setInterval`（`apps/worker` 的入口属 Agent 00/14）。
- **B**：worker 起一个只监听 `internal` 网络的极小 HTTP 端口，
  提供 `/health/ready`（Redis 可达 + 队列消费者在跑）。
- **C**：接受现状，但把「Queue backlog 超阈值」在 Uptime Kuma 上
  配起来，并在 `docs/15` 里写明「worker 没有容器级健康语义」。

**A 与 C 可以同时做。** 无论选哪个，都请把结论写进 `docs/15`。

### Compatibility / Database Impact / API Impact

无（worker 不对外）。

**Downstream Impact：Agent 14（若要改 worker 入口）。**

---

## 7. `docs/16` 的「TLS 指南」原本没有落点（已补）

### Current Problem

任务书要求「TLS 指南」，`docker-compose.yml` 与 `nginx.conf` **两处**
都写着「见 `infra/nginx/README.md`」—— 而那份文件**当时并不存在**。
悬空引用不会让任何测试变红。

而且这块有一个真正的坑：**证书不存在时 nginx 起不来**
（`cannot load certificate`，healthcheck `nginx -t` 永远不过 → 反复重启），
而 ACME 的 webroot 验证又需要一个能对外提供 80 的 nginx。**先有鸡还是先有蛋。**
只写「用 certbot 签一张」是不够的。

### 本模块的取值（**已实现**）

补了 `infra/nginx/README.md`：首次部署六步（含**自签证书占位**解开上面那个环）、
续期 cron（webroot 方式，不需要停 nginx；并指明「证书续了还要
`nginx -s reload`」这个最常见的坑）、排查表。
`verify-deploy.mjs` 里加了 4 条守卫（文件存在、含 `openssl req -x509`、
含续期、compose 引用的仓库内文件都存在）。

### Requested Change

在 `docs/16` 的 Nginx 段里指向 `infra/nginx/README.md`。

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：** 无。

---

## 8. 恢复流程里「清 Redis」的时机（**只是观察，不建议改**）

### Current Problem

`docs/16` 的顺序是 `5. 启 API → 6. 启 Worker → 7. 清建 Redis cache`，
`scripts/ops/restore-mysql.sh` 逐字照做。于是有**几秒的窗口**：
API 已经起来、Redis 缓存还没清，前台可能读到**回滚前**的缓存内容
（TTL 最长 60 秒）。

### 本模块的取值（**未改，跟随文档**）

**刻意没有**把清缓存挪到启应用之前 —— 那会更「正确」，
但会**偏离 `docs/16` 写明的步骤**。运维手册与脚本不一致比这 3 秒窗口危险得多。
所以这里只记录，不动。

### Requested Change

若维护者同意，把 `docs/16` 的顺序改成
`… 4. migrate status → 5. 清 Redis → 6. 启 API → 7. 启 Worker → 8. health check → 9. 核对`，
我随之改脚本。

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：** 无（运维手册）。

---

## 附：Agent 10 的 CCR 第 3 项点名了本 Agent

Agent 10 的 CCR 写：

> **3. 缓存 TTL 未定义** … **Downstream Impact：Agent 11**（运维要知道缓存的最长陈旧时间）

回答（已写进 `agent-11-HANDOFF.md`）：**内容类 60 秒、元数据类 300 秒**。
对运维的含义有两条，都已在 HANDOFF 的 Integration Notes 里写明：

1. **恢复演练后必须清缓存** —— 恢复脚本第 7 步 `FLUSHALL` 已经做了；
   漏掉会出现「数据库回滚了、前台还在展示回滚前的内容」。
2. **备份/恢复的 RTO/RPO 不受缓存影响** —— `docs/13` 的
   「Redis 不是业务数据库」成立了，所以 compose 里 Redis
   **刻意关掉持久化**（`--save '' --appendonly no`）。
