# Handoff

**Agent:** 08 — Featured / Daily 发布
**Wave:** 2B（上游：Agent 00、01、05、06、07 —— 五者均 `✅ 已完成`）
**日期:** 2026-09-29
**基线:** Development Contract v1.1 / Agent Rule v1.0
**分支:** `agent/08-publishing`

> ⚠ **先读文末的《补遗（§23 独立审查）》**。正文的实现描述在审查**之前**
> 就已成立，但独立审查在其上仍查出 **1 个 P1 + 1 个 P2 + 4 个 P3/P4**，
> **全部已修复并加了有牙齿的回归守卫**。
>
> 其中两条修正了正文里**过于乐观的声称**（第 8 条「自动草稿天然满足
> LEAD_REQUIRED」是**错的**；`scheduledAt` 是一个**被静默兑现错的承诺**），
> 一条暴露了**挂到根模块会启动即崩**的缺陷（正文完全没提到它）。
> 下游请按《补遗》理解，不要按正文的旧结论做假设。

---

## Task

`tasks/agent-08-publishing.md`：

> 实现 Featured、Daily Draft、编辑、排序、Schedule、Publish、Archive。

契约依据是 `docs/10-publishing-daily.md`、`docs/04` 的 Admin Publishing 段、
`docs/05` 的 `DailyEditionStatus` / `DailySectionType` / `DailyDisplayStyle` 状态机，
以及 `docs/13` 的 `publishing.daily-draft` / `publishing.daily-publish` 两个 Job。

**任务书的「必测」八项**逐条覆盖情况：

| 必测项                   | 覆盖位置                                                                         |
| ------------------------ | -------------------------------------------------------------------------------- |
| approved-only Featured   | `featured-service.spec.ts`（两道门各一条用例）                                   |
| draft generation         | `publishing-service.spec.ts` + `publishing-draft-compiler.spec.ts`（27 项）      |
| 未审核 08:00 不发        | `publishing-service.spec.ts` 的 `NOT_SCHEDULED` 分支                             |
| scheduled publish        | `publishing-service.spec.ts` + `daily-service.spec.ts`                           |
| Lead required            | `daily-preflight-parity.spec.ts` + `daily-service.spec.ts`（且断言**不占期号**） |
| REJECTED 阻断            | 同上（`CONTENT_NOT_PUBLISHABLE`）                                                |
| editionNo 发布时分配     | `daily-service.spec.ts`（含「取消不占号」）                                      |
| archive 只返回 PUBLISHED | `daily-service.spec.ts` + `daily-db.integration.spec.ts`                         |

---

## Implemented

### 1. 精选（Featured）—— `apps/api/src/modules/featured/**`

`docs/10`：

> 精选是实时编辑流。Content APPROVED 且勾选 Featured 后创建 FeaturedItem。

- **两道门都要过**：`contents.pipeline_status = APPROVED`
  **且** `editorial_reviews.publish_featured = true`。
  只检查前者不够 —— 「进精选」是一个**独立的编辑意图**。
- 可改：自定义标题 / 摘要 / 权重 / 上下架。
- **禁止改** `originalUrl` / `publishedAt` / `sourceId`
  （`docs/10` 明令）：落实在**接口形状**（`UpdateFeaturedInput` 里没有这些键）
  **加**请求校验（传了 **400**，错误信息说明「docs/10 禁止」）—— **不是静默忽略**。
- 下架是**软下架**（`active = false`，保留历史）。
- 公开面 `GET /featured` 会过滤掉「下架的」**以及「内容后来被撤下的」**——
  后者不是冗余检查：内容被 `REJECTED` 时精选项不会自动消失。

### 2. 日报编辑与发布 —— `apps/api/src/modules/daily/**`

**状态机**（`state.ts`，穷尽 `Record`，契约加状态即编译不过）：

```text
DRAFT → REVIEWING → SCHEDULED → PUBLISHED
  ↓        ↓            ↓
       CANCELLED ──→ DRAFT（撤销误操作）
```

- 编辑是**整体替换**（`PUT :date/sections`），单事务里先删后建 ——
  不会留下「旧版块没了、新的一边建一边失败」的半截状态。
- `DRAFT` 被保存后自动变 `REVIEWING`（「有人动过它了」）。
  这既让 07:30 的提醒有意义，也让草稿编译器**停止覆盖**（见下）。
- **`SCHEDULED` 仍可编辑**（修错别字不该把已排的期踢回去）；`PUBLISHED` 不行。
- 保存时校验**所有引用的内容存在且已 `APPROVED`** ——
  没有这道校验就能把一条没审的内容直接发到前台，绕过 `docs/00` 的
  「任何内容必须人工审核」。**这是本模块自查时发现并补上的一处缺口。**
- 发布：**只有 `SCHEDULED` 能发**（`docs/10` 的「未审核 08:00 不发」）→
  发布前校验 → **校验通过才占期号**（失败绝不占号，否则 `NO.001` 会空掉）。
- 期号 `NO.001` 起，**只在真正发布时分配**；取消的草稿不占号。
- 公开面：`GET /daily/:date` 与 `GET /daily/archive` **只返回 `PUBLISHED`**；
  未发布的期次**对外 404**（不是空日报 —— 后者会让前台渲染出一个
  看起来正常的空白页面，而真相是「今天还没发」）。

### 3. 草稿生成与定时发布 —— `apps/worker/src/jobs/publishing/**`

`docs/10` 的「建议调度」与实现对照：

```text
00:10 初始化当天 DRAFT      → initDraft()            只建空期，不碰内容
05:30 生成初始 draft        → generateDraft()        整份重算
07:00 刷新候选              → generateDraft()        同一函数，重跑而已
07:30 未 REVIEWING 则通知    → remindIfNotReviewing() 进程内完成，不入队
08:00 只有 SCHEDULED 才发布  → publishIfScheduled()
```

**草稿生成的三条安全性质**（每一条都有测试）：

1. **只写 `DRAFT`**。管理员一旦保存过（→ `REVIEWING`）或排过期（→ `SCHEDULED`），
   生成器**再也不会碰它**。这是「05:30 的自动草稿不覆盖管理员 06:00 的编辑」的**唯一**保证。
2. **整份重算**而不是增量。因为只有 `DRAFT` 才会走到这里，而 `DRAFT` 意味着
   「没有任何人动过」，重算等价且更简单 —— 它顺带处理了「某条候选后来被撤下」。
3. **没有候选时不替换**。否则一次上游故障（候选查询返回空）
   会把一份已经生成好的草稿清空。

**草稿编译器**（`draft-compiler.ts`，纯函数，27 项测试）实现 `docs/10` 的
七个默认版块与多样性规则：

- 同 Event 默认 1 条 Primary（非主稿**丢弃**并记原因）；
- `X_VOICES` 最多 10 条，保留**分数最高**的；
- **Lead 只有 1 条**：由 `displayStyleFor` **结构性保证**
  （只有 `FRONT_PAGE[0]` 可能是 `LEAD`），且 `applySourceDiversity`
  **永不降级 LEAD**（降了会让草稿过不了发布前校验）；
- 单一来源不超过主要条目 25%（超出者**降级为 `STANDARD`**，不是丢弃）；
- 确定性：分数 → 发布时间 → `contentId`（**数值**降序）三级决胜，
  打乱输入顺序得到同样的输出 —— 这是「重跑幂等」的前提。

**依赖注入接线**（`publishing-di-wiring.spec.ts`）：模块的 provider 图**真的能被
构造出来**（`Test.createTestingModule().compile()` 不触发 `onModuleInit`，
所以不需要 Redis）。这条是本模块自查时补的 —— `module.ts` 的装配此前
**零覆盖**，而它已经真实地栽过一次（`@Module({...})` 装饰器在类定义时求值，
我把一个 provider 常量写在了类之后 → TDZ → **启动即 `ReferenceError`**，
lint 与 typecheck 都发现不了）。静态扫描那半还钉住「构造参数必须有显式
`@Inject`」，防 Agent 02 实测过的 `emitDecoratorMetadata` 退化。

**调度器**（`scheduler.ts`）：每 60 秒醒一次，按时间顺序处理当天已到点的槽位。

- **停机追赶**：worker 06:00 才起来，00:10 与 05:30 两趟会被补跑。
  这是安全的 —— 所有能补跑的动作都以**人的决定**为前提
  （发布只发 `SCHEDULED`，而 `SCHEDULED` 只能由管理员排期）。
- **不回溯历史**：只处理当天，中间那几天不会补发（日报是当日产品）。
- 幂等三层：进程内 `handled` 集合 + **JobId**（真正的兜底，`removeOnComplete`
  保留 24 小时覆盖整个业务日）+ 通知的 `(type, targetUrl)` 查重。
- **故障隔离**：一个槽位失败不影响后面的 —— 否则「07:30 的提醒因为某个 bug 抛了」
  会让 08:00 的发布也一起不发生，而提醒是可有可无的、发布不是。

---

## Files Added

**API（21 个源码文件）**

```text
apps/api/src/modules/daily/
  module.ts  controller.ts  index.ts
  service.ts            编排：编辑 / 排期 / 取消 / 发布 / 读取
  repository.ts         端口（编辑与读取）
  prisma-daily.repository.ts
  preflight.ts          ★ 发布前校验（与 worker 侧逐字相同的两份之一）
  state.ts              ★ 状态机（穷尽 Record）
  public-view.ts        ★ 对外投影（新增字段默认不外泄）
  audit.ts              ★ 结构化审计（日报 + 精选共用）
  clock.ts  limits.ts  dto.ts

apps/api/src/modules/featured/
  module.ts  controller.ts  index.ts
  service.ts  repository.ts  prisma-featured.repository.ts
  dto.ts  limits.ts
```

**Worker（17 个源码文件）**

```text
apps/worker/src/jobs/publishing/
  module.ts  index.ts
  publishing.service.ts      草稿生成 / 定时发布 / 提醒
  publishing.repository.ts   端口
  prisma-publishing.repository.ts
  publishing.worker.ts       publishing 队列消费者
  scheduler.ts               ★ 五个槽位的调度器
  queue.ts                   ★ 3 段 JobId + 启动期自检
  queue-names.ts  enqueuer.ts  connection（复用 Agent 06 的解析）
  draft-compiler.ts          ★ 草稿编译器（纯函数）
  preflight.ts               ★ 与 api 侧逐字相同
  notifier.ts  prisma-notifier.ts
  job-run.repository（实现本地的，端口复用 Agent 06 的）
  prisma.service.ts  clock.ts
```

**测试（18 个文件 / 279 项）**

```text
apps/api/test/
  daily-preflight-parity.spec.ts          10  ★ 跨 app 一致性守卫 + preflight 行为
  daily-service.spec.ts                   30  状态机 / 排期 / 发布 / 编辑 / 归档
  daily-dto.spec.ts                       21  请求解析与截断
  daily-routes.spec.ts                     6  路由表 + 守卫 + **路由声明顺序**
  daily-db.integration.spec.ts            23  **真 MySQL**（业务日往返 / 级联 / 唯一约束 / 期号分配）
  daily-public-view.spec.ts               12  ★ 对外投影（防泄漏：断言内部字段**不存在**）
  publishing-di-wiring.spec.ts             7  ★ 模块依赖图（加完立刻抓到 ADMIN_ORIGIN_CONFIG 漏绑）
  featured-service.spec.ts                17  approved-only / 禁止改的字段
  featured-routes.spec.ts                  4  路由表 + 守卫
  support/publishing-fakes.ts                 内存替身

apps/worker/test/
  publishing-draft-compiler.spec.ts       27  ★ 归类 / Lead / Event / X 上限 / 多样性 / 确定性
  publishing-di-wiring.spec.ts             7  ★ 依赖注入接线（构造参数静态扫描 + 真解析模块图）
  publishing-db.integration.spec.ts       16  **真 MySQL**（★ P1 修复：候选口径 / 快照内容状态 / 发布）
  comment-safety.spec.ts                   4  ★ 注释提前闭合（本模块踩过三次的坑）
  publishing-service.spec.ts              26  三条安全性质 / 窗口 / 发布四路径 / 提醒
  publishing-queue.spec.ts                20  JobId 段数 / 槽位表 / 启动自检 / 载荷
  publishing-scheduler.spec.ts            17  槽位触发 / 顺序 / 幂等 / 追赶 / 隔离
  publishing-worker.spec.ts               16  分派 / 业务结论 vs 任务失败 / Dead Letter
  publishing-queue.integration.spec.ts     7  **真 Redis**（builder 产物真的入队 + 真的被消费）
  support/publishing-fakes.ts                 内存替身 + 通知记录器
```

**其它**

```text
handoffs/agent-08-HANDOFF.md（本文件）
handoffs/CONTRACT_CHANGE_REQUEST-agent-08.md（11 项）
work/_agent08/REVIEW.md（§23 审查报告，不在 git 内）
```

## Files Modified

```text
packages/contracts/src/errors.ts        仅**追加** 7 个业务码（52 insertions / 0 deletions）
apps/api/test/auth-contract.spec.ts     登记 modules/featured/controller.ts 与
                                        modules/daily/controller.ts 为 admin 路由所有者
                                        （Agent 02 设计的白名单，新 admin 模块必须登记）
```

**未触碰**：`prisma/**`、`apps/api/src/app.module.ts`、`apps/worker/src/worker.module.ts`、
`apps/api/src/modules/{auth,sources,users,admin-review}/**`、
`apps/worker/src/jobs/{collectors,ai,content}/**`、
`packages/contracts` 的枚举 / Queue / Job / DTO。

---

## Database Migrations

**None**

未创建任何 Migration，未改动 `prisma/schema.prisma`。
用到的四张表（`featured_items` / `daily_editions` / `daily_sections` / `daily_items`）
在 Agent 01 的初始 schema 里都已存在，**没有新字段需求**。

⚠ 但有三处「**需要新字段/新表才能按字面实现**」的契约要求，已提 CCR：
revision 表（发布后修改）、`organization` 字段（25% 多样性规则）、
`admin_notifications` 的唯一约束（通知幂等）。

---

## Public Interfaces

### 给 Agent 12（Admin UI）—— 最重要

- **Admin 路由形状由本模块定义**（`docs/04` 只写了「沿用 v1.0」，而 v1.0
  **不在本开发包里**）。完整表见 CCR 第 1 项，逐字与实现一致，
  并由 `daily-routes.spec.ts` / `featured-routes.spec.ts` 守卫（多一条即红）。
- **日报的字段上限**从 `modules/daily/limits.ts` 取（`MAX_SECTIONS` 等），
  别自己写一套：`dto.ts` 里**结构性错误报 400、展示字段截断**，
  前端做即时校验时应当用同一组常量。
- **状态机从 `modules/daily/state.ts` 取**（`DAILY_TRANSITIONS` / `canTransition` /
  `isEditable`），别在前端重写一遍按钮可用性判断。
- 分页封套：后台列表 `{data, meta:{from,to,total}}`；公开精选是
  cursor 分页 `{data, meta:{nextCursor}}`（与 `docs/02` 一致）。
- ⚠ **`GET /admin/daily/:date` 会惰性补建当天期次**（幂等，只建空行）。
  这是刻意的：否则管理员在 00:10 之前打开编辑台只有 404，
  而那是他无法自助解决的死路。**已记入 HANDOFF 的设计取舍。**
- ⚠ **`POST /admin/daily/:date/schedule` 不接受任何参数**（§23 审查后的修正）。
  传 `scheduledAt` 或任何未知字段 → **400**，错误信息里说明了原因与替代做法。
  排期固定使用该业务日的**上海 08:00**；要立刻发出请用 `PATCH`… 不对 —— 用
  `POST /admin/daily/:date/publish`。响应里的 `scheduledAt` 是服务端算的，**只读**。
- ⚠ **`POST /admin/daily/:date/publish` 成功返回 `{edition, editionNoLabel}`；
  失败一律抛错**（没有 `published: false` 这种形状）。要处理的三种 409：
  - `DAILY_INVALID_TRANSITION`（还不是 `SCHEDULED` —— 这是最常见的，
    请直接告诉管理员「先排期」而不是「发布失败」）；
  - `DAILY_ALREADY_PUBLISHED`（已经发过了；`details.hint` 里有下一步建议）；
  - `DAILY_PREFLIGHT_FAILED`（`details.issues` 是逐条的
    `{reason, message, target}` —— **请逐条显示**，
    只显示「发布前校验未通过」等于没说）。
- 发布前校验的问题码（`PreflightReason`）从
  `modules/daily/preflight.ts` 取，别在前端硬编码字符串。

### 给 Agent 10（Search / Public API）

- `GET /featured` 与 `GET /daily/:date` / `GET /daily/archive` **已经实现**在
  本模块里（`modules/featured` 与 `modules/daily`）。若你要在自己模块里
  统一挂公开路由，请 `imports: [FeaturedModule, DailyModule]` 复用
  `FeaturedService` / `DailyService`，**不要重写一遍**。
- 前台投影用 `toPublicEdition()` / `toArchiveEntry()`
  （`modules/daily/public-view.ts`）—— 它**刻意隐藏**了 `editionId` /
  `status` / `scheduledAt` / `pipelineStatus` 这些后台字段。
  `docs/14` 要求「不把后台完整 debug 信息直接搬给用户」。
- `contents.body_original` 是**已清洗的 HTML**（Agent 05 的 `docs/14` 清洗点），
  日报条目里的 `excerpt` 可能来自 `customExcerpt`（编辑手写，**未清洗**）——
  渲染时请照常按纯文本处理。

### 给 Agent 13（Public Web）

- `GET /daily/:date` 的返回里，每条条目带 `contentId`（供跳
  `GET /contents/:id`）、`headline`（编辑自定义标题，没有则回落到内容标题）、
  `excerpt`、`originalUrl`、`source{tier,official}` —— 够画 `docs/22` 的
  「来源：Anthropic · 官方一手」那一行。
- 未发布的期次是 **404**：请把「今天还没发」和「这一天没有日报」
  渲染成同一件事，而不是一个空白日报页。

### 给 Agent 11（Ops）—— 必读

1. ⚠ **Redis 是硬依赖**：`imports: [PublishingModule]` 会真的连 Redis、
   起一个 BullMQ 消费者（`publishing` 队列，并发 1），
   **并开始一个每分钟醒一次的调度器**。
2. ⚠ 调度器**只在 worker 里**，且**没有分布式锁** —— 真正防重复的是 JobId
   （两个实例同时 tick 只会入队同一个 jobId，BullMQ 只留一个）。
3. 状态机终态：`DRAFT → REVIEWING → SCHEDULED → PUBLISHED`；`CANCELLED` 是终态
   但**可以恢复成 `DRAFT`**（取消不占号，所以是无损的）。
4. ⚠ **`job_runs` 的 `DEAD` 只在真失败时出现**：
   「到点了但没排期 → 不发」是**业务结论**，job 记 `SUCCEEDED`。
   若你的面板把「publish job 没有产出」当成故障，会每天早上误报一次。
5. 通知写在 `admin_notifications`（`type` 为 `DAILY_REVIEW_PENDING` /
   `DAILY_NOT_PUBLISHED` / `DAILY_PREFLIGHT_BLOCKED`），**不发邮件**
   （与 Agent 07 一致：`notification.admin-email` 没有消费者）。
6. ⚠ **api 进程里也有一份日报代码**（手动发布走的是 api 的同步路径）。
   两条路径**共用同一套 preflight 规则**，靠
   `apps/api/test/daily-preflight-parity.spec.ts` 的静态比对钉住 ——
   若你改动其中一份，那个测试会立刻红。

### 给 Agent 14（最终集成）—— 必做

1. ⚠ **必须在根模块挂载**，否则日报与精选在真实进程里全 404：

   ```ts
   // apps/api/src/app.module.ts
   @Module({ imports: [CommonModule, AuthModule, AdminReviewModule, FeaturedModule, DailyModule] })

   // apps/worker/src/worker.module.ts
   @Module({ imports: [/* 04 */, /* 05 */, /* 06 */, PublishingModule] })
   ```

2. **不要再注册全局异常过滤器**（`CommonModule` 已提供）。
3. ⚠ 引用 `PublishingModule` 会**起消费者 + 每分钟的调度器** ——
   与 Agent 04/05/06 同性质，需要那个**统一的**测试期开关
   （这是本仓库第四个 Agent 提同一件事）。
4. ⚠ `PublishingScheduler` 与 `PublishingQueueWorker` 都是本模块的 provider，
   **不要**在别处重复注册（会跑两遍调度）。
5. 共享包的收口建议见 CCR 第 3 / 4 / 5 项（preflight、worker Prisma、
   通知写入）—— 本模块都留了「不做顺手重构」的边界。

---

## APIs Used

**外部：无。** 本模块**不调用任何外部服务** —— 出网只发生在采集（Agent 04）
与 AI（Agent 06）。它只读写 MySQL 与 Redis。

**内部**：`@signal/contracts`、`@signal/config`、`@signal/logger`、
以及**跨模块走公开面**复用 Agent 06 的两样东西：

- `parseRedisConnection`（`jobs/ai/index.ts` 导出）—— 避免第 4 份 Redis 解析；
- `JobRunRecorder` 端口（同）—— 只实现本地化（它要本模块的 Prisma 包装）。

---

## Events / Queues

| 项             | 值                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| 消费           | `publishing` 队列的 `publishing.daily-draft` / `publishing.daily-publish`；并发 1（契约）                    |
| 生产（本队列） | 同上两个 Job 名                                                                                              |
| JobId          | `daily-draft:{businessDate}:{slot}` / `daily-publish:{businessDate}:{slot}`（**自造 3 段**，见 CCR 第 0 项） |
| 槽位           | `0010` / `0530` / `0700` / `0730`（不入队）/ `0800`                                                          |
| 重试           | 契约值 `PUBLISHING_RETRY`（3 次指数退避 10s）                                                                |
| Dead Letter    | 终态写 `job_runs`，最终失败 = `DEAD`（`docs/13`）                                                            |
| 调度           | 模块内 60 秒定时器（**不用** BullMQ repeatable —— `docs/13` 没有这个 Job 名）                                |

**未新增任何 Queue / Job 名。**（§6 禁止创建近义名，因此 07:30 的提醒不入队。）

---

## Environment Variables

**未新增任何 env。** 只用 `docs/20` 已有的 `REDIS_URL` / `LOG_LEVEL` / `NODE_ENV`。

**依赖变更：无**（`bullmq` / `@prisma/client` / `ioredis` 都已在 `apps/worker` 的
依赖里；`apps/api` 侧只在既有依赖上工作）。

---

## Test Results

```text
pnpm lint                                        ✓ 0 errors
pnpm typecheck                                   ✓ tsc -b + web tsc --noEmit
pnpm format:check（本模块全部文件）               ✓ All matched files use Prettier code style
pnpm test                                        ✓ 72 files / 1676 tests（基线 57 / 1443）
REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration
                                                 ✓ 6 files / 77 tests（真 MySQL + 真 Redis）
REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration
                                                 ✓ 8 files / 143 tests（真 MySQL + 真 Redis）
```

**新增测试 279 项**（单测 233 + 集成 46）。

## Commands

```bash
pnpm test                                                     # 单测（无需 DB/Redis）
pnpm --filter @signal/api test:integration                     # 需要真 MySQL + 真 Redis
pnpm --filter @signal/worker test:integration                  # 同上
pnpm test:db                                                   # Agent 01 的库契约（需先 pnpm build）

# 本机 Redis 未起时：
#   "E:\redis\Redis-8.8.0-Windows-x64-cygwin-with-Service\redis-server" \
#       --port 6390 --save '' --appendonly no
#   REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration
```

⚠ **集成测试不要并行跑**（Agent 05/06 的老问题）：api 与 worker 两套共用同一个
MySQL 实例，两个进程同时跑会互相干扰。

---

## Known Limitations

### 设计取舍（§23.8 要求逐条记录）

1. **草稿生成是「规则版」，没有接 AI。** `docs/10` 说「AI 只能给 Lead、section、
   排序建议」，而 `AiTaskType.DAILY_DRAFT` 在 Agent 06 的 Prompt Registry 里
   **显式登记为 `null`**（`promptFor` 抛 `UNSUPPORTED`）。
   本模块因此按分数/类型/关键词/来源属性做**确定性**规则排序。
   三个理由：没有 AI 也能出草稿（AI 不可用是常态）；规则版是确定的
   （重跑幂等是 `docs/07` 的硬要求）；AI 建议将来覆盖的是**同一份 DRAFT**，
   状态机不用改。**已与用户确认这是 V1 的取舍。**

2. **「单一公司不超过主要条目 25%」用 `Source` 近似「公司」。**
   schema 里**没有「公司」这个实体**。已提 CCR 第 7 项。
   「主要条目」按 `DailyDisplayStyle` 读作 `LEAD` + `MAJOR`。

3. **候选窗口是「该业务日 08:00 之前的 24 小时」。**
   `docs/10` 只写了「在业务窗口内」，**没有定义窗口** —— 这是本模块的取值决定。
   三个理由与备选方案见 CCR 第 6 项（**需要产品裁决**）。

4. **发布后修改（`docs/10` 的 typo / broken link / fact correction + revision）
   V1 不支持**，因为没有 revision 表。理由：没有 revision 的「发布后修改」
   就是**静默改历史**，比不支持更糟。已提 CCR 第 8 项。

5. **`07:30` 的提醒跑在调度器进程内，不入队。**
   `docs/13` 的 10 个 Job 名里没有「日报提醒」，§6 又禁止创建近义 Job。
   与 Agent 07 的通知扫描同一取舍。已记入 CCR 第 9 项。

6. **调度器不加分布式锁。** 真正防重复的是 JobId（`removeOnComplete` 保留 24h，
   覆盖整个业务日）；两个实例同时 tick 只会入队同一个 jobId。
   另外两层（内存 `handled` 集合、通知查重）只是省掉无谓的查询。

7. **`GET /admin/daily/:date` 是「读操作带写入」**（惰性补建当天期次）。
   可接受的理由与 Agent 07 的 Dashboard 相同：补建幂等、失败不影响响应。
   **未来日期不补建**（否则列表里会堆出一批空期次）。

8. **`FRONT_PAGE` 只放 1 条（头条）。** `docs/10` 说「Lead 只有 1 条」，
   而 `FRONT_PAGE` 就是头条区。其他的高分内容进各自主题版块。

   > ⚠ **本条原先接着写「自动草稿天然满足 `LEAD_REQUIRED`，只要候选池非空」——
   > 那句话是错的**，已由 §23 审查证伪。正确条件是「**至少一条非 X 候选**」：
   > X 帖子一律进 `X_VOICES`，而 `X_VOICES` 的第 0 条是 `MAJOR` 不是 `LEAD`，
   > 所以全 X 候选的日子 `FRONT_PAGE` 为空 → 结构性地没有 LEAD。
   > **已修**：非 X 池为空时，把分数最高的那条 X 提到 `FRONT_PAGE` 当头条
   > （并把它从 `X_VOICES` 移出，保持「一条内容只出现一次」）。
   > 3 条回归用例在 `publishing-draft-compiler.spec.ts`。

9. **`preflightEdition` 在两个 app 里各一份**（跨 app 不能 import）。
   由 `daily-preflight-parity.spec.ts` **静态比对全文**钉住，
   已做变异验证（改坏一行确实变红，并报出第几行不同）。已提 CCR 第 3 项。

10. **worker 侧 `PrismaClient` 包装现在是第 8 份。** 未提取共享包的理由：
    那属于「顺手重构」（§9），而正确做法是一份 `@Global()` 的 worker `PrismaModule`
    —— 对整个 app 的装配决策，归 Agent 14。已提 CCR 第 4 项。

11. **通知写在 `admin_notifications`，该表没有唯一约束**（Agent 07 的说明）。
    幂等靠应用层「先查后写」，**并发下可能写两条重复通知**。
    刻意接受：重复一次只是噪音，漏掉一次意味着日报没人管。
    已提 CCR 第 5 项建议加 `@@unique([type, targetUrl])`。

12. **08:00 未发布时会发一条 `DAILY_NOT_PUBLISHED` 通知**（「到点没发」）。
    这一条**不在 `docs/10` 的字面要求里** —— 它是本模块补的：
    没有它，「今天这一期没上线」对管理员是**静默**的。
    若产品上不要，删掉 `PublishingNotificationType.DAILY_NOT_PUBLISHED` 即可。

13. **审计只写日志、会被轮转掉**，不可长期取证（与 Agent 07 同一个诉求，
    已由它的 CCR 请求 `admin_audit_logs` 表，本模块沿用不重复提）。

14. **⚠ 管理员重复发布 → 409 `DAILY_ALREADY_PUBLISHED`，而不是幂等的 200。**
    这一条与 worker 侧**刻意不一致**，两条路径的诉求不同：

    ```text
    worker 的 publishIfScheduled   必须幂等（会被重试、会与手动发布撞车）
                                   → 「目标状态已达成」= 成功
    api 的 POST …/publish          是**人点的**
                                   → 静默 200 会让他以为「这次点击完成了发布」
    ```

    而 V1 **不支持发布后修改**（见第 4 条），所以「它早就发出去了、
    你这次点击什么也没做」才是管理员需要听到的话。错误里带上
    `editionNo` / `publishedAt` / `hint: see the archive instead`，
    免得他反复点。
    「读状态之后被别人抢先」的竞态走同一条路（`details.raced = true`）。

    > 这一条是本模块自查时补的：`DAILY_ALREADY_PUBLISHED` 起初
    > **注册了却从未被抛出**（重复发布当时返回幂等的 200）。
    > 一个注册了但没人用的错误码是一份**会误导人的契约表面** ——
    > 读注册表的人会以为它能出现。现在它真的会出现。

15. **⚠ 已取消的期次在 08:00 **不发**「未按时发布」提醒。**
    这条通知的用途是「你今天漏了一件事」，而取消是管理员的**主动决定**。
    对已取消的期次再提醒一次是纯噪音，而且会**稀释这条通知的信噪比** ——
    真正漏掉的那天就不显眼了。

    `PublishOutcome.reason` 因此把 `CANCELLED` 与 `NOT_SCHEDULED` 分开，
    运维面板据此区分「今天本该有报纸但没出」与「今天本来就没有报纸」。

    > 自查时补的：第一版把判断写成「不是 `SCHEDULED` 就提醒」，
    > 于是 CANCELLED 也会被提醒。已加两条对照用例
    > （CANCELLED 不提醒 / DRAFT 提醒）钉住。

16. **⚠ 排期（`POST …/schedule`）不接受自定义时刻，传了就 400。**
    排期固定使用该业务日的**上海 08:00**（`docs/10` 的目标发布时刻，
    契约常量 `DAILY_TARGET_PUBLISH_HOUR`）；要立刻发出请走
    `POST …/publish`。

    **这是 §23 审查的 P2 修复。** 第一版接受一个 `scheduledAt`、
    把它存进库、**却没有任何代码读它** —— 于是「管理员传 20:00 以为晚上发，
    worker 在 08:00 那一班就发出去了」。而 DTO 的注释自己写着
    「静默忽略会让管理员以为自己排到了别的时间」，一条单元测试还写着
    「显式传入的时刻会被采用」—— **把错的印象固化了下来**。

    现在传 `scheduledAt`（或任何未知字段）一律 **400**，
    错误信息里说明「排期用哪个时刻、要立刻发该走哪条路」。
    `scheduledAt` 仍落库，用途是**记录与展示**（运维回答「这一期本来打算几点发」）。

    它与 worker 真正发布的时刻之所以一致，是因为**两边都从同一个契约常量派生**
    —— `publishing-queue.spec.ts` 有一条守卫钉住
    `SLOT_TIME[PUBLISH].hour === DAILY_TARGET_PUBLISH_HOUR`。
    没有那条守卫，改常量会让两者静默脱节，而两个模块的测试都还是绿的。

### 未修复但已上报

- `common/prisma/bigint-id.ts` 缺 BIGINT 上界（属 Agent 02，
  Agent 03 的 CCR 第 8 项，仍未裁决）。本模块在 api 侧沿用 Agent 07 的
  `toReviewId`；worker 侧不需要（它的 id 全部来自库，不是外部输入）。
- 契约的 3/4 个 `JobId` builder 会被 BullMQ 拒绝（Agent 06 的 CCR 第 0 项，
  本模块**重申并补了真 Redis 的证据**）。

### 环境约束

- **两套集成测试共用同一个 MySQL 实例**：请串行跑（与 Agent 05/06 同）。
- 真 Redis 的队列集成测试会 `obliterate` 掉 `publishing` 队列，
  **只能对专用测试 Redis 运行**。
- 本机 Redis 默认端口未起，需要用 `REDIS_URL` 指向临时实例（见 Commands）。

---

## Contract Change Requests

见 `handoffs/CONTRACT_CHANGE_REQUEST-agent-08.md`（**11 项**）。

**最需要裁决的三项**：

0. ⚠ `JobId.dailyDraft` 2 段会被 BullMQ 拒绝（**第三次重申**，本模块补了真 Redis 证据）
1. ⚠ Admin Publishing 路由表（`docs/04` 只写「沿用 v1.0」而 v1.0 不在包里）—— **Agent 10/12 依赖**
2. ⚠ 「业务窗口」的取值（契约未定义，本模块取了「该业务日 08:00 前的 24 小时」）—— **需产品裁决**

**没有一项阻塞交付。**

---

## Integration Notes

### Git

- 仓库：`E:\desk\Signal-Project-Package-v1.2\Signal`，分支 `agent/08-publishing`（基线 `main`）。
- 提交署名：Jov3c（**不含** Claude）。
- 开发在 worktree `work/_agent08/Signal` 里进行。
- ⚠ 本分支继承了一份**上一轮未提交的半成品**（`modules/featured/**` 的 10 个文件、
  无测试），我在其基础上补全而非重写。它已随本次一并提交。

### 与上游的接口（易错点）

- `EditorialReview.publishFeatured` / `includeDailyCandidate` 由 **Agent 07** 写；
  本模块**只读**它们，只写 `FeaturedItem` / `DailyItem` / `DailyEdition` 的状态与内容。
- 日报候选口径跨两个 Agent：**Agent 05** 保证 `contents.pipelineStatus = APPROVED`
  与 `EditorialReview(PENDING)` 的创建；**本模块**保证只挑
  `includeDailyCandidate = true` 且 `review.status = APPROVED` 的。
- ⚠ 内容可能在**加入日报之后**被撤下（`REJECTED`）。因此发布前会**再校验一次**，
  而不是信任保存时的校验结果 —— 两处校验都不是冗余的。

---

# 补遗（2026-09-29）：§23 独立审查后的缺陷修复

## 为什么有这段

按 §23.3，审查由一个**没有本次开发上下文**的独立执行者完成
（报告：`work/_agent08/REVIEW.md`，不在 git 内）。
**结论：不通过 —— 1 个 P0 都没有，但有 1 个 P1 + 1 个 P2。**

> ⚠ 审查开始后我**又改了实现**（发布语义、CANCELLED 提醒），
> 审查者冻结了文件指纹 `9c64e265…` 重跑全套，结论只对那一版负责。
> 那两处修订它按**修订后**版本复核，**两条都成立**；
> 它原本列为候选发现的「CANCELLED 也发提醒」已由我先行修掉，**已撤回**。
>
> **这段的价值不在于「抓到了几个 bug」，而在于抓到的那个 P1 是
> 「测试全绿但因为替身把状态写死而永远测不到」—— 与 Agent 06 的 P0 同形。**

## 先修正三处**过于乐观的声称**（§23.6 第 4 条要求）

| #   | 正文原先的说法                                                            | 事实                                                                                                                                         | 处置                                                                   |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | 设计取舍第 8 条：「自动草稿**天然满足** `LEAD_REQUIRED`，只要候选池非空」 | **错。** 正确条件是「至少一条**非 X** 候选」。全 X 候选的日子 → `sections` 只有 `X_VOICES` → `preflight` 报 `LEAD_REQUIRED` → 天天要人工干预 | 修实现（X 兜底顶上头条）+ 修这句 + 3 条回归用例                        |
| 2   | 「允许：…调整权重…」隐含「排期可以指定时刻」                              | `POST …/schedule` 接受 `scheduledAt`、**存进库、却没有任何代码读它**。管理员传 20:00 以为晚上发，worker 在 08:00 那一班就发出去了            | 改为**拒绝**该参数（400 + 说明），并加两边一致性的守卫                 |
| 3   | 「`POST …/publish` 幂等返回 `alreadyPublished`」（第一版）                | 那对一个**人点的**按钮是错的：静默 200 会让他以为这次点击完成了发布                                                                          | 改为 409 `DAILY_ALREADY_PUBLISHED`（已在审查前自行修正，审查确认成立） |

## 修复清单

| #   | 严重度 | 问题                                                                                                                                                                                            | 位置                                                                             |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | **P1** | worker 持久化层**零执行**，而替身把 `contentStatus` **写死成 `APPROVED`** → 任务书「REJECTED 阻断」在 08:00 自动发布路径上**永远测不出来**；漏一个 select 会静默发被撤回的内容而 1600+ 测试全绿 | 新增 `publishing-db.integration.spec.ts`（16 项，真 MySQL）                      |
| 2   | **P2** | `scheduledAt` 被接受、被存库、被测试说「会采用」，**却没有任何代码读它**                                                                                                                        | 见上表第 2 条 + 两边一致性守卫                                                   |
| 3   | **P3** | 全 X 候选的日子自动草稿结构性没有 LEAD                                                                                                                                                          | `draft-compiler.ts` 加 X 兜底 + 3 条用例                                         |
| 4   | **P3** | `public-view.ts`（135 行前台防泄漏层）**从未执行**                                                                                                                                              | 新增 `daily-public-view.spec.ts`（12 项，断言内部字段**不存在**）                |
| 5   | **P3** | api 侧 `DailyModule`/`FeaturedModule` **没有 DI 接线测试**                                                                                                                                      | 新增 `publishing-di-wiring.spec.ts`（7 项）—— **加完立刻抓到一个启动即崩的缺陷** |
| 6   | **P4** | `assertStateMachineCoversContract()` **零调用点，是死代码** —— 而本模块在 `queue.ts` 文件头**逐字**写着「必须真的被调用，否则就是死代码」                                                       | 接到 `DailyModule.onModuleInit`                                                  |
| 7   | **P4** | `assertPublishingQueueContract` 的测试**只有 `not.toThrow()`**（掏空函数体仍是绿的）                                                                                                            | 抽出 `publishingQueueProblems()`，喂坏输入断言**真的报错**                       |

## ⚠ 第 5 项抓到的缺陷比「缺个测试」严重得多（**下游必读**）

给两个模块补 DI 接线测试之后，第一次运行就报了：

```text
Nest can't resolve dependencies of the AdminOriginGuard (?).
Please make sure that the argument "ADMIN_ORIGIN_CONFIG" at index [0] is available
in the FeaturedModule module.
```

**`DailyModule` / `FeaturedModule` 提供了 `AdminOriginGuard`，却没有提供
它构造参数依赖的 `ADMIN_ORIGIN_CONFIG`。**

后果：这两个模块**能编译、能通过全部单测**，但 Agent 14 一旦把它们挂进
`app.module.ts`，API 进程**启动即崩**。而这是**只在真实集成时才会暴露**的
一类缺陷 —— 单测永远不会构造完整的模块图。

**已修**：两个模块各自补上
`{ provide: ADMIN_ORIGIN_CONFIG, useFactory: () => createAdminOriginConfig() }`。

> 这条值得 Agent 12 / 13 / 14 各自看一眼：**任何提供 `AdminOriginGuard` 的
> 新模块都必须同时提供 `ADMIN_ORIGIN_CONFIG`**。建议 Agent 14 把
> `AdminOriginGuard` 的依赖收进一个共享模块（与 Agent 07 CCR 第 7 项同一诉求），
> 让「漏绑」在编译期就不可能发生。

## ⚠ 下游必须注意的破坏性变更（汇总）

1. **`POST /admin/daily/:date/schedule` 不再接受任何参数。**
   传 `scheduledAt` 或任何未知字段 → **400**，错误信息里说明
   「排期固定用该业务日的上海 08:00；要立刻发出请用 `POST …/publish`」。
   **Agent 12 若已经写了带时刻的排期表单，请改掉。**
   `scheduledAt` 仍然出现在响应里（服务端算的），用途是**记录与展示**。
2. **`POST /admin/daily/:date/publish` 的 409 语义**（见设计取舍第 14 条）：
   已发布 → `DAILY_ALREADY_PUBLISHED`；未排期 → `DAILY_INVALID_TRANSITION`；
   预检不过 → `DAILY_PREFLIGHT_FAILED`（`details.issues` 请逐条显示）。
3. **`PublishResult` 形状变了**：`{edition, editionNoLabel}`，
   **没有 `published` / `alreadyPublished` / `issues`**（失败一律抛错）。
4. **全 X 候选的日子，自动草稿现在会把分数最高的那条 X 提到 `FRONT_PAGE` 当头条**
   （此前它只进 `X_VOICES`）。若 Agent 12 的编辑器假设「`FRONT_PAGE` 只有文章」，
   请放宽。

## 新增/变化的测试

```text
修复前  pnpm test → 69 files / 1644 tests ；api IT 77 ；worker IT 127
修复后  pnpm test → 72 files / 1676 tests ；api IT 77 ；worker IT 143
```

新增 4 个测试文件：`publishing-db.integration.spec.ts`（16）、
`daily-public-view.spec.ts`（12）、`publishing-di-wiring.spec.ts`（7）、
`comment-safety.spec.ts`（4）。

## 反证记录（确认新守卫**有牙齿**）

按 §23.5 的手法对**关键新守卫**做了变异反证（改坏 → 确认变红 → 恢复）：

| 守卫                                   | 变异                                                        | 结果                                            |
| -------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| `daily-preflight-parity`               | worker 侧 `MAX_LEAD_ITEMS` 1 → 3                            | ✅ 变红，并报出**第 112 行不同**                |
| `publishing-db.integration`（P1 修复） | 真仓储 `snapshot()` 改成永远返回 `APPROVED`（即替身的行为） | ✅ 变红：`expected 'APPROVED' to be 'REJECTED'` |
| `comment-safety`                       | 它自己 —— 我在注释里写了两处字面序列                        | ✅ 两次都变红（**这是真的抓到，不是构造的**）   |

## 审查未验的部分（审查者自己列的）

- 真 Redis 上的**多实例并发**（两个 scheduler 同时 tick）未实测 ——
  只有「JobId 幂等」这一层被真 Redis 验过；
- 真实 X / RSS 数据形态下的**多样性规则表现**（`MAJOR_SOURCE_SHARE` 是个启发式）；
- `docs/10` 的「业务窗口」取值仍是本模块的决定（CCR 第 6 项，**需产品裁决**）。

## 审查发现但**不属于本模块**的问题（§24.6：不自己改别人的行）

- ⚠ **`content-db.integration.spec.ts`（Agent 05）有一条 flaky**：
  并发用例单跑三次挂一次（MySQL 死锁，`prisma-content.repository.ts:116`）。
  它会让「全绿」这个信号不可靠。**已在本文件中记录并上报，未修改 Agent 05 的代码。**
- 契约的 `JobId.dailyDraft` 仍是 2 段（Agent 06 CCR 第 0 项，本模块第三次重申）。
