# Contract Change Request — Agent 09（收藏 / 阅读进度 / 阅读偏好）

**Agent:** 09
**Module:** Bookmarks / Reading Progress / User Preferences
**日期:** 2026-09-29
**基线:** Development Contract v1.1 / Agent Rule v1.0

> 按 §7：本模块**没有**直接修改任何公共契约。下面每一项都写清了
> 「我暂时怎么绕过的」与「建议怎么改」，都没有阻塞本次交付。

---

## 0. ✅ **已解决**（2026-09-29，`d7b828e`）：`common/prisma/bigint-id.ts` 缺 BIGINT 上界

> **本项与第 5 项已由用户批准后修复**（Agent 09 合并入 main 之后）。
> 下面的原文保留 —— 它是这个洞被重复上报四次的记录，对后来者仍有意义。

**这不是新问题** —— 这是**第四个**被它打到的 Agent。

### Current Problem

`common/prisma/bigint-id.ts`（属 Agent 02）的 `toBigIntId()` 只校验
「20 位以内的十进制数字」，**没有上界**。而 Prisma 把 JS `bigint` 按
**有符号** 64 位绑定：任何超过 `2^63-1` 的值（**包括合法的无符号上限
`18446744073709551615` 本身**）都会让驱动抛 `PrismaClientUnknownRequestError`。

后果：`POST /api/v1/bookmarks/18446744073709551615` 返回 **500 而不是 404**，
污染 5xx 告警 —— 而调用方只是点了一个畸形的链接。

**上报历史**：

| 谁           | 在哪                                               |
| ------------ | -------------------------------------------------- |
| Agent 03     | 其 CCR 第 8 项                                     |
| Agent 07     | 其 CCR 里重申（并自建 `toReviewId`）               |
| **Agent 09** | 本项（`bookmarks` 与 `reading-progress` 各收一次） |

### Requested Change

在 `common/prisma/bigint-id.ts` 里**加一个上界**（3 行）：

```ts
/** Prisma 能安全绑定的上界（有符号 64 位最大值）。 */
export const MAX_BINDABLE_ID = 9_223_372_036_854_775_807n;

export function toBigIntId(value: string): bigint | null {
  if (!BIGINT_ID_PATTERN.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > MAX_BINDABLE_ID ? null : parsed; // ← 新增
}
```

⚠ 这会**改变**已有调用方的行为：Agent 03 / 07 / 09 目前各自在自己的边界上
把它收敛成 `null`（→ 404），所以改完之后它们的行为**不变**（只是去掉了重复）。
这是一个**纯收紧**的改动，不会让任何现有调用从「正常」变成「异常」。

### Reason

四条独立的重复实现（03 的 `toSourceId`、07 的 `toReviewId`、09 的两个）
是这个洞存在的直接成本。而它是**三行**的修复。

### Compatibility

兼容（收紧了非法输入的处置：500 → 404）。**Database Impact：无。**
**Downstream Impact：Agent 03 / 07 / 09 可以删掉各自的本地收敛**（可选）。

---

## 1. ⚠️ `PUT /reading-progress` **没有请求体形状**；`resource_type` 没有枚举

### Current Problem

`docs/04` 的 User 段只写了：

```text
PUT /reading-progress
```

**没有请求体形状**。而 `prisma/schema.prisma` 里
`reading_progress.resource_type` 是 **`VarChar(30)`**，`docs/05` 的枚举清单里
**没有**对应的枚举。于是「允许哪些取值」没有契约可依。

### 本模块的取值（**已实现，请裁决是否写进契约**）

```json
{
  "resourceType": "CONTENT",
  "resourceId": "123",
  "progress": 0.42,
  "lastPosition": "第三章 · 第二节"
}
```

- `resourceType` **V1 只接受 `CONTENT`**，其他值 → 400
  （错误码 `READING_RESOURCE_TYPE_UNSUPPORTED`）。
- `progress` 是**闭区间 `[0, 1]`**（`docs/11`），`NaN` / `Infinity` / 字符串数字都拒。
- `lastPosition` 可选，按**字符**截断到 255（`VarChar(255)`）。
- 响应是更新后的整行（含 `completedAt` / `updatedAt`）。

**为什么不接受任意字符串**：`resource_type` 参与**主键**
（`@@id([userId, resourceType, resourceId])`），任意字符串意味着调用方可以
往库里灌入无界的垃圾键 —— 那些行永远没人读、也不会被清理。

### Requested Change

把上面的请求体形状写进 `docs/04`；并决定
「`resource_type` 是自由字符串还是受控取值集合」——
若是受控，请在 `docs/05` 补一个枚举（例如 `ReadingResourceType`）。

### Compatibility / Database Impact / API Impact

无（新增接口的细节）。**Downstream Impact：Agent 13**（前台要按这个形状写）。

---

## 2. `GET /bookmarks` **没有分页与响应形状**约定

### Current Problem

`docs/04` 只写了 `GET /bookmarks`。`docs/02` 说「Public Feed 使用 Cursor Pagination；
Admin 表格可用 page/pageSize」—— 收藏是**个人列表**，两套都不完全贴合。

### 本模块的取值（**已实现**）

- **cursor 分页**，封套 `{data, meta:{nextCursor}}`（与 `docs/02` 的一致）。
- 游标是**复合的** `{createdAtMillis}-{contentId}`，因为列表按
  `createdAt DESC` 排序而 `createdAt` 是**毫秒精度、并不唯一**
  （用户一次性收藏多条时会撞在同一毫秒）。只拿一个**不参与排序**的字段
  （例如 `contentId`）当游标，翻页会在边界上漏行或重复 —— 而且只在特定数据下出现。
- `limit` 上限 50，越界**夹到边界**（不 400）。
- 每个条目带**内容卡片预览**（title / summary / originalUrl / imageUrl /
  publishedAt / language / source{id,name,slug,type,kind,tier,official}）+
  `contentId` + `createdAt`。
- ⚠ **不**带 `evidenceSummary`（那要算事件证据口径，是内容**详情**的字段）；
  前台要证据链请走 `GET /contents/:id`。

### Requested Change

把「用户个人列表用 cursor 分页 + 复合游标」与响应形状写进 `docs/04`。
并请裁决：**收藏列表要不要过滤掉「内容已被撤下」的收藏**。

本模块的取值是**过滤**（`docs/12`：Public API 不得返回 REJECTED / internal candidate），
但**收藏行本身保留** —— 内容恢复可见后会重新出现。
另一种合理做法是「返回但标记为不可用」。**请裁决。**

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：Agent 13**（收藏页要按这个形状写）。

---

## 3. `PUT /me/preferences` 的语义是「**部分更新**」而动词是 `PUT`

### Current Problem

`docs/04` 写的是 `PUT /me/preferences`。严格 REST 语义下 `PUT` 表示
**整体替换**（没给的字段应当被清空/重置为默认值）。而本模块实现的是
**部分更新**（没给的键不动）。

两者在实际使用上差别很大：用户只改主题时，严格 PUT 会把字号重置回默认。

### Requested Change

二选一：

- **A（我倾向）**：保留路径与动词，但在 `docs/04` 里明确写
  「语义是部分更新（未提供的字段保持不变）」—— 这与 `docs/04` 已经定下的
  路径形态一致，改动最小；
- **B**：改成 `PATCH /me/preferences`（`PATCH` 的部分更新语义是公认的）——
  更规范，但需要通知 Agent 13 与 Agent 12。

**在契约明确之前**，本模块按 A 实现（并在 HANDOFF 里记录了这个取舍）。

### Compatibility

若选 B 则是**破坏性变更**（路径变了）。**Downstream Impact：Agent 12 / 13。**

---

## 4. 建议：`CONTENT_NOT_VISIBLE` 应被 Agent 10 / 13 复用

### Current Problem

本模块新增了 `CONTENT_NOT_VISIBLE`（404），语义是
「内容不存在 **或** 存在但未 `APPROVED`」—— 两者返回**同一个**码是**故意的**
（否则「加收藏」这个接口会变成一个「某 id 是否存在 / 是否被撤下」的探测器）。

而 `docs/12` 的可见性规则（Public API 不得返回 REJECTED / internal candidate）
对 Agent 10 的公开读同样成立 —— 它会需要**同一个**语义的码。

### Requested Change

把它登记为**跨模块的可见性错误码**（而不是「Agent 09 的收藏专用码」），
并在 `docs/04` 的可见性说明里引用它。这样 Agent 10 的
`GET /contents/:id` 对不可见内容返回 404 时用同一个码，前台可以统一处理。

⚠ 请顺便裁决：它与 Agent 06 的 `AI_CONTENT_NOT_FOUND` 是否构成
`docs/05` 所禁止的「同义码」。

**本模块的判断是「不构成」**：那个是 AI 任务的载荷指向了库里**不存在**的内容
（只表示不存在，且是内部任务上下文）；这个是**对外可见性**的判定结果
（涵盖「不存在」与「存在但未审核」两种）。两者主体与语义都不同。
**但这一条只有契约 Owner 能定，所以我提出来。**

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：Agent 10**（可复用）。

---

## 5. ✅ **已解决**（2026-09-29，`d7b828e`）：测试文件的类型错误对 CI **不可见**

> **已修**：根 `verify` 改为 `... && pnpm -r typecheck && ...`，8 个既有错误也一并修掉了。
> 下面的原文保留（它是这个洞复现两次的记录）。

### 原文

### Current Problem

- 根 `typecheck` = `tsc -b && pnpm --filter @signal/web run typecheck`
  —— **不检查任何测试文件**。
- 而 `apps/api` 与 `apps/worker` **各自**有 `typecheck` 脚本会跑
  `tsc -p test/tsconfig.json`，`pnpm verify` **从不调用它们**。

后果：**测试文件的类型错误只在有人手动跑那条命令时才会出现**。
Agent 07 记录过这个洞（当时 `apps/api` 有 5 个既有错误）。

**本次实测**：Agent 09 跑了一遍，抓到 **10 个**：

```text
Agent 08 遗留（9 个，均在 apps/api）：
  daily-preflight-parity.spec.ts   ×5  字符串字面量赋给 DailyDisplayStyle
  daily-public-view.spec.ts        ×4  字符串字面量赋给 SourceKind / SourceTier
Agent 08 遗留（1 个，在 apps/worker）：
  publishing-db.integration.spec.ts ×1  string 赋给 EditorialReviewStatus
```

**全部已修**（Agent 09 顺手修的 —— 它们是**已合并进 main 的**文件里的错误，
而根 `verify` 报绿，属于「绿得不对」）。另有 **8 个既有错误**未修：

```text
apps/api/test/sources-api.spec.ts              ×5   Agent 03（SourceRepository.rows 不存在）
apps/worker/test/collectors-db.integration.spec.ts     ×1   Agent 04
apps/worker/test/collectors-di-wiring.spec.ts          ×1   Agent 04（WORKER_SRC 未定义）
apps/worker/test/collectors-queue.integration.spec.ts  ×1   Agent 04
```

### Requested Change

在根 `verify` 里加上这两个 typecheck（或让根 `typecheck` 收敛到
`pnpm -r typecheck`）：

```json
"verify": "pnpm lint && pnpm -r typecheck && pnpm test"
```

并修掉上面那 8 个既有错误。**这是一条会持续复发的洞** —— 每个 Agent 都可能
往测试里写类型错误而不自知（本项目已经发生两次）。

### Compatibility

无。**Database Impact / API Impact：无。**
**Downstream Impact：所有 Agent**（提交前会多一条必过的检查）。

---

## 汇总：哪些影响下游

| 项                                    | 影响                    | 是否阻塞                |
| ------------------------------------- | ----------------------- | ----------------------- |
| 0. `toBigIntId` 缺上界（第四次）      | Agent 02 / 03 / 07 / 14 | ❌ 不阻塞（各自已绕过） |
| 1. `PUT /reading-progress` 请求体形状 | **Agent 13**            | ❌（实现已可用）        |
| 2. `GET /bookmarks` 分页与响应形状    | **Agent 13**            | ❌                      |
| 3. `PUT /me/preferences` 的 PUT 语义  | Agent 12 / 13           | ❌（按 A 实现）         |
| 4. `CONTENT_NOT_VISIBLE` 跨模块复用   | Agent 10                | ❌                      |
| 5. 测试类型检查的洞                   | **所有 Agent**          | ❌                      |

**没有一项阻塞本次交付。**
