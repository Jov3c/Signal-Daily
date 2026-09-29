# Handoff

**Agent:** 05 — Content Pipeline / Event / Evidence
**Wave:** 1B（上游：Agent 00、01、04、06 —— 四者均 `✅ 已完成`）
**日期:** 2026-09-29
**基线:** Development Contract v1.1 / Frontend Prototype v1.7 / Agent Rule v1.0
**分支:** `agent/05-pipeline`

> ⚠ **本次交付未做 §23 独立审查。**
> 用户明确要求「一个 agent 开发就行」，因此原 §23 的独立审查（连轻量版）
> 都没有执行。**这不是遗漏，是应要求跳过**，但下游必须据此评估风险：
> 本 HANDOFF 里的全部验证都由**作者自己**完成，
> 而本项目的历史反复证明「作者自测全绿 ≠ 验过了」
>（Agent 00/01 查出 6 个真 bug、Agent 06 查出 1 个 P0，都在全绿状态下）。
>
> **本模块自查过程确实抓到了 12 个自己制造的问题**（见文末《自查记录》），
> 其中 3 个属于「两个 bug 叠加、修好一个才暴露另一个」那类。
> 但**这不等于独立审查** —— 建议 Agent 14 在最终集成前对本模块补一次审查，
> 重点看：HTML 清洗策略是否够狠、相似度阈值在真实数据上的表现、
> 以及状态机在失败路径上的终态。

---

## Task

`tasks/agent-05-pipeline.md`：

实现 `RawItem → Normalize → Exact Dedup → Near Dedup → Event Cluster →
Evidence Attach → AI Analysis → Review Queue`，**每阶段必须幂等**。

Evidence 责任（任务书单列的一节）：

- 同 Event 关联多来源
- 自动生成 Primary / Supporting / Official / Social Evidence
- `distinct source_id` 计算独立来源基础值
- 同 URL / 同 Source 重复证据去重
- Event Primary Evidence 事务安全

禁止：改 Source Tier、直接发布、把转载数量当独立来源数量。

---

## Implemented

### S1 Normalize（RawItem → Content）

**HTML 清洗**（`docs/14` 五条要求的白名单实现，用 `sanitize-html` 而不是手写）：

| `docs/14` 要求 | 实现 |
| -------------- | ---- |
| 删除 script | 白名单里没有 `script`，且它在 `nonTextTags` 里 → **连内容一起丢** |
| 删除 event handler | `allowedAttributes` 里**没有任何 `on*`**，`*` 上零属性 |
| iframe 默认删除 | 不在白名单 + `nonTextTags` |
| style 白名单 | 只放行 `text-align` 的四个合法值，且只在块级排版标签上 |
| URL scheme 白名单 | `http` / `https` / `mailto`；相对 URL 允许；**`data:` 拒绝** |

**正文提取**（`html/extract.ts`）：MANUAL_URL 的 `bodyRaw` 是**整页 HTML**
（Agent 04 的交接第 ① 条），所以按 `article` → `main`/`[role=main]` → `body` → 片段
的顺序取正文。同类容器取**文本最长**的那个（首页多卡片场景）。

**其余判断**：标题三级回退（来源标题 → 正文首段 → URL 末段）、
缩略图取正文第一张图、`language` 缺失落 `und`（**不猜**）、
`ContentType` 按 `SourceType` + `payload.tagName` 推导。

### S2 Exact Dedup（`docs/06` 幂等键 ③）

用采集端算好的 `RawItem.contentHash`（走 Agent 01 建的索引），
**在 Content 落库之前**判 —— 保证同一份内容库里恰好一行。
被判定重复的那条只留 `raw_items.status = DUPLICATE`（原始事实仍可追溯）。

### S3 Near Dedup

**中文按字符二元组（bigram）+ Jaccard**，不按词 —— 中文没有空格，
按空白切词会让任意两篇中文要么全同、要么相似度为 0。
阈值 **0.35 是实测校准的**（详见《设计取舍》第 3 条）。
结果按「跨源 / 同源」分组，**不做任何删除或标记** ——
同一事件的多来源报道是 `docs/22` 里**有价值**的独立来源。

### S4 Event Cluster

- **主来源 5 档全序**（`cluster/priority.ts`）：官方 → 当事人 → 核心开发者
  → 高质量媒体 → 二手；档位之外还有两个确定性决胜键。
- **归属判定**（`cluster/event-cluster.ts`）复用 S3 的相似度结果，不重算。
- `Event` / `EventContent` / `contents.event_id` 同事务写入。

### S5 Evidence Attach

- 五类证据按**来源属性**映射（`official`/`tier`/`kind`），不看正文。
- 官方来源的**第一条**是 `PRIMARY_SOURCE`，后续是 `OFFICIAL_CONFIRMATION`。
- `distinct source_id` 算独立来源数（`docs/03`：**不冗余存储**）。
- 同 URL 靠 `EventEvidence` 的 `@@unique([eventId, urlHash])` 去重。
- **Primary 唯一靠事务**：先清旧的 → 插新的 → 再设新的，三步同一事务。

### S6 AI 衔接 + Review Queue

- 聚类完成后：挂证据 → `pipelineStatus = ANALYZING` → 入队
  Agent 06 的 `ai.translate` + `ai.classify-score`。
- **收尾扫描** `sweepForReview()`：把「AiRun 都不在途、还没有审核行」的
  内容推进到 `REVIEW_PENDING` + 建 `EditorialReview(PENDING)` + 落 `ContentTopic`。
  由模块内的 `setInterval(60s)` 驱动（**不需要分布式锁**，见《设计取舍》第 6 条）。

---

## Files Added

**源码（26 个，全部在 `apps/worker/src/jobs/content/`）：**

```text
content.service.ts            编排（Normalize/Dedup/Cluster/Evidence/AI/Review）
content.worker.ts             content-pipeline 消费者（三个作业 + Dead Letter）
content-enqueuer.ts           入队端口（含转交 ai 队列）
module.ts                     ContentPipelineModule（自启动消费者 + 收尾扫描）
queue.ts / queue-names.ts     3 段 JobId + 启动期自检 + 重试选项
ports.ts                      持久化端口
prisma-content.repository.ts  唯一写 contents/raw_items/events/event_evidence 的地方
prisma-job-run.repository.ts  Dead Letter 落库
prisma.service.ts / connection.ts / bigint-id.ts / contract-enum.ts
normalize/normalize.ts        纯函数：RawItem → Content 的全部判断
normalize/content-type.ts     SourceType + payload → ContentType
html/policy.ts                清洗策略（docs/14 逐条）
html/sanitize.ts              清洗执行 + 实质性判据
html/extract.ts               整页 → 正文区域
html/plain-text.ts            HTML → 纯文本（给 AI 用）
dedup/exact.ts                精确判重（正本选择）
dedup/similarity.ts           中文 bigram + Jaccard + 阈值
cluster/priority.ts           主来源 5 档
cluster/event-cluster.ts      归属判定 + Event.status/relation 常量
evidence/evidence-plan.ts     证据规划（类型映射 + Primary 选择）
job-run.repository.ts         JobRunRecorder 端口
index.ts                      公开面
```

**测试（10 个文件）：**

```text
content-html-sanitize.spec.ts       47  清洗（docs/14 五条 + 绕过手法）
content-normalize-extract.spec.ts   19  正文提取 + 类型推导
content-normalize.spec.ts           29  Normalize 纯函数
content-dedup-exact.spec.ts         16  精确判重（正本选择/平局/脏 id）
content-dedup-similarity.spec.ts    23  中文相似度 + 阈值校准依据
content-cluster.spec.ts             24  主来源优先级 + 归属判定
content-evidence.spec.ts            24  证据类型 + 独立来源 + Primary
content-service.spec.ts             58  编排（幂等/串联/失败/证据/AI/收尾）
content-db.integration.spec.ts      32  **真 MySQL**
content-queue.integration.spec.ts   13  **真 Redis + 真 BullMQ**
```

**其它：**

```text
handoffs/agent-05-HANDOFF.md（本文件）
handoffs/CONTRACT_CHANGE_REQUEST-agent-05.md
work/_agent05/PROGRESS.md（开发期任务看板，不在 git 内）
```

## Files Modified

```text
apps/worker/package.json          + sanitize-html@2.17.0、htmlparser2@^10.1.0（+ @types/sanitize-html dev）
packages/contracts/src/errors.ts  仅**追加** 2 个业务码（CONTENT_RAW_ITEM_NOT_FOUND / CONTENT_EMPTY，删除 0 行）
pnpm-lock.yaml
```

**未触碰**：`prisma/**`、`apps/worker/src/worker.module.ts`、
`apps/worker/src/jobs/collectors/**`、`apps/worker/src/jobs/ai/**`、
`packages/contracts` 的枚举 / Queue / Job / DTO。

---

## Database Migrations

**None**

未创建任何 Migration，未改动 `prisma/schema.prisma`。
本模块用到的表（`raw_items` / `contents` / `content_topics` / `events` /
`event_contents` / `event_evidence` / `editorial_reviews` / `topics`）
在 Agent 01 的初始 schema 里都已存在，**没有新字段需求**。

---

## Public Interfaces

下游从 `apps/worker/src/jobs/content/index.ts` 取。

### 给 Agent 07（Admin Review API）

- **审核队列的来源**：`EditorialReview(status=PENDING)` 由本模块在
  `sweepForReview()` 里创建（见《设计取舍》第 5 条）。Agent 07 直接查即可。
- **`ai_analysis` 的读法**（Agent 06 的分区结构）：
  `aiAnalysis.score.band` / `aiAnalysis.score.topics` / `aiAnalysis.score.dimensions`。
- **`ContentTopic.confidence` 恒为 `1`**：Agent 06 的输出契约里没有逐主题置信度，
  本模块写 `1` 表示「模型选定」，**没有编造一个小数** ——
  编出来的 0.87 会被下游当成有依据的数字。
- 事件与证据：`Event.primaryContentId`、`EventContent.relation`
  （`primary` / `related`）、`EventEvidence.isPrimary`（**每事件至多一个**）。

### 给 Agent 08（Publishing / Daily）

- 日报候选应当是 `pipelineStatus = REVIEW_PENDING` 且 `EditorialReview` 已通过的内容。
- `Event.lastSeenAt` 会随新报道持续推后 —— 一个长期话题可能聚成很大的事件，
  **V1 不做事件边界切分**（见《设计取舍》第 4 条）。

### 给 Agent 10（Search / Public API）

- `contents.body_original` 存的是**已清洗的 HTML**（`docs/14` 的清洗点在本模块）。
  **不要二次渲染未清洗的内容，也不需要再清洗一遍**（重复清洗是安全的但没必要）。
- `contents.body_translated` 由 Agent 06 写入。
- `language` 可能是 `und`（来源没给语言时）—— 前台按语言筛选时请把它当作「未知」。

### 给 Agent 11（Ops）

- **Redis 是硬依赖**：`imports: [ContentPipelineModule]` 会真的连 Redis
  并起一个 BullMQ 消费者 + 一个 60 秒的收尾扫描定时器。
- 收尾扫描是**幂等**的，所以**没有加分布式锁**（见《设计取舍》第 6 条）。
- 状态机终态：`INGESTED → ANALYZING → REVIEW_PENDING`；
  数据结论失败时 `raw_items.status = FAILED` + `failure_code`。
- ⚠ **`raw_items.status = FAILED` 是终态**：本模块不会自动重试它。
  需要人工在后台看（或由 Agent 07 提供重跑入口）。

### 给 Agent 14（最终集成）—— 必做

```ts
// apps/worker/src/worker.module.ts
@Module({ imports: [ContentPipelineModule] })
export class WorkerModule {}
```

1. ⚠ **引用 `ContentPipelineModule` 会启动真实 Redis 消费者 + 定时器**。
   与 `CollectorsModule` / `AiWorkerModule` 行为一致 —— 需要一个**统一的**
   测试期开关，别让各模块自己发明。
2. ⚠ **worker 侧现有 6 处重复实现**（PrismaService / 枚举桥接双向 /
   Redis 连接解析 / JobRun 落库 / bigint-id），见 CCR。
3. **本模块未做 §23 独立审查**（见文头），建议集成前补。
4. 本模块依赖 Agent 06 的 `jobs/ai` 公开面（`AI_JOB_OPTIONS` /
   `classifyScoreJobId` / `translateJobId` / `promptFor`）——
   这是**跨模块 import**。若 Agent 14 把 AI 能力提到共享包，这里要一起改。

---

## APIs Used

**外部：无。** 本模块**不调用任何外部服务** —— 出网只发生在采集（Agent 04）
与 AI（Agent 06）。它只读写 MySQL 与 Redis。

**内部**：`@signal/contracts`、`@signal/config`、`@signal/logger`、
`@signal/source-core`（仅类型层面未用；实际未 import）、`jobs/ai`（Agent 06 的公开面）。

---

## Events / Queues

| 项 | 值 |
| -- | -- |
| 消费 | `content-pipeline` 队列的 `content.normalize` / `content.dedup` / `content.event-cluster`；并发 8（契约） |
| 生产（本队列） | 同上三个 Job 名；JobId 见下 |
| 生产（AI 队列） | `ai.translate` / `ai.classify-score`（**复用 Agent 06 的 builder**） |
| JobId | `normalize:{rawItemId}:{v}` / `dedup:{contentId}:{v}` / `cluster:{contentId}:{v}` |
| 重试 | 3 次固定退避（**契约未定义 content-pipeline 的重试**，见《设计取舍》第 1 条） |
| Dead Letter | 终态写 `job_runs`，最终失败 = `DEAD`（`docs/13`） |

**未新增任何 Queue / Job 名。**

---

## Environment Variables

**未新增任何 env。** 只用 `docs/20` 已有的 `REDIS_URL` / `LOG_LEVEL` / `NODE_ENV`。

**依赖变更**：`apps/worker` 新增 `sanitize-html@2.17.0`、`htmlparser2@^10.1.0`
（+ `@types/sanitize-html` dev）。

> ⚠ **`htmlparser2` 必须锁在 v10**：v12 是**纯 ESM**，而 worker 是 CommonJS ——
> 单测会全绿（vitest 做转换），但真跑 `node dist` 会崩。
> 已用 `require('./dist/...')` 的进程级探针验证过 v10 可用。

---

## Tests

见上方《Files Added》的测试清单（共 285 项，其中真库 32 + 真 Redis 13）。

**测试数据刻意对齐真实形态**：全部用**中文正文**，包含
`《书名号》`「引号」、emoji 代理对、整页 HTML（导航/侧栏/页脚）、
RSS 片段、X 纯文本帖、只有图片的帖。
Agent 01 的 FULLTEXT 事故（用 ASCII 探针测中文搜索、一直显示绿）是这里的直接教训。

## Test Results

```text
pnpm lint                                        ✓ 0 errors
pnpm typecheck                                   ✓ tsc -b + web tsc --noEmit
pnpm --filter @signal/worker typecheck           ✓ tsc -b + tsc -p test/tsconfig.json
pnpm test                                        ✓ 55 files / 1388 tests（基线 54 / 1348）
pnpm --filter @signal/worker test:integration    ✓ 6 files / 120 tests（真 MySQL + 真 Redis）
pnpm test:db                                     ✓ 26 tests（Agent 01 的，未受影响）
进程级 dist 探针（require('./dist/...)）          ✓ 提取/清洗/纯文本/类型推导逐项验证
```

## Commands

```bash
pnpm test                                                     # 单测（无需 DB/Redis）
pnpm --filter @signal/worker test:integration                  # 需要真 MySQL + 真 Redis
pnpm test:db                                                   # Agent 01 的库契约

# 本机 Redis 未起时：
#   <redis-server> --port 6390 --save '' --appendonly no
#   REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration
```

---

## Known Limitations

### 设计取舍（§23.8 要求逐条记录）

1. **`docs/13` 没有为 content-pipeline 定义重试策略。**
   Retry 一节只写了 Collector（3 次）/ AI（3、1、0）/ Publishing（3 次）。
   本模块取本地默认（3 次、指数退避 5s），**已提 CCR**。
2. **`JobId.normalize` 是坏的，本模块自己实现了 3 段 builder。**
   契约的它产出 2 段，被 BullMQ 拒绝（真 Redis 实测）。按 §7 不改契约，
   改用 `normalize:{rawItemId}:{version}`，第三段是**归一化规则版本**
   （清洗策略/提取算法变了就该能重跑历史内容）。已提 CCR。
3. **近似判重的阈值 0.35 是实测校准的，但仍是启发式。**
   实测：同一事件不同措辞 ≈0.45、无关 <0.2。文章越长这个阈值越偏严、
   越短越偏松。可接受的理由是**它只产出候选、不做不可逆判断**。
   上真实数据后应重新校准 precision/recall。
4. **不做事件边界切分。** 同一话题的后续进展（「发布」→「发布后撤回」）
   文字相似度高，会被聚成同一个 `Event`，`lastSeenAt` 持续推后。
   V1 只要求「同一事件只形成一个 Event」，边界判定属 V2。
5. **`EditorialReview` 行由本模块创建**（不是 Agent 07）。
   理由：`docs/07` 的流水线终点是「Review Queue」，而
   `pipelineStatus = REVIEW_PENDING` 如果没有对应的审核行，
   管理员在后台看不到它 —— 那是「进队列了但没进队列」。
   若 Agent 07 认为自己该建，属可调整的边界。
6. **收尾扫描用 60 秒轮询，且不加分布式锁。**
   原因：`docs/13` 的 10 个 Job 名里**没有「AI 完成」这一类**，
   而 Agent 06 的作业在 `ai` 队列上、跑完不会回调本模块。
   不加锁是因为**扫描是幂等的**（`finalizeForReview` 内部 upsert，
   且只挑「还没有审核行」的内容）—— 与 Agent 04 的调度器不同，
   那边「双抓取」不是幂等的。
7. **`CollectedItem.type` 在采集端落库时被丢弃**，本模块按 `SourceType`
   + `payload` 重推 `ContentType`。更干净的做法是让 `raw_items` 存下
   采集端算好的类型，或把推导提到共享包 —— 已提 CCR。
8. **近似判重的候选窗口是「最近 7 天、最多 50 条」，要读回候选的正文。**
   这是本模块**最贵的一次查询**。真正的规模化方案是持久化指纹
   （MinHash/LSH 或向量检索），而 `docs/07` 明确「V1 不引入向量数据库」。
9. **`ContentTopic.confidence` 恒为 1**（模型没给逐主题置信度，不编造）。
10. **worker 侧 6 处重复实现**（详见 CCR）。

### 未修复但已上报

- `common/prisma/bigint-id.ts` 缺 BIGINT 上界（属 Agent 02，Agent 03 已提 CCR 第 8 项）。
  本模块在边界上用自己的 `toBigintId`。
- **契约里 3/4 个 `JobId` builder 的产物会被 BullMQ 拒绝**（Agent 06 的 CCR 第 0 项，至今未裁决）。

### 环境约束

- **两套集成测试共用同一个 MySQL 实例**，`fileParallelism: false` 只管进程内。
  两个进程同时跑会互相干扰（Agent 06 实测随机挂 4 项）。CI 上请串行。
- 本模块的 DB 集成测试**每条用例跑完就清库**（`afterEach`）——
  事件聚合是按相似度归属的，用例之间共享数据库会互相干扰。

---

## Contract Change Requests

见 `handoffs/CONTRACT_CHANGE_REQUEST-agent-05.md`。

---

## Integration Notes

### Git

- 仓库：`E:\desk\Signal-Project-Package-v1.2\Signal`，分支 `agent/05-pipeline`（基线 `main`）。
- 提交署名：Jov3c。
- ⚠ 开发全程在**独立 git worktree**（`work/_agent05/Signal`）里进行，
  未占用主工作树。

---

# 自查记录（**不是**独立审查）

> ⚠ 再说一次：本次**没有做 §23 独立审查**（用户要求只用一个 agent）。
> 下面是我在开发过程中**自己**抓到的 12 个问题。列出来是为了让下游知道
> 「哪些坑已经踩过」，**不是**为了声称「已经验过了」。

| # | 问题 | 现象 / 后果 |
| - | ---- | ----------- |
| 1 | `style` 白名单整条失效 | `allowedStyles` 写了 `text-align`，但没把 `style` 加进 `allowedAttributes` → 样式被**静默剥掉** |
| 2 | 链接加固被自己剥掉 | `transformTags` 加的 `rel`/`target` 不在白名单里，加上去又被删 |
| 3 | `htmlparser2` v12 是**纯 ESM** | worker 是 CJS → **单测全绿但真跑 `node dist` 会崩**（降到双格式 v10） |
| 4 | 中文被转义成数字实体 | 提取时 `发` → `&#x53d1;`，**体积涨 8 倍**（改用 `encodeEntities: 'utf8'`） |
| 5 | 纯文本投影没解码实体 | `sanitize-html` 会重新转义 `&` → 标题显示成字面的 `AT&amp;T` |
| 6 | 替身的 `??` 吃掉显式 `null` | `titleRaw ?? '默认'` 让「把标题设为空」传不进去 → **3 条测试假绿** |
| 7 | 替身用**计数器**当 `createdAt` | 真实仓储用真时间戳 → 时间窗过滤把候选全筛掉 |
| 8 | **我自己的验证 grep 写错了** | `grep "error TS.*content-"` 恒不匹配（「content-」在「error TS」**之前**）→ 连续几轮看到「0 错误」，实际有 6 个 |
| 9 | 近似判重的断言写错了桶 | 两条内容同源 → 匹配进 `sameSourceMatches`，而断言的是 `crossSourceMatches` |
| 10 | 事件聚合的幂等自检被提前返回挡住 | 已在事件里的内容重跑会**新建重复事件**（重试是正常路径） |
| 11 | 事件查询没把探测内容自己算进去 | 纯函数的幂等自检**永远拿不到**它所属的事件 → 第 10 条也永远不触发 |
| 12 | 幂等命中仍去挂接 → 撞唯一约束 | 纯函数只返回「加入哪个事件」，没说「它本来就是成员」→ 第二次聚合抛 P2002 |

**三条最值得记的**：

- **第 8 条**：验证工具本身写错，会让「我检查过了」变成一句空话。
  已改成数「所有 `error TS` 行里有多少落在我的文件路径上」，
  不再依赖行的前后顺序。
- **第 10 + 11 条**：两个 bug 叠在一起时，**修好一个才暴露另一个** ——
  修完 11 之后 12 才第一次被执行到。如果只修了 11 就收工，
  会以为已经好了。
- **第 3 条**：只有真跑 `node dist` 才能发现（vitest 会做模块转换）。
  构建后写了 `require('./dist/...')` 的探针逐项验证。
