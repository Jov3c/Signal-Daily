# Contract Change Request

**Agent:** 06 — AI Provider / 翻译 / 分类 / 评分
**Module:** `apps/worker/src/jobs/ai/`
**日期:** 2026-09-24
**基线:** Development Contract v1.1 / Agent Rule v1.0

> 本文按《Signal 多 Agent 执行规则 v1.0》§7 的模板撰写。
> 第 1 项我自己用临时方案绕过了（并在 HANDOFF 里注明），第 2–5 项需要 Agent 14 裁决。
> **没有一项阻塞我的交付** —— 列出它们是为了不让「临时接法」变成事实契约。

---

## 0. ⚠️ 最高优先：`JobId` 里有 **3 个 builder 的产物会被 BullMQ 直接拒绝**

> 这一项不是「我缺个 builder」，而是**契约里现成的 builder 有 3/4 不可用**。
> 它影响的不只是我 —— Agent 04 与 Agent 08 一旦照契约使用就会在入队时抛错。
> 单独放在第 0 位是因为它比本文其它各项都要紧。

### Current Problem

`bullmq@5.81.5` 的 `Job` 构造函数里有这么一条（`dist/classes/job.js`）：

```js
if (this.opts?.jobId?.includes(':') && this.opts?.jobId?.split(':').length !== 3) {
  throw new Error('Custom Id cannot contain :');
}
```

也就是：**含 `:` 的自定义 jobId 必须恰好 3 段**。

我是**先怀疑、后实测**才确认这一点的（独立审查也各自独立复现了）。真 Redis + 真 BullMQ 实测：

```text
ACCEPTED  contract aiScore               ai-score:123:v1            ← 3 段
ACCEPTED  contract collectorFetchSource  collector:1:2026-09-24     ← 3 段
REJECTED  contract normalize             normalize:123              ← 2 段
REJECTED  contract dailyDraft            daily-draft:2026-09-24     ← 2 段
REJECTED  （修复前）translateJobId        translate:123              ← 2 段
```

`packages/contracts/src/queues.ts` 的 `JobId` 共 4 个 builder，**3 个是 2 段**：

| builder | 产物 | 段数 | BullMQ |
| ------- | ---- | ---- | ------ |
| `collectorFetchSource` | `collector:{sourceId}:{window}` | 3 | ✅ |
| `normalize` | `normalize:{rawItemId}` | 2 | ❌ |
| `aiScore` | `ai-score:{contentId}:{promptVersion}` | 3 | ✅ |
| `dailyDraft` | `daily-draft:{businessDate}` | 2 | ❌ |

### 影响面（不是我一个人的事）

- `JobId.normalize` → **Agent 04** 的 `content.normalize` 入队会抛
  `Custom Id cannot contain :`；
- `JobId.dailyDraft` → **Agent 08** 的 `publishing.daily-draft` 同理；
- 两者都会表现为「任务根本没进队列」，而 BullMQ 抛的是同步异常，
  很容易被上层当成「入队失败」笼统处理掉，看不出根因。

### Requested Change

请 Agent 14 裁决其一：

- **(a)** 把 `normalize` / `dailyDraft` 补成 3 段（例如
  `normalize:{rawItemId}:{contentHash}`、`daily-draft:{businessDate}:{attempt}`）；
- **(b)** 统一换掉分隔符（例如 `normalize__{rawItemId}`），
  但那样 4 个 builder 都要改，且要让出一条迁移路径；
- **(c)** 在 `docs/13` 明确「custom jobId 只用 3 段形态」，
  并把 2 段的两个 builder 标为待修。

**无论选哪个，都建议加一条守卫**：所有 `JobId.*` 的产出必须
`split(':').length === 3`（或按 (b) 的规则）。这类约束 `tsc` 管不着，
只有运行期或显式断言能守 —— 而它已经真实地坑过一次：

> 我在 `queue.ts` 里自造的 `translateJobId` 原本产出 `translate:{contentId}`（2 段），
> 而当时 **886 项单测 + 21 项集成测试全绿** ——
> 因为集成测试自己拼 `it-<random>` 字面量，**从来没调用过 builder**。
> 「测试自己拼字面量」是一种很隐蔽的空跑。

### Compatibility

- (a) 会改变 normalize / dailyDraft 的 JobId 形态，**破坏已经在 Redis 里的 job 幂等键**
  （部署时若队列里有在途 job，需要清空或接受一次重复执行）。
- (b) 破坏性更大。

### Database Impact

无。

### API Impact

无。

### Downstream Impact

Agent 04、06、08；Agent 11（部署时的队列迁移）、Agent 14（裁决）。

---

## 1. `JobId` 缺少 `ai.translate` 的 builder

### Current Problem

`packages/contracts/src/queues.ts` 的 `JobId` 只有 4 个 builder：

```text
collectorFetchSource / normalize / aiScore / dailyDraft
```

`docs/13` 的 JobId 示例也只给了这 4 种形态。但 `docs/13` 的 Job 清单里有 **10 个 Job**，
其中 `ai.translate` 没有对应的幂等键格式。

### Requested Change

在 `JobId` 里补一个：

```ts
/** `translate:{contentId}:{promptVersion}` */
translate: (contentId: string, promptVersion: string): string =>
  `translate:${contentId}:${promptVersion}`,
```

### Reason

Agent 00 的 HANDOFF 是硬性要求：

> **必须使用 `JobId.*` builder 生成 JobId**，不要自行拼字符串，否则幂等会被破坏。

而契约里没有 translate 的 builder，于是我要么自己拼字符串（违反该要求），
要么不提供幂等键。我的临时做法是在 `apps/worker/src/jobs/ai/queue.ts` 里写了
`translateJobId()`，格式 `translate:{contentId}`。

**注意我漏了 `promptVersion`** —— 这正是「自己拼字符串」的代价：
`aiScore` 的 builder 带 `promptVersion` 是刻意的（prompt 改版后要能重评），
而一个手写的 translate JobId 没有这个维度，于是翻译 prompt 改版后
**历史内容永远无法被重新翻译**。这个洞是契约缺口直接导致的，应该在契约层修掉。

### Compatibility

纯新增，不影响任何已有调用方。

### Database Impact

无。

### API Impact

无。

### Downstream Impact

Agent 06（替换临时函数）、Agent 14（集成时统一）。

---

## 2. Worker 侧的公共桥接被重复实现了三份

### Current Problem

`apps/api` 里有一份 Agent 02 落地的公共层：

```text
apps/api/src/common/prisma/prisma-enums.ts   枚举桥接
apps/api/src/common/prisma/prisma.service.ts @Global PrismaService
```

但 `apps/api/src/**` **不在 worker 的 tsconfig 项目引用图里**，
跨 app import 会把 api 的整个源码树拖进 worker 的构建 —— 而 `docs/02` 只允许
跨 app 共享 `packages/*`。结果是每个需要 DB 的 worker 模块都得自己写一份。

截至目前（含 Agent 04 未提交的工作）worker 侧已经有三份重复：

| 用途                    | 位置                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| PrismaService           | `apps/worker/src/jobs/collectors/prisma.service.ts`（Agent 04）、`apps/worker/src/jobs/ai/prisma.service.ts`（Agent 06） |
| 枚举桥接（契约→Prisma） | `jobs/collectors/contract-enum.ts`（Agent 04）、`jobs/ai/contract-enum.ts`（Agent 06）                                   |
| 枚举收敛（Prisma→契约） | `jobs/ai/enum-guard.ts`（Agent 06，与 api 的 `prisma-enums.ts` 同一函数）                                                |
| Redis 连接串解析 | `apps/api/src/modules/sources/source-enqueuer.ts` 的 `redisConnectionOptions()`（Agent 03）、`jobs/ai/connection.ts` 的 `parseRedisConnection()`（Agent 06） |
| `JobRun` 落库（docs/13 的 Dead Letter） | `jobs/collectors/`（Agent 04）、`jobs/ai/job-run.repository.ts` + `prisma-job-run.repository.ts`（Agent 06） |

### Requested Change

请裁决其一：

- **(a)** 新建 `packages/prisma-kit`（或并入现有包），把 `PrismaService` +
  双向枚举桥接放进去，api 与 worker 共用；
- **(b)** 明确「worker 每个 Job 模块各留一份」是**接受的设计**，并写进 `docs/02` / `docs/18`。

### Reason

Agent 02 的 HANDOFF 明确写着「**下游请复用，不要各建一份**」，
但那条指令在 worker 侧**物理上无法执行**。这不是风格问题：
三份 `contract-enum.ts` 各自维护一张映射表，`AiTaskType` 或 `SourceType`
新增取值时**只要有一份忘了改，那条路径就会在运行期抛错**，
而 `tsc` 只能保证各自的表对自己是穷尽的。

我按 §9「只改自己模块目录」选了 (b) 的现状（各留一份并记入 HANDOFF），
但这个决定影响了 4 个以上 Agent，应由 Agent 14 统一。

### Compatibility

选 (a) 会移动文件、影响 Agent 02/03/04/06；选 (b) 无影响。

### Database Impact

无。

### API Impact

无。

### Downstream Impact

Agent 02、03、04、06、07、08、09、10。

---

## 3. `ai.classify-score` 的语义：一次调用产出两个 `AiTaskType`

### Current Problem

`docs/13` 的 Job 名是 `ai.classify-score`（一个 Job），
而 `docs/05` 的 `AiTaskType` 里 `CLASSIFY` 与 `SCORE` 是**两个独立取值**。
`AiRun.taskType` 只能填一个。

于是「一次调用同时产出分类与评分」时，`ai_runs` 的行只能记成 `SCORE`，
`CLASSIFY` 这个取值在本模块**永远不会被写到**。

### Requested Change

请裁决其一：

- **(a)** 确认现实现是正确的：`ai.classify-score` = 一次 provider 调用，
  同时产出 dimensions 与 topics，`AiRun.taskType = SCORE`；
  `CLASSIFY` 保留给将来的独立分类任务。**（这是我采用的解释）**
- **(b)** 要求拆成两次调用 / 两条 AiRun（`CLASSIFY` + `SCORE`）；
- **(c)** 在 `docs/05` 或 `docs/08` 里写明「分类与评分共用一次调用」，
  并把 `AiTaskType.CLASSIFY` 标注为「预留未使用」。

### Reason

我选 (a) 的依据是 Job 名本身就叫 `classify-score`（一个 Job），
且拆成两次调用会让成本翻倍而信息量不变（同一个模型、同一份正文、同一份上下文）。
但「`AiTaskType.CLASSIFY` 在 V1 从不出现」这件事必须被显式确认，
否则 Agent 07 做审核页筛选时可能按 `taskType = CLASSIFY` 去查，永远查不到。

### Compatibility

选 (b) 会改变 ai 队列的调用次数与成本，影响 Agent 05/08 的预算预期。

### Database Impact

无（`AiTaskType` 已含两个取值，不需要迁移）。

### API Impact

选 (b) 会让 `ai_runs` 行数翻倍（Admin 若展示 AI 调用历史会看到差别）。

### Downstream Impact

Agent 05、07、08、11（成本与队列监控）。

---

## 4. `docs/20` 没有模型单价，预算只能是估算

### Current Problem

`docs/08` 要求「预算 80% 告警 / 100% 非关键任务暂停」，
`AI_DAILY_BUDGET_USD` 也确实存在（默认 5）。
但 `docs/20` 只有 `AI_MODEL_CHEAP|MEDIUM|STRONG` 三个**自由字符串**，
没有任何单价变量 —— 而 `AI_DEFAULT_BASE_URL` 允许指向任意 OpenAI-compatible 端点。

**没有单价就算不出成本，`estimatedCostUsd` 只能是 null，预算就永远不会触发。**

### Requested Change

请裁决其一：

- **(a)** 确认现实现：价格表作为**代码常量**（`apps/worker/src/jobs/ai/pricing.ts`），
  未知名走**刻意取高**的兜底价；不新增 env。**（这是我采用的解释）**
- **(b)** 在 `docs/20` 增加 `AI_PRICE_INPUT_PER_MILLION_USD` /
  `AI_PRICE_OUTPUT_PER_MILLION_USD`（或一张 JSON 表），同步改 `envSchema` 与 `.env.example`；
- **(c)** 约定「成本以 provider 账单为准，`AiRun.estimatedCostUsd` 仅作参考」，
  并把预算降级为「token 数上限」而不是美元上限。

### Reason

我选 (a) 的理由：§20 明令「任何代理不得新增未记录 env」，改 `docs/20` 必须走 CCR；
而 (a) 不新增契约，且兜底价**刻意取高**——宁可让预算早一点触发（可见的告警），
也不要因为低估而静默超支（静默失败）。

**这是设计取舍，已记入 HANDOFF。** 但请确认这个取舍可接受：
它意味着**部署方用表里没有的模型时，预算数字是估算而非真实成本**。
若产品上不能接受，应走 (b)。

### Compatibility

选 (b) 需要同步改 `docs/20` + `envSchema` + `.env.example`（三者有测试断言必须同步）。

### Database Impact

无。

### API Impact

无（`estimatedCostUsd` 是可空列，语义不变）。

### Downstream Impact

Agent 11（部署时要填单价）、Agent 08（日报草稿是 strong 档，成本最高）。
