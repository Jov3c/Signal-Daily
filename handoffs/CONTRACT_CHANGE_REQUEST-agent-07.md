# Contract Change Request

**Agent:** 07 — 编辑审核 CMS API / Evidence
**Module:** `apps/api/src/modules/admin-review/`
**日期:** 2026-09-29
**基线:** Development Contract v1.1 / Agent Rule v1.0

> 本文按《Signal 多 Agent 执行规则 v1.0》§7 的模板撰写。
> **没有一项阻塞我的交付。**
> ⚠ 本次**没有追加任何错误码**（全部复用平台码），是本项目第一个不改 `packages/contracts` 的模块。

---

## 1. 「分数档位」被实现了两遍（建议提到共享包）

### Current Problem

`docs/08` 的阈值（`>=85` 一级候选 / `70–84.99` 推荐 / `55–69.99` 普通 / `<55` 不进高优先）
现在有两份实现：

| 位置 | 用途 |
| ---- | ---- |
| `apps/worker/src/jobs/ai/scoring.ts`（Agent 06） | 算 `finalScore` 与档位，落 `ai_analysis` |
| `apps/api/src/modules/admin-review/scoring.ts`（本模块） | 审核列表按档位筛选、Detail 展示 |

**不能共用**：`apps/worker/src/**` 不在 `apps/api` 的 tsconfig 引用图里，
跨 app import 直接触发 `TS6059` —— Agent 04 在提取 `packages/source-core` 时踩过同一个坑。

### Requested Change

把「分数档位」提到一个共享位置（`packages/contracts` 的纯函数，或新建包），
让 06 与 07 共用同一份。阈值本身是 `docs/08` 的**契约值**，
放 `packages/contracts` 在语义上是合适的。

### Reason

两份实现漂移的表现是「同一个分数在 worker 落库时是 RECOMMENDED、
在后台筛选时是 NORMAL」，而**没有任何报错**。

**这类漂移已经真实发生过一次**：Agent 04 的 `packages/source-core` 就是为了
「SSRF 规则 / 到期规则 / config 形状」三处不能各写一份才提取的。

### Compatibility

纯新增（把纯函数搬进包），无破坏性；调用方改 import 即可。

### Database Impact / API Impact

无。

### Downstream Impact

Agent 06（改 import）、Agent 07（本模块）、Agent 10（搜索/前台若也要档位）。

---

## 2. `docs/09` 要求审计，但 schema 里没有审计表

### Current Problem

`docs/09`：「所有人工 Evidence 操作写审计日志。」

而 schema 里：

- **没有**审计表；
- `event_evidence` **没有操作者字段**（只有 `createdAt`）；
- `admin_notifications` 是「发给管理员看的通知」，**不是**「记录管理员做了什么」——
  把它当审计用会让「已读」语义与「已发生」语义纠缠在一起。

### Requested Change

请裁决其一：

- **(a)** 新增 `admin_audit_logs` 表（`actor_user_id` / `action` / `target_type` /
  `target_id` / `before` / `after` / `created_at`）→ 需要 Agent 01 建表 + Migration；
- **(b)** 明确「结构化日志即为 V1 的审计」并写进 `docs/09`（本模块采用的方案）。

### Reason

本模块采用 (b)：写结构化日志（带 `ADMIN_EVIDENCE_*` 分类与操作者 id）。
**代价必须说清楚：日志会被轮转掉（`docs/15` 的 Docker log rotate），
因此这不是可长期追溯的审计。**

对一个**编辑型平台**而言，「谁把哪条证据设为 Primary」在事后是需要能查的
（例如发布出错时回溯）。如果产品上认为这重要，应当走 (a)。

### Compatibility

(a) 是纯新增表，无破坏性。

### Database Impact

(a) 需要 Migration。

### API Impact

无（审计是写侧）。

### Downstream Impact

Agent 01（建表）、Agent 07（本模块改写入路径）、Agent 11（日志轮转策略）、Agent 14。

---

## 3. `AdminOriginGuard` 被实现了两遍（重申 Agent 03 的 CCR 第 7 项）

### Current Problem

`docs/14`：「敏感 Admin mutation 进行 Origin check」。

- Agent 03：`apps/api/src/modules/sources/admin-origin.guard.ts`
- 本模块：`apps/api/src/modules/admin-review/admin-origin.guard.ts`

**Agent 03 的 CCR 第 7 项已经建议把它提到 `common/`「一次覆盖 03/07/12」，至今未裁决。**

### Requested Change

提到 `apps/api/src/common/guards/`，03 / 07 / 12 共用。

### Reason

本模块**没有**直接 import Agent 03 的那一份，因为**它依赖 `SOURCE_CONFIG`**
（`modules/sources/source.config.ts`）—— 复用守卫就得连带复用那个模块的
整个配置装配，两个模块的生命周期会绑在一起。而这里只需要两个 env 值。

两份实现漂移的表现是「后台的某个页面接受跨源请求、另一个拒绝」，
而这类安全控制的漂移**不会有人发现**。

### Compatibility

需要 03 / 07 改 import；12 直接用。注意 Agent 03 那份的构造依赖要一并处理
（把「允许列表」作为 token 注入，而不是注入整个 `SourceConfig`）。

### Database Impact / API Impact

无。

### Downstream Impact

Agent 03（改 import）、Agent 07（本模块）、Agent 12（将来直接用）、Agent 14。

---

## 4. ⚠ `common/prisma/bigint-id.ts` 缺 BIGINT 上界（**重申 Agent 03 的 CCR 第 8 项**）

### Current Problem

`toBigIntId()` 只校验「20 位以内的十进制数字」，**没有上界**。
而 Prisma 把 JS `bigint` 按**有符号** 64 位绑定：超过 `2^63-1` 的值
（**包括合法的无符号上限 `18446744073709551615` 本身**）会让驱动抛
`PrismaClientUnknownRequestError`。

后果：`GET /admin/review/18446744073709551615` 返回 **500 而不是 404**，
污染 5xx 告警。

**Agent 03 已经发现并提了 CCR 第 8 项**，它在本模块边界上用 `toSourceId` 绕过了；
**本模块又撞了一次**（真库集成测试抓到），也在边界上用 `toReviewId` 绕过了。

### Requested Change

直接在 `common/prisma/bigint-id.ts` 里补上界，让 `toBigIntId` 自己返回 `null`。
那是 Agent 02 的文件，按 §9 我不越界修改。

### Reason

**同一个洞已经被两个 Agent 各绕过一次。** 每多一个 Agent 用 `toBigIntId`，
就多一份「有人忘了再收一次」的风险 —— 而漏掉的表现是 500 噪声，
不是功能错误，因此更难被发现。

### Compatibility

纯收紧（超界从「抛异常」变成「返回 null」）。**可能影响已有调用方**：
若有地方依赖它抛错（几乎不可能），需要一起改。

### Database Impact / API Impact

无。

### Downstream Impact

Agent 02（改文件）、Agent 03 / 07（删掉本地的绕过版本）、Agent 08 / 09 / 10（受益）。
