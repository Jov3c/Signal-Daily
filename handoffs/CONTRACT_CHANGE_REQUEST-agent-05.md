# Contract Change Request

**Agent:** 05 — Content Pipeline / Event / Evidence
**Module:** `apps/worker/src/jobs/content/`
**日期:** 2026-09-29
**基线:** Development Contract v1.1 / Agent Rule v1.0

> 本文按《Signal 多 Agent 执行规则 v1.0》§7 的模板撰写。
> **没有一项阻塞我的交付** —— 列出它们是为了不让「临时接法」变成事实契约。

---

## 0. ⚠️ 最高优先：`JobId.normalize` 会被 BullMQ 拒绝（**重申 Agent 06 的第 0 项**）

**这一项不是新问题**，是 Agent 06 在
`CONTRACT_CHANGE_REQUEST-agent-06.md` 第 0 项已经提过、**至今无人裁决**的。
我把它放在第 0 位是因为它**直接卡住了本模块的入队路径**。

### Current Problem

`packages/contracts/src/queues.ts`：

```ts
normalize: (rawItemId: string): string => `normalize:${rawItemId}`,   // 2 段
dailyDraft: (businessDate: string): string => `daily-draft:${businessDate}`,  // 2 段
```

而 `bullmq@5` 的 `Job` 构造函数要求**含 `:` 的自定义 jobId 必须恰好 3 段**。
真 Redis 实测（本机 6390）：

```text
REJECTED  contract JobId.normalize(rawItemId)  normalize:123      -> Custom Id cannot contain :
ACCEPTED  本模块的 3 段形态                     normalize:123:v1
```

### Requested Change

请 Agent 14 裁决（与 Agent 06 的第 0 项同一裁决）：

- **(a)** 把 `normalize` / `dailyDraft` 补成 3 段；
- **(b)** 统一换掉分隔符（4 个 builder 都要改）；
- **(c)** 在 `docs/13` 明确「custom jobId 只用 3 段形态」，并把 2 段的标为待修。

### Reason

按 §7 我不改公共契约，只能在 `queue.ts` 里自造 3 段 builder。
代价是「契约里写着一种格式、代码里用着另一种」——
**这种不一致本身就是下一批 bug 的来源**。

### Compatibility

- (a) 改变 JobId 形态 → **破坏 Redis 里在途 job 的幂等键**，部署时需清空或接受一次重复执行。
- (b) 破坏性更大。

### Database Impact

无。

### API Impact

无。

### Downstream Impact

Agent 04（`normalize` 的潜在使用者）、Agent 05（本模块）、Agent 08（`dailyDraft`）、
Agent 11（部署时的队列迁移）、Agent 14（裁决）。

---

## 1. `docs/13` 没有为 `content-pipeline` 定义重试策略

### Current Problem

`docs/13` 的 Retry 一节只定义了：

```text
Collector：3 次指数退避。
AI：timeout/429/5xx 3 次；schema invalid 1 次；unsupported 不 retry。
Publishing：3 次，但 publish job 必须幂等。
```

**content-pipeline 的三个作业完全没有重试定义**，而契约里也没有对应的
`CONTENT_PIPELINE_RETRY` 常量。

### Requested Change

在 `docs/13` 与 `packages/contracts/src/queues.ts` 里补一档，例如：

```ts
export const CONTENT_PIPELINE_RETRY: RetryPolicy = {
  attempts: 3,
  backoff: { type: 'exponential', delayMs: 5_000 },
};
```

### Reason

本模块取的是**本地默认值**（与 Collector 同档：3 次、指数退避 5s），
理由是两者的失败模式相近 —— 都是对外部数据的处理，瞬时故障重试有意义、
结构性错误重试无用。但这是**我的猜测，不是契约**。

### Compatibility

纯新增。

### Database Impact

无。**API Impact**：无。

### Downstream Impact

Agent 11（按重试策略做告警阈值时需要一个确定的数字）、Agent 14。

---

## 2. worker 侧现在有 **6 处**重复实现

### Current Problem

`apps/api/src/**` 不在 worker 的 tsconfig 引用图里，`docs/02` 又只允许跨 app
共享 `packages/*` —— 于是每个 worker Job 模块都各写一份。截至本模块交付：

| 用途 | 位置（各有 2–4 份） |
| ---- | ------------------- |
| `PrismaService` | api / collectors / ai / **content** |
| 枚举桥接（契约→Prisma） | collectors / ai / **content** |
| 枚举收敛（Prisma→契约） | ai / **content** / api 的 `prisma-enums.ts` |
| Redis 连接串解析 | api（`source-enqueuer`）/ ai / **content** |
| `JobRun` 落库（docs/13 的 Dead Letter） | collectors / ai / **content** |
| `bigint-id`（BIGINT 上界收敛） | collectors / api / **content** |

### Requested Change

新建一个共享包（例如 `packages/worker-kit` 或并入现有包），
把这些放进去；或明确「每模块各留一份」是接受的设计并写进 `docs/02`。

### Reason

各写一份的代价不是风格问题：**枚举桥接的表漏改一处，那条路径就会在运行期抛错**，
而 `tsc` 只能保证各自的表对自己是穷尽的。
`JobRun` 落库更麻烦 —— **三份实现的「DEAD 判定口径」必须一致**，
否则 Agent 11 的运维面板读同一张 `job_runs` 表却看到三种语义。

### Compatibility

选共享包会移动文件、影响 Agent 02/03/04/06/08。

### Database Impact / API Impact

无。

### Downstream Impact

Agent 02、03、04、06、07、08、09、10、14。

---

## 3. `CollectedItem.type` 在采集端落库时被丢弃

### Current Problem

采集端的 `CollectedItem` **有**一个 `type: ContentType` 字段
（`jobs/collectors/types.ts`，注释写着「建议的内容类型，**供 Pipeline 使用**」），
六个适配器也都填了。但它**没有落库**：

- `raw_items` 表没有 type 列（Agent 01 的 schema）；
- `NewRawItem`（采集端的落库端口）没有这个字段；
- `prisma-raw-item.repository.ts` 的 `createMany` 也没写它。

于是本模块只能按 `SourceType` + `payload` **重推**一遍
（`normalize/content-type.ts`），比如 GitHub 靠 `payload.tagName` 是否存在
区分 `GITHUB_RELEASE` 与 `GITHUB_REPO`。

### Requested Change

请裁决其一：

- **(a)** 让 `raw_items` 存下采集端算好的类型（需 Agent 01 加列 → Migration）；
- **(b)** 明确「重推是接受的」并把规则写进 `docs/02` / `docs/06`；
- **(c)** 把类型推导提到共享包，让采集端与 Pipeline 共用同一份。
  **（这是最干净的一条：既不需要加列，也消除了两处漂移）**

### Reason

现在是**两处实现同一套规则**（适配器里填的 + 本模块推的），
而漂移的表现是「内容类型静默变了」—— 没有任何报错。

### Compatibility

(c) 是纯新增包，无破坏性。

### Database Impact

(a) 需要 Migration（`raw_items` 加一列）。

### API Impact

无。

### Downstream Impact

Agent 04（适配器）、Agent 05（本模块）、Agent 10（按类型筛选）、Agent 14。
