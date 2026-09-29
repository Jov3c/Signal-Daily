# Contract Change Request — Agent 08（精选 / 日报发布）

**Agent:** 08
**Module:** Featured / Daily Publishing
**日期:** 2026-09-29
**基线:** Development Contract v1.1 / Agent Rule v1.0

> 按 §7：本模块**没有**直接修改任何公共契约。下面每一项都写清了
> 「我暂时怎么绕过的」与「建议怎么改」，都没有阻塞本次交付。

---

## 0. ⚠️ 最高优先：`JobId.dailyDraft` 会被 BullMQ 拒绝（**重申** Agent 06 第 0 项）

**这不是新问题** —— Agent 06 的独立审查最早发现它（其 CCR 第 0 项），
Agent 05 在 CCR 里重申过一次，**至今无人裁决**。本模块是第三个被它打到的，
而且这次拿到了**真 Redis 的证据**。

### Current Problem

`packages/contracts/src/queues.ts`：

```ts
dailyDraft: (businessDate: string): string => `daily-draft:${businessDate}`,   // 2 段
```

而 `bullmq@5` 的 `Job` 构造函数要求含 `:` 的自定义 jobId **恰好 3 段**，
否则 `queue.add()` **同步抛错**。真 Redis（本机 6390）实测：

```text
REJECTED  contract JobId.dailyDraft('2026-09-29')   daily-draft:2026-09-29  -> Custom Id cannot contain :
ACCEPTED  本模块 3 段形态                            daily-draft:2026-09-29:0530
```

证据在 `apps/worker/test/publishing-queue.integration.spec.ts`：
一条用例**把契约 builder 的产物真的塞进 `queue.add()`** 并断言它抛错。

### Requested Change

二选一（我倾向 A）：

**A. 每个 builder 都产出 3 段，第三段是真实存在的维度。**

```ts
dailyDraft: (businessDate: string, slot: string): string =>
  `daily-draft:${businessDate}:${slot}`,
dailyPublish: (businessDate: string, slot: string): string =>
  `daily-publish:${businessDate}:${slot}`,
normalize: (rawItemId: string, ruleVersion: string): string =>
  `normalize:${rawItemId}:${ruleVersion}`,   // Agent 05 已自造
```

**B. 在 `queues.ts` 里加一条不变式与自检**（`assertAllJobIdsAreBullMqAcceptable()`），
让「产出的 jobId 会被 BullMQ 接受」成为可执行的契约而不是注释。

### ⚠ 第三段是**调度槽**，不是凑数（这一点请务必读）

`docs/10` 的「建议调度」在**同一个业务日**上有**三次**草稿相关动作
（00:10 初始化、05:30 生成、07:00 刷新）。如果第三段不区分它们：

- 三次入队得到**同一个 jobId**；
- BullMQ 把后两次当成重复任务**直接丢掉**；
- **07:00 的刷新永远不会执行，而且不报任何错**。

所以 `slot`（`0010` / `0530` / `0700` / `0730` / `0800`）是
「这一天里的哪一趟」，天然该进幂等键。同一趟重试复用同一个 jobId（这正是要的）。

### Compatibility

- 改 `JobId.dailyDraft` 的签名是**破坏性**的（编译期即可发现）；
- 目前只有本模块用它，而本模块**没有用**（自造了 3 段 builder）；
- Agent 04 / 05 / 06 已经各自自造过同类 builder，统一之后它们可以切回来。

### Database Impact

None

### API Impact

None

### Downstream Impact

Agent 04 / 05 / 08（已经各自绕过）、Agent 14（统一时请一并收口）。

---

## 1. ⚠️ `docs/04` 的 Admin Publishing 段**没有内容**，路由形状由本模块定义

### Current Problem

`docs/04-api-contract.md` 的 Admin Publishing 一节全文只有一句：

```text
沿用 v1.0 的 Featured / Daily API。
```

而 **v1.0 开发文档不在本开发包里**（我全盘核对过 `01-development-docs/`，
只有 v1.1）。`contracts/openapi-outline.yaml` 只固定了**一条**：

```yaml
/admin/daily/{date}/publish:  post:  operationId: publishDaily
```

后果：Admin 的精选与日报接口**无契约可依**，而 Agent 12（后台 UI）
与 Agent 10（公开 API）都要依赖它。

### Requested Change

把下面这张表写进 `docs/04`（与已实现逐字一致，已由
`apps/api/test/daily-routes.spec.ts` / `featured-routes.spec.ts` 守卫）：

```text
精选
  GET    /api/v1/admin/featured              列表（含未上架）
  POST   /api/v1/admin/featured              加入精选（仅 APPROVED + 勾选 Featured）
  PATCH  /api/v1/admin/featured/:contentId   自定义标题 / 摘要 / 权重 / 上下架
  DELETE /api/v1/admin/featured/:contentId   下架（软删除，保留历史）

日报
  GET    /api/v1/admin/daily?year=&month=&status=   期次列表
  GET    /api/v1/admin/daily/:date                  编辑台详情
  PUT    /api/v1/admin/daily/:date/sections         整体替换版块与条目
  POST   /api/v1/admin/daily/:date/schedule         排期（**无参数**；固定用该业务日上海 08:00）
  POST   /api/v1/admin/daily/:date/publish          立即发布（openapi 已固定）
  POST   /api/v1/admin/daily/:date/cancel           取消

公开（docs/04 已有）
  GET    /api/v1/featured
  GET    /api/v1/daily/:date
  GET    /api/v1/daily/archive?year=&month=
```

### Reason

否则 Agent 12 只能对着实现代码猜接口，而「猜」在本项目里已经被证明会分叉。

### Compatibility / Database Impact / API Impact

无（都是新增路由）。**Downstream Impact：Agent 10 / 12**（它们要按这张表对接）。

---

## 2. `packages/contracts/src/queues.ts` 缺 `daily-publish` 的 JobId builder

### Current Problem

`JobId` 里只有 4 个 builder，`publishing.daily-publish`（`docs/13` 的固定 Job 名）
**没有**对应的 builder。本模块自造了 `dailyPublishJobId`。

### Requested Change

补齐（与第 0 项一起改）：

```ts
dailyDraft:   (businessDate, slot) => `daily-draft:${businessDate}:${slot}`,
dailyPublish: (businessDate, slot) => `daily-publish:${businessDate}:${slot}`,
```

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：无**（目前只有本模块用）。

---

## 3. `preflightEdition()` 必须在两个 app 里各存一份 —— 建议提到共享包

### Current Problem

发布前校验（`docs/10` 的 Publish Preflight）被**两条路径**调用：

```text
apps/api/src/modules/daily/preflight.ts        管理员点「立即发布」
apps/worker/src/jobs/publishing/preflight.ts   08:00 的定时发布
```

`apps/api/src/**` 与 `apps/worker/src/**` 是两个独立 tsconfig 工程，
跨 app import 会触发 `TS6059`（Agent 04 提取 `packages/source-core` 时踩过；
Agent 07 的 `scoring.ts` 因此也各留一份）。

**规则漂移的后果是最难查的一类 bug**：管理员点得动、定时跑不动（或反过来），
两条路径都「正常工作」，没有任何日志异常。

**本模块的临时对策**：两份文件**逐字相同**，并由
`apps/api/test/daily-preflight-parity.spec.ts` 静态比对全文钉住
（改一份忘一份即变红，且报出第几行不同）。已做变异验证：改坏一行确实变红。

### Requested Change

按 Agent 04 提取 `packages/source-core` 的同一思路，建一个共享包
（`packages/publishing-core` 或把纯规则并入 `packages/contracts`），
让 api 与 worker 共用**同一份** `preflightEdition`。

同时建议一并收口另外两处同类重复：

- Agent 07 的 `apps/api/src/modules/admin-review/scoring.ts`（分数档位，第二份）
- Agent 06 的 `apps/worker/src/jobs/ai/scoring.ts`（第一份）

### Reason

「同一个业务规则在两个进程里各写一遍」是这个仓库目前**最大的横向风险**，
已经有三个 Agent 撞上（04 / 06 / 07 / 08）。

### Compatibility

不影响对外行为。**Database Impact / API Impact：无。**
**Downstream Impact：Agent 14**（集成阶段收口）。

---

## 4. worker 侧的 `PrismaClient` 包装现在有 **8 份**

### Current Problem

```text
apps/worker/src/jobs/collectors/prisma.service.ts
apps/worker/src/jobs/ai/prisma.service.ts
apps/worker/src/jobs/content/prisma.service.ts
apps/worker/src/jobs/publishing/prisma.service.ts          ← 本模块新增（第 4 份 worker 侧）
+ apps/api/src/common/prisma/prisma.service.ts（1 份）
+ 各自测试里的替身
```

每一份都是一个**独立的连接池**，而它们最终都会挂在**同一个** Nest 应用里
（Agent 14 的 `worker.module.ts`）。

这已经是 Agent 05 / 06 / 07 都提过的 CCR（Agent 06 第 2 项），
本模块把计数从 6 推到 8。

**我没有把它提取成共享包**，理由：那属于「顺手重构」（§9），
而且正确做法是**一份 `@Global()` 的 worker 侧 `PrismaService`**，
那是对整个 app 的装配决策 —— 归 Agent 14。

### Requested Change

在 worker 侧建**一份** `PrismaModule`（`@Global()`），
四个 job 模块全部 `imports` 它、删掉各自的 `prisma.service.ts`。

### Compatibility

纯内部装配。**Database Impact / API Impact：无。**
**Downstream Impact：Agent 14。**

---

## 5. 写 `admin_notifications` 的地方现在有**两处**（api 与 worker）

### Current Problem

- Agent 07 的 `NotificationService`（`apps/api`）：高分候选、来源失败；
- 本模块的 `PrismaPublishingNotifier`（`apps/worker`）：`docs/10` 的
  07:30 日报审核提醒、08:00 未发布提醒、发布前校验阻断提醒。

两处各自的幂等手法相同（`(type, targetUrl)` 先查后写，因为
`admin_notifications` **没有唯一约束**），但**是两份代码**。

### Requested Change

二选一：

- **A**：给 `admin_notifications` 加一个 `@@unique([type, targetUrl])`
  （属 Agent 01，需要 Migration）—— 这样幂等可以交给 DB，两处都不用再手写；
- **B**：把「写通知」提成一个共享端口（与第 3 项同一批做）。

我倾向 **A**：它同时消除了「并发下可能写两条重复通知」这个已知代价。

### Compatibility

A 需要 Migration（`admin_notifications` 里可能已有重复行，需要先清理）。
**API Impact：无（通知是内部数据）。Downstream Impact：Agent 01 / 07 / 11。**

---

## 6. `docs/10` 的「业务窗口」**没有定义**（本模块取值如下）

### Current Problem

`docs/10` 的 Draft Compiler 只写了候选必须「在业务窗口内」，
**没有说窗口是什么**。这是必须做决定的地方 —— 它直接决定
「昨天的新闻会不会上今天的日报」。

### 本模块的取值（**已实现，请裁决是否写进契约**）

```text
窗口 = [该业务日 08:00 上海时间 − 24h,  该业务日 08:00 上海时间)
```

即「上一期发布之后、到这一期发布之前」的 24 小时。

三个理由：与**发布时刻**对齐（一天报一天的事）；**按业务日固定**
（不随这一趟几点跑变化，否则 05:30 与 07:00 两趟会看到两个窗口）；
**自然向后滚动**（昨天 09:00 的内容不在昨天那一期、只在今天这一期 —— 一天的新闻只上一次报）。

若产品上希望「日报覆盖整个自然日」，那应当改成
`[businessDate 00:00, +24h)`，但那样 00:00–08:00 的内容会**等到第二天**才上报。
**请裁决。**

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：无**（只影响草稿选材）。

---

## 7. `docs/10` 的「单一公司不超过主要条目 25%」缺字段支持

### Current Problem

`prisma/schema.prisma` 里**没有「公司」这个实体**。
`docs/10` 的多样性规则「单一公司不超过主要条目 25%」无法按字面实现。

### 本模块的近似（**已实现，已在 HANDOFF 记录**）

用 **`Source`** 近似「公司」（一家公司的官方 Blog / X 账号就是它的一个 Source）；
「主要条目」按 `docs/05` 的 `DailyDisplayStyle` 读作 `LEAD` + `MAJOR`。

### Requested Change

若要按字面实现，需要给 `sources` 加一个 `organization` 字段（或建一张
`organizations` 表）—— 属 Agent 01，需要 Migration。
**在那之前本模块的近似与它的记录保持不变。**

### Compatibility / Database Impact / API Impact

需要 Migration（若采纳）。**Downstream Impact：Agent 01 / 12。**

---

## 8. 发布后的修改（`docs/10`）在 V1 **无法实现**，因为没有 revision 表

### Current Problem

`docs/10`：

```text
发布后修改：只允许 typo、broken link、fact correction，并记录 revision。
禁止静默重排整版。
```

而 schema 里**没有** revision 表。

**本模块的选择：V1 明确不支持发布后编辑**（`PUBLISHED` 是状态机终态）。
理由：没有 revision 的「发布后修改」就是**静默改历史**，
比「不支持」更糟 —— 前者会让「这一期的内容到底是什么」失去唯一答案。

### Requested Change

若产品上确实需要，请新增一张 `daily_edition_revisions`
（记每次修改的 diff、操作者、时间），属 Agent 01。

### Compatibility / Database Impact / API Impact

需要 Migration。**Downstream Impact：Agent 01 / 12。**

---

## 9. `docs/13` 没有「日报审核提醒」这一类 Job 名 —— 本模块用进程内动作代替

### Current Problem

`docs/10` 要求「07:30 未 REVIEWING 则通知管理员」，
但 `docs/13` 固定的 10 个 Job 名里**没有**对应的一项，
而 §6 禁止创建近义 Job。

### 本模块的处理（**不改契约**）

由 `PublishingScheduler` 在**进程内**直接完成（写一行 `admin_notifications`），
**不入队**。理由与 Agent 07 的通知扫描一致。

### Requested Change

**无（这是记录，不是请求）** —— 但如果 Agent 11 希望所有定时动作都
在 worker 的运维视野里以 Job 的形式出现，那应当在 `docs/13` 里补一个
Job 名（例如 `publishing.daily-review-reminder`），本模块再切过去。

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：Agent 11**（知情即可）。

---

## 汇总：哪些影响下游

| 项                         | 影响               | 是否阻塞                |
| -------------------------- | ------------------ | ----------------------- |
| 0. `JobId` 3 段            | Agent 04 / 05 / 14 | ❌ 不阻塞（各自已绕过） |
| 1. Admin Publishing 路由表 | **Agent 10 / 12**  | ❌ 不阻塞（实现已可用） |
| 2. `dailyPublish` builder  | 无                 | ❌                      |
| 3. preflight 共享包        | Agent 14           | ❌（有静态守卫兜着）    |
| 4. worker Prisma 8 份      | Agent 14           | ❌                      |
| 5. 通知表唯一约束          | Agent 01 / 07 / 11 | ❌                      |
| 6. 业务窗口取值            | **需产品裁决**     | ❌（已取默认值）        |
| 7. 「公司」字段            | Agent 01 / 12      | ❌                      |
| 8. revision 表             | Agent 01 / 12      | ❌                      |
| 9. 提醒 Job 名             | Agent 11           | ❌                      |
| 10.（见下）排期不接受参数  | **Agent 12**       | ❌                      |

---

## 10. `POST /admin/daily/:date/schedule` **不接受任何参数**（§23 审查后的修正）

### Current Problem

`docs/10` 没有描述 Admin 的排期接口形状（见第 1 项）。
本模块第一版让它接受一个可选的 `scheduledAt`，**但那是一个错的承诺**：
它被解析、被存库，**却没有任何代码读它** —— 排期后到 08:00 那一班就会发，
管理员指定的时刻完全不起作用。（§23 独立审查的 P2。）

### 本模块现在的行为（**已实现**）

- 传 `scheduledAt`（或任何未知字段）→ **400**，错误信息说明
  「排期固定用该业务日的上海 08:00；要立刻发出请用 `POST …/publish`」。
- 空体 / 无体 → 200，`scheduledAt` 由服务端算（= 该业务日上海 08:00）。
- `scheduledAt` 仍出现在响应里，用途是**记录与展示**。

### Requested Change

把「排期 = 标记为到目标时刻可发，目标时刻是契约常量」写进 `docs/04` 的
Admin Publishing 段，并说明「立即发布」是另一条路由。

⚠ 如果产品上确实需要「指定发布时刻」，那需要：
（a）契约里补上这个能力，（b）worker 侧让发布由 `scheduledAt` 驱动
（而不是固定 08:00 的那一班），（c）把这条写进 `docs/10`。
**在契约明确之前本模块不做** —— 一个「接受但忽略」的参数比没有参数更糟。

### Compatibility

⚠ **破坏性**：`POST …/schedule` 不再接受参数。**Downstream Impact：Agent 12**
（若它已经写了带时刻的排期表单，需改掉；要立刻发走 `POST …/publish`）。

### Database Impact / API Impact

无 Migration。API 请求体形状变了（见上）。

---

**没有一项阻塞本次交付。**
