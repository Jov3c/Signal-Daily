# Handoff

**Agent:** 06 — AI Provider / 翻译 / 分类 / 评分
**Wave:** 1（上游：Agent 00、Agent 01 —— 两者均 `✅ 已完成`）
**日期:** 2026-09-24
**基线:** Development Contract v1.1 / Frontend Prototype v1.7 / Agent Rule v1.0
**分支:** `agent/06-ai`

> ⚠ **先读末尾的《补遗（§23 独立审查）》**。正文里的实现描述在审查**之前**就已成立，
> 但两轮独立审查（安全向 / 工程向）在此之上仍查出 **1 个 P0 + 2 个 P1 + 6 个 P2**
> 以及一批 P3/P4，**全部已修复并加了有牙齿的回归守卫**。
> 其中「翻译任务根本进不了队列」与「prompt injection 防护可被 10 类不可见字符绕过」
> 这两条，在修复前 **886 项单测 + 21 项集成测试全绿**。
>
> 另外：有一条**跨 Agent 的契约缺陷**（契约里 3/4 个 `JobId` builder 的产物会被 BullMQ 拒绝，
> 会打到 Agent 04 与 Agent 08）—— 见 `CONTRACT_CHANGE_REQUEST-agent-06.md` 第 0 项。

---

## Task

`tasks/agent-06-ai.md` 的范围：统一 AI Provider、Prompt Registry、结构化输出、六维评分、成本记录，
并把 Source / Evidence 上下文喂给 credibility 判断。

`docs/08` 的硬约束（AI **不能**）：修改 Source Tier、自己宣布某来源「官方」、自动 publish、
因为转载次数多就提高独立来源数。

---

## Implemented

### 1. `AiProvider` 端口 + OpenAI-compatible 实现

- 业务代码只依赖 `AiProvider` 接口（`provider/provider.ts`），换 provider 的改动被限制在 `provider/` 内。
- `OpenAiCompatibleProvider` **只用 Node 22 内置的 `fetch`**，不引入任何 HTTP 客户端依赖；
  超时用 `AbortSignal.timeout()`。
- 失败按 `docs/13` 的三档收敛成 `AiError.kind`：`TRANSIENT`（超时 / 429 / 5xx，重试 3 次）、
  `SCHEMA_INVALID`（重试 1 次）、`UNSUPPORTED`（不重试），外加
  `NOT_CONFIGURED` / `UNAUTHORIZED` / `BUDGET_EXCEEDED` / `CONTENT_NOT_FOUND`（均不重试）。

### 2. Prompt Registry（版本强制）

- `prompts/registry.ts`：每个已实现任务登记 `version`（`v{N}`）与 **正文指纹**（FNV-1a）。
- 指纹被**钉在测试文件里**（不是自洽断言）：改动 prompt 正文一个字符即变红，
  逼作者显式决定「升版本还是改回去」。
- 未实现的任务（`DAILY_DRAFT` 等）**显式登记为 `null`**，取用时抛 `UNSUPPORTED`
  —— 「未实现」是一个显式状态，不是漏掉。

### 3. 结构化输出（zod 强校验）

- 每个 schema 都用 `.strict()`：**多余字段导致整份输出失败**。
  这是 `docs/08` 的「AI 不能改 Source Tier / 不能自称官方」在输出契约上的落点 ——
  模型试图输出 `sourceTier` / `official` 必须是一次**可见的失败**，而不是被静默丢弃。
- `schema/json-text.ts` 容忍真实上游的常见形态（```json 围栏、前后解说文字），
  但**不修复被截断的 JSON**（那是真的不完整，应当按 schema invalid 处理）。
- 错误详情**完全不含模型输出内容**，只带 `reason` 与 `outputLength`（见补遗 P3-2）。

### 4. 六维评分

- 权重 `importance 25 / relevance 20 / credibility 20 / novelty 15 / density 10 / readValue 10`
  （有测试断言**和恰为 100**）。
- **全程整数运算**，且返回值、`ai_analysis`、落库列三处是**同一个数**（见补遗 P2-3）。
- 档位 `>=85 TOP_CANDIDATE / 70–84.99 RECOMMENDED / 55–69.99 NORMAL / <55 LOW`，
  边界精确到 84.99 / 85.00。档位是**派生值、不落库**，因此不需要新枚举、不碰公共契约。
- 超范围与 `NaN` / `Infinity` 一律**向下收敛为 0**（而不是当成满分）。

### 5. Evidence 上下文（`tasks/agent-06-ai.md` 的「新输入」）

- 输出 `docs/08` 的六个字段，键序固定（prompt cache 友好）。
- `independentSourceCount` **只数 distinct `source_id`**：同一来源的 10 条证据算 1；
  `sourceId` 为 `null` 的不计入。
- `hasOfficialConfirmation` 看的是**证据那条来源**的 `official`，不是内容所属来源（见补遗 P2-2）。

### 6. 成本与预算

- 每个模型给一张代码内价格表 + **刻意取高**的未知名兜底价；
  `estimatedCostUsd` 缺失时写 `null` 而不是 `0`（`0` 会让预算静默少算）。
- 预算按 **Asia/Shanghai 业务日**统计（用 `@signal/config` 的 `businessDayRangeUtc()`，
  而不是 UTC 日 —— 否则上海每天早上 8 点预算重置，而日报目标发布时刻正是 08:00）。
- 80% 告警（`errorCode: AI_BUDGET_WARNING` + 可查询快照）、100% 暂停非关键任务；
  关键任务目前只有 `DAILY_DRAFT`。
- `AI_DAILY_BUDGET_USD = 0` 的字面语义是「一分钱都不能花」，**不是**「不限量」。

### 7. Prompt injection 防护（`docs/14`）

- **结构性保证**：不可信正文里的**每一个** `<` / `>` 都被改写成全角，
  因此分隔符 `<<<UNTRUSTED_CONTENT>>>` 在结构上无法被构造出来。
- 剔除集合用 Unicode **`Cf` / `Cc` 属性类**（不是手写码点表），
  并保留 `\t` / `\n` / `\r`。
- 换行折成空格用于**可信区**的单行标签（来源名、主题名）。
- 更上层还有：输出 schema 强校验 + **AI 永不写 `sources`**（真库层有守卫）。

### 8. 两个 Job

- `ai.translate`（cheap 档）→ 写 `contents.body_translated`，**绝不写 `body_original`**。
- `ai.classify-score`（medium 档）→ 写六维列 + `final_score` + `recommendation_reason` +
  `ai_analysis`（按任务分区，见补遗 P2-1）。
- 重试次数由 handler 按 `AiError.kind` 用 `UnrecoverableError` 收紧；
  终态写一行 `job_runs`（`docs/13` 的 Dead Letter：最终失败 = `DEAD`）。

---

## Files Added

**源码（32 个，全部在 `apps/worker/src/jobs/ai/`）：**

```text
ai.service.ts                 编排（预算 → provider → 校验 → 落库）
ai.worker.ts                  ai 队列消费者（重试收敛 + Dead Letter）
ai.types.ts                   任务分层 / 关键性 / 温度 / 失败分类→错误码
ai.errors.ts                  AiError + 失败分类→retry 策略
ai.config.ts                  从 docs/20 已有 env 派生（不新增 env）
ai-run.repository.ts          AiRepository 端口 + AiRun 两阶段契约
ai.config / ai-run…           见上
budget.ts                     业务日预算闸门（80% / 100%）
clock.ts                      可注入时钟
connection.ts                 REDIS_URL → BullMQ 连接参数
contract-enum.ts              契约枚举 → Prisma 枚举（写入方向）
enum-guard.ts                 Prisma 值 → 契约枚举（读取方向）
evidence-context.ts           docs/08 的六字段上下文
job-run.repository.ts         JobRunRecorder 端口
module.ts                     AiWorkerModule（自启动消费者）
pricing.ts                    价格表 + 兜底价 + 各任务输入上限
prisma-ai-run.repository.ts   唯一写库点
prisma-job-run.repository.ts  Dead Letter 落库
prisma.service.ts             Worker 侧 PrismaService
queue.ts                      入队契约 + JobId builder + 启动期自检
queue-names.ts                队列名 / 并发度
scoring.ts                    六维权重 / 档位 / 落库映射
untrusted.ts                  不可信正文隔离
index.ts                      公开面
prompts/{registry,build-messages}.ts
provider/{provider,openai-compatible.provider}.ts
schema/{classify-score,translate}.schema.ts  schema/{json-text,language,validate}.ts
```

**测试（13 个 `ai-*.spec.ts` + `test/support/ai-fakes.ts` + `test/tsconfig.json`）：**

```text
ai-jobid.spec.ts               JobId 段数 / 队列映射 / 入队选项（P0 回归守卫）
ai-untrusted.spec.ts           注入防护（结构性 + 模型视角）
ai-scoring.spec.ts             权重 / 确定性 / 档位边界 / 落库自洽
ai-pricing-budget.spec.ts      价格表 / 业务日边界 / 阈值
ai-schema.spec.ts              结构化输出（含 strict 与错误详情无回显）
ai-evidence-context.spec.ts    独立来源数 / 官方确认（含假阳性假阴性）
ai-prompts.spec.ts             版本指纹守卫
ai-service.spec.ts             编排（含跨任务 ai_analysis 不互相覆盖）
ai-worker.spec.ts              重试收敛 + Dead Letter
ai-score-write-scope.spec.ts   写入范围静态扫描（扫全模块）
ai-provider-openai.spec.ts     **本地真实 HTTP server**（不 mock fetch）
ai-db.integration.spec.ts      真 MySQL 不变式（21 项中的 17 项）
ai-queue.integration.spec.ts   真 Redis 重试次数与 builder
```

**其它：**

```text
apps/worker/vitest.integration.config.mts
handoffs/agent-06-HANDOFF.md（本文件）
handoffs/CONTRACT_CHANGE_REQUEST-agent-06.md（5 项，含跨 Agent 的第 0 项）
```

## Files Modified

```text
apps/worker/package.json       + zod；+ test:integration 脚本；typecheck 追加 tsc -p test/tsconfig.json
packages/contracts/src/errors.ts  仅**追加** 7 个 AI_* 业务码（62 insertions, 0 deletions）
pnpm-lock.yaml
```

---

## Database Migrations

**None**

未创建任何 Migration，未修改 `prisma/schema.prisma`、`prisma/migrations/**`、`prisma/seed.ts`
（§10：除 Agent 01 与最终 Agent 14 外任何 Agent 不得创建 Migration）。
所需字段（`ai_runs` / `contents.ai_analysis` / `job_runs`）在 Agent 01 的初始 schema 里已存在。

---

## Public Interfaces

下游从 `apps/worker/src/jobs/ai/index.ts` 取，**不要深入子目录**。

### 给 Agent 05（流水线）

```ts
import {
  AiService,        // runTask({ taskType, contentId })
  AiWorkerModule,   // imports 即完成接线（含消费者启动）
  classifyScoreJobId, translateJobId, AI_JOB_OPTIONS, AI_QUEUE_NAME,
} from '../jobs/ai';
```

**边界（重要）**：`AiService` **不写** `contents.pipelineStatus`，也**不写** `ContentTopic`。

- 状态机归你（Agent 05）。AI 跑完不代表内容该进入待审。
- 分类结果通过返回值给你：`outcome.topics`（kebab-case slug 数组）、
  `outcome.summary`（翻译任务的中文摘要）、`outcome.detectedLanguage`。
  由你把它们与 Content 的创建放在一起写，避免两个 Agent 争同一张关联表。
- 入队请用 `...AI_JOB_OPTIONS`（`attempts: 3`）——
  用 BullMQ 默认的 `attempts: 1` 会**静默关掉** handler 的重试分档。
  `assertEnqueueOptions()` 可自检。

### 给 Agent 07（审核后端）

- 分数与理由：`contents.{importanceScore,…,finalScore}`、`contents.recommendationReason`。
- **档位不落库**，用 `scoreBand(content.finalScore)` 现算（`>=85 / 70 / 55`）。
  `isHighPriority(band)` 即 `docs/08` 的「<55 默认不进高优先审核列表」。
- **`ai_analysis` 的结构是 `{ score: {...}, translation: {...} }`**（按任务分区）。
  读法是 `aiAnalysis.score.topics` / `aiAnalysis.score.band`。
- ⚠ **`AiTaskType.CLASSIFY` 永远不出现在 `ai_runs`**：分类与评分共用一次调用
  （job 名就叫 `ai.classify-score`），`AiRun.taskType = SCORE`。
  按 `taskType = CLASSIFY` 筛 `ai_runs` 会永远查不到 —— 见 CCR 第 3 项。
- Evidence 上下文的口径与 Agent 06 一致，可直接复用 `buildEvidenceContext()`。

### 给 Agent 08（发布）

- 复用 `untrusted.ts` 的隔离与 `AiService` 的编排做 `publishing.daily-draft`。
- `promptFor(AiTaskType.DAILY_DRAFT)` 目前抛 `UNSUPPORTED` —— 你实现时须在
  `prompts/registry.ts` 登记 prompt 并**升版本号**（指纹守卫会逼你显式确认）。
- ⚠ 你可能会用到 `JobId.dailyDraft` —— **它产出的 `daily-draft:{businessDate}` 是 2 段，
  会被 BullMQ 拒绝**（见 CCR 第 0 项）。在裁决前请勿直接使用。

### 给 Agent 11（运维）

- **Redis 是硬依赖**：引用 `AiWorkerModule` 会真的起一个 BullMQ 消费者。
- 单条 AI 调用失败 → `ai_runs.error_code`；任务最终失败 → `job_runs.status = 'DEAD'`。
- 预算：`AiService.budgetSnapshot()` 可按业务日查询；
  80% 会在日志里打 `errorCode: AI_BUDGET_WARNING`。
- ⚠ **`ai_runs` 可能残留永远 `RUNNING` 的行**（进程崩溃 / 收尾失败）。
  建议加一个巡检（见 Known Limitations 第 2 条）。
- ⚠ 价格表是代码常量，用表里没有的模型时成本是**兜底估算**而非真实账单。

### 给 Agent 14（集成）

1. **不要改 `worker.module.ts`** —— 根注册归你。`imports: [AiWorkerModule]` 即完成接线。
2. ⚠ **引用 `AiWorkerModule` 会启动真实 Redis 消费者**。若 `boot.spec.ts` 把队列模块
   纳入 `WorkerModule`，无 Redis 的机器上会开始刷重连错误（BullMQ 不同步抛错）。
   Agent 04 的 `CollectorsModule` 有同样性质 —— 建议你**统一**决定是否要一个
   「测试环境不启动消费者」的开关，而不是各模块自己发明。
3. ⚠ **跨 Agent 契约缺陷（CCR 第 0 项）**：`JobId.normalize` 与 `JobId.dailyDraft` 是 2 段，
   会被 BullMQ 拒绝（`Custom Id cannot contain :`）。会打到 Agent 04 与 Agent 08。
4. worker 侧有 5 处重复实现（PrismaService / 枚举桥接双向 / Redis 连接解析 / JobRun 落库），
   见 CCR 第 2 项。

---

## APIs Used

**外部：** 仅 OpenAI-compatible Chat Completions（`POST {AI_DEFAULT_BASE_URL}/chat/completions`），
用 Node 内置 `fetch`。**测试不调用任何真实外部服务**。

**内部：** `@signal/contracts`（枚举 / Queue / Job / 错误码 / `RetryPolicy`）、
`@signal/config`（`parseEnv` / `businessDateOf` / `businessDayRangeUtc`）、
`@signal/logger`。

---

## Events / Queues

不新增 Queue / Job（都用契约里已有的）。

| 项 | 值 |
| -- | -- |
| Queue | `ai`（`QueueName.AI`） |
| Job | `ai.translate` / `ai.classify-score` |
| 并发 | 3（`QUEUE_CONCURRENCY[QueueName.AI]`） |
| 入队 attempts | 3（`AI_RETRY.transient.attempts`） |
| JobId | `ai-score:{contentId}:{promptVersion}`（用契约 builder）<br>`translate:{contentId}:{promptVersion}`（**自造，见 CCR 第 1 项**） |
| 重试收敛 | 失败时按 kind 抛 `UnrecoverableError` |
| Dead Letter | 终态写 `job_runs`，最终失败 = `DEAD` |

---

## Environment Variables

**未新增任何 env。** 只用 `docs/20` 已有的：
`AI_DEFAULT_PROVIDER` / `AI_DEFAULT_BASE_URL` / `AI_DEFAULT_API_KEY` /
`AI_MODEL_CHEAP|MEDIUM|STRONG` / `AI_DAILY_BUDGET_USD`，以及 `REDIS_URL`、`LOG_LEVEL`。

`envSchema` 与 `.env.example` **未改**（`packages/config` 有测试断言 schema 与 `docs/20` 一一对应）。

---

## Tests

| 文件 | 覆盖 |
| ---- | ---- |
| `ai-jobid.spec.ts` (10) | JobId 段数 / 幂等格式 / 队列映射 / 入队选项 |
| `ai-untrusted.spec.ts` (33) | 结构性防闭合、10 类绕过字符、代理对截断、单行标签 |
| `ai-scoring.spec.ts` (21) | 权重和、确定性、档位边界、落库自洽 |
| `ai-pricing-budget.spec.ts` (18) | 价格表、业务日边界、80/100 阈值、未计价暴露 |
| `ai-schema.spec.ts` (26) | strict 拒多余字段、错误详情无回显、语言代码收敛 |
| `ai-evidence-context.spec.ts` (20) | distinct 来源、转载不抬高、官方确认真假阳性 |
| `ai-prompts.spec.ts` (16) | 指纹守卫、安全声明注入 |
| `ai-service.spec.ts` (32) | 前置顺序、AiRun 两阶段、失败不写产物、跨任务不覆盖 |
| `ai-worker.spec.ts` (32) | 重试收敛、Dead Letter、分类↔错误码 linkage |
| `ai-score-write-scope.spec.ts` (9) | 扫全模块：不写 sources / 不碰 pipelineStatus / 无 shell |
| `ai-provider-openai.spec.ts` (25) | 本地真 HTTP：URL/头/body/超时/全部错误分类 |
| `ai-db.integration.spec.ts` (17) | 真 MySQL：枚举桥接、DECIMAL 往返、事务回滚、范围快照 |
| `ai-queue.integration.spec.ts` (11) | 真 Redis：重试次数、builder 可入队、幂等 |

## Test Results

```text
pnpm lint                          ✓ 0 errors
pnpm typecheck                     ✓ tsc -b + web tsc --noEmit
pnpm --filter @signal/worker typecheck  ✓ tsc -b + tsc -p test/tsconfig.json
pnpm format:check                  ✓（本模块全部文件）
pnpm test                          ✓ 39 files / 938 tests        （基线 28 / 703）
pnpm test:db                       ✓ 1 file  / 26 tests         （真 MySQL 8.4.11）
pnpm --filter @signal/worker test:integration  ✓ 2 files / 28 tests（真 MySQL + 真 Redis）
```

独立审查做的反证（改动实现 → 确认变红 → 恢复）覆盖 16 + 10 个变体，
详见 `work/_agent06/review-security.md` 与 `review-engineering.md` 的反证记录表。

## Commands

```bash
pnpm test                                        # 单元测试（无需 MySQL / Redis）
pnpm test:db                                     # Agent 01 的库契约测试
pnpm --filter @signal/worker test:integration     # 本模块集成测试（需要 MySQL + Redis）

# 本机 Redis 未起时，可用：
#   <redis-server> --port 6390 --save '' --appendonly no
#   REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration
```

---

## Known Limitations

### 设计取舍（§23.6 要求逐条记录 —— 审查时这些只存在于代码注释里）

1. **预算闸门是软闸门。** 并发任务可能同时通过检查再各自消费，
   因此实际支出可以略微越过上限。它是**安全阀，不是账务**；
   精确拦截需要分布式锁或预留额度，而 `docs/01` 明确「任何关键业务状态不得只存在 Redis」。
2. **崩溃可能留下永远 `RUNNING` 的 `ai_runs` 行。** 没有 `finishedAt`，也没有清扫任务。
   **建议 Agent 11 加一个巡检**（例如「`RUNNING` 超过 10 分钟」告警）。
   接受它的理由是：有上界（`requestTimeoutMs` 内必然结束），
   且「有一条可疑的 RUNNING」本身是有用的信号。
3. **关键任务只有 `DAILY_DRAFT`**（其余任务预算耗尽即停）。若产品上认为评分也必须保证，改 `ai.types.ts` 的 `CRITICAL_TASKS` 即可。
4. **价格表是代码常量**，未知名走**刻意取高**的兜底价。
   它是**估算**，不是账务依据；用表里没有的模型时预算数字会偏离真实成本。
   若产品上不能接受，应走 CCR 第 4 项（新增单价 env）。
5. **`ai.classify-score` 一次调用同时产出分类与评分**，`AiRun.taskType = SCORE`，
   `AiTaskType.CLASSIFY` 在 V1 从不出现。见 CCR 第 3 项。
6. **翻译产物只写 `body_translated` + `ai_analysis`。** `contents.summary` 与
   `content_topics` 由 Agent 05 决定是否写（AI 不在流水线里抢写内容结构列）。
7. **固定分隔符而不是随机 nonce**（安全取舍）。理由是 prompt cache —— 随机 nonce 会让
   同一份正文每次 prompt 都不同，直接毁掉缓存，而 `AI_DAILY_BUDGET_USD` 只有 5 美元。
   固定的前提是「正文里不可能构造出分隔符」，这一条现在是**结构性**保证
   （见补遗 P1：第一版是启发式的，被绕过了）。
8. **不可信正文里的尖括号会被改成全角。** 代价是原文的 `<` / `>` 不再逐字保真。
   对本模块的用途（评分 / 分类 / 翻译）无影响；若将来有任务需要精确原文
   （例如代码片段提取），**不能复用** `sanitizeUntrustedText`，应另设受控通道。
9. **`translatedText` 上限是输入上限的 8 倍**（`TRANSLATED_TEXT_MAX_CHARS`）。
   中文译文通常比英文原文长 1.5–2 倍，8 倍给足余量同时把「无界写入」变成有界。
10. **`body_translated` 的 HTML sanitize 责任未明确。** `docs/14` 要求服务端 sanitize 后再展示，
    但本模块只做字符级隔离，不做 HTML 清洗。
    **谁负责清洗 `body_translated` 必须在集成阶段定下来**，否则前端可能直接渲染模型输出。
11. **成本按 `ai_runs.created_at` 归属业务日**，即调用**开始**时刻。
    跨业务日的调用（上海 23:59 发起、00:01 结束）成本记在前一天。口径确定、可解释。
12. **`JobRun` 只记终态**（`SUCCEEDED` / `DEAD`），不记每次重试 ——
    中间态由 BullMQ 自己保存，`job_runs` 回答的是「这个任务最后怎么样了」。

### 未修复但已上报

- `common/prisma/bigint-id.ts` 缺 BIGINT 上界（属 Agent 02，Agent 03 已提 CCR 第 8 项）。
  本模块在边界上用了自己的 `toBigIntId`。
- **契约里 3/4 个 `JobId` builder 的产物会被 BullMQ 拒绝** —— 见 CCR 第 0 项。

### 环境约束

- **两套集成测试共用同一个 MySQL 实例**（`.env` 的 `DATABASE_URL`），
  `fileParallelism: false` 只保证**进程内**串行。**两个进程同时跑会互相干扰**
  （实测：并发时 Agent 01 的 26 项里会随机挂 4 项；串行则稳定全绿）。
  CI 上请勿并行跑 `pnpm test:db` 与 worker 的 `test:integration`。

---

## Contract Change Requests

见 `handoffs/CONTRACT_CHANGE_REQUEST-agent-06.md`（5 项）：

0. ⚠️ **最高优先**：`JobId` 里 3/4 个 builder 的产物会被 BullMQ 拒绝（跨 Agent，打到 04/08）
1. `JobId` 缺 `ai.translate` 的 builder（我已自造，**已提 CCR**）
2. worker 侧 5 处重复实现（PrismaService / 枚举桥接双向 / Redis 连接解析 / JobRun 落库）
3. `ai.classify-score` 的语义：一次调用产出两个 `AiTaskType` 中的一个
4. `docs/20` 没有模型单价，预算只能是估算

**没有一项阻塞交付。**

---

## Integration Notes

### Git

- 仓库：`E:\desk\Signal-Project-Package-v1.2\Signal`，分支 `agent/06-ai`（基线 `main` = `7e47f77`）。
- 提交署名：Jov3c。
- ⚠ 开发期间 Agent 04 正在 `agent/04-collectors` 分支上**未提交地**工作，
  因此本次开发在**独立 git worktree**（`work/_agent06/Signal`）里进行，未触碰主工作树。
- ⚠ 与本模块相关的**冲突点**（合并时注意）：
  `apps/worker/package.json`（Agent 04/05 大概率也要加依赖）、
  `apps/worker/vitest.integration.config.mts`（新建的 app 级配置，若 Agent 04/05 各建一份会同名覆盖）、
  `packages/contracts/src/errors.ts`（双方都在文件末尾追加区块，会产生文本冲突）。

---

# 补遗（2026-09-24）：§23 独立审查后的缺陷修复

## 为什么有这个补遗

按 §23.2，两轮独立审查（**安全向**与**工程向**）由未参与本次开发的独立执行者完成，
各自在独立 worktree 里真跑命令、做反证。

**在审查之前，本 HANDOFF 正文描述的验证（938 项单测 + 28 项集成测试全绿、
16 个反证变体、真 HTTP server、真 Redis、真 MySQL）已经全部成立。**
审查仍然在上述全绿状态之上查出 **1 个 P0 + 2 个 P1 + 6 个 P2** 及一批 P3/P4。

以下内容**修正了正文里若干处过于乐观的声称**，下游必须按本节理解，不要按正文的旧结论做假设。

## 修复清单

| # | 严重度 | 问题 | 位置 |
| - | ------ | ---- | ---- |
| 1 | **P0** | `translateJobId` 产出 2 段 JobId，**被 BullMQ 直接拒绝** → `ai.translate` 根本进不了队列，翻译链路整体不可用 | `queue.ts` |
| 2 | **P1** | 注入防护可被 **10 类不可见格式字符**绕过（`U+200E`/`U+00AD`/`U+061C`/… ），分隔符可被提前闭合 | `untrusted.ts` |
| 3 | **P1** | `ai` 队列**没有任何消费者启动路径**（`AiQueueWorker` 只被测试 new 过） | `module.ts` |
| 4 | **P2** | `hasOfficialConfirmation` 判的是**内容来源**而不是**证据来源** → 官方光环加到二手来源 / 官方一手被当二手 | `evidence-context.ts` |
| 5 | **P2** | `SCORE` 与 `TRANSLATE` **整列互相覆盖** `ai_analysis` → 先评分再翻译会丢掉 `band` / `topics` | `prisma-ai-run.repository.ts` |
| 6 | **P2** | 失败路径丢弃**已知**的 token 与成本 → 已计费的调用对预算不可见 | `ai.service.ts` |
| 7 | **P2** | `final_score` 与同行的六维列**算术不自洽**（最多差 0.10，可**翻转档位**） | `scoring.ts` |
| 8 | **P2** | 写入范围不变式**只对着内存替身断言**，真实现零覆盖（注释引用的测试文件不存在） | 测试 |
| 9 | P3 ×7 | 上游错误体原文进日志 / 模型原文进日志 / `translatedText` 无上限 / `assertQueueMapping` 是死代码且不校验 attempts / 错误码 linkage 无守卫 / `JobRun = DEAD` 未实现 / 两处测试名与内容不符 | 多处 |
| 10 | P4 ×4 | 截断劈开代理对 / 空字符串 id 被当成 0 / `taskTypeOfJobName` 写死字面量 / 幂等入口零测试 | 多处 |

## 关键修复细节（下游必须了解）

### P0：`translateJobId` 的 JobId 被 BullMQ 拒绝（**破坏性**）

BullMQ 5 对含 `:` 的自定义 jobId 要求**恰好 3 段**：

```js
if (this.opts?.jobId?.includes(':') && this.opts?.jobId?.split(':').length !== 3) {
  throw new Error('Custom Id cannot contain :');
}
```

修复前 `translateJobId('123')` → `translate:123`（2 段）→ `queue.add()` **同步抛错**。

**修复**：签名加了 `promptVersion`，产出 `translate:{contentId}:{promptVersion}`。
**下游若已按旧签名调用，编译会直接失败**（这是好事）。

**为什么 21 项真 Redis 集成测试没发现**：集成测试自己拼 `it-<random>` 字面量，
**从来没调用过 builder**。「测试自己拼字面量」是一种很隐蔽的空跑。
现在 `ai-queue.integration.spec.ts` 会真的把 builder 的产物入队一次。

**同一规则会打到别人**：契约的 `JobId.normalize`（2 段）与 `JobId.dailyDraft`（2 段）
同样会被拒 —— 已提 CCR 第 0 项，影响 Agent 04 / Agent 08。

### P1：注入防护从「启发式」改成「结构性」（**改变正文内容**）

第一版规则是「把连续 3 个以上的尖括号改写掉」，并用手写码点表剔除不可见字符。
审查用真跑证明：**把 `<` 与 `>` 用表里没有的格式字符隔开**（10 类），
`/<{3,}/` 就不匹配了；而模型的 tokenizer 只要丢弃这些字符，就会看到一个**额外的闭标记**。

**修复**：

1. 剔除集合改成 Unicode **`Cf` / `Cc` 属性类**（手写表必然漏，且 Unicode 还在新增 `Cf`）；
2. 防闭合改成**结构性**：正文里的**每一个** `<` / `>` 都改写成全角 `＜` / `＞`。

**下游代价**：不可信正文里的尖括号不再逐字保真。
复用 `sanitizeUntrustedText` 的任务（例如 Agent 08 的日报草稿）要接受这一点。

**测试教训（值得所有 Agent 记住）**：原先所有断言数的都是**原始文本**里的标记，
而不是**模型看到的东西**。现在 `ai-untrusted.spec.ts` 对 10 类字符逐一断言
「模型视角下闭标记仍然只有一个」。

### P1：`ai` 队列现在会自启动消费者

修复前 `AiWorkerModule` 只提供 `AiService` 与仓储 ——
即使 Agent 14 按注释 import 了它，两个 Job 也**没有消费者**，入队的 job 会一直躺在 Redis 里。

**修复**：与 Agent 04 的 `CollectorWorker` 对齐，`AiQueueWorker` 是本模块的 provider，
由 `onModuleInit` 启动、`onModuleDestroy` 关闭。

**⚠ Agent 14 必读**：引用本模块会**真的连 Redis 并起消费者**。
若要保住「无 Redis 也能跑 `pnpm test`」，需要一个**统一的**开关 ——
这是对整个 app 所有队列模块的决策，请不要让各模块自己发明。

### P2：`hasOfficialConfirmation` 的来源归属（**语义变更**）

模块自己的定义是「`PRIMARY_SOURCE` 类型的证据，**且它的来源**被标为 official」，
但代码判的是**当前内容自己的来源**。两者在多来源事件里会分叉：

- **假阳性**：官方来源的内容 + 事件里任意一条 primary 证据（可能来自普通媒体）→ 被判「有官方确认」；
- **假阴性**：媒体来源的内容 + 事件里的官方一手证据 → 被判「没有官方确认」。

**修复**：`EvidenceProjection` 增加 `sourceOfficial`（证据自己那条来源的 `official`，
从 `event_evidence → sources` join 取得，`sourceId` 为 `null` 时也是 `null`）。
`findEventEvidences()` 的返回结构变了 —— 但它是本模块内部端口，下游只用 `buildEvidenceContext()`。

**Agent 07 注意**：审核页若自己也判「有没有官方确认」，请用同一口径，否则两边会不一致。

### P2：`ai_analysis` 改为按任务分区（**结构变更**）

修复前 `SCORE` 与 `TRANSLATE` 都整列覆盖，**串行执行也丢数据**（不是竞态）：

```text
先评分 → {"band":"TOP_CANDIDATE","topics":["ai-models"],...}
再翻译 → {"taskType":"TRANSLATE","detectedLanguage":"en"}   ← 评分侧全部消失
```

而 `ai.service.ts` 里恰好写着「即使 Agent 05 没有把 topics 写进 `content_topics`，
管理员在审核页仍能看到模型当时选了什么」—— 那句话在正常流水线形态下**不成立**。

**修复**：结构与写路径都改了：

```json
{ "score": { "dimensions": {...}, "finalScore": 76.32, "band": "RECOMMENDED",
             "reason": "...", "topics": [...], "promptVersion": "v1" },
  "translation": { "detectedLanguage": "en", "summary": "...", "promptVersion": "v1" } }
```

写路径改为**交互式事务内先读再合并**（数组式事务做不到「先读后写」）。

**⚠ Agent 07 必读**：读法是 `aiAnalysis.score.*` / `aiAnalysis.translation.*`，
不再是扁平结构。第一版写进去的扁平数据不会被保留（它本来就不完整）。

### P2：失败也要记成本

模型**已经答了、已经计费**，但输出不合 schema 时，第一版把 token 与成本写成 `null`
（`uncostedRuns` +1，而它不参与 `ratio`），于是这笔钱对预算**完全不可见**。

「答非所要」恰是最常见的失败形态，还会重试 —— 漏记会持续放大。
**修复**：usage 在**校验之前**就算出来并带进失败收尾。

### P2：分数三处一致（**影响档位**）

`scoreContent()` 返回**未量化**的维度，而加权时内部量化 —— 于是：

```text
aiAnalysis.dimensions = 84.85 / 落库列 = 84.8 / 参与计算 = 84.9
```

后果是 `final_score` 与「用落库六维重算」最多差 0.10，审查穷尽搜索找出
**3 组档位翻转**（例如落库 70.00 RECOMMENDED vs 重算 69.98 NORMAL）——
直接改变「进不进高优先审核列表」。

**修复**：`scoreContent()` 返回量化后的维度，三处是同一个数。
**注意**：`ai-scoring.spec.ts` 里原先有一条断言 `update.importanceScore === 87.34`
的用例 —— 那是在**把 bug 钉成期望行为**，已改正为断言量化值。

### 其它

- 上游非 JSON 错误体**不再回显原文**（只报长度与 content-type）；
  错误详情**不含模型输出内容**（只带 `reason` + `outputLength`）。
- `translatedText` 加了 `.max()`（输入上限的 8 倍）。
- `assertQueueMapping()` 现在**真的被调用**（`AiQueueWorker.start()`），并额外校验 JobId 段数。
- `FAILURE_KIND_TO_ERROR_CODE` 改用 `DomainErrorCode.*` 常量 + `DomainErrorCodeValue` 类型
  —— 改了契约码会**编译不过**，而不是静默产生未登记的码。
- 新增 `job_runs` 写入（`docs/13` 的 Dead Letter）。
- 截断避开代理对；空字符串 id 不再被当成 0；`taskTypeOfJobName` 改用 `JobName.*`。

## 新增/变化的测试

```text
修复前  pnpm test → 37 files / 886 tests ；integration → 21
修复后  pnpm test → 39 files / 938 tests ；integration → 28
```

新增两个测试文件（`ai-jobid.spec.ts`、`ai-score-write-scope.spec.ts`），
并把「事务回滚」「分数列白名单」「未知枚举抛错」「范围快照」搬进了**真库**集成测试
（原先只对着内存替身断言）。

**一条测试被加强而不是新增**：`瞬时失败恰好跑 3 次` 原先用 `attempts = 3` 入队，
而那时 handler 的上限与 BullMQ 的上限**重合** —— 把 `attemptsMade + 1` 改成
`attemptsMade`（语义猜错一格）之后它**仍然是绿的**。现在改成 `attempts = 5` 入队，
两种实现就分开了（3 次 vs 4 次）。已反证确认它现在会红。

## ⚠ 下游必须注意的破坏性变更（汇总）

1. `translateJobId(contentId)` → **`translateJobId(contentId, promptVersion)`**（编译期即可发现）。
2. `ai_analysis` 结构 → **`{ score: {...}, translation: {...} }`**（运行时，无编译期保护）。
3. `hasOfficialConfirmation` 的**判定口径变了**（同一份数据可能得出不同结论）。
4. `contents` 的六维列与 `final_score` 的值可能**与修复前不同**（量化方式变了）——
   历史数据与新数据之间会有最多 0.1 的差异，档位可能不同。
5. 不可信正文里的 `<` / `>` 变成全角（影响复用 `sanitizeUntrustedText` 的模块）。
6. 引用 `AiWorkerModule` 会**启动真实 Redis 消费者**（Agent 14 需要决定测试期的开关策略）。

## 审查报告原文

原样保存在（不在 git 仓库内，属于审查产物）：

```text
work/_agent06/review-security.md       安全向（含 10 个反证的记录）
work/_agent06/review-engineering.md    工程向（含 16 个反证的记录）
work/_agent06/probe-security/          安全向的探针脚本
work/_agent06/probe-engineering/       工程向的探针脚本
```

两份报告都确认：反证与探针跑完后工作目录干净、基线全绿。
