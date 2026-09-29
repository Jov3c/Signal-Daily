# Handoff

**Agent:** 07 — 编辑审核 CMS API / Evidence
**Wave:** 2（上游：Agent 00、01、02、03、05、06 —— 六者均 `✅ 已完成`）
**日期:** 2026-09-29
**基线:** Development Contract v1.1 / Agent Rule v1.0
**分支:** `agent/07-admin-review`

> ⚠ **本次交付未做 §23 独立审查**（用户明确要求「一个 agent 开发就行」，
> 与 Agent 05 同一处理）。HANDOFF 里的全部验证都由**作者自己**完成。
> 自查过程抓到 3 个自己制造的问题（见文末），但**这不等于独立审查** ——
> 建议 Agent 14 集成前补一次，重点看：批量审核的边界、证据链事务、
> 以及「读操作带副作用」（Dashboard 顺带跑通知扫描）。

---

## Task

`tasks/agent-07-admin-cms.md`：候选审核 API、Evidence 管理 API、管理员通知。

`docs/09` 要求 Dashboard 与 Review Detail 的完整字段清单。

---

## Implemented

### 1. 审核队列与详情（`docs/04` + `docs/09`）

```text
GET /api/v1/admin/review              finalScore DESC, publishedAt DESC
GET /api/v1/admin/review/:contentId   docs/09 的「必须同时看到」清单
```

- 列表额外带 **Source tier / official / independentSourceCount / scoreBand**；
- **独立来源数与官方确认一次算好整页事件的口径**（不是每行一次查询）；
- Detail 含：原文/翻译、来源 kind/tier/official、AI 六维 + 理由 + 主题、
  事件、Primary/Supporting/Related Evidence、独立来源数、官方确认、相似内容。

### 2. 审核决策

```text
POST /api/v1/admin/review/:contentId/decision   五个动作
POST /api/v1/admin/review/bulk                  只允许 Defer / Reject
```

- 五动作 → `EditorialReview.status` + 两个布尔位 + `Content.pipelineStatus`，
  用**穷尽 `Record`** 表达（契约新增动作时编译不过，而不是落进某个 default）；
- **Defer 不改内容状态**（它还留在候选池里）；
- 批量**逐条报跳过原因**，不静默跳过。

### 3. Evidence 人工纠正 + 审计

```text
GET    /api/v1/admin/events/:eventId/evidence
POST   /api/v1/admin/events/:eventId/evidence
PATCH  /api/v1/admin/events/:eventId/evidence/:evidenceId
DELETE /api/v1/admin/events/:eventId/evidence/:evidenceId
POST   /api/v1/admin/events/:eventId/evidence/:evidenceId/set-primary
```

- URL **scheme 白名单**（http/https）+ 长度；`javascript:` / `data:` / 相对路径被拒；
- 同 URL 重复 → **409**（先查一次给出可读错误，DB 唯一约束是最后一道防线）；
- **Primary 切换用事务**（先清旧的、再设新的）—— `docs/03` 明确 DB 层不强制；
- **每次人工操作都写审计**（结构化日志）。

### 4. 管理员通知 + Dashboard

- 高分通知（`finalScore >= 85` 且仍在待审）、Source 失败通知；
- 幂等扫描（靠 `(type, targetUrl)` 去重，因为 `admin_notifications` **没有唯一约束**）；
- Dashboard：今日抓取 / 高分候选 / 待审 / 失败来源 / AI 成本 / 日报状态，**按上海业务日**。

---

## Files Added

```
apps/api/src/modules/admin-review/
  module.ts  controller.ts  index.ts
  review.service.ts  evidence.service.ts  notification.service.ts
  repository.ts              端口
  prisma-admin-review.repository.ts
  admin-origin.guard.ts      ★ Origin check（Agent 03 那份的 CCR 未裁决，见取舍 5）
  audit.ts                   结构化审计
  scoring.ts                 ★ 分数档位（与 Agent 06 同口径的第二份，见取舍 2）
  bigint-id.ts               ★ BIGINT 上界收敛（见取舍 4）
  clock.ts
  dto/review.dto.ts  dto/parse.ts

apps/api/test/
  admin-review-service.spec.ts        (41)  服务层（审核/证据/通知/Dashboard）
  admin-review-routes.spec.ts         (14)  路由面 + 守卫应用 + Origin 行为
  admin-review-db.integration.spec.ts (10)  **真 MySQL**
  support/admin-review-fakes.ts       内存替身

handoffs/agent-07-HANDOFF.md
handoffs/CONTRACT_CHANGE_REQUEST-agent-07.md
```

## Files Modified

```
apps/api/test/auth-contract.spec.ts   登记 modules/admin-review/controller.ts 为 admin 路由所有者
                                      （Agent 02 设计的白名单，新 admin 模块必须登记）
```

**未触碰**：`prisma/**`、`apps/api/src/app.module.ts`、`apps/worker/**`、
`apps/api/src/modules/{auth,sources,users}/**`、`packages/contracts`（**本次没有追加任何错误码**）。

---

## Database Migrations

**None**

---

## Public Interfaces

下游从 `apps/api/src/modules/admin-review/index.ts` 取。

### 给 Agent 12（Admin UI）—— 最重要

- **审核动作是 `action` 字段**，不是直接传状态：
  `APPROVE_FEATURED` / `APPROVE_DAILY` / `APPROVE_BOTH` / `DEFER` / `REJECT`。
  批量只接受 `DEFER` / `REJECT`（传 APPROVE 会 400，且错误信息说明了原因）。
- **批量响应里有 `skipped`**：前端**必须显示它**，
  否则管理员会以为 10 条全处理了。
- 列表分页封套：`{data, meta:{page,pageSize,total,totalPages}}`。
- `scoreBand` 是**派生值**（`TOP_CANDIDATE` / `RECOMMENDED` / `NORMAL` / `LOW`），
  直接用于「高优先」筛选，阈值与 Agent 06 一致。
- X 账号 Tab 复用 `GET /admin/sources?type=X_USER`（Agent 03），本模块**不做**第二套。

### 给 Agent 08（Publishing）

- ⚠ **本模块只做决策，不做发布**：`Approve Featured / Daily` 只写
  `EditorialReview.publishFeatured / includeDailyCandidate` 与
  `Content.pipelineStatus = APPROVED`。**`FeaturedItem` / `DailyItem` 由你创建**。
- 日报候选 = `EditorialReview.includeDailyCandidate = true` 且 `status = APPROVED`。

### 给 Agent 11（Ops）

- **Redis 不是本模块的依赖**（只读 MySQL）—— 与 03/04/06 不同。
- ⚠ **api 进程里有一个 60 秒的通知扫描定时器**（见取舍 6），
  它会在多实例部署时被每个实例各跑一次（幂等，所以只是重复查询）。
- 审计**只写日志**，会被轮转掉 —— 不可作为长期取证（见取舍 3）。

### 给 Agent 14（最终集成）—— 必做

1. ⚠ **必须在根模块挂载**（否则整个审核后端在真实进程里 404）：
   ```ts
   @Module({ imports: [CommonModule, AuthModule, AdminReviewModule] })
   ```
2. **不要再注册全局异常过滤器**（`CommonModule` 已提供）。
3. ⚠ **本模块未做 §23 独立审查**，建议集成前补。
4. `apps/api` 的**既有** 5 个类型错误（`test/sources-api.spec.ts`，Agent 03 的）
   与根 `verify` 不检查测试文件类型是同一个老问题，仍未修。

---

## Events / Queues

**None** —— 本模块不注册也不消费任何 Queue / Job。
`docs/13` 的 `notification.admin-email` 由 **worker** 消费；
本模块只落 `admin_notifications` 行，**没有**入队邮件（见取舍 6）。

---

## Environment Variables

**未新增任何 env。** 只用 `APP_BASE_URL` / `API_BASE_URL`（Origin 允许列表）与 `LOG_LEVEL`。

---

## Test Results

```text
pnpm lint                                        ✓ 0 errors
pnpm typecheck                                   ✓
pnpm test                                        ✓ 57 files / 1443 tests（基线 57 / 1388）
pnpm --filter @signal/api test:integration        ✓ 5 files / 54 tests
pnpm test:db                                     ✓ 26 tests（需先 pnpm build，见 Known Limitations 1）
```

---

## Known Limitations

### 设计取舍（§23.8 要求逐条记录）

1. **`pnpm test:db` 需要先 `pnpm build`。**
   Agent 01 的 seed 测试依赖 `prisma/dist/seed.js`，未构建时会失败
   （报「需先 pnpm build」）。**这不是本模块引入的**，但会误导第一次跑的人。
2. **分数档位（85/70/55）在本模块是第二份实现。**
   Agent 06 的 `apps/worker/src/jobs/ai/scoring.ts` 是第一份，**跨 app 不能 import**
   （`TS6059`，与 Agent 04 提取 source-core 时同一个坑）。已提 CCR。
3. **`docs/09` 要求「人工 Evidence 操作写审计日志」，但 schema 里没有审计表。**
   本模块写**结构化日志**（带 `ADMIN_EVIDENCE_*` 分类与操作者 id）。
   **代价：日志会被轮转掉，不可长期取证。** 已提 CCR 请求一张审计表。
   `admin_notifications` **不能**当审计用 —— 它是「发给管理员看的」，
   方向与「记录管理员做了什么」相反。
4. **`common/prisma/bigint-id.ts` 缺 BIGINT 上界**（Agent 03 的 CCR 第 8 项，仍未裁决）。
   本模块在边界上用 `bigint-id.ts` 的 `toReviewId` 再收一次。
   真库集成测试有一条直接断言「超界 id 被忽略而不是抛驱动层异常」。
   **这是 Agent 03 已经发现、但至今没人修的同一个洞。**
5. **`AdminOriginGuard` 是第二份实现**（Agent 03 的 CCR 第 7 项建议提到 `common/`，
   仍未裁决）。不直接 import 是因为那份依赖 `SOURCE_CONFIG`，
   复用就得连带复用 Agent 03 的整个配置装配。
6. **通知扫描跑在 api 进程的定时器里，而不是 worker。**
   通知的触发条件横跨 04/06 两个 worker 模块，而 `docs/13` 没有「通知扫描」这个 Job 名。
   代价：api 多了后台任务、通知不在 worker 的运维视野里。已提 CCR 建议挪进 worker。
   **另外 `GET /admin/dashboard` 会顺带跑一次扫描** —— 那是「读操作带副作用」，
   之所以可接受是因为扫描幂等且失败不影响响应（已记入 HANDOFF 正文）。
7. **相似内容用「事件成员」而不是重算相似度。**
   相似度算法在 worker 侧（跨 app 不能 import），而事件成员本来就是
   相似度判定的**结论**。因此 `similarity` 字段返回 `null` —— **不谎报一个没算过的数字**。
   精确重复也不会出现（它们在 Agent 05 建 Content 之前就被挡掉了）。
8. **本模块不做发布**（见「给 Agent 08」）。

### 未修复但已上报

- **`apps/api` 有 5 个既有类型错误**（`test/sources-api.spec.ts`，Agent 03 的）。
  与 Agent 04 的 3 个、以及「根 `verify` 不检查测试文件类型」是同一个老问题。
- 契约的 3/4 个 `JobId` builder 会被 BullMQ 拒绝（Agent 06 的 CCR 第 0 项，仍未裁决）。

---

## Contract Change Requests

见 `handoffs/CONTRACT_CHANGE_REQUEST-agent-07.md`（4 项）。

---

## Integration Notes

- 开发全程在**独立 git worktree**（`work/_agent07/Signal`）里进行。
- **本次没有修改 `packages/contracts`**（没有新错误码需求 —— 全部复用平台码）。

---

# 自查记录（**不是**独立审查）

| # | 问题 | 现象 / 后果 |
| - | ---- | ----------- |
| 1 | 仓库只用了 `toBigIntId`（**缺 BIGINT 上界**） | 超界 id 抛 `PrismaClientUnknownRequestError`（500）而不是 404 —— **真库测试抓到的**；这正是 Agent 03 已发现未修的同一个洞 |
| 2 | 为了让 lint 过把 `GUARDS_METADATA` 改成 `import type` | 它们是**运行时值**，改完变成 `undefined` → **7 条路由/守卫测试全红** |
| 3 | 新增 admin 控制器没登记进 Agent 02 的白名单 | 跨模块守卫「只有登记过的模块可以声明 admin 路由前缀」变红 —— 这是它**设计上**要求新模块做的动作，已登记 |

第 2 条值得单独说：**lint 的建议不总是对的**。
`consistent-type-imports` 看着「这个 import 只被用在类型位置」（因为 `Reflect.getMetadata` 的第一个参数是 `any`），
但它其实被当作**值**传进去了。**先跑测试再信 lint**。
