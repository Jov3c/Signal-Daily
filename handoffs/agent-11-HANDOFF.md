# Handoff — Agent 11（部署 / 运维 / 健康检查）

| 项               | 值                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| **Agent**        | 11                                                                                                    |
| **任务**         | `tasks/agent-11-ops.md` —— 让香港 VPS 单机生产可运行                                                  |
| **依赖**         | 00（后期接全系统：01 / 02 / 04 / 05 / 06 / 08 / 10 已读）                                             |
| **日期**         | 2026-09-30                                                                                            |
| **状态**         | ✅ 已完成（含 1 项**如实上报的部署风险**，见 Known Limitations 第 1 条）                              |
| **提交**         | `3f8e819`（infra / compose / nginx / 运维脚本 / deploy workflow）<br>`4f0b8b2`（健康检查 + TLS 指南） |
| **CCR**          | [CONTRACT_CHANGE_REQUEST-agent-11.md](./CONTRACT_CHANGE_REQUEST-agent-11.md)（8 项，无一阻塞）        |
| **§23 独立审查** | 未做。见文末「关于 §23」。                                                                            |

---

## Task

`tasks/agent-11-ops.md`：

> **必须**：Compose、Nginx same-origin、TLS 指南、MySQL/Redis internal-only、
> health、log rotate、backup/restore、deploy workflow、migration gate。
> **测试**：compose validate、container health、nginx route、backup 产物、
> 空测试库 restore、镜像不含 secret。

拆成两批交付：`3f8e819`（基础设施形态）与本提交（**健康检查** ——
compose 的 `api` healthcheck 依赖它，缺了它整栈起不来）。

---

## Implemented

### 1. 健康检查 —— `apps/api/src/modules/health/`

```text
routes.ts        路径的唯一真源（四个地方要就同一组路径达成一致）
ports.ts         readiness 的允许清单 + 失败原因的枚举
probes.ts        两条真实探针（MySQL / Redis）+ 失败归类
redis-client.ts  探针专用连接（参数与 Agent 02 的限流器**有意相反**）
service.ts       live() / ready() + 探针覆盖不变式
controller.ts    两条路由
module.ts        装配
index.ts         公开面
```

`GET /health/live` → 永远 200；`GET /health/ready` → 全 up 则 200，否则 503。
两条都**不在** `/api/v1` 下（`docs/04`）。

**五个刻意决定**（每条都有守卫）：

| 决定                                                        | 不这么做会怎样                                                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live()` **一个依赖都不查**                                 | 一次 MySQL 抖动会让**所有** api 容器被反复重启，而重启不会让 MySQL 更快恢复 —— 把「依赖短暂不可用」放大成「服务整体不可用」                           |
| `ready()` **并行、不短路**                                  | 第二个故障要等第一个修好才暴露                                                                                                                        |
| 503 用 `@Res` 手动设状态码，**不 throw**                    | `AppErrorFilter` 是 `@Catch()`，会把 `ServiceUnavailableException` 收敛成 `{error:{code:"INTERNAL_ERROR"}}`，`checks` 全丢 → 只知道坏了、不知道谁坏了 |
| 失败原因只有 `UNREACHABLE` / `TIMEOUT` / `ERROR` 三个枚举值 | `/health/` 在 nginx 上对外可达，而 `redactString` **不覆盖**裸的主机/端口 → 原始 message 进响应体等于泄露内网拓扑                                     |
| 探针**不抛异常**（连不上是 `down`，不是异常）               | 「该重启 Redis」与「该修探针」这两件事会混在同一个 503 告警里                                                                                         |

**探针覆盖不变式**：`HealthService` 的构造函数断言「每个声明依赖恰好一条探针」。
这是本类里唯一能出现的**静默错误** —— 漏接 mysql 时 `every(up)` 只看 redis，
`/health/ready` 会永远返回 200 而数据库根本没人问过。接线错了就在**启动时**炸。

### 2. 全局前缀的 `exclude` —— `apps/api/src/bootstrap.ts`（Agent 00 的文件）

```ts
export function applyApiPrefix(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX.slice(1), { exclude: HEALTH_ROUTE_EXCLUSIONS });
}
```

抽出 `applyApiPrefix()` 是这次最要紧的一处（**CCR 第 1 项**）：
`AppModule` 是空壳，测试走不到 `createApiApp()`，于是它们全都**手工复制**了
这一行 `setGlobalPrefix` —— 测试复制生产配置，**测试验的是自己那份副本**。
删掉 `exclude` 生产会坏而测试全绿。现在测试调**同一份实现**（M1 反证）。

### 3. `ops:verify`

根 `package.json` 加 `"ops:verify": "node scripts/ops/verify-deploy.mjs"`，
并**纳入 `pnpm verify`** —— 「一条命令验完」比「记得额外跑一个脚本」可靠。
（`infra/` 与 `scripts/` 不在 `vitest.config.mts` 的 include 里，
所以它做成可独立运行的脚本而不是 vitest 用例。）

### 4. TLS 指南 —— `infra/nginx/README.md`（新增）

`docker-compose.yml` 与 `nginx.conf` **两处**都写着「见 `infra/nginx/README.md`」，
而那份文件当时**并不存在**。补上了，并且补上那个真正的坑：

> **证书不存在时 nginx 起不来**（`cannot load certificate` → healthcheck
> `nginx -t` 永远不过 → 反复重启），而 ACME 的 webroot 验证又需要一个能对外
> 提供 80 的 nginx。**先有鸡还是先有蛋。** 解法是先用一张自签证书占位。

含：首次部署六步、续期 cron（webroot 方式不需要停 nginx，并指明
「证书续了还要 `nginx -s reload`」这个最常见的坑）、排查表。

### 5. 跨产物一致性守卫（这是本次最花心思的一块）

`/health/live` 与 `/health/ready` 被写在**四处**，分属不同文件、不同语言，
编译期谁也管不到谁：

```text
1. controller.ts 的 @Controller/@Get       路由真正注册在哪
2. bootstrap.ts 的 setGlobalPrefix.exclude 决定它加了前缀后是否还叫这个名字
3. docker-compose.yml 的 api healthcheck   一个 fetch 的 URL 字面量
4. scripts/ops/healthcheck.sh              两个 bash 字面量
```

四处里任意一处写错的后果**完全一样**：容器永远 `starting`、
`depends_on: service_healthy` 卡死、整机起不来，而 `pnpm test` **全绿**
（测试不读 compose）。

所以把路径抽成 `routes.ts` 的常量，并由 `health-routes.spec.ts` 把第 3、4 处
的字面量**读出来与可执行的常量逐字比对**，还真的对那条路径发一次 HTTP。
`verify-deploy.mjs` 那边补的是部署形态那一半（exclude 有没有接上、
compose 打的是不是 `/health/`、nginx 有没有 `/health/` location）。

### 6. `auth-contract.spec.ts` 的原生 SQL 守卫（Agent 02 的文件，**CCR 第 2 项**）

旧正则只放行 `$queryRaw(Prisma.sql\`…\`)`，把 `$queryRaw\`…\``（**另一种同样
参数化**的标签模板写法）判成违规。改成认「是不是标签模板」这个真正的判据，
并把「有牙齿」那条从**同义反复**改成跑同一组正则（M5 反证）。

**过程中的一次自我纠正**：我第一反应是「那就把 `Prisma.sql` 引进来过守卫」——
那会让 `probes.ts` 依赖 `@prisma/client`，而它本该是一个什么 SQL 客户端都能用的
窄端口文件。**为了过守卫把设计改差**是这次记下的教训；改成修守卫之后，
`SqlPinger` 端口顺势收敛成 `{ ping(): Promise<unknown> }` ——
探针不再假装自己是 Prisma，SQL 只出现在装配处一行。

---

## Files Added

```text
apps/api/src/modules/health/routes.ts
apps/api/src/modules/health/ports.ts
apps/api/src/modules/health/probes.ts
apps/api/src/modules/health/redis-client.ts
apps/api/src/modules/health/service.ts
apps/api/src/modules/health/controller.ts
apps/api/src/modules/health/module.ts
apps/api/src/modules/health/index.ts
apps/api/test/health-routes.spec.ts            33 条（真 HTTP + 跨产物一致性）
apps/api/test/health-db.integration.spec.ts     7 条（真 MySQL + 真 Redis）
infra/nginx/README.md                           TLS 指南
handoffs/CONTRACT_CHANGE_REQUEST-agent-11.md
handoffs/agent-11-HANDOFF.md
```

（`3f8e819` 已交付：`docker-compose.yml`、`infra/Dockerfile`、
`infra/nginx/nginx.conf`、`infra/mysql/my.cnf`、`infra/ops-check.env`、
`.dockerignore`、`scripts/ops/*`、`.github/workflows/deploy.yml`）

## Files Modified

| 文件                                  | 归属     | 改了什么                                                                 |
| ------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `apps/api/src/bootstrap.ts`           | Agent 00 | 加 `exclude`；抽出 `applyApiPrefix()`（**CCR 第 1 项**）                 |
| `apps/api/test/auth-contract.spec.ts` | Agent 02 | 原生 SQL 守卫放宽到认标签模板；牙齿用例改跑同一组正则（**CCR 第 2 项**） |
| `scripts/ops/verify-deploy.mjs`       | Agent 11 | 61 → 73 项：健康检查路径、bootstrap exclude、悬空引用                    |
| `package.json`（根）                  | 共享     | `ops:verify` 脚本；`verify` 纳入它                                       |

**没有**动 `apps/api/src/app.module.ts`（根注册归 Agent 14）。

---

## Database Migrations

**无。** 健康检查只读（`SELECT 1`），不碰任何业务表，也不需要迁移。

## Environment Variables

**没有新增。** `docs/20` 的清单不变 —— 探针超时是常量（`PROBE_TIMEOUT_MS`），
不是 env。健康模块只读既有的 `DATABASE_URL` 与 `REDIS_URL`。

## Events / Queues

**无。** 健康检查不产生也不消费任何 job。

---

## Test Results

```text
pnpm verify                     ✓ lint + 三个包的 typecheck（含测试文件）
                                ✓ 81 files / 1823 tests
                                ✓ ops:verify 73 项

pnpm --filter @signal/api test:integration
  REDIS_URL=redis://127.0.0.1:6390
                                ✓ 9 files / 122 tests（真 MySQL + 真 Redis）
                                  新增 7 条 = health-db.integration.spec.ts

pnpm --filter @signal/worker test:integration   ✓ 8 files / 145 tests（未触及）

node scripts/ops/verify-deploy.mjs              ✓ 73 项（含真实 docker compose config）
```

与 `1f16b2a` 时相比：`1789 → 1823`（+33 健康用例、+1 守卫牙齿用例）。

---

## 反证记录（§23.5 手法，**5 条，全部实测**）

| #   | 变异                                            | 结果                                                                                           |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| M1  | `applyApiPrefix` 去掉 `exclude`                 | 🔴 `/health/live → 200` 等 5 条真 HTTP 用例变红（路径变成 `/api/v1/...`）                      |
| M2  | `HEALTH_READY_SEGMENT` 改成 `'readyz'`          | 🔴 compose 逐字比对用例变红（**证明跨产物守卫不是空转**）                                      |
| M3  | `PROBE_TIMEOUT_MS` 改成 6000（> compose 的 5s） | 🔴 「探针预算必须小于 healthcheck timeout」变红                                                |
| M4  | `enableOfflineQueue` 改回 `false`               | 🔴 **2 条**真 Redis 用例变红 —— `Redis 探针 → up` 与「全新连接的第一个 ping() 就成功」（见下） |
| M5  | 原生 SQL 守卫的正则退回旧版                     | 🔴 `auth-contract.spec.ts` 2 条变红（**证明我对那条守卫的修改是承重的**）                      |

全部变异已还原，还原后 `pnpm verify` 全绿。

**M4 值得单独说** —— 它是这次唯一一个「靠实测才站住」的判断：

```text
redis://127.0.0.1:1 + { lazyConnect: true, connectTimeout: 1000,
                        maxRetriesPerRequest: 1 } 的 ping()
  enableOfflineQueue: true   → 连不上时 68ms 返回 MaxRetriesPerRequestError（正确）
  enableOfflineQueue: false  → **健康 Redis 上的第一个 ping() 也失败**
```

原因是 `ioredis` 的 `sendCommand()` 先看状态再判可写性，而 `lazyConnect` 下
`connect()` 是异步的 —— 第一个命令执行到判定时状态必然是 `connecting`。
表现是「容器起来后的第一次 healthcheck 是红的，重启一次就好了」，
**极难复现**。直觉写法（`false`）是错的，注释与用例都钉住了这一点。

---

## Known Limitations

### 设计取舍（§23.8 要求逐条记录）

**1. ⚠⚠ worker 的 healthcheck 是个空壳 —— 这是本次发现的真实风险**

```yaml
worker:
  healthcheck:
    test: ['CMD-SHELL', 'test -d /proc/1']
```

`docs/15` 定义的两个健康端点都是 **HTTP**，而 worker 不监听端口，
所以 compose 里只能写成这样。但**这不是一个健康检查**：容器还在跑，
`/proc/1` 就一定在。它检测的是「容器死没死」—— 那件事 docker 自己本来就知道。

它测不到唯一值得测的那种故障：**进程活着但消费者卡死了**
（BullMQ 连接僵住、handler 里死循环）。此时 docker 说 healthy、
**队列在堆积、日报不会生成、而所有告警都是绿的**。

compose 的注释、CCR 第 6 项都已如实写明，**没有**把它伪装成 ready 语义。
三个候选方案（心跳文件 / 最小 HTTP 端口 / 靠队列积压告警）在 CCR 第 6 项，
请裁决。

**2. `PROBE_TIMEOUT_MS = 3000` 是实测边界，不是拍的**

MySQL 不可达时 Prisma 报 `Can't reach database server` 实测约 **2050ms**。
预算若是 2000 就会正好卡在它前面 → 具体原因被自己的超时盖成笼统的 `TIMEOUT`。
代价：MySQL 真挂时整条 readiness 最坏耗时约 3 秒（仍在 compose 的 5s 之内，
有守卫钉住这个不等式）。若某天 Prisma 变慢，请上调预算而**不是**下调。

**3. 一个依赖有多条探针时会算重复**（`assertProbesCoverDependencies` 会抛）

这是刻意的：一个依赖出现两条探针说明接线有歧义（哪条代表它？）。
真要加「主备两个 Redis」，应该在一个探针内部表达，而不是挂两条。

**4. 探针超时是 `Promise.race`，被放弃的那条 promise 无法真正取消**

`$queryRaw` 与 `ping()` 都不接受 `AbortSignal`。所以超时后底层连接仍在
自己走完（由 ioredis 的 `connectTimeout: 1000` 与 Prisma 自己的
`connect_timeout` 兜底）。**没有**为此引入一个「可取消查询」的抽象 ——
那会为了一个 3 秒的场景把端口复杂化。

**5. 没有 Sentry / Uptime Kuma 的接入代码**

`docs/15` 把这两个列为「推荐监控，不强制」。本模块只提供
它们要探的两个端点。告警规则（5xx 激增 / Queue backlog / Source 连续失败 /
07:30 日报未 review）**没有**落在代码里 —— 它们属于监控系统配置，
不属于仓库。（worker 那条见第 1 条。）

**6. 恢复流程里清 Redis 的时机跟随 `docs/16`，没有「改对」**

`docs/16` 的顺序是「启 API → 启 Worker → 清 Redis」，于是有几秒窗口
前台可能读到回滚前的缓存（TTL 最长 60 秒）。**刻意没改** ——
运维手册与脚本不一致比这 3 秒窗口危险得多。CCR 第 8 项记录了这件事，
若维护者改文档，我随之改脚本。

**7. `verify-deploy.mjs` 是文本断言，不是语义断言**

它读 YAML / conf 的**文本**（因为 `infra/` 不在 vitest 的 include 里）。
所以「mysql 没有宿主端口」这类断言依赖缩进与键名写法。
真实的插值校验靠 `docker compose config --quiet`（装了 docker 才跑，
跳过时**会打印**，不算通过）。

### 未修复但已上报

- **worker 没有真正的健康信号** —— CCR 第 6 项，需裁决（上面第 1 条）。
- **`docs/04` 的 Health 段没给形状** —— 实现已可用，请把 CCR 第 4 项那张表抄进文档。
- **`docs/15` 没规定失败原因能否外泄** —— CCR 第 5 项。
- **`/health/` 是否应该对公网开放** —— 当前 nginx 是开放的（`access_log off`）。
  响应体已保证不含内网信息，但「要不要开放」是产品/安全决定，请裁决（CCR 第 5 项）。

---

## Contract Change Requests

8 项，**无一阻塞**。逐条见
[CONTRACT_CHANGE_REQUEST-agent-11.md](./CONTRACT_CHANGE_REQUEST-agent-11.md)。

其中**需要动作**的两项：

| #   | 事项                                         | 需要谁              |
| --- | -------------------------------------------- | ------------------- |
| 1   | `applyApiPrefix()` 的用法写进 `docs/18`      | Agent 00 / 14       |
| 6   | worker 健康信号（心跳文件 / 最小 HTTP 端口） | **裁决** + Agent 14 |

---

## Integration Notes

### 给 Agent 14（最终集成）—— 必做

```ts
// apps/api/src/app.module.ts
import { CommonModule } from './common/common.module';
import { HealthModule } from './modules/health';

@Module({ imports: [CommonModule, HealthModule /* 其余模块 */] })
export class AppModule {}
```

1. **挂 `HealthModule`** —— 不挂的话 compose 的 api healthcheck
   （打 `http://api:3001/health/ready`）永远 503，整栈起不来。
2. **不要重复注册 `APP_FILTER`** —— `HealthModule` 会 `imports: [CommonModule]`
   （为了 `PrismaService` 与 `APP_LOGGER`），Nest 按模块 token 去重，
   再 import 一次是安全的。但**手动**再注册一个过滤器会破坏 `@Res` 的设计。
   具体地：**不要把 `/health/*` 加进任何全局守卫或全局拦截器**。
3. `HealthModule` 会自己开一条 Redis 连接并在 `onModuleDestroy` 里关掉它 ——
   与 Agent 02 的限流连接、Agent 10 的缓存连接各是各的。这是刻意的：
   它们的故障语义不同（探活 fail-fast / 限流 fail-closed / 缓存 fail-open）。
4. 挂上 `HealthModule` 之后，`health-routes.spec.ts` 里那条「接线断言」
   （`bootstrap.ts` 调了 `applyApiPrefix`）可以升级成对 `createApiApp()` 的
   **真 HTTP** 断言 —— 那时 `/health/ready` 在真 app 上应该直接 200。
   文件里有注释标了这件事。

### 给 Agent 12 / 13

- **不要**用 `/health/*` 做前台或后台的「系统状态」展示。
  它是给 docker 与运维用的（无封套、无鉴权、可能 503）。
  后台要做系统面板，请另开一条 Admin 路由自己聚合数据。
- 如果前台要「内容有多新」的语义，用 API 而不是缓存：
  **缓存最长陈旧 60 秒（内容）/ 300 秒（元数据）**（Agent 10 的 CCR 第 3 项
  点名要本 Agent 确认这个数字）。

### 运维要点（回答 Agent 10 的 CCR 第 3 项）

```text
内容类缓存 TTL 60s      → 后台点「撤下」后，前台最多 60 秒还在展示
元数据类缓存 TTL 300s   → 人物 / 主题 / X 流
```

两条运维含义：

1. **恢复演练后必须清缓存** —— `scripts/ops/restore-mysql.sh` 第 7 步
   `FLUSHALL` 已做。漏掉会出现「数据库回滚了、前台还在展示回滚前的内容」。
2. **备份 / 恢复的 RTO/RPO 不受缓存影响** —— `docs/13` 的
   「Redis 不是业务数据库」成立，所以 compose 里 Redis **刻意关掉持久化**
   （`--save '' --appendonly no`）。这不是省事，是不让人误以为
   Redis 里有需要保住的东西。

---

## 关于 §23

**本次没有做 §23 的独立审查。** 理由：用户明确要求
「下次不要再审查这么久了」（`1f16b2a` 那次 §23 的开销不可接受）。

**替代**：5 条**变异反证**（全部实测，见上），其中 M2 / M4 / M5 分别打在
跨产物一致性守卫、那个反直觉的 ioredis 参数、以及对他人守卫的修改上 ——
这三处正是最需要外部视角的地方。

⚠ **仍然建议**一次轻量独立审查，重点看两处：

1. `applyApiPrefix()` 的抽取是否引入了行为差异（Agent 00 的文件）；
2. `auth-contract.spec.ts` 放宽 `$queryRaw` 是否真的没有削弱拦截面
   （我的论据是「两种标签模板都被 Prisma 的类型系统约束为
   `TemplateStringsArray | Sql`，真正的逃生口 `$queryRawUnsafe` 仍被拦」——
   这是一个**可以被反驳**的判断，值得第二双眼睛）。

---

## Git

```text
3f8e819  feat(agent-11): 部署编排、运维脚本与部署 workflow（**未完成**，见下）
4f0b8b2  feat(agent-11): 健康检查（/health/live + /health/ready）与 TLS 指南
```

分支：`main`。远程：`https://github.com/Jov3c/Signal-Daily`（private）。
