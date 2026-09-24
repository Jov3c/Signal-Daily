# Contract Change Request — Agent 03

**Agent:** 03 — Source Registry / X 白名单
**Module:** `apps/api/src/modules/sources/**`
**日期:** 2026-09-24
**依据:** 《Signal 多 Agent 执行规则 v1.0》§7

> 本文件记录 **7 项**需要公共契约 Owner（Agent 00 / 01 / 14）裁决的事项。
> 全部**不阻塞**下游开工：我已按最保守的方式实现，并在 HANDOFF 里写清了下游
> 必须对齐的具体形状。但其中第 1、2、6 项若不固化，Agent 04 会有真实的踩坑风险。

---

## 1. Source Registry 的「读侧」需要被 `apps/worker` 复用（**最重要**）

### Current Problem

`docs/02-repository-contract.md` 规定：

- API 模块在 `apps/api/src/modules/<module>/`
- Worker Job 在 `apps/worker/src/jobs/<area>/`

而 `docs/06` 与 `docs/19` 要求 **Agent 04（Collectors）+ Scheduler** 复用
Source Registry 的三样东西：

| 需要复用的东西 | 本模块的位置 | 为什么必须是同一份 |
| --- | --- | --- |
| SSRF / URL 安全校验 | `apps/api/src/modules/sources/url-safety/` | `docs/06` 明令「对 redirect 重新校验」。两份实现必然漂移，最终等于没有防护 |
| 「什么算到期」的查询规则 | `apps/api/src/modules/sources/scheduling.ts` | 各写一份的结果是「后台显示已停用，worker 还在抓」——线上极难排查 |
| 每种 `SourceType` 的 `config` 形状 | `apps/api/src/modules/sources/source-config.schema.ts` | 采集器读的就是这份 JSON；两边默认值假设不一致 → 采集行为静默变化 |

但我的允许修改范围**只有** `apps/api/src/modules/sources/**`。
`apps/worker` 直接 `import` `apps/api/...` 会把 Nest / Express 整条依赖树
拖进 worker 的构建图，是明确的架构倒退。

### Requested Change

把上述三样提升为一个**共享 workspace 包**，建议命名 `packages/source-core`
（或 `packages/net-guard`，若只提升 SSRF 部分）。归属 Agent 00。

### Reason

见上表。这是三个 Agent（03 / 04 / 14）之间的真实耦合点，
不解决就只能靠「三份复制品保持同步」这种不可持续的做法。

### Compatibility

**不影响已有模块**：这是新增包 + 把本模块内的实现**原样移动**过去，
本模块改为 re-export。行为完全不变。

### Database Impact

None

### API Impact

None

### Downstream Impact

- **Agent 04**：从新包 import，而不是从 `apps/api` 里抄。
- **Agent 14**：集成时把 `packages/source-core` 加进 `tsconfig` project references。

### 在裁决之前我做了什么

为了让将来的搬迁是**纯移动**（不需要改写），我已经把这三处写成：

- **零依赖**：`scheduling.ts` 与 `url-safety/ip.ts` 不 import 任何东西；
  `url-safety/url-safety.ts` 与 `safe-fetch.ts` 只依赖 `node:*` 与 `@signal/contracts`
  （两个 app 都已依赖它）。**没有 Nest、没有 Prisma、没有 ioredis。**
- **无副作用**：全部是纯函数与普通对象。

HANDOFF 里给出了精确的 import 路径与两种接法（含「CCR 未通过时」的临时方案）。

---

## 2. `collector.fetch-source` 的 Job 载荷形状未在 `docs/13` 定义

### Current Problem

`docs/13-queue-scheduler.md` 固定了 Queue 名、Job 名与 `JobId` 格式
（`collector:{sourceId}:{window}`），但**没有定义任务载荷**。
而 `POST /admin/sources/:id/fetch-now` 必须往里放一个任务，
Agent 04 的 Worker 必须消费它 —— 两边对不上就是一个静默失效的功能。

### Requested Change

在 `docs/13` 里固化载荷形状：

```jsonc
{
  "sourceId": "123",              // BIGINT → string（docs/02）
  "trigger": "manual",            // "manual"（管理员手动）| "schedule"（调度器到期）
  "requestedAt": "2026-09-24T01:00:56.616Z"  // ISO 8601 UTC
}
```

并定义 **幂等窗口**：`window` 取 `floor(now / 60s)`（epoch 分钟），
即同一分钟内重复的手动触发只入队一次。

### Reason

`trigger` 让 Worker 能区分「管理员手动触发的，应当在失败时更积极地重试/告警」
与「调度器到期的常规轮询」。不定义的话 Agent 04 只能猜。

### Compatibility

新增定义，不改既有内容。

### Database Impact

None

### API Impact

`POST /admin/sources/:id/fetch-now` 的响应体（见第 3 项）。

### Downstream Impact

**Agent 04**（载荷消费端）、**Agent 13 / 12**（若将来要在前端显示「已排队的抓取」）。

---

## 3. `docs/04` 未定义 `test` 与 `fetch-now` 的响应

### Current Problem

`docs/04` 只列了 8 条路由路径，没有定义其中两条的请求/响应语义：

- `POST /admin/sources/:id/test`
- `POST /admin/sources/:id/fetch-now`

### Requested Change

补充定义（我已按此实现）：

**`test`** → **HTTP 200**，成功与失败都 200：

```jsonc
{ "data": { "ok": false, "type": "RSS", "target": "https://example.com/feed",
            "latencyMs": 412, "message": "Target responded with HTTP 404" } }
```

「目标站点连不上」是这次探测的**结论**，不是请求本身出错 —— 所以不报 4xx/5xx。
只有「这个 Source 根本不存在」才是 404。

**`fetch-now`** → **HTTP 202 Accepted**：

```jsonc
{ "data": { "queue": "collector", "jobName": "collector.fetch-source",
            "jobId": "collector:123:29836860", "window": "29836860" } }
```

202 是「已受理、异步执行」的标准语义。Redis 不可用时 **503 `SOURCE_ENQUEUE_FAILED`**
（fail-closed，绝不返回「已入队」）。

### Reason

不定义的话 Agent 12（Admin UI）只能靠猜，而「探测失败到底是不是错误」
直接影响 UI 要不要弹红框。

### Compatibility

新增定义。

### Database Impact

None

### API Impact

新增两条端点语义（路由本身已在 `docs/04` 里）。

### Downstream Impact

**Agent 12**（Admin UI）。若 `docs/04` 最终不采纳 200/202，请通知我改。

---

## 4. `priority` / `trustScore` / `fetchIntervalSeconds` 的取值范围未定义

### Current Problem

`docs/03` 给了列类型（`TINYINT` / `DECIMAL(4,1)` / `INT`）与默认值，
但没有给**业务取值范围**。仅按列类型放行会放进 127、999.9 这类值。

### Requested Change

在 `docs/03`（或 `docs/06`）里写明：

| 字段 | 范围 | 理由 |
| --- | --- | --- |
| `priority` | `0–100` 整数 | 编辑权重，0–100 是一眼能懂的量纲（seed 数据是 80–95） |
| `trustScore` | `0–10`，**最多一位小数** | 列是 `DECIMAL(4,1)`，多出来的精度会被 MySQL **静默舍入** |
| `fetchIntervalSeconds` | `60–604800` 整数 | 下限是 `docs/06` 的调度精度（每分钟一轮），上限 7 天 |

### Reason

「存进去和读出来不一样」（静默舍入）必须在入口挡住，否则管理员会以为改成功了。

### Compatibility

收紧校验。存量 seed 数据（80–95 / 9.5 / 900 / 1800）全部落在区间内。

### Database Impact

None（不改列类型）

### API Impact

超出范围 → 400 `VALIDATION_FAILED`。

### Downstream Impact

Agent 12（Admin UI 表单的 min/max）、Agent 07（若也要写 Source）。

---

## 5. `nextFetchAt` 的初值与 enable 语义未定义

### Current Problem

`docs/06` 只说「每分钟查 `enabled && next_fetch_at <= now`」，
没说：新来源的 `next_fetch_at` 初值是什么？启用一个停用的来源要不要重置它？

**这一点有实际后果**：Agent 01 的 seed 建的 8 个来源**都没有写 `next_fetch_at`（= NULL）**，
如果「到期」判定只写 `next_fetch_at <= now`，这 8 个预置来源**永远不会被采集**。

### Requested Change

在 `docs/06` 里写明：

1. **`next_fetch_at IS NULL` 视为到期**（否则 seed 数据永远不采集）。
2. 新建来源时 `next_fetch_at = now`（`docs/06`：「新增账号后自动进入下一调度周期」）。
3. 「停用 → 启用」这个**状态跃迁**时 `next_fetch_at = now`。
4. **重复调用 `enable` 不重置** `next_fetch_at`（否则管理员反复点启用 = 反复插队，
   会把 `next_fetch_at` 早的正常来源饿死）。`enable` / `disable` 都是幂等的。

### Reason

第 4 条是刻意的产品取舍：调度顺序由 `next_fetch_at` 决定，而不是由
「谁最近被管理员点过」决定。若不写明，下游很容易实现成每次都重置。

### Compatibility

新增定义。

### Database Impact

None

### API Impact

`POST /:id/enable`、`POST /:id/disable` 的幂等语义。

### Downstream Impact

**Agent 04**（Scheduler 的到期查询与抓完之后的 `next_fetch_at` 推进）。

---

## 6. 每种 `SourceType` 的 `config` 契约未定义

### Current Problem

`sources.config` 是 `Json?`，数据库帮不上任何忙。`docs/04` 只给了一个
`X_USER` 的示例，没有定义其余 5 种类型的 config 键、默认值与必填规则。

这个形状是 **Agent 04（采集器）直接消费的**，不固化就一定会对不上。

### Requested Change

把下表写进 `docs/06`（或新建 `docs/24-source-config.md`）：

| `type` | config 键 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `RSS` | `maxItems` | `50`（1–500） | `feedUrl` 存在 `sources.feed_url` **列**上，不进 config |
| `X_USER` | `handle` | — **必填** | 1–15 位 `A-Za-z0-9_` |
| | `includeQuotes` | `true` | `docs/06`：可选 Quote Post |
| | `includeReplies` | `false` | `docs/06`：默认排除 Reply |
| | `includeReposts` | `false` | `docs/06`：默认排除纯 Repost |
| `GITHUB_REPO` | `repo` | — 必填（或 `externalId`） | `owner/name` |
| | `includeReleases` | `true` | |
| `HACKER_NEWS` | `feed` | `top` | 枚举 `top｜new｜best｜ask｜show｜job` |
| | `minScore` | `0`（0–10000） | |
| `HUGGINGFACE` | `repoType` | `model` | 枚举 `model｜dataset｜space` |
| | `repoId` | — 必填（或 `externalId`） | `owner/name` |
| `MANUAL_URL` | `url` | — **必填** | 抓取目标，经 SSRF 校验 |
| | `note` | 无 | ≤500 字符 |

另外两条实现约定：

- **写入时是「全量快照」**：该类型的全部已声明键都会显式写下（含默认值），
  而不是「只写偏离默认值的键」。理由是 Collector 读的就是这份 JSON ——
  稀疏存储下，一次不碰 config 的 `PATCH` 会让未落库的键在概念上退回代码默认值，
  两边假设一旦不同，采集行为会静默变化且无处报错。
- **`seed` / `seedNote` 两键在所有类型上都放行**：它们是 Agent 01 的 seed 标记，
  不是业务配置。不放行的话，管理员在 Admin UI 里回传一次完整 config 就会被拒。

### Reason

采集器与注册表共享同一个数据结构，必须有一份成文契约。

### Compatibility

`docs/04` 的 `X_USER` 示例仍然成立（`handle` / `includeQuotes` / `includeReplies`）。

### Database Impact

None

### API Impact

未知键 → 400 `SOURCE_CONFIG_INVALID`（严格白名单，防止 `includQuotes` 这类拼写错误静默生效）。

### Downstream Impact

**Agent 04**（主要）、Agent 12（表单字段）、Agent 14。

---

## 7. Admin mutation 的 CSRF / Origin 校验归属

### Current Problem

`docs/14-security.md` 要求「敏感 Admin mutation 进行 Origin check + CSRF token」。
Agent 02 的 HANDOFF 明确写：

> 未做 CSRF token …… `/admin/*` 属 Agent 03/07/12，若需要请在那里补
> （`AuthModule` 未注册全局 CSRF 中间件）。

也就是说这件事落到了每个 Admin 模块自己头上。各写一份必然不一致，
而且**很容易被漏掉**（漏掉不会有任何报错）。

### Requested Change

由公共 Owner 决定其一：

- **（推荐）** 在 `apps/api/src/common/` 提供**全局**的 Origin check 守卫
  （或直接在 `AuthGuard` 里做），一次覆盖 03 / 07 / 12 的全部 `/admin/*`；
- 或者明确写进 `docs/14`：「V1 依赖 `SameSite=Lax` Cookie + 各模块自建 Origin check」，
  并说明这是**已接受的残余风险**。

### Reason

CSRF 是「漏掉无声、补上重复」的典型横切关注点，最适合放在公共层。
`SameSite=Lax` 已经挡住了跨站表单 POST，但挡不住同站子域与旧浏览器，
所以 `docs/14` 才要求 Origin check。

### Compatibility

若走全局方案，本模块会**移除**自己的 Origin 守卫（避免两层重复）。

### Database Impact

None

### API Impact

非浏览器客户端（curl / 运维脚本）不带 `Origin` 头，必须**放行** ——
否则会破坏运维与 E2E 探针。所以规则只能是「**带了 `Origin` 就必须匹配**」，
不能是「必须带 `Origin`」。这一点建议一并写进 `docs/14`。

### Downstream Impact

Agent 07 / 12 / 14、Agent 11（部署时的 `APP_BASE_URL` 必须与实际访问域名一致）。

---

## 附：本模块**没有**提出的变更

以下是检查过、但**确认不需要**动契约的：

- **未新增任何 env**：只用了 `docs/20` 已记录的 `SOURCE_FETCH_TIMEOUT_MS` /
  `SOURCE_FETCH_MAX_BYTES` / `X_API_BEARER_TOKEN` / `GITHUB_TOKEN` / `REDIS_URL`。
- **未改 Prisma**：没有新字段、没有 Migration。
- **未新增枚举值**：`SourceType` / `SourceKind` / `SourceTier` 全部沿用。
- **未新增错误码同义项**：只**追加** 4 个（`SOURCE_DUPLICATE_SLUG` /
  `SOURCE_URL_NOT_ALLOWED` / `SOURCE_CONFIG_INVALID` / `SOURCE_ENQUEUE_FAILED`），
  与既有的 `SOURCE_NOT_FOUND` / `RATE_LIMITED` 等无同义冲突。
- **未新增 Queue / Job 名**：只用 `collector` / `collector.fetch-source`。
- **未引入订阅语义**（规则 §13）。
