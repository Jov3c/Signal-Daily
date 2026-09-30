# Contract Change Request — Agent 10（搜索 / Public Read / Evidence Summary）

**Agent:** 10
**Module:** Public Read / Search
**日期:** 2026-09-30
**基线:** Development Contract v1.1 / Agent Rule v1.0

> 按 §7：本模块**没有**直接修改任何公共契约。下面每一项都写清了
> 「我暂时怎么绕过的」与「建议怎么改」，都没有阻塞本次交付。

---

## 1. ⚠️ `docs/04` 的 Public 段**只给了路径**，没给形状

### Current Problem

`docs/04` 的 Public 段是一串裸路径（`GET /today`、`GET /search?q=`…），
除了 `GET /contents/:id` 列了「必须返回」的字段之外，**没有任何响应形状、
分页方式、封套约定**。而 `contracts/openapi-outline.yaml` 也只写到
`responses: {'200': {description: ...}}` 这一层。

本模块要为 10 条路由定形状，其中 4 条完全没有依据。

### 本模块的取值（**已实现**）

```text
GET /today        → {data: {businessDate, featured: PublicContent[], latest: PublicContent[]}}
                    featured = 当日 finalScore >= 70 的前 10 条（门槛同 docs/08 的「推荐」档）
                    latest   = 当日最新 20 条
                    窗口 = **上海业务日**（businessDayRangeUtc）

GET /contents/:id → {data: PublicContent}   （逐字对齐 contracts 的 PublicContent）
GET /contents/:id/evidence
                  → {data: {contentId, eventId|null, evidence: PublicEvidence[]}}
                    evidence 的字段：id / evidenceType / title / url / publishedAt /
                    isPrimary / source（**不含** urlHash / confidence / contentId）

GET /x            → {data: PublicContent[], meta: {nextCursor}}   （cursor 分页）
GET /people       → {data: (PublicPerson & {contentCount})[]}
GET /people/:slug → {data: (PublicPerson & {contentCount, contents: PublicContent[]})}
GET /topics       → {data: (PublicTopic & {contentCount})[]}
GET /topics/:slug → {data: (PublicTopic & {contentCount, contents: PublicContent[]})}
GET /sources/:slug→ {data: (PublicSource & {baseUrl, contentCount, contents})}

GET /search       → {data: PublicContent[], meta: {total, limit, offset}}
                    **offset 分页**，不是 cursor
```

### Requested Change

把上面这张表写进 `docs/04`（与实现逐字一致，已有路由表守卫钉住条数）。

### Reason

Agent 13 的前台要按这些形状写页面。没有契约，它只能对着实现猜 ——
而「猜」在本项目里已经被证明会分叉（Agent 08 的 Admin 路由表是同一个情况）。

### Compatibility / Database Impact / API Impact

无（都是新增路由）。**Downstream Impact：Agent 13**（主要）、Agent 12。

---

## 2. ⚠️ 搜索为什么用 **offset** 而不是 cursor

### Current Problem

`docs/02` 说「Public Feed 使用 Cursor Pagination」。但搜索**无法**用游标：

FULLTEXT 的排序是 `MATCH(...) AGAINST(...)` 算出来的**相关度**，
它不是一个稳定的列值。要给它做游标，只能把相关度当游标存下来 ——
而相关度会随数据集变化（新增一条内容就可能改变已有结果的分数），
那样的游标比 offset 更脆。

### 本模块的取值（**已实现**）

`{data, meta: {total, limit, offset}}`，`offset` 由调用方传。

### Requested Change

在 `docs/02` 或 `docs/04` 里写明：「搜索是 offset 分页的**例外**，理由是
相关度不是稳定列」。否则将来会有人「为了统一」把它改成 cursor。

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：Agent 13。**

---

## 3. ⚠️ `docs/12` 给了缓存**键**却没给 **TTL**

### Current Problem

`docs/12` 列了 8 个键（`v1:today` / `v1:featured:…` / …），
**一个 TTL 都没给**。而 TTL 直接决定一个产品行为：
「管理员在后台把内容撤下之后，前台还会展示多久」。

### 本模块的取值（**已实现**）

| 键                                   | TTL        | 理由                                                                                                 |
| ------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------- |
| `content:*` / `evidence:*` / `today` | **60 秒**  | 内容会被 Agent 07 撤下（`REJECTED`），撤下必须尽快生效 —— 缓存太久等于「后台点了撤下、前台还在展示」 |
| `people` / `topics` / `x:*`          | **300 秒** | 人物/主题元数据几乎不变；X 流按时间倒序，慢 5 分钟无感                                               |

### Requested Change

把两档 TTL 写进 `docs/12`，或明确说「由实现决定」。

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：Agent 11**（运维要知道缓存的最长陈旧时间）。

---

## 4. ⚠️ `docs/12` 的 8 个键里有 2 个**没有实现**（属 Agent 08）

### Current Problem

`docs/12` 列了 `v1:featured:{topic}:{cursor}` 与 `v1:daily:{date}`，
但它们对应的路由（`GET /featured`、`GET /daily/:date`）由 **Agent 08** 实现，
而 08 的模块**不缓存**。

于是「契约里写了的缓存键」有 2/8 是空的。

### Requested Change

二选一：

- **A**：`docs/12` 里标注这两个键「V1 未实现」；
- **B**：让 Agent 08 的模块接上缓存（需要它 `imports` 本模块的 `PublicCache`）。

**我倾向 A**：`GET /featured` 与 `GET /daily/:date` 的查询代价很低
（一个索引扫描 + 一个 join），缓存它们带来的复杂度大于收益。
而那 8 个键是**设计意图清单**，不必等于「都必须实现」。

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：Agent 08 / 14。**

---

## 5. ⚠️ `docs/12` 的「主动 invalidation」缺一个**跨模块的触发点**

### Current Problem

`docs/12`：

```text
Event Evidence 发生人工修改时主动 invalidation。
```

而人工修改证据的接口属 **Agent 07**（`/admin/events/:id/evidence/*`），
本模块**不允许**改它的代码（§9）。所以这个「主动失效」目前**没有调用点**。

本模块已经提供了实现（`invalidateEventEvidence(cache, eventId)`，
从 `modules/public-read/index.ts` 导出），并且有 **60 秒 TTL 兜底** ——
所以「忘了接」的后果是最多 60 秒的陈旧，不是永久错误。

### Requested Change

请 **Agent 14** 在集成阶段把 Agent 07 的证据变更接口接到它：

```ts
// Agent 07 的 evidence.service.ts 里每次变更之后
await invalidateEventEvidence(cache, eventId);
```

或者由 Agent 07 自己接（那需要它 `imports: [PublicReadModule]`，
会引入一个 api 内部的模块依赖 —— 由 Agent 14 判断哪种更合适）。

⚠ **`invalidateEventEvidence` 只能删证据链的键**，删不掉「该事件下所有内容的
详情缓存」（缓存里没有 event→content 的反向索引），那一部分靠 TTL 兜底。
若产品上要求「撤下后立即全网生效」，那需要：
（a）缓存里维护反向索引，或（b）不用缓存。**请裁决是否需要。**

### Compatibility / Database Impact / API Impact

无。**Downstream Impact：Agent 07 / 14。**

---

## 汇总：哪些影响下游

| 项                     | 影响              | 是否阻塞          |
| ---------------------- | ----------------- | ----------------- |
| 1. Public 段的响应形状 | **Agent 13** / 12 | ❌（实现已可用）  |
| 2. 搜索用 offset 分页  | Agent 13          | ❌                |
| 3. 缓存 TTL 未定义     | Agent 11          | ❌                |
| 4. 2 个缓存键未实现    | Agent 08 / 14     | ❌                |
| 5. 主动失效缺触发点    | **Agent 07 / 14** | ❌（有 TTL 兜底） |

**没有一项阻塞本次交付。**
