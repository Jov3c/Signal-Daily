# Handoff

**Agent:** 09 — 收藏 / 阅读进度 / 阅读偏好
**Wave:** 2（上游：Agent 00、01、02 —— 三者均 `✅ 已完成`）
**日期:** 2026-09-29
**基线:** Development Contract v1.1 / Agent Rule v1.0
**分支:** `agent/09-user-features`

> ⚠ **先读文末的《补遗（§23 独立审查）》**。正文的实现描述在审查**之前**
> 就已成立，但独立审查在其上仍查出 **13 条 P3/P4**（**无 P0、无 P1**），
> 其中 **2 条是真 bug**，**已全部修复并加了回归守卫**。
>
> 两条真 bug 都值得单独说：一条是**登记进冻结契约却从未被抛出的错误码**
> （而我的 CCR 声称会返回它）；一条是**两个校验器各自表述同一个游标格式**
> 导致的 500。另外三条「覆盖缺口」里有两条是**假绿**——
> 用例的注释与它实际测的东西不一致。

---

## Task

`tasks/agent-09-user-features.md`：

> 实现登录用户个人阅读能力，**不包含任何订阅功能**。

契约依据：`docs/04` 的 User 段（6 条路由）、`docs/11`（用户功能）、
`docs/12`（可见性规则）、规则 §13（订阅模块已取消）。

**任务书的「必测」五项**逐条覆盖：

| 必测项                          | 覆盖位置                                                       |
| ------------------------------- | -------------------------------------------------------------- |
| Bookmark 幂等                   | `user-features-service.spec.ts`（add/remove 各一条）+ 真库一条 |
| 匿名拒绝                        | `user-features-routes.spec.ts`（守卫读控制器元数据）           |
| progress complete               | `user-features-service.spec.ts`（三条规则）+ 真库精度往返      |
| 偏好校验 / 同步                 | `user-features-dto.spec.ts` + `user-features-service.spec.ts`  |
| 项目中无 `/subscriptions` route | `user-features-routes.spec.ts`（**全仓库**静态扫描）           |

---

## Implemented

### 1. 收藏 —— `apps/api/src/modules/bookmarks/**`

```text
POST   /api/v1/bookmarks/:contentId
DELETE /api/v1/bookmarks/:contentId
GET    /api/v1/bookmarks
```

- **两条幂等承诺**（`docs/11`）：
  - `add` 重复调用 200，且 `createdAt` **仍是第一次**的时间（不刷新）——
    实现靠 `createMany({ skipDuplicates })` + 主键，**不是先查后写**
    （后者在并发下会有一条抛 P2002 → 500）。
  - `remove` 重复调用 200 —— 本来就没收藏也算「目标状态已达成」。
- **准入与可见性是一对刻意不对称的规则**：
  - **加**收藏要求内容对外可见（`APPROVED`）；不可见 → **404**，
    与「不存在」同一个响应 —— 否则本接口会变成一个
    「某 id 是否存在 / 是否被撤下」的探测器。
  - **取消**收藏**不检查内容状态** —— 内容后来被撤下时，
    用户仍然必须能清理自己的收藏。
- **列表用复合游标** `{createdAtMillis}-{contentId}`：列表按 `createdAt DESC`
  排序而它**毫秒精度、不唯一**（一次性收藏多条会撞在同一毫秒）。
  只拿 `contentId` 当游标（一个**不参与排序**的字段）会在边界上漏行。
- 列表**过滤掉内容已不可见的收藏**（`docs/12`），但**收藏行保留** ——
  内容恢复可见后会重新出现。

### 2. 阅读进度 —— `apps/api/src/modules/reading-progress/**`

```text
PUT /api/v1/reading-progress
```

- **upsert**（主键 `(userId, resourceType, resourceId)`）：`docs/11` 说
  「客户端节流更新」，同一份内容只该有一行，否则表会被几十倍放大。
- **`completedAt` 三条规则**（`docs/11`：`>=0.95 可 completed`）：
  1. 跨过 0.95 的**那一次**置位；
  2. **已完成的不回退**（之后读到 0.2 也不清空）；
  3. **不刷新已有的完成时间**（重复写 0.98 不会把时间刷成现在）。
- `progress` 的边界是**闭区间 `[0, 1]`**，而列类型是 `Decimal(5,4)`
  （存得下 `9.9999`）—— **数据库不会替我们挡住越界值**，所以在 dto 层拒。
  `NaN` / `Infinity` 用 `Number.isFinite` 挡（`NaN >= 0` 是 `false`，
  用比较运算会漏）。
- `resourceType` **V1 只接受 `CONTENT`**（见 CCR 第 1 项）。

### 3. 阅读偏好 —— `apps/api/src/modules/user-preferences/**`

```text
GET /api/v1/me/preferences
PUT /api/v1/me/preferences
```

- **读时补建**：行不存在就用数据库默认值建一行，**不是 404** ——
  Agent 02 说偏好行在建号时自动创建，但 OAuth 路径 / 未来新增的建号路径
  都可能漏掉这一步，而「每个用户都应该有偏好」本来就是这个字段的语义。
- **部分更新**（未提供的字段不动）。⚠ 动词是 `PUT` 而语义是部分更新 ——
  这是 `docs/04` 定下的路径，语义细节已提 CCR 第 3 项请裁。
- **未知字段一律 400**（不是静默忽略）：客户端把 `articleFontSize` 拼错时，
  静默忽略会让它以为保存成功。
- 只有**三个明确字段**，没有 JSON 扩展位 —— 这是 `docs/03`
  「不使用一个无限扩张的 JSON 代替明确字段」与 `docs/11` 的
  「不建立广告画像 / 不保存兴趣订阅图谱」在实现上的落点。

### 4. 全项目「没有订阅」的静态守卫

`user-features-routes.spec.ts` 里有一条**扫全仓库**
（`apps/api` / `apps/worker` / `apps/web` / `packages/*`）的守卫：

- 没有任何 `@Controller` 声明订阅路由；
- 三张被禁的表（`person_subscriptions` / `topic_subscriptions` /
  `source_subscriptions`）**没有被定义，也没有被读写**。

> ⚠ 判据刻意**精确到「实际定义 / 实际使用」**而不是「字符串出现过」。
> 第一版写成 `code.includes(table)`，它立刻报了
> `prisma/schema.prisma: source_subscriptions` —— 而那是 schema 顶部的一行
> **禁止性注释**（「V1 不存在任何订阅表（…一律禁止）」）。
> 也就是说，**一句禁令被守卫当成了违规**。
> 假阳性比漏判更危险：它会让下一个人直接把守卫删掉。
> 现在只抓三种真正违规的形态：`model <table>` / `@@map("<table>")` /
> `prisma.<camelCase>`，并且**反向断言那句禁令不会被命中**。

---

## Files Added

**API（22 个源码文件）**

```text
apps/api/src/modules/bookmarks/
  module.ts  controller.ts  index.ts
  service.ts                  幂等（add/remove）
  repository.ts               端口
  prisma-bookmarks.repository.ts   ★ 复合游标 + 可见性过滤
  dto.ts  bigint-id.ts

apps/api/src/modules/reading-progress/
  module.ts  controller.ts  index.ts
  service.ts                  completedAt 三条规则
  repository.ts  prisma-reading-progress.repository.ts
  resource-type.ts            ★ V1 的取值集合（契约缺口，见 CCR 第 1 项）
  dto.ts  bigint-id.ts

apps/api/src/modules/user-preferences/
  module.ts  controller.ts  index.ts
  service.ts  repository.ts  prisma-user-preferences.repository.ts  dto.ts
```

**测试（7 个文件 / 105 项）**

```text
apps/api/test/
  user-features-service.spec.ts        26  幂等 / 完成规则 / 分页 / 补建
  user-features-dto.spec.ts            19  三个 dto 的校验与截断
  user-features-routes.spec.ts         10  路由表 + 守卫 + ★ 全项目无订阅
  user-features-di-wiring.spec.ts       6  ★ 三个模块的依赖图真的能建起来
  user-features-db.integration.spec.ts 23  **真 MySQL**（精度往返 / 游标 / 级联 / ensure / 并发）
  user-features-http.spec.ts           23  ★ **真 HTTP**（匿名 401 / 封套形状 / 状态码 / 接线）
  support/user-features-fakes.ts           内存替身
```

**其它**

```text
handoffs/agent-09-HANDOFF.md（本文件）
handoffs/CONTRACT_CHANGE_REQUEST-agent-09.md（6 项）
work/_agent09/REVIEW.md（§23 审查报告，不在 git 内）
```

## Files Modified

```text
packages/contracts/src/errors.ts        仅**追加** 2 个业务码（删除 0 行）
  CONTENT_NOT_VISIBLE / READING_RESOURCE_TYPE_UNSUPPORTED
```

### ⚠ 顺手修了 Agent 08 遗留的 **10 个测试类型错误**

根 `typecheck` **不检查测试文件**，而 `apps/api` / `apps/worker` 各自的
`typecheck` 脚本（会跑 `tsc -p test/tsconfig.json`）**`pnpm verify` 从不调用**。
于是 Agent 08 合并进 `main` 的这几个文件里带着 10 个类型错误，而 `verify` 报绿：

```text
apps/api/test/daily-preflight-parity.spec.ts   ×5  字符串字面量赋给 DailyDisplayStyle
apps/api/test/daily-public-view.spec.ts        ×4  字符串字面量赋给 SourceKind / SourceTier
apps/worker/test/publishing-db.integration.spec.ts ×1  string 赋给 EditorialReviewStatus
```

这是**已合并进 main 的文件**里的错误，属于「绿得不对」，所以直接修了
（§9 禁止的是「顺手重构别人的模块」，而这是修 `main` 上已存在的缺陷，
且不改变任何行为）。**已提 CCR 第 5 项**建议把这两个 typecheck 收进根 `verify`。

**未触碰**：`prisma/**`、`apps/api/src/app.module.ts`、`apps/worker/src/worker.module.ts`、
`apps/api/src/modules/{auth,users,sources,admin-review,featured,daily}/**`、
`apps/worker/src/**`、`packages/contracts` 的枚举 / Queue / Job / DTO。

---

## Database Migrations

**None**

未创建任何 Migration，未改动 `prisma/schema.prisma`。
三张表（`bookmarks` / `reading_progress` / `user_preferences`）在 Agent 01 的
初始 schema 里都已存在，**没有新字段需求**。

⚠ 但有一处「按字面实现需要新枚举」的契约要求，已提 CCR 第 1 项
（`reading_progress.resource_type` 的取值集合）。

---

## Public Interfaces

### 给 Agent 13（Public Web v1.7）—— 最重要

- **三个模块都要 `imports` 才能用**（它们各自 `imports: [AuthModule]`，
  `AuthGuard` 及其依赖由 AuthModule 导出）。
- `@UseGuards(AuthGuard)` + `@CurrentUser()` → `{ id, role, sessionId }`，
  **`id` 是 string**（BIGINT 已转）。
- **401 的处理与前台的刷新逻辑一致**：未登录 / 会话失效 → 401，
  前台清本地状态并静默走刷新或跳登录（与 Agent 02 给 Agent 13 的说明一致）。
- ⚠ **`GET /bookmarks` 的游标是复合的**（`{ms}-{contentId}`）——
  不要自己拼，把上一页返回的 `meta.nextCursor` 原样传回来。
- ⚠ **收藏列表不带 `evidenceSummary`**：要证据链请走 `GET /contents/:id`。
- 收藏 / 进度 / 偏好三者的**请求体形状**见本 HANDOFF 与 CCR（`docs/04`
  对 `PUT /reading-progress` 与 `GET /bookmarks` 没有给形状，是本模块定的）。

### 给 Agent 10（Search / Public API）

- **`CONTENT_NOT_VISIBLE`**（404）是本模块新增的**可见性**错误码，
  语义是「不存在 **或** 存在但未 `APPROVED`」。你的公开读（`GET /contents/:id`）
  对不可见内容返回 404 时**可以直接复用同一个码**，前台就能统一处理。
  请在 CCR 第 4 项上表态（它是否与 `AI_CONTENT_NOT_FOUND` 构成同义码）。
- ⚠ 若你在 `GET /contents/:id` 里要带 `bookmarked`（契约的 `PublicContent`
  有这个可选字段），请用本模块的 `BookmarkService`/仓储，**不要自己写一条
  `SELECT`** —— 可见性口径（`APPROVED`）必须与这里一致。
- 收藏列表的**卡片预览**形状（`BookmarkedContent`）是从
  `modules/bookmarks/index.ts` 导出的，与你的 `PublicContent` 是**两套**：
  前者是「个人列表条目」，后者是「内容详情」。刻意不合并 ——
  硬要合并就得在列表里算 `evidenceSummary`，那是 N+1。

### 给 Agent 12（Admin UI）

- 本模块**没有 admin 路由**（收藏 / 进度 / 偏好都是用户自己的数据）。
- ⚠ 若后台要按用户查看收藏，请提 CCR —— 那需要一个新的 admin 端点，
  而任务书没有要求，本模块**刻意不做**（避免把用户私人数据暴露给后台
  而没有任何产品依据）。

### 给 Agent 14（最终集成）—— 必做

```ts
// apps/api/src/app.module.ts
@Module({
  imports: [
    CommonModule, AuthModule, AdminReviewModule, FeaturedModule, DailyModule,
    BookmarksModule, ReadingProgressModule, UserPreferencesModule,   // ← Agent 09
  ],
})
```

1. ⚠ **不要再注册全局异常过滤器**（`CommonModule` 已提供）。
2. ⚠ `UserPreferenceController` 的前缀是 **`me/preferences`**，
   Agent 02 的是 **`me`** —— 两个控制器共存时依赖图与路由表都不冲突
   （`user-features-di-wiring.spec.ts` 里有一条断言在 `init()` 之后仍能取到），
   但**路由注册顺序**由 Nest 决定，请不要调整控制器数组的顺序去「优化」它。
3. 本模块的三个模块**不启动任何后台任务**（没有消费者、没有定时器），
   与 04/05/06/07/08 不同 —— 引用它们**不需要**那个「统一的测试期开关」。
4. ⚠ **建议顺手做 CCR 第 5 项**（把两个 test typecheck 收进根 `verify`）——
   已经复现两次了。

---

## APIs Used

**外部：无。** 本模块不调用任何外部服务，只读写 MySQL。

**内部**：`@signal/contracts`（枚举 / 错误码 / 封套）、
`common/guards`（`AuthGuard` / `@CurrentUser`）、
`common/prisma`（`PrismaService` 是 `@Global`；`toBigIntId` 见下）。

---

## Events / Queues

**None** —— 本模块**不注册也不消费任何 Queue / Job**，没有定时器。

理由：收藏 / 进度 / 偏好都是**同步的写请求**（用户点了就要立刻生效），
没有任何需要异步化的重活。`docs/13` 的 Job 名里也没有对应项。

---

## Environment Variables

**未新增任何 env。** 只用 `docs/20` 已有的 `DATABASE_URL` / `LOG_LEVEL`。

**依赖变更：无。**

---

## Test Results

```text
pnpm lint                                        ✓ 0 errors
pnpm typecheck                                   ✓ tsc -b + web tsc --noEmit
pnpm test                                        ✓ 77 files / 1762 tests（基线 72 / 1676）
npx tsc -p apps/api/test/tsconfig.json --noEmit    ✓ 只剩 Agent 03 的 5 个既有错误
npx tsc -p apps/worker/test/tsconfig.json --noEmit ✓ 只剩 Agent 04 的 3 个既有错误
REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration
                                                 ✓ 7 files / 100 tests（真 MySQL + 真 Redis）
REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/worker test:integration
                                                 ✓ 8 files / 143 tests（真 MySQL + 真 Redis）
```

**新增测试 105 项**（单测 82 + 集成 23）—— 含审查后补的 25 项。

## Commands

```bash
pnpm test                                                     # 单测（无需 DB/Redis）
pnpm --filter @signal/api test:integration                     # 需要真 MySQL + 真 Redis
pnpm --filter @signal/worker test:integration                  # 同上
# ⚠ 这两条根 verify 不会跑，但会发现测试文件里的类型错误：
npx tsc -p apps/api/test/tsconfig.json --noEmit
npx tsc -p apps/worker/test/tsconfig.json --noEmit
```

---

## Known Limitations

### 设计取舍（§23.8 要求逐条记录）

1. **`PUT /reading-progress` 的请求体形状是本模块定的**（`docs/04` 没给）。
   已提 CCR 第 1 项请裁。

2. **`resource_type` 只接受 `CONTENT`**（`VarChar(30)` 但 `docs/05` 无枚举）。
   理由：它参与主键，任意字符串会往库里灌无界垃圾键。已提 CCR 第 1 项。

3. **`GET /bookmarks` 用复合游标 + cursor 分页**（`docs/04` 没给形状）。
   已提 CCR 第 2 项。

4. **收藏列表过滤掉「内容已不可见」的收藏，但收藏行保留。**
   `docs/12` 要求 Public API 不返回 REJECTED/internal candidate；
   另一种合理做法是「返回但标记为不可用」。已提 CCR 第 2 项请裁。

5. **收藏列表不带 `evidenceSummary`。** 那是内容**详情**的字段，
   在列表里算就是 N+1（Agent 07 为审核列表专门解决过同一个问题）。
   前台要证据链走 `GET /contents/:id`。

6. **`PUT /me/preferences` 的语义是「部分更新」而动词是 `PUT`。**
   严格 REST 下 `PUT` 是整体替换 —— 那会让「只改主题」的操作把字号重置回默认。
   已提 CCR 第 3 项请裁（A：保留 `PUT` 但写清语义；B：改成 `PATCH`）。

7. **`add` 收藏要求内容 `APPROVED`，`remove` 不检查。** 这条不对称是刻意的：
   前者防「内容探测」，后者保证用户能清理自己的收藏。

8. **`completedAt` 一旦置位就不再回退，也不刷新。**
   理由：用户已经读完过一次；把「重读开头」当成「撤销完成」会让
   「我读过哪些」的答案随一次误触而丢失。`docs/11` 只说「`>=0.95 可 completed」，
   没有说之后如何 —— 这是本模块的取值。

9. **`bigint-id.ts` 在 `bookmarks` 与 `reading-progress` 各有一份**
   （`toBookmarkContentId` / `toResourceId`）。不合一份的理由与 Agent 02/07
   对 `clock.ts` 的取舍相同（跨模块 import 会把两个模块的生命周期绑在一起），
   而且它们只有 8 行。**根因是 `common/prisma/bigint-id.ts` 缺上界** ——
   这是**第四次**上报（CCR 第 0 项）。`user-preferences` **不需要**它
   （`userId` 来自认证主体，必然是合法的 BIGINT）。

10. **没有后台按用户查看收藏的接口。** 任务书没有要求，
    而把用户私人数据暴露给后台需要产品依据。需要就提 CCR。

11. **`user-preferences` 的 `update` 前会先 `ensure`**（多一次往返）。
    代价换的是「对还没有偏好行的用户不会抛 P2025 → 500」。

### 未修复但已上报

- `common/prisma/bigint-id.ts` 缺 BIGINT 上界（**第四次**，CCR 第 0 项）。
- 测试文件的类型错误对根 `verify` 不可见（CCR 第 5 项）。
  **本模块顺手修了 Agent 08 遗留的 10 个**；**仍有 8 个既有错误未修**
  （Agent 03 的 5 个、Agent 04 的 3 个）—— 它们不属于本模块，按 §24.6 未动。

---

## Contract Change Requests

见 `handoffs/CONTRACT_CHANGE_REQUEST-agent-09.md`（**6 项**）。

**最需要裁决的三项**：

0. ⚠ `toBigIntId` 缺上界（**第四次**上报，四份重复实现是它的直接成本）
1. ⚠ `PUT /reading-progress` 的请求体形状 + `resource_type` 的取值集合（契约缺口）
2. ⚠ 测试类型检查的洞（**已经复现两次**，会持续复发）

**没有一项阻塞交付。**

---

## Integration Notes

### Git

- 仓库：`E:\desk\Signal-Project-Package-v1.2\Signal`，分支 `agent/09-user-features`。
- 提交署名：Jov3c（**不含** Claude）。

### 与上游的接口（易错点）

- `AuthUser.id` 是 **string**（Agent 02 已把 BIGINT 转好）—— 别再做一次 `String()`。
- 授权按**库里的当前角色**判定（Agent 02 每个认证请求一次 DB 查询），
  所以登出 / 撤权 / 禁用**立刻生效** —— 本模块不需要任何额外处理。
- `PrismaService` 是 `@Global()` 的（Agent 02 落地），**不要**在本模块再建一份。
- 偏好行由 `findOrCreateByEmail` 在建号时创建（Agent 02），
  但本模块**不依赖**这一点（读时补建，见取舍）。

---

# 补遗（2026-09-29）：§23 独立审查后的缺陷修复

## 为什么有这段

按 §23.3，审查由一个**没有本次开发上下文**的独立执行者完成
（报告：`work/_agent09/REVIEW.md`，不在 git 内）。

**结论：通过 —— 无 P0、无 P1。** 但查出 **13 条 P3/P4**，
其中 2 条是真 bug、3 条是覆盖缺口（含 2 条**假绿**）。
按 §23.6「修复，不是只记录」，全部已修。

> 审查者还独立跑了 `tsc -p apps/{api,worker}/test/tsconfig.json --noEmit`，
> 确认**只**剩 Agent 03 的 5 个与 Agent 04 的 3 个既有错误 ——
> 即本模块（含顺手修的 Agent 08 那 10 处）确实是干净的。

## 先修正正文里两处**过于乐观的声称**（§23.6 第 4 条）

| #   | 正文/CCR 原先的说法                                                                            | 事实                                                                                                        | 处置                                                 |
| --- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | CCR 第 1 项：「`resourceType` 其他值 → 400**（错误码 `READING_RESOURCE_TYPE_UNSUPPORTED`）**」 | **错。** 那个码被登记进冻结契约、CCR 也这么写，但实现里**从未抛出** —— 非法取值实际返回 `VALIDATION_FAILED` | 修实现（真的抛它）+ 单测与 **HTTP 级**各一条回归守卫 |
| 2   | 「`GET /bookmarks` 的游标校验」                                                                | 实现里有**两个**游标校验器（dto 的正则 + 解码器的 `Number.isSafeInteger`），二者口径不同                    | 改成**共用解码器**（见修复清单第 2 条）              |

## 修复清单

| #   | 严重度        | 问题                                                                                                                                                                                | 位置                                                                        |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | **P3 真 bug** | `READING_RESOURCE_TYPE_UNSUPPORTED` **注册了却零使用**（见上表）                                                                                                                    | `reading-progress/dto.ts`                                                   |
| 2   | **P3 真 bug** | `GET /bookmarks?cursor=99999999999999999999-1`（20 位毫秒）→ **500 而不是 400**。dto 的 `/^\d{1,20}-\d{1,20}$/` 放行，解码器的 `Number.isSafeInteger` 拒绝 → 仓储抛**普通 `Error`** | `bookmarks/dto.ts`（改用 `decodeBookmarkCursor`）                           |
| 3   | P3 覆盖缺口   | **控制器层零执行**：6 条路由从未被真正调用过（只有元数据断言），响应封套 / 状态码 / 路径参数接线全无覆盖                                                                            | 新增 `user-features-http.spec.ts`（23 项，**真 HTTP**）                     |
| 4   | P3 覆盖缺口   | `PrismaReadingProgressRepository.isResourceVisible` / `find` **真库零执行**；`BookmarkService.remove` 的「不查可见性」只在替身上验过                                                | 真库新增 3 条                                                               |
| 5   | P3 覆盖缺口   | 替身 `preview()` 把预览字段**写死**，而真库只断言了 `source.name` / `originalUrl` → `kind`/`tier`/`type`/`official`/`language` 的映射错位**两套测试都不红**                         | 真库逐字段断言                                                              |
| 6   | P4            | 「收藏不可见内容」用例**注释写了 101、实际只测 999** → 「存在但不可见」这条路径从没被走到                                                                                           | 改成真的测两种情形，并断言**两者返回同一个码与同一个状态码**                |
| 7   | P4            | 「`resourceType` 由 dto 挡住」是**空跑用例**（断言的是合法输入能通过）                                                                                                              | 换成「超界 BIGINT 的 `resourceId` → 404」                                   |
| 8   | P4            | 真库 `updatedAt` 用字符串 `>=` 断言 → **值不变也会通过**                                                                                                                            | 改成 `not.toBe` + 时间戳 `toBeGreaterThan`                                  |
| 9   | P4            | `BOOKMARK_LOGGER` **死导出**（模块里根本没注册它）                                                                                                                                  | 删掉                                                                        |
| 10  | P4            | `UpsertProgressInput.now` **真实现忽略、替身却用** → 两套 `updatedAt` 语义不同而各自「测得过」                                                                                      | 从端口删掉 `now`（`updated_at` 由 Prisma 的 `@updatedAt` 维护）             |
| 11  | P4            | 「并发 add 幂等」只有论证、**没有实测**                                                                                                                                             | 真库 `Promise.all` 五条并发，断言不抛且只有一行                             |
| 12  | P4            | reading-progress 的**超界 BIGINT** 路径无测试                                                                                                                                       | 补（单测）                                                                  |
| 13  | P4            | 两个新码不以 `_NOT_FOUND` 结尾 → 省略 `httpStatus` 会得 500（当前两处均显式 404）                                                                                                   | 加注释；并在服务层测试里**断言 `httpStatus === 404`**（把「必须显式」钉住） |

## ⚠ 第 3 项补的 HTTP 测试是怎么做的（值得下游借鉴）

`AuthGuard` 的**行为**由 Agent 02 覆盖，这里**不重复**。
所以只把守卫依赖的**两个端口**（`ACCESS_TOKEN_VERIFIER` /
`AUTH_SESSION_LOOKUP`）换成桩，其余全是真的：

```text
真的 AuthGuard · 真的控制器 · 真的服务 · 真的 dto · 真的异常过滤器 · 真的 HTTP 栈
```

覆盖到的：**匿名 6 条路由全 401**（任务书的必测项，从「元数据级」升级到
「真 HTTP 级」）、响应封套形状、状态码、`:contentId` 的路径参数接线、
以及校验错误在真实异常过滤器下的样子（含 `requestId`）。

> 这条方法对**所有**需要鉴权的模块都适用 —— 建议 Agent 10 / 12 / 13 照做。

## 新增/变化的测试

```text
修复前  pnpm test → 76 files / 1737 tests ；api IT 96 ；worker IT 143
修复后  pnpm test → 77 files / 1762 tests ；api IT 100 ；worker IT 143
```

新增 `user-features-http.spec.ts`（23 项，真 HTTP）；
真库 19 → 23 项；单测若干条被**加强**而不是新增（见第 6/7/8 条）。

## 反证记录（确认新守卫**有牙齿**）

按 §23.5 的手法，对本轮**新增的关键守卫**做了变异反证（改坏 → 确认变红 → 恢复）：

| 守卫                                           | 变异（**实际执行的**）                                                    | 结果                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| `READING_RESOURCE_TYPE_UNSUPPORTED`（F1 回归） | `reading-progress/dto.ts` 里把那段 `throw` 删掉、退回 `errors.push`       | ✅ **2 条**变红（单测 + HTTP 测试各一条）                |
| 游标 400（F2 回归）                            | `bookmarks/dto.ts` 换回第一版的正则                                       | ✅ 变红：`非法 cursor → 400（不是 500）`（实际返回 500） |
| `CONTENT_NOT_VISIBLE`（可见性语义）            | `bookmarks/service.ts` 把那个码换成平台码 `NOT_FOUND`（模拟后人「简化」） | ✅ **4 条**变红（含 HTTP 级那条）                        |

> ⚠ 第三条的**牙齿边界**要说清：它抓的是「码被改掉」。
> 而「两种不可见**不可区分**」本身是**结构性**保证 ——
> 仓储端口的 `isContentVisible` 返回 `boolean`，服务层**拿不到**区分它们所需的信息。
> 与 `displayStyleFor` 保证「Lead 只有一条」同一性质：靠形状，不靠自觉。

## 审查未验的部分（审查者自己列的）

- **端到端 HTTP 原本零覆盖**（现已补 23 项，但**仍未覆盖**：真实登录流程、
  会话撤销后立刻 401 —— 那两条属 Agent 02 的范围）；
- emoji 写进真 MySQL（只核对了 migration 是 utf8mb4）；
- `ensure` + `update` 对**不存在行**的真实组合（现有真库测试里 `ensure` 先跑过）；
- 超界 BIGINT 是否**真的**让驱动抛错（本模块只验了「不会 500」）；
- **未做变异反证、未写探针**（§23.5 深度审查默认不做）。

## 审查发现但**不属于本模块**的问题（§24.6：不自己改别人的行）

- ⚠ **`content-db.integration.spec.ts`（Agent 05）有一条 flaky**：
  并发用例偶发失败（MySQL 死锁，`prisma-content.repository.ts:116`）。
  Agent 08 的审查者独立报过一次，我这次也撞到一次（重跑两次全过）。
  它会让「全绿」这个信号不可靠。**已记录，未修改 Agent 05 的代码。**
- `apps/api/test/sources-api.spec.ts`（Agent 03）5 个类型错误、
  `apps/worker/test/collectors-*.spec.ts`（Agent 04）3 个 —— 见 CCR 第 5 项。
