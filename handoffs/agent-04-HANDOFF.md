# Handoff

**Agent:** 04 — Collectors / Scheduler
**Wave:** 1B（上游：Agent 00、01、03）
**日期:** 2026-09-24
**基线:** Development Contract v1.1 / Frontend Prototype v1.7 / Agent Rule v1.0
**交付面:** `apps/worker/**`（+ `packages/source-core`，见契约变更请求第 9 项）

> ⚠ **先读文末的「补遗（§23 独立审查）」再看正文结论。**
> 正文记录交付时的实现与验证；补遗记录两轮独立审查在
> **`pnpm verify` 868 项全绿 + 集成测试 44 项全绿**的状态下查出的
> **1 个 P0 + 2 个 P1 + 2 个 P2 + 一批 P3/P4**，以及它们的修复与
> **下游必须注意的行为变更**。
> 审查由**两个没有本次开发上下文**的独立执行者完成（安全向 / 工程向），
> 原始产物在 `work/_agent04/review-sec/` 与 `work/_agent04/review-eng/`。

---

## Task

`tasks/agent-04-collectors.md`：

- 六种来源的统一 Collector（RSS / X / GitHub / HN / Hugging Face / Manual URL）
- 统一 `CollectedItem`，携带 `sourceId`；Source tier/kind/official **不进 payload**
- Source Scheduler（每分钟查到期 → Redis 锁 → 入队列）
- X 采集强规则：只处理 `type=X_USER AND enabled=true`，默认收原创 + 可选 Quote，
  排除 Reply / 纯 Repost；**不实现任何用户订阅语义**（规则 §13）

**依赖：** 00 + 01 + 03（全部 `✅ 已完成`，开工前已确认）。

---

## Implemented

### 1. `packages/source-core` —— 与 Source Registry 共用的信源内核

按 `handoffs/CONTRACT_CHANGE_REQUEST-agent-03.md` 第 1 项，把三样
**必须由写库方（Agent 03）与读库/抓取方（Agent 04）共用同一份**的实现
从 `apps/api/src/modules/sources/` 提取为共享包：

| 单元                        | 若各写一份的后果                                                       | 放一份的收益                                     |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| `url-safety/`（SSRF 三层）  | `docs/06` 明令「对 redirect 重新校验」；两份必然漂移，最终等于没有防护 | 采集侧与后台 `test` 端点探的是同一套判定         |
| `scheduling.ts`（到期规则） | 后台显示「已停用」，worker 却还在抓 —— 线上极难排查                    | 调度器与 Admin 用同一个 `buildDueSourcesWhere()` |
| `source-config.schema.ts`   | Collector 读的就是这份 JSON；两边默认值假设不一致 → 采集行为静默变化   | 写入端与消费端共用同一张类型表                   |

**跨 app 相对 import 实测做不到**（`TS6059`：文件不在 worker 的 `rootDir` 内，
另有 `TS6307`），所以只能提取共享包。本次是**纯搬迁**（`git mv`，内容逐字未改），
`apps/api/src/modules/sources/` 下保留同名 re-export 垫片，
**Agent 03 的模块与全部既有测试 import 路径一行未改**。

### 2. 统一适配器与六个实现

`CollectorAdapter`（`types.ts`）：`fetch(source, cursor, context) => CollectorBatch`。

| 适配器                        | 采集什么                          | `ContentType`                    | 窗口上限                        |
| ----------------------------- | --------------------------------- | -------------------------------- | ------------------------------- |
| `RssCollectorAdapter`         | RSS 2.0 / Atom 1.0 / RSS 1.0(RDF) | `ARTICLE`                        | `maxItems`（默认 50，上限 500） |
| `XUserCollectorAdapter`       | 白名单账号的推文                  | `X_POST`                         | `X_FETCH_MAX_RESULTS = 50`      |
| `GithubRepoCollectorAdapter`  | Release（或仓库本身）             | `GITHUB_RELEASE` / `GITHUB_REPO` | `GITHUB_RELEASES_PER_PAGE = 30` |
| `HackerNewsCollectorAdapter`  | 榜单前 N 个 story                 | `HN_STORY`                       | `HN_MAX_ITEMS = 30`，并发 5     |
| `HuggingFaceCollectorAdapter` | 仓库的 commit                     | `MODEL`                          | `HF_MAX_COMMITS = 30`           |
| `ManualUrlCollectorAdapter`   | 单个页面                          | `ARTICLE`                        | 正文 200k 字符                  |

**所有出网都走 `safeFetchText`**（含 DNS 全地址校验 + 逐跳重定向再校验 +
超时预算 + 流式体积上限）—— 包括 GitHub / HN / HF 这些硬编码厂商端点，
因为**超时与体积上限是每个请求都需要的**：一个卡住的 HN 请求会占满
`collector` 队列的 5 个并发额度，把其它来源一起饿死。

### 3. 幂等、去重与状态推进

```
① 取锁 source-fetch:{sourceId}     ← raw_items 上没有唯一约束，先查后写必须靠它
② 读 Source（不存在 / 已停用 → 跳过）
③ 从 raw_items 推导增量游标
④ 适配器 fetch
⑤ 去重（批内 + 库内，docs/06 的幂等第 1、2 条）
⑥ 落 RawItem
⑦ 推进 next_fetch_at / last_* 状态（基准是**本轮开始时刻**）
⑧ 记 JobRun
```

### 4. Scheduler 与队列消费

- `SourceScheduler`：进程内 `setInterval(60s)` + Redis 锁。
  **刻意不用 BullMQ repeatable job**：`docs/13` 固定了 10 个 Job 名，
  没有「调度扫描」这一个，而 §9 禁止新造近义名。
- `CollectorWorker`：BullMQ `collector` 队列，并发 5（`QUEUE_CONCURRENCY`）。
  载荷畸形 → `UnrecoverableError`；失败按 `retryable` 决定抛普通 `Error`
  （退避重试）还是 `UnrecoverableError`（立刻终止）。

### 5. SSRF / 凭据 / 不可信输入的处置

- 三层防护**原样复用** Agent 03 的实现（见第 1 节），没有另写一份。
- X 未配令牌时**先抛错、完全不发请求**（不撞风控、不假装成功）。
- 跨主机重定向丢弃 `authorization` / `cookie` / `proxy-authorization`。
- XML：实测拒绝外部实体、不放大嵌套实体、有深嵌套上限、拒绝 `__proto__` 元素名
  （证据 `work/_agent04/probe-xml-safety.mjs`）。

---

## Files Added

```
packages/source-core/{package.json,tsconfig.json}
packages/source-core/src/{index,scheduling,source-config.schema}.ts
packages/source-core/src/url-safety/{index,ip,url-safety,safe-fetch}.ts   ← git mv 自 apps/api

apps/worker/src/jobs/collectors/
  module.ts  collector.config.ts  clock.ts  types.ts
  payload-keys.ts        ★ payload 的按类型白名单（P0 修复）
  field-limits.ts        ★ 外部输入 → 列宽的收敛（P2 修复）
  errors.ts  hashing.ts  json-value.ts  contract-enum.ts  bigint-id.ts
  logger.ts  prisma.service.ts
  collector.service.ts  scheduler.service.ts  collector.worker.ts
  source-lock.ts  source-queue.ts  redis.ts
  ports.ts  repository.ts（端口）
  prisma-{source,raw-item,job-run}.repository.ts
  feed/parse-feed.ts
  text/markup.ts
  url/canonical.ts
  adapters/{index,http,json,config-read}.ts
  adapters/{rss,x-user,github-repo,hacker-news,huggingface,manual-url}.adapter.ts

apps/worker/test/
  collectors-adapters.spec.ts          (64)
  collectors-text-url.spec.ts          (40)  ★ §23 后补 ReDoS 标度 + canonical 编码
  collectors-parse-feed.spec.ts        (25)  ★ §23 后补 DOCTYPE 窗口绕过
  collectors-service.spec.ts           (23)
  collectors-service-guards.spec.ts    (15)  ★ §23 后补的服务层回归
  collectors-scheduler.spec.ts         (13)  ★ §23 后补「停用来源不入队」
  collectors-worker.spec.ts            (15)
  collectors-di-wiring.spec.ts         (6)   ★ §23 后补的 DI 守卫
  collectors-db.integration.spec.ts    (27)  真 MySQL
  collectors-queue.integration.spec.ts (19)  真 Redis + BullMQ
  support/{collector-fakes.ts,feed-fixtures.ts}
apps/worker/vitest.integration.config.mts

handoffs/agent-04-HANDOFF.md
handoffs/CONTRACT_CHANGE_REQUEST-agent-04.md   (9 项)
```

工作脚本（不属于交付物，在 `work/_agent04/`）：
`probe-upstreams.mjs`（真实上游响应形状）、`probe-xml-safety.mjs`（XML 攻击载荷）、
`probe-dist-collectors.mjs`（**进程级** E2E：真 dist + 真 MySQL + 真 Redis + 真网络）、
`counterproof-agent04.py`（反证）、以及审查者的全部产物（`review-sec/`、`review-eng/`）。

## Files Modified

```
packages/contracts/src/errors.ts     仅**追加** 3 个业务码（删除行 = 0）
apps/api/src/modules/sources/url-safety/index.ts   re-export 垫片
apps/api/src/modules/sources/scheduling.ts         re-export 垫片
apps/api/src/modules/sources/source-config.schema.ts re-export 垫片
apps/api/test/di-wiring.spec.ts      守卫改为在**内联源码**上验证 matcher（见 §23 补遗）
apps/api/{tsconfig.json,test/tsconfig.json,vitest.integration.config.mts,package.json}
tsconfig.json  vitest.config.mts     注册 packages/source-core
apps/worker/{package.json,tsconfig.json}
pnpm-lock.yaml
```

**零改动**（已 `git status` / `git diff` 确认）：`prisma/**`、
`apps/api/src/app.module.ts`、`apps/worker/src/worker.module.ts`、`apps/web/**`、
`infra/**`、`.env.example`、`eslint.config.mjs`、`packages/config/**`、`packages/logger/**`。

---

## Database Migrations

**None**

未创建任何 Migration，未改动 `prisma/schema.prisma`。
只用 Agent 01 已建好的三张表：`sources` / `raw_items` / `job_runs`。
**没有新字段需求** —— `type/kind/tier/official/config(Json?)` + 三个索引已经够用。

---

## Public Interfaces

### 给 Agent 05（Content Pipeline / Event / Evidence）—— 最重要的一节

**① 采集端不做任何清洗，正文里可能有 HTML。**
`RawItem.bodyRaw` 是**外部原始抓取事实**（`docs/03` 的语义）。
RSS 的 `content:encoded`、MANUAL_URL 的整页 HTML 都会原样进来。
`docs/14`「前端不得渲染未清洗 HTML」的清洗点**在 Pipeline 的 Normalize**。
`titleRaw` 是**纯文本**（去标签 + 解码实体），但它**不是**「已净化的 HTML」——
见 `text/markup.ts` 的 `toPlainTitle` 注释里钉住的三种残留内容。

**② 幂等键只有两个属于采集端，第三个留给你。**
`docs/06` 的三条幂等键：① `(source_id, external_id)` ② `canonical_url_hash`
已由采集端在落库前拦截；③ `content_hash` **采集端只计算、不做拦截** ——
同一篇文章换了标题、或正文被上游修订，都应作为新事实入库，
Near Dedup 的判断属于 `docs/07`。

**③ `RawItem.status` 只用了一个值：`FETCHED`。**
`NORMALIZED` / `DUPLICATE` / `READY_FOR_ANALYSIS` / `FAILED` 全留给你。

**④ 采集端**不会**把 `kind` / `tier` / `official` 写进 payload**，
请经 `source_id` 关联现查（`tasks/agent-04`、`docs/22`）。
守卫是**按类型的白名单**（`payload-keys.ts`）：你要往 payload 里加字段的话，
那是采集端的事，不要在 Pipeline 里改 `raw_items`。

**⑤「游标」不表示「已处理完」。**
采集端不再用时间 / id 做增量过滤（那会造成永久漏采，见 §23 补遗），
所以每一轮都可能重复返回已经落库的条目 —— 这是**刻意**的，
去重由幂等键承担。不要假设「这一轮的新 RawItem 就是全部的新内容」。

### 给 Agent 07 / 12（Admin Review / Admin UI）

- `Source.last_error_code` 的取值来自契约的 `DOMAIN_REASON`。
  **`SOURCE_FETCH_CREDENTIALS_MISSING` / `SOURCE_FETCH_UNAUTHORIZED` 需要人动手**
  （去配令牌），且它们会让 `JobRun` **直接终态 `DEAD`**（不是 FAILED）。
- `CollectorBatch.complete = false` 会记一条 `collector did not take everything…`
  的 warn 日志 —— 它意味着「上游给的没取完」，管理员的行动项是调大窗口上限
  （RSS 的 `maxItems` 上限 500）。
- 管理员在 Source Registry 里改 `fetchIntervalSeconds` 会直接改调度节奏；
  本模块不缓存它（每个任务重新读库）。

### 给 Agent 11（Ops）

- **Redis 是硬依赖**：`fetch-now` 的入队（Agent 03）与调度锁都在它上面。
  Agent 04 侧的降级行为：锁拿不到 → **跳过**（记日志，不重试）；
  Redis 抛错 → 那一条采集记为**可重试**的 `SOURCE_FETCH_FAILED`，
  且**不去写库**（避免在故障时放大写入）。
- **Worker 需要 `@prisma/client@6.19.3`**（与仓库根/`apps/api` 同版本，
  Prisma 版本不一致会解析出多份客户端）。
- `rediss:`（TLS Redis）在生产要能用：`redisConnectionOptions` 会带 `tls: {}`。
  ⚠ **该分支没有测试覆盖**（本机没有 TLS Redis），已记在 Known Limitations。
- Worker 的常驻句柄来自 BullMQ 的 `Worker`（`apps/worker/src/main.ts` 的占位
  定时器在集合成后可以移除 —— 那是 Agent 00 的 Known Limitations 第 2 条）。
- `pnpm --filter @signal/worker test:integration` 需要**真实 Redis**；
  它现在会先 ping 一次并在失败时给出明确错误（见 §23 补遗 F-21）。

### 给 Agent 14（最终集成）—— 必做

```ts
// apps/worker/src/worker.module.ts
@Module({ imports: [CollectorsModule] })
export class WorkerModule {}
```

- `CollectorsModule` 在 `apps/worker/src/jobs/collectors/module.ts`，
  `exports: [CollectorService, SourceScheduler]`。
- **不要**在 `worker.module.ts` 之外重复注册 `SourceScheduler` 或
  `CollectorWorker` —— 它们已经在模块里，重复注册会让调度器跑两遍。
- 核对契约变更请求第 9 项的**超出允许目录改动清单**。
- 建议把 `pnpm --filter @signal/worker test:integration` 接进 CI
  （需要一个 Redis service；`pnpm verify` 里不含它）。

---

## APIs Used

外部出网**只发生在采集任务里**，且只访问：

- 管理员配置的 feed / 页面 URL（**经完整 SSRF 三层校验**）
- `https://api.x.com/2/...`（需 `X_API_BEARER_TOKEN`；未配置时**完全不发请求**）
- `https://api.github.com/...`（`GITHUB_TOKEN` 可选，匿名可用）
- `https://hacker-news.firebaseio.com/v0/...`
- `https://huggingface.co/api/...`

**真实响应形状已实测记录**在 `work/_agent04/probe-upstreams.json`
（GitHub / HN / RSS / Atom / HTML 拿到真响应；**HF 与 X 在本机不可达**，见下）。

## Events / Queues

- 消费：`QueueName.COLLECTOR`（`collector`）/ `JobName.COLLECTOR_FETCH_SOURCE`
  （`collector.fetch-source`）/ 并发 5（`QUEUE_CONCURRENCY`）。
- 生产（调度器入队）：同队列，`JobId.collectorFetchSource(sourceId, window)`，
  `COLLECTOR_RETRY`（3 次指数退避 5000ms）。
  ⚠ 契约用 `backoff.delayMs`，BullMQ 用 `backoff.delay` —— 转换写在
  `source-queue.ts` 里并**在真 Redis 上断言过**（写错的表现是「退避变成 0」，不报错）。
- **未新增任何 Queue / Job 名**（真 Redis 测试断言：Queue 恰好 6 个、Job 恰好 10 个）。
- 锁 key：`source-fetch:{sourceId}`（`docs/06` 的字面格式）。

## Environment Variables

**未新增任何 env。** 只读 `docs/20` 已记录的：
`SOURCE_FETCH_TIMEOUT_MS` / `SOURCE_FETCH_MAX_BYTES` / `X_API_BEARER_TOKEN` /
`GITHUB_TOKEN` / `REDIS_URL` / `LOG_LEVEL` / `NODE_ENV` / `APP_TIMEZONE`。

**依赖变更**：`apps/worker` 新增 `@prisma/client@6.19.3`、`bullmq@5.81.5`、
`ioredis`、`fast-xml-parser@5`（RSS/Atom 解析）、`@nestjs/testing`(dev)。

---

## Tests

| 文件                                   | 项数 | 覆盖                                                                                                                       |
| -------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| `collectors-adapters.spec.ts`          | 64   | 六个适配器（真实现 + stub 网络）、SSRF 五类绕过、重定向链、**六个适配器真实输出的 payload 白名单**、`complete` 如实上报    |
| `collectors-text-url.spec.ts`          | 37   | 实体解码、标题净化及其**边界**、canonical 归一化、**超长输入的线性标度（ReDoS 守卫）**                                     |
| `collectors-parse-feed.spec.ts`        | 24   | RSS/Atom/RDF/单条目/CDATA/`[object Object]` 陷阱/DOCTYPE（含 4KB 窗口绕过）/十亿笑声                                       |
| `collectors-service.spec.ts`           | 23   | 幂等四条边界、失败隔离、状态推进基准、锁、`disabled` 语义                                                                  |
| `collectors-service-guards.spec.ts`    | 15   | **真适配器 × 真 service**（P0 回归）、字段长度收敛、`language` 语义、JobRun 终态、`complete` 告警                          |
| `collectors-scheduler.spec.ts`         | 12   | 入队载荷、失败隔离、锁、整轮容错、停用来源不入队                                                                           |
| `collectors-worker.spec.ts`            | 15   | 载荷校验、重试语义（含**错误类型**断言）、并发度取自契约                                                                   |
| `collectors-di-wiring.spec.ts`         | 6    | **静态扫描 `@Inject`** + 真实 `CollectorsModule` 依赖图编译                                                                |
| `collectors-db.integration.spec.ts`    | 27   | **真 MySQL**：到期 SQL（含 `NULL`）、UTC 语义、BIGINT 上界、幂等键查询、游标                                               |
| `collectors-queue.integration.spec.ts` | 19   | **真 Redis + BullMQ**：真入队、JobId 幂等、重试选项落在任务上、跨 Agent 载荷契约、锁互斥/TTL/token 比对、**锁 TTL 不变量** |

**测试数据刻意对齐真实形态**（§23.3）：fixture 全部是**中文**正文，
且形状取自**真实响应**（`feed-fixtures.ts` 顶部逐个注明来源）。
超长输入这一项曾经完全没做 —— 见 §23 补遗。

连不上 MySQL / Redis 的集成测试**直接失败，不静默跳过**
（队列那一份曾经会在 Redis 不可用时 19 项全部 skip 且不提 Redis，已修）。

---

## Commands

修复后的最终数字：

```
pnpm verify                                     ✓ 36 files / 911 tests（lint + typecheck + 单测）
pnpm --filter @signal/worker test:integration   ✓ 2 files / 47 tests（真 MySQL + 真 Redis + 真 BullMQ）
pnpm --filter @signal/api test:integration      ✓ 4 files / 46 tests（Agent 03 的，未受影响）
pnpm test:db                                    ⚠ 22 passed · 4 FAILED ← 见第 5b 节（跨 Agent 问题，非本次引入）
进程级 dist 探针                                 ✓ 22/22 PASS（真网络抓 hnrss.org 并落库）
反证（第一轮 12 条 + 第二轮 6 条）                ✓ 18/18 有牙齿 · 0 空跑 · 0 harness 错误
```

```bash
pnpm verify                                                       # lint + typecheck + 单测（无需 DB/Redis）
pnpm --filter @signal/worker test:integration                     # 需要真 MySQL + 真 Redis
REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration
pnpm --filter @signal/worker build
# 进程级 E2E（真 dist + 真 MySQL + 真 Redis + 真网络）：
cd apps/worker && REDIS_URL=redis://127.0.0.1:6390 node ../../../work/_agent04/probe-dist-collectors.mjs
# 反证：
python ../work/_agent04/counterproof-agent04.py
```

本地 Redis（`docs/20` 默认 6379 未运行，集成测试用临时实例）：

```bash
"E:/redis/Redis-8.8.0-Windows-x64-cygwin-with-Service/redis-server" \
  --port 6390 --save '' --appendonly no
```

---

## Known Limitations

1. **X（`api.x.com`）的真实令牌路径未做端到端验证。**
   本机不可达 + `X_API_BEARER_TOKEN` 未配置。已验证的是
   「未配置时先抛错、且**完全不发请求**」，以及用真实现 + stub 网络
   跑通的解析与过滤逻辑。**上线前必须在能访问 X 的环境验一次。**
2. **Hugging Face 端点形状未能实测。**
   本机对 `huggingface.co` 的 DNS 被污染（解析到 `69.63.176.15`，与 HF 无关）。
   适配器采用「按文档形状严格解析，形状对不上就**如实失败**」的策略 ——
   宽松解析会在形状变化时返回 0 条，而「这个源本来就没更新」在数据上
   长得一模一样。**形状不匹配现在的表现是一条可见的 `SOURCE_FETCH_FAILED`。**
3. **DNS rebinding / TOCTOU 未消除。**
   `assertHostResolvesToPublicAddress()` 解析并校验每一个地址之后，
   `fetch()` 会**再解析一次**；两次之间 DNS 可以改答案。
   彻底修复需要「钉住已校验 IP 再连接」（自定义 agent / 直连 IP + Host 头）。
   当前实现显著收窄了攻击面，但**不等价于完全消除**。（该说明随 `url-safety`
   一起搬到了 `packages/source-core`。）
4. **`rediss:`（TLS Redis）分支无测试覆盖。**
   本机没有可连的 TLS Redis；`redisConnectionOptions` 的 `tls: {}` 只能靠
   代码论证。反证实测：删掉那一行，两个测试套件**全绿**。
5. **`raw_items` 上没有唯一约束，幂等依赖那把 Redis 锁。**
   已用真库实测「没有锁时确实会双写」（同一 `(source_id, external_id)`
   出现 2 行）。加唯一约束属改 `prisma/schema.prisma`（Agent 01 独占，§10），
   因此未做。**锁的 TTL 必须严格大于一次采集的最坏耗时** ——
   该不变量现在有一条测试钉住（`collectors-queue.integration.spec.ts`）。
6. **多 worker 实例下的真实锁竞争未做多进程复现。**
   单实例下锁语义已由真 Redis 测试覆盖（互斥 / 只释放自己的 / TTL 过期 /
   不可用时抛错）；「TTL 过期导致双写」是**真库双写实测 + 算术**推出的。
7. **生产 MySQL 的 `sql_mode` 差异未验证。**
   本机是默认严格模式，所以列宽超限是「整批失败」。
   若生产关掉 `STRICT_TRANS_TABLES`，表现会变成**静默截断** ——
   两种都不可接受，但形态不同。字段收敛现在在采集端就做了，
   所以这一条更多是「确认生产配置」的提醒。
8. **`fetchWindow` / `redisConnectionOptions` / `bigint-id` 仍是跨 app 的三处重复实现。**
   各自都有「两边漂移就静默出错」的性质。已记入
   `CONTRACT_CHANGE_REQUEST-agent-04.md` 第 8 项建议提升为共享包。
9. **`docs/06` 与 `tasks/agent-04` 关于 kind/tier/official 的要求互相矛盾**，
   本模块按 `tasks/` 实现。已记入 CCR 第 1 项请求裁决。
10. **`pnpm test:integration` 不在 `pnpm verify` 内**（需要真 MySQL + Redis）。
    有基础设施的环境请额外跑它。
11. **反证覆盖的是「本次修复的路径」**，不是全部行为。
    完整的行为级反证见 `work/_agent04/review-eng/sweep2-results.json`
    （审查者做的 53 条变异，其中 14 条确认无覆盖 —— 那些里
    与本模块**核心承诺**相关的已在本次补齐守卫，其余记录在案）。

---

## Contract Change Requests

见 **`handoffs/CONTRACT_CHANGE_REQUEST-agent-04.md`**（**9 项**）。

其中**最需要尽快裁决**的三项：

1. **第 1 项**：`docs/06` 与 `tasks/agent-04` 关于 kind/tier/official 的矛盾 ——
   它是本次 P0 缺陷的根因。
2. **第 3 项**：「采集窗口」的语义未定义 —— 它导致了两个静默永久漏采的 P1。
3. **第 6 项**：3 个新 Error Code 的追认（纯追加，删除 0 行）。

对 `packages/contracts/src/errors.ts` 的改动是**纯追加**（新增 3 个码，**删除 0 行**），
未改动任何既有 code 或规则。

---

## Integration Notes

（见「Public Interfaces」一节的分对象说明。补充两条给所有下游：）

1. **本次交付改了 `apps/api` 的 5 个文件与根配置** ——
   全部是为 `packages/source-core` 的提取做的接线，逐条列在
   `CONTRACT_CHANGE_REQUEST-agent-04.md` 第 9 项。集成时请核对。
2. **`apps/worker` 没有 import `apps/api`**（无架构倒退）。
   共享的是 `packages/source-core` 这个**零依赖**包
   （只依赖 `node:*` 与 `@signal/contracts`，不含 Nest / Prisma / ioredis）。

---

## 结论

（本节在 §23 独立审查通过之前**刻意留空** —— 按 §23.7，
P0/P1 未修复并通过复审前不得给出完成结论。补遗章节记录了完整结论。）

---

# 补遗（2026-09-24）：§23 独立审查发现并修复的缺陷

> 本文正文的验证结果（`pnpm verify` 868 项全绿、集成测试 44 项全绿、
> 进程级 dist 探针 22/22 PASS）**在审查前就已经成立**，但两轮独立审查
> 仍然查出 **1 个 P0 + 2 个 P1 + 2 个 P2 + 一批 P3/P4**。
> 以下记录「原先哪条声称过于乐观」「改了什么」「下游必须注意什么」。
>
> 审查由**两个没有本次开发上下文**的独立执行者完成（安全向 / 工程向），
> 报告与全部原始输出在 `work/_agent04/review-sec/` 与 `work/_agent04/review-eng/`。
> **两个审查者独立发现了同一个 P0**，这正是 §23 存在的理由。

## 1. 原先过于乐观的声称（逐条更正）

| 正文/代码里的声称                                         | 事实                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 「六个适配器全部可用」                                    | **假**。`SourceType.X_USER` **100% 不可用、0 条入库**：X 适配器用 `payload.kind` 记录推文的引用关系，与「Source 元数据不得进 payload」的**键名黑名单**守卫（含 `kind`）撞名 → 每条推文都在落库前抛错。**P0 / F-01**                        |
| 「所有 Adapter 返回统一 CollectedItem」（隐含：都能落库） | **假**。适配器测试不过 service、service 测试用替身 ——「真适配器 → 落库守卫」这条路径**从来没有被执行过**。旧测试还同时断言 `payload['kind']` **存在**与 `kind` **必须被拒** —— 两条互相矛盾的断言从来没有同时执行。                        |
| 「`complete: true` 表示都取回来了」                       | **假**。RSS 在 `maxItems` 处直接 `break` 却报告 `true`；HN 取榜单前 30 却报告 `true`。字段含义与取值直接矛盾。**P1 / F-03**                                                                                                                |
| 「增量用 id 的数值比较…与榜单排序无关」（HN 注释）        | **假**。榜序与 id 序无关：「发布较早、后来涨上首页」的帖子（HN 最典型的现象）会被**永久跳过**，无任何信号。实测：第 2 轮榜眼 97 从未采过却被跳过。**P1 / F-02**                                                                            |
| 「`stripTags` 是轻量实现」                                | **不足**。`/<[^>]*>/g` 在「含 `<` 无 `>`」的输入上是 **O(n²)**，且**同步**阻塞事件循环。实测 2× 输入 → ~4× 耗时；2 MiB 输入（= `SOURCE_FETCH_MAX_BYTES`）会阻塞几十分钟，把同进程的 Worker（并发 5）与 Scheduler 一起拖死。**P1 / 安全向** |
| 「GitHub 仓库的 `language` 写进 `language` 列」           | **假**。`repo.language` 是**主编程语言名**（`JavaScript` 10 字符），而 `raw_items.language` 是 BCP-47 标签、`Char(5)` → 真库报「column too long」→ 该来源**永久失败**、0 条。**P2 / 安全向**                                               |
| 「字段直接落库」                                          | **假**。超长 `externalId`(>512) / URL(>2048) 会让 `createMany` **整批失败**（全有或全无）—— 3 条里 1 条坏，另外 2 条好的也一起丢。**P2 / 安全向**                                                                                          |
| 「canonical 归一化」                                      | **不完整**。用 `searchParams` 迭代（**已解码**）后手工拼回，`?q=a%26b` 变成 `?q=a&b` —— 描述的是另一个资源。**P2 / F-06**                                                                                                                  |
| 「游标取最新一条有 externalId 的记录」                    | **与实现不符**。实现取的是「最近写入那一行」（榜序最靠后的那个），不是最大值。**P2 / F-07**                                                                                                                                                |
| 「不可重试的失败会被记成 DEAD」                           | **假**。只按 `isFinalAttempt` 判断，而不可重试的失败第 1 次就被终止 → JobRun **永远停在 FAILED**，`docs/13` 的 dead-letter 视图漏掉**唯一需要人动手**的那一类。**P2 / F-05**                                                               |
| 「带 DOCTYPE 的 feed 一律拒绝」                           | **不成立**。只扫前 4KB，用一个 5KB 注释把 DOCTYPE 推过去即可绕过。**P3 / P3-1**                                                                                                                                                            |
| 「fast-xml-parser 不加载 DTD」                            | **后半句对、前半句错**。实测：内部 DTD 子集**会被解析**、简单内部实体会被展开；外部实体被拒绝、嵌套实体不放大。**P3 / P3-1**                                                                                                               |
| 「`toPlainTitle` 能防解码造出标签」                       | **保证过强**。双重编码（`&amp;lt;…`）只解一层；未闭合标签会留下裸 `<`；大写命名实体（`&LT;`）不解码。**P3 / P3-2**                                                                                                                         |
| 「`nextCursor` 是适配器的扩展点」                         | **死字段**。六个适配器全返回 `null`，全仓库**无消费者**；`EMPTY_CURSOR` 从未被引用。**P3 / F-11**                                                                                                                                          |
| 「集成测试连不上 Redis 就直接失败」                       | **与行为相反**。Redis 不可用时 19 项全部 **skip**、报错只提 `Hook timed out in 60000ms`、一个字不提 Redis，且 beforeAll + afterAll 各挂满 60 秒。**P4 / F-21**                                                                             |
| 「每次运行用独立的队列前缀」（集成测试注释）              | **假**。用的是生产队列名 `collector` 并 `obliterate({force:true})` —— 会**清空共享 Redis 上真实 worker 正在消费的生产队列**。**P2 / F-09**                                                                                                 |
| 「替身直接解释 `@signal/source-core` 的到期规则」         | **假**。替身既没 import 也没读 `now`，只按 `enabled` 过滤 —— 那句话会让人以为调度器单测覆盖了到期语义。**P3 / F-10**                                                                                                                       |

## 2. 修复内容与影响范围

| #                    | 修复                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 / F-01**        | 守卫从**键名黑名单**改成**按 `SourceType` 的白名单**（新文件 `payload-keys.ts`）：未登记的键一律拒绝。X 的键同时改名为 `postKind`。**新增**「真适配器 → 真守卫」回归（`collectors-adapters.spec.ts` 与 `collectors-service-guards.spec.ts`）。 |
| **P1 / F-02**        | HN **去掉 id 增量过滤**，改为「取榜单前 N + 靠库去重」（`selectIds` 现在只是 `slice`）。代价是每轮多一次 `findExistingKeys` 查询。                                                                                                             |
| **P1 / F-03**        | RSS **去掉时间增量过滤**（同上理由），并把 `complete` 改成**如实反映**截断；`CollectorBatch` 删除死字段 `nextCursor`；service 在 `complete === false` 时记 warn。                                                                              |
| **P1 / 安全**        | `stripTags` 改为**单趟线性扫描**（`indexOf`，无回溯）。行为有两处刻意差异：未闭合 `<` 之后的整段**原样保留**（不吞内容）；注释与 `script`/`style` 整块仍删除。                                                                                 |
| **P2 / 安全**        | 新增 `field-limits.ts`：`externalId`(512) 与标题(65535 **字节**) 截断、语言标签收敛（编程语言名 → `null`）、URL 超长**丢弃并计数**（截断 URL 会造出 404 链接）。在 `persist()` 统一执行，`canonicalUrlHash` 基于**收敛后**的 URL。             |
| **P2 / F-06**        | `canonicalizeUrl` 改用 `URLSearchParams` 重新序列化（正确的百分号编码）。                                                                                                                                                                      |
| **P2 / F-07**        | `latestCursor` 的 `sinceExternalId` 改为取**数值最大**的 id，且只接受纯数字（服务 X 的 `since_id`）。                                                                                                                                          |
| **P2 / F-05**        | 不可重试的失败**立即**终态：`JobRun = DEAD`。                                                                                                                                                                                                  |
| **P2 / F-09**        | `BullSourceFetchQueue` 的队列名可注入（默认仍是契约的 `collector`）；集成测试用一次性队列名，**不再 `obliterate` 生产队列**。                                                                                                                  |
| **P2 / F-08**        | 补 `CONTRACT_CHANGE_REQUEST-agent-04.md`（9 项）。                                                                                                                                                                                             |
| **P3 / P3-1**        | `rejectDoctype` 改为扫描**全文**（XML 里正文中的字面量 `<!DOCTYPE` 必须转义，所以全文扫描不会误伤）；文件头更正为实测结论表。                                                                                                                  |
| **P3 / P3-2**        | `toPlainTitle` 的保证**收窄并写明**三种残留（双重编码 / 未闭合标签 / 零散 `<`），并把它们**钉进测试**；`decodeEntities` 支持大写命名实体。                                                                                                     |
| **P3 / F-10**        | 替身注释更正，明确它只模型化规则的一半；**新增**「停用来源不入队」用例。                                                                                                                                                                       |
| **P3 / F-11**        | 删除 `nextCursor` 与 `EMPTY_CURSOR`。                                                                                                                                                                                                          |
| **P3 / F-12**        | 锁 TTL 的算式更正（`1 + ceil(N/并发)`），**新增不变量测试**（最坏请求数 × 超时 ≤ TTL）。                                                                                                                                                       |
| **P3 / F-13**        | `CollectorConfig` 增加 `fetchImpl` / `lookup` 测试接缝并透传 —— 让「真适配器 × 真 service」可测（这正是 P0 逃逸的机制）。                                                                                                                      |
| **P3 / F-14**        | **新增** `collectors-di-wiring.spec.ts`：静态扫描 `@Inject` + 真实 `CollectorsModule` 依赖图编译。原先 `@nestjs/testing` 是**死依赖**。                                                                                                        |
| **P4 / P4-2**        | JSON 解析失败的错误消息不再携带响应体前 120 字符（对端可控，可能回显凭据）—— 改为只报 `content-type` 与字节数。                                                                                                                                |
| **P4 / P4-3**        | `COLLECTOR_PAYLOAD_INVALID` 改名为 kebab-case 的 `malformed-collector-payload`，避免被误当成契约业务码。                                                                                                                                       |
| **P4 / F-17 / F-18** | 弱断言修正：「可重试失败」现在断言**错误类型**（原先的正则连 `UnrecoverableError` 也匹配）。                                                                                                                                                   |
| **P4 / F-19**        | 拼写（`Workre`）、重复注释、死分支 `?? ''`、不可达的 `serialised === undefined` 分支全部清理。                                                                                                                                                 |
| **P4 / F-21**        | 集成测试先显式 ping Redis，失败时给出**指向 Redis 的错误**（对齐同目录 DB 集成测试的做法）。                                                                                                                                                   |
| **P4 / F-20**        | 进程级 dist 探针的 DI 部分**转成已提交的回归测试**（见 F-14），不再只存在于不进 git 的 `work/` 里。                                                                                                                                            |

## 3. ⚠ 下游必须注意的行为变更

1. **`RawItem.payload` 现在是按类型白名单校验的。**
   X 的推文类别键从 `kind` 改名为 **`postKind`**。
   任何按 `payload.kind` 读取的代码（目前没有，但要提醒）需同步。
2. **采集端不再做时间 / id 增量过滤。**
   每一轮都可能返回**已经落库**的条目（由幂等键挡掉）。
   下游不要假设「这一轮的新 RawItem 就是全部新内容」。
   好处是：窗口外与「后来才涨上来」的条目不再被永久丢弃。
3. **`CollectorBatch.nextCursor` 字段已删除**（它从来没有被消费过）。
   `complete` 现在会真的为 `false`，并且会记一条 warn 日志。
4. **RSS 的 `maxItems` 语义现在是「单轮上限」，而且窗口**真的**会推进。**
   ⚠ 这条曾经写反过：第二轮复审实测 —— 12 条 feed + `maxItems=2`、连采 4 轮，
   库里仍只有 2 条，其余 10 条**永久丢失**。原因是适配器在解析时就按
   `maxItems` 截断，而 feed 顺序稳定 → 每轮都取同一批最新条目。
   现在机制是：**适配器返回整个窗口**（RSS 硬上限 500 / GitHub 100），
   **service 在去重之后**按 `roundLimit` 截断 —— 已采到的被幂等键挡掉，
   下一轮自然从上次停下的地方继续。`complete` 现在只管「上游这一次给的
   有没有都读进来」，「这一轮入库了多少、还剩多少留到下一轮」由一条 info 日志给出。
5. **不可重试的失败现在 `JobRun = DEAD`**（不是 FAILED）。
   后台按 `FAILED` 找「待处理失败」的逻辑需要把 `DEAD` 一起算上。
6. **`raw_items.language` 不再接受编程语言名。**
   GitHub 仓库来源的 `language` 会是 `null`（除非仓库主语言恰好是
   2–5 字符的语言标签形状），由 Pipeline 的 `LANGUAGE_DETECT` 补。
7. **超长字段的处理变了**：`externalId` 截断、标题按字节截断、
   **URL 超长的条目被丢弃并计数**（不再是整批失败）。

## 4. 反证（§23.4 要求「确认守卫有牙齿」）

`work/_agent04/counterproof-agent04.py` —— 把本次**每一条修复**故意改坏，
确认新守卫真的会红，然后还原并逐字节校验（每次还原后比 sha256）。

```
M01  RED   P0：X 适配器的 payload 键改回撞名的 `kind`
M02  RED   P0：守卫退回「键名黑名单」语义
M03  RED   P1：RSS 的 `complete` 退回恒为 true
M04  RED   P1：HN 的 selectIds 退回按 id 跳过（**忠实复现旧实现**：含改签名 + 传游标 + 改调用）
M05  RED   P1：stripTags 退回二次爆炸的正则
M06  RED   P2：字段长度不再收敛
M07  RED   P2：language 不再收敛
M08  RED   F-05：不可重试的失败不再记 DEAD
M09  RED   F-06：canonicalizeUrl 退回手工拼查询串
M10  RED   F-07：游标退回「最近写入那一行」的 externalId
M11  RED   F-14：Prisma 仓储去掉显式 @Inject
M12  RED   P3-1：rejectDoctype 退回只扫前 4KB

12/12 有牙齿 · 0 空跑 · 0 harness 错误
```

⚠ **这一轮反证本身抓出了两个真问题**（都已修，见第 7 节）：

- **M04 第一版是 GREEN** —— 但那是**我的变异写错了**（写成了 `slice` 的等价物），
  不是测试没牙齿。改成忠实复现旧实现（三处一起改）后 RED。
- **M09 与 M12 第一轮是 GREEN，而且是真缺口**：我声称补了
  「canonical 查询串重编码」与「DOCTYPE 4KB 窗口」两条守卫，
  但那批编辑脚本在第三个文件断言失败时**整批中止**，两条守卫**根本没写进文件**，
  而我当时没有逐个核对。
  **是反证把它们暴露出来的** —— 这正是 §23.4「没做过反证的测试一律视为空跑」的意义。

> 审查者也各自做了独立反证：安全向 32 条、工程向 53 条。
> 工程向的 53 条里 **14 条确认无覆盖**（两个套件全绿）——
> 其中与本模块**核心承诺**相关的已在本次补齐（见上表的 F-14 / F-12 /
> 字段收敛 / `complete`），其余记录在案。

## 4b. 反证抓出的、我自己的两个问题（已修）

这一节值得单独列出来，因为它是「反证有效」的直接证据，而不是审查者的发现：

1. **两条守卫根本没落地。** 我声称补了 canonical 查询串重编码（F-06）与
   DOCTYPE 4KB 窗口（P3-1）的回归守卫，但那批编辑脚本在**第三个文件**
   断言失败时整批中止 —— 前两个文件的改动写入成功、后两个没有，
   而我没有逐个核对就继续往下做了。反证的 M09 / M12 变 GREEN 才暴露出来。
   **教训**：批量编辑必须**逐项验证落地**，不能只看脚本的总体输出。
   （修复：改用「写入后立刻断言标记存在」的写法。）
2. **一条测试名与新行为矛盾。** parse-feed 里有一条用例名叫
   「DOCTYPE 只在开头判定，正文里出现 `<!DOCTYPE` 的示例文本不会误伤」——
   实现已经改成扫描全文，名字没跟着改。已更名为
   「正文里**转义后**的 `<!DOCTYPE` 文本不会误伤（XML 里字面量必须转义）」。
   §23 明确把「文档与实现不符」定性为缺陷，测试名也算。

## 5. 审查者指出、但我**没有改**的项（附理由）

1. **DNS rebinding / TOCTOU**（P4-4）：彻底修复要在连接层「钉住已校验的 IP」，
   属于 `packages/source-core` 的连接层改造。当前实现显著收窄了攻击面，
   已如实记录，不假装已解决。
2. **`rediss:` 无测试覆盖**（F-16 之一）：本机没有可连的 TLS Redis，
   不伪造一个「看起来验过了」的用例。
3. **加 `raw_items` 唯一约束**：属 `prisma/schema.prisma`（Agent 01 独占，§10）。
   已记入 Known Limitations 第 5 条。
4. **`fetchWindow` / `redisConnectionOptions` / `bigint-id` 的三处重复**：
   已记入 CCR 第 8 项建议提升为共享包，但不在本 Agent 的允许范围内就地搬。
5. **`docs/06` 的两处分歧**：属文档，已记入 CCR 第 1、2 项请求 Owner 裁决。

## 5b. ⚠ 本次验证过程中发现的、**不属于 Agent 04** 的跨 Agent 问题

### 本地 `contents` 表的 FULLTEXT 索引当前检索不到任何词条

**现象**（`pnpm test:db`，Agent 01 的交付物）：4 项失败 ——
`中文词能命中 title` / `body_translated` / `summary` 与
`英文检索在 ngram parser 下仍然可用`，全部返回 `[]`。

**已做的诊断**：

| 检查                                                               | 结果                                           |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| `SHOW CREATE TABLE contents`                                       | 索引**存在**，且确实是 `WITH PARSER ngram`     |
| `_prisma_migrations`                                               | 两个迁移**都已应用**                           |
| `ngram_token_size`                                                 | 2（默认值，正确）                              |
| MySQL 版本                                                         | 8.4.11                                         |
| **对照实验：新建一张 `TEXT` 列 + ngram FULLTEXT 的表，插入后检索** | **中文命中 1、英文命中 1** —— FTS 引擎本身正常 |
| 手动插入一行到 `contents` 再 `MATCH`                               | 中英文**都**命中 0                             |

**结论**：MySQL 的 FTS 正常、schema 与迁移都正确，
问题在 **`contents` 这一张表的索引处于「定义在、但索引里没有词条」的状态**，
需要重建该索引（即重放 `20260923170000_fulltext_ngram` 的那两条 DDL）。

**与 Agent 04 无关**：本次交付没有触碰 `prisma/**`（`git status` 为空）、
没有触碰 `contents` 表、也没有执行任何 DDL。
本次会话**早期**跑 `pnpm test:db` 是 **26 项全绿**的，之后（并发审查探针运行期间）
变成了这样；具体原因**未能确定**，不猜测。

**我没有修它**：`contents` 属 Agent 01 的冻结 schema，§10 明确禁止其他 Agent 改动，
而且对共享数据库执行 DDL 需要用户明确授权 —— 我尝试执行时权限系统正确拦下了，
我没有绕过。

**给 Agent 01 / 14 的行动项**：

1. 重建 `contents` 的 FULLTEXT 索引（DDL 见上述迁移文件，两条语句照抄即可）；
2. 顺带注意：`schema-contract.spec.ts` 里「`contents` 上存在 FULLTEXT 索引」这条断言
   **在索引不可用时仍然通过** —— 它只验结构、不验行为。这正是 §23.3 说的
   「结构检查通过 ≠ 功能可用」，建议补一条「索引真的能检索到词条」的守卫
   （现有那 4 条中文用例已经是，所以**只要它们在 CI 里跑**就够了）。

## 6. 无法在本环境验证（需人工确认）

1. `X_API_BEARER_TOKEN` 的**真实令牌路径**（本机 `api.x.com` 不可达）。
   ⚠ 而且由于本次修复的 P0，**在此之前即使配上令牌也必然 0 条入库** ——
   这条验证必须在 P0 修复后重做。
2. **Hugging Face 的真实端点形状**（本机 DNS 被污染）。
3. **`rediss:`（TLS Redis）**。
4. **多 worker 实例的锁竞争**（单机单 Redis）。
5. **生产 MySQL 的 `sql_mode`**。
6. **真实 hnrss.org / github.blog 的稳定出网**：本机偶发超时
   （dist 探针的一次运行 3 项 FAIL 全在此；另一次 22/22 PASS）。
   这与实现无关，但意味着那条探针不能当守门测试 —— 它的 DI 部分
   已经转成已提交的测试（F-14）。

---

# 补遗二（2026-09-24）：第二轮独立复审发现并修复的缺陷

> **第一轮审查通过之后**（P0 + P1-a/P1-b/P1-c 都已修、902 项单测 + 46 项集成全绿、
> 反证 12/12 有牙齿），第二轮独立复审**仍判不通过**，而且抓到一条
> **由我自己的修复新引入的 P1**。以下如实记录。
> 报告与原始产物：`work/_agent04/review-round2/review-C-verification.md`。

## 0. 第二轮复审确认「真修好」的

P0（X 采集）、P1-a（HN 永久漏采）、P1-c（`stripTags` ReDoS）、
P2（canonical 编码 / 游标语义 / 不可重试→DEAD）、
以及 DI 守卫、字段收敛、集成测试卫生 —— 复审都用**忠实复现旧实现的反证** +
真库 / 真适配器端到端确认过，反证全部变红。

## 1. ⚠ N1（P1，**本次修复新引入**）：`rejectDoctype` 全文扫描误杀合法 feed

**我做了什么**：把 DOCTYPE 守卫从「只看前 4KB」改成「扫描全文」，
理由写在注释里：「XML 里正文中的字面量 `<!DOCTYPE` 必须写成 `&lt;!DOCTYPE`」。

**那句话对纯文本成立，对 CDATA 段与注释不成立** ——
那两处的内容按 XML 规范**就是字面量、不转义**。而「用 CDATA 包一整篇 HTML」
正是 RSS `content:encoded` 的常见真实形态（WordPress 默认 feed 就是这样）。

**后果**（复审用真适配器 × 真 service 复现，我独立复现过）：
一份 19.7 KB 的**合法** feed，`<!DOCTYPE html>` 出现在 CDATA 里 →
**整条被拒绝** → 该来源永久 `SOURCE_FETCH_FAILED`、**0 条入库**。
而我的旧实现（前 4KB）是**放行**的 —— 也就是说，我把一个「守卫没做到它宣称的事」
（P3，后果有限）**改成了主动伤害**。

**修复**：先剥掉 CDATA 段与注释（`stripLiteralRegions`），再在剩余部分里找
`<!DOCTYPE`。既堵住 4KB 窗口的绕过，也不把「正文里的文档示例」当成真 DOCTYPE。
**并补了 CDATA / 注释两条回归用例**（复审的反证 M18 当时全绿 = 零覆盖，现在 M13 红）。

## 2. ⚠ N2（P1，**只修好了一半**）：RSS 每轮上限造成永久丢失，而 HANDOFF 声称相反

**复审的实测**：12 条 feed（顺序固定、最新在前）+ `maxItems=2`，连采 4 轮 →
库里只有 `post-11` / `post-12`，`post-1..post-10` **永久采不到**。

**为什么**：我在第一轮修掉了「时间游标」那一半，但适配器仍在解析时按 `maxItems`
截断 —— 而 feed 顺序稳定，每轮都取**同一批**最新条目，第 N+1 条之后永远轮不到。

**而且我的 HANDOFF 写着「这一轮只取 N 条，其余的下一轮还有机会」** —— 与实测相反。
按 §23.6「记录与实现不符视同缺陷」。

**修复**（机制改动，不是加个日志）：

- `CollectorBatch` 新增 `roundLimit`：适配器**返回整个窗口**（受一个硬上限约束：
  RSS 500 = `MAX_RSS_MAX_ITEMS`、GitHub 100 = `per_page` 上限），
  并声明「每轮最多入库多少条」；
- **service 在去重之后**按 `roundLimit` 截断 —— 已采到的被幂等键挡掉，
  下一轮自然从上次停下的地方继续，**窗口随轮次向下推进**；
- 留下的条数由一条 `info` 日志给出（`deferred`），**不是丢失**。

**验证**：端到端守卫「真 RSS 适配器 × 真 service，6 条 feed + maxItems=2，
3 轮后全部入库」（反证 M14 红）。

## 3. 其余修复

| #      | 严重度 | 问题                                                                                                                                                                                                                 | 修复                                                                                                      |
| ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **N3** | P3     | **X 的 `language` 未过收敛函数** → `lang="zh-Hant"` 在真库报「column too long」→ 整批 0 条。第一轮审查已经点出「建议一并收敛」，我只改了 GitHub 那条路。复审的反证显示这条路径**零覆盖**（接上收敛后 202+46 项全绿） | 接上 `normalizeLanguageTag`，**并补两条守卫**（超长 → `null`；`zh` 照常保留）                             |
| **N4** | P3     | F-09 的修复（队列名可注入）让**生产默认名失去了唯一的钉子** —— 反证把默认名改成 `collector-typo`，202+46 项**全绿**。而它一旦错，`apps/api` 与 worker 会落在两个队列上，**采集整体静默停止**                         | 暴露 `readonly queueName`，集成测试断言默认值等于 `QueueName.COLLECTOR`                                   |
| **N5** | P4     | `complete` 从「恒为 true 的谎言」变成了「HN 恒为 false 的常量」—— `/topstories.json` 固定 500 条、`HN_MAX_ITEMS` 固定 30，于是每轮都打一条**管理员无法行动**的告警（没有设置能让它变 true）                          | `complete` 改为可行动语义：**取回的条目里有没有处理失败的**；「只取前 30 条」是文件头写明的设计，不再报警 |
| **N6** | P4     | 批内去重用**未截断**的 externalId，落库用**截断后**的 → 两条只在第 513 个字符上不同的 guid 会撞成同一 `external_id`，库里两行同 id（该表无唯一约束，不报错），`docs/06` 的幂等键在写入那一刻被绕过                   | 把 `fitItemToColumns` **提前到去重之前**，两处用同一个值                                                  |
| **N7** | P4     | `clampToBytes` 的二分可能切在**代理对中间**，末尾留下半个 emoji（写库后变 `U+FFFD`）                                                                                                                                 | 截断后去掉结尾的孤立代理项                                                                                |
| **N8** | P4     | `stripTags` 的注释声称「旧实现会把未闭合 `<` 之后的内容**吞掉**」—— 实测**旧实现也不吞**，真正的差异是**多补一个空格**（经空白折叠后无影响）。配套断言 `out.length >= input.length` 对两种实现都成立，区分不了新旧   | 注释改为实测结论表；断言改为钉住**只有新实现成立**的性质                                                  |
| **N9** | P4     | payload 白名单校验失败（代码缺陷）被收敛成**可重试**的 `SOURCE_FETCH_FAILED`，重试 3 次只会延迟暴露 + 写 3 条同样的日志                                                                                              | 新增 `payloadContractViolated()`（不可重试）                                                              |

## 4. 反证（补遗二的守卫）

`work/_agent04/counterproof-round2.py`，6 条 —— **6/6 RED，0 空跑、0 harness 错误**：

```
M13  RED   N1：rejectDoctype 退回「不剥 CDATA/注释」的全文扫描
M14  RED   N2：RSS 退回「适配器自己按 maxItems 截断」
M15  RED   N4：队列默认名改成 collector-typo
M16  RED   N6：批内去重退回用未截断的 externalId
M17  RED   N3：X 的 language 不再过收敛函数
M18  RED   N5：HN 的 complete 退回「取满窗口即 false」
```

⚠ M14 的第一版是 **GREEN** —— 我的窗口推进守卫当时用的是 `StubAdapter`，
所以改坏 **RSS 适配器**不会让它变红。**守卫落在错误的层级**，
等价于测了替身自己的行为。补上「真 RSS 适配器 × 真 service」的端到端守卫后才红。
这与第一轮「守卫覆盖范围」的教训是同一类。

## 5. 补遗二带来的行为变更（下游必看）

1. **`CollectorBatch.roundLimit`** 是适配器声明「每轮最多入库多少条」的新字段；
   **截断发生在 service 的去重之后**。适配器**不应该**再自己按上限截断。
2. **RSS 与 GitHub 的请求窗口变大了**：RSS 最多解析 500 条（硬上限）、
   GitHub 的 `per_page` 从 30 提到 100。**不增加请求数**，但单次解析 / 查询的规模变大。
3. **`complete` 的语义收窄**为「上游这一次给的我有没有都读进来」；
   「这一轮入库了多少、还剩多少留到下一轮」是一条 `info` 日志（`deferred`）。
4. **CDATA / 注释里的字面量 `<!DOCTYPE` 不再被拒**（N1）。
5. **payload 白名单违规现在是不可重试的失败**（`SOURCE_CONFIG_INVALID`）。
