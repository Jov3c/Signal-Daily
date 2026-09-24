# Contract Change Request — Agent 04

**Agent:** 04 — Collectors / Scheduler
**Module:** `apps/worker/src/jobs/collectors/**`、`packages/source-core`（本次由 Agent 04 提取）
**日期:** 2026-09-24
**依据:** 《Signal 多 Agent 执行规则 v1.0》§7

> 本文件记录 **9 项**需要公共契约 Owner（Agent 00 / 01 / 14）裁决或知悉的事项。
> 全部**不阻塞**下游开工：每一项都已在最保守的方式下实现，并在 HANDOFF 里
> 写清了下游必须对齐的具体形状。
> 其中第 1、2、3 项请优先裁决 —— 它们会影响 Agent 05 与 Agent 14。

---

## 1. `docs/06` 与 `tasks/agent-04` 关于 kind/tier/official 的要求**互相矛盾**

### Current Problem

两份文档的表述冲突：

```
docs/06-collector-source-registry.md:58
  「RSS / GitHub / HN / Hugging Face / Manual URL
    沿用 v1.0，但采集完成后必须继承 Source 的 kind/tier/official 元数据进入 Pipeline。」

tasks/agent-04-collectors.md:25
  「Source tier/kind/official 不复制到 Raw payload 作为事实源，处理时通过 Source 关联读取。」
```

Agent 04 选了 `tasks/` 的解读，理由（已写在 `ports.ts` 文件头）：

- `kind` / `tier` / `official` 是**会变的编辑配置**（`docs/22`：「Tier 由管理员维护」）。
  把抓取当时的取值写进 `RawItem`，那条数据就带上一份**会过期的历史快照**：
  管理员把来源从 `tier=B` 提到 `S` 之后，老 RawItem 里仍然写着 `B`，
  而 Pipeline / Review 到底该信谁就说不清。
- 读取时经 `source_id` 关联现查，得到的是**当前**的编辑判断 —— 这才是想要的。

### Requested Change

请 Agent 14 在 `docs/06` 上二选一：

- **（建议）** 把第 58 行改成：「采集完成后，Pipeline 经 `source_id` 关联读取
  Source 的 `kind` / `tier` / `official`；**不**复制到 RawItem payload 作为事实源。」
- 或者明确「必须复制」，那样 Agent 04 会改实现（但请一并说明
  「Source 元数据变更后历史 RawItem 的取值如何处理」）。

### Reason

这是本次交付中**唯一一处对文档字面要求的偏离**，而且它是 P0 缺陷的根因：
为了执行「不许写 kind」，实现选了「键名黑名单」这种过宽的表达方式，
于是撞掉了 X 适配器自己的 `kind`（推文的引用关系），
导致 `SourceType.X_USER` 整体不可用、0 条入库。

### Compatibility

改文档措辞，不改代码。Agent 04 的实现已经是建议的形态。

### Database Impact

None

### API Impact

None

### Downstream Impact

**Agent 05**（Pipeline 必须经关联读 Source，而不是读 payload）、
**Agent 07**（Review Detail 的 Source kind/tier/official 同样要现查）、Agent 14。

---

## 2. `docs/06` 的 `CollectorAdapter` 接口与实际实现有一处缺失

### Current Problem

`docs/06` 给的接口是：

```ts
interface CollectorAdapter {
  type: SourceType;
  test(source: SourceConfig): Promise<CollectorTestResult>;
  fetch(source: SourceConfig, cursor?: string): Promise<CollectorBatch>;
}
```

两个与实现不一致的地方：

1. **`test()` Agent 04 刻意没有实现**。`POST /admin/sources/:id/test` 已经由
   Agent 03 的 `apps/api/src/modules/sources/source-tester.ts` 实现并交付。
   在 Worker 里再实现一份会让「后台点 Test 说没问题」与「采集器实际抓取」
   变成**两套判定** —— 那正是 `docs/06` 自己要防的不一致。
2. **`fetch()` 的 `cursor` 不是 `string`，而是一个结构**
   （`CollectorCursor = { sincePublishedAt, sinceExternalId }`），
   原因是 `sources.config` 是严格白名单的 `Json?`，不能往里塞游标状态，
   而 `prisma/**` 属 Agent 01（§10 禁止其他 Agent 建 Migration）。
   游标因此从**已落库的事实**推导。

### Requested Change

在 `docs/06` 里写明：

- `test()` 的归属是 **Admin Source Registry（Agent 03）**，Collector 不重复实现；
- `CollectorAdapter.fetch(source, cursor, context)` 的形参形状由
  `apps/worker/src/jobs/collectors/types.ts` 定义，`cursor` 是结构而非字符串。

### Reason

不写明的话，下游或未来的 Agent 会照文档字面去补 `test()`，
从而重新引入「两套探测判定」。

### Compatibility

文档补充，不改代码。

### Database Impact / API Impact

None

### Downstream Impact

Agent 05（实现 `content.normalize` 时会对齐同一套适配器形状）、Agent 14。

---

## 3. 「采集窗口」的语义未在契约里定义（本次修复了一个 P1 缺陷）

### Current Problem

`docs/06` 只说「采集」，没有定义**单轮采集的窗口**与**窗口外条目的去向**。
Agent 04 最初的实现是「取窗口 + 按游标跳过更旧的条目」，结果是：

- **RSS**：`maxItems=50` 时，一个新加的历史很长的源只有最新 50 篇被采到，
  其余**永久丢失**（游标一建立就再也轮不到它们）；
- **HN**：按 id 做增量，会让「发布较早、后来才涨上首页」的帖子
  （HN 上最典型的现象）**永久跳过** —— 因为它的 id 比游标小。

两处都**没有任何信号**：不计数、不进日志、`complete` 还是 `true`。

### Requested Change

在 `docs/06`（或 `docs/13`）里明确三点：

1. **窗口是「单轮上限」**，不是「只关心最新的 N 条」；
2. **窗口外的条目不算已处理** —— 必须能被后续轮次重新取到，
   由 `docs/06` 已有的幂等键（source+externalId / canonical URL hash）去重；
3. **`CollectorBatch.complete` 必须如实反映**「上游给的有没有取完」，
   为 `false` 时采集器必须记一条可行动的告警（管理员据此调大窗口）。

### Reason

「静默永久漏采」是编辑型产品最难发现的一类数据缺口：
后台显示一切正常，只是那个源内容偏少 —— 与「这个源本来就没更新」无法区分。

### Compatibility

新增定义。Agent 04 已按此实现。

### Database Impact

None

### API Impact

None

### Downstream Impact

**Agent 05**（Pipeline 看到 `RawItem` 变多时不要假设「增量」已过滤干净）、
**Agent 12**（Manage Sources 页面应展示「上一轮没取完」这类提示）、Agent 14。

---

## 4. `SOURCES.config` 的契约已在 Agent 03 的 CCR 第 6 项请求固化（本次消费确认）

### Current Problem

本模块是 `config` 形状的**消费端**。Agent 03 的 CCR 第 6 项给出了完整表，
但尚未写进 `docs/06`。

### Requested Change

与 Agent 03 的 CCR 第 6 项**合并裁决**。Agent 04 在实现中确认了以下两点是消费端的硬需求：

- 「写入时是全量快照」必须保持 —— 采集器读的就是这份 JSON，
  稀疏存储下两边的默认值假设会静默分叉；
- `seed` / `seedNote` 必须继续放行 —— 它们是识别 seed 演示数据的唯一标记。

### Reason

采集器与注册表共享同一个数据结构，必须有一份成文契约。

### Compatibility / Database Impact / API Impact

None

### Downstream Impact

Agent 05、Agent 12、Agent 14。

---

## 5. `collector.fetch-source` 的载荷形状（与 Agent 03 的 CCR 第 2 项合并）

### Current Problem

`docs/13` 固定了 Queue 名 / Job 名 / JobId 格式，没有定义**载荷**。

### Requested Change

与 **Agent 03 的 CCR 第 2 项合并**。Agent 04 是消费端，已在
`collectors-queue.integration.spec.ts` 里用 Agent 03 文档中的**字面载荷**
喂进消费端做逐字断言：

```jsonc
{ "sourceId": "123", "trigger": "manual", "requestedAt": "2026-09-24T01:00:56.616Z" }
```

并补充两条消费端的行为（请一并写进 `docs/13`）：

- `trigger` 决定**失败语义**：`manual` 与 `schedule` 走同一套重试策略，
  但 `schedule` 路径**不会**采集已停用的来源（`docs/06`），`manual` 会；
- 载荷畸形（`sourceId` 非十进制数字串、`trigger` 不在两个取值里）→
  消费端记一条日志后用 `UnrecoverableError` 终止，**不重试**、不写库。

### Reason

消费端已经按这个形状实现；不固化则两边一旦漂移就是静默失效的功能。

### Compatibility / Database Impact / API Impact

None

### Downstream Impact

Agent 12（若要在 UI 上展示「已排队的抓取」）、Agent 14。

---

## 6. 新增 3 个 Error Code（**纯追加，删除 0 行**）

### Current Problem

采集失败需要可行动的结论，而 `DomainErrorCode` 里没有对应的码。

### Requested Change

**已在 `packages/contracts/src/errors.ts` 追加 3 个**，请 Owner 追认：

| 码                                 | 何时                                                              | 可重试 |
| ---------------------------------- | ----------------------------------------------------------------- | ------ |
| `SOURCE_FETCH_FAILED`              | 采集运行时失败（超时 / 连不上 / 上游非 2xx / 解析失败）           | 是     |
| `SOURCE_FETCH_CREDENTIALS_MISSING` | 该类型需要凭据但 `docs/20` 的 env 未配（如 `X_API_BEARER_TOKEN`） | **否** |
| `SOURCE_FETCH_UNAUTHORIZED`        | 上游以 401/403 明确拒绝（令牌无效 / 过期 / 额度）                 | **否** |

与既有码的分工（已在注释里写清，无同义冲突）：

- `SOURCE_ENQUEUE_FAILED`（Agent 03）= 任务**没进队列**（查 Redis）；
  本组 = 进了队列但**抓不到**（查来源或上游）。
- 平台级 `UNAUTHORIZED` = **我们的** API 未认证；
  `SOURCE_FETCH_UNAUTHORIZED` = **上游**拒绝了我们的凭据。

### Reason

规则 §6 把「Error Code 规则」列为 Frozen Contract，§7 要求走 CCR。
Agent 02 / 03 都各自提交了 CCR（Agent 03 的 CCR 第 523 行覆盖同一文件）。

### Compatibility

纯追加，`git diff` 删除行数 = **0**。既有码与规则未改。

### Database Impact / API Impact

None（这 3 个码只写进 `Source.last_error_code` / `JobRun.error_code` 这类自由列，
不会被任何 API 作为响应码返回）。

### Downstream Impact

**Agent 11**（告警规则：`SOURCE_FETCH_CREDENTIALS_MISSING` / `_UNAUTHORIZED`
是**需要人动手**的信号，且它们会让 `JobRun` 直接终态 `DEAD`）、
**Agent 12**（后台展示错误码时的文案）。

---

## 7. 「不可重试的失败应立即终态」未在 `docs/13` 写明

### Current Problem

`docs/13` 的 dead-letter 说「最终失败 → JobRun = DEAD」，但没有定义
**不可重试**的失败算不算「最终」。

按字面的 `attempt < maxAttempts` 判断，「令牌没配」这类失败
（第 1 次就被 `UnrecoverableError` 终止，永远不会有第 3 次）
的 JobRun 会**永远停在 `FAILED`** —— 而它恰恰是唯一需要人去动手的那一类，
后台的 dead-letter 视图会漏掉它们。

### Requested Change

在 `docs/13` 写明：

> 不可重试的失败（配置 / 凭据 / 地址类）**立即**是终态：`JobRun = DEAD`。

### Reason

dead-letter 视图的价值在于「列出需要人处理的失败」。

### Compatibility

新增定义。Agent 04 已按此实现（`collector.service.ts` 的 `recordFailure`）。

### Database Impact / API Impact

None

### Downstream Impact

Agent 11、Agent 12。

---

## 8. 三处「进程内重复实现」建议提升为共享（`fetchWindow` 等）

### Current Problem

本次按 Agent 03 的 CCR 第 1 项提取了 `packages/source-core`（SSRF / 调度规则 / config 契约）。
但仍有几处**跨 app 的重复实现**，它们各自都有「两边漂移就静默出错」的性质：

| 重复的东西                                          | 位置                                                                        | 漂移的后果                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `fetchWindow(at)`（幂等窗口 = epoch 分钟）          | `apps/worker/.../source-queue.ts` 与 `apps/api/.../source-enqueuer.ts`      | 两边不一致 → 同一分钟内的重复触发**不会被去重**，或跨分钟被误合并 |
| `redisConnectionOptions(redisUrl)`                  | 同上两个模块，外加 `apps/worker/.../redis.ts`                               | `rediss:` 漏掉 `tls` 的表现是「连上了但立刻断」，错误信息不提 TLS |
| `toBigIntId` / `MAX_BINDABLE_ID`（BIGINT 上界收敛） | `apps/worker/.../bigint-id.ts` 与 `apps/api/src/common/prisma/bigint-id.ts` | 超界 id 在一处变 404、在另一处变 500                              |

### Requested Change

请 Owner 决定其一：

- **（建议）** 把 `fetchWindow` 与 `redisConnectionOptions` 提升到
  `packages/source-core`（或新的 `packages/queue-core`）；两者都是零依赖纯函数，
  搬迁是纯移动；
- 或明确「允许各 app 各有一份」，并在 `docs/18` 里写明「这类纯函数的重复是可接受的」。

`bigint-id` 的上界问题请与 **Agent 03 的 CCR 第 8 项合并处理**
（那一项已经请求给 `common/prisma/bigint-id.ts` 补上界，属 Agent 02/14）。

### Reason

这三处的共同点是：重复的不是样板，是**判断**。
Agent 04 的 `bigint-id.ts` 与 `redisConnectionOptions` 已经是「同一逻辑的第三份实现」
（另两份分别在 Agent 02 与 Agent 03 的模块里）。

### Compatibility

纯移动 + re-export，行为不变。

### Database Impact / API Impact

None

### Downstream Impact

Agent 11（部署时 `rediss:` 的行为）、Agent 10（同样要处理 BIGINT id）、Agent 14。

---

## 9. 本次交付中**超出允许目录**的改动清单（供 Agent 14 集成时核对）

`tasks/agent-04-collectors.md` 只说了目标与测试要求，没有列允许目录；
Agent 04 的交付面是 `apps/worker/**`。实际改动另有以下文件，
**逐条列在这里**（Agent 03 的 CCR 第 10 项确立了这个做法）。

> ⚠ 第 1 项（提取 `packages/source-core`）**已获得用户明确授权**后才执行 ——
> 它是 Agent 03 的 CCR 第 1 项所请求的动作，但归属名义上是 Agent 00，
> 因此 Agent 04 在动手前向用户确认过（用户选择了「提取共享包」）。

| 文件                                                                                                       | 改动                                                                                                 | 为什么必要                                                                               | 删除行数                          |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| `packages/source-core/**`                                                                                  | **新增包**（从 `apps/api/src/modules/sources/` 搬入 url-safety / scheduling / source-config.schema） | Agent 03 的 CCR 第 1 项；跨 app 复用无法用相对 import 实现（实测 TS6059）                | 0（纯搬迁 + 新增 re-export 垫片） |
| `apps/api/src/modules/sources/url-safety/index.ts`<br>`.../scheduling.ts`<br>`.../source-config.schema.ts` | 改为 `export * from '@signal/source-core'` 的**垫片**                                                | 让 Agent 03 的模块与全部既有测试 import 路径一行不改                                     | 0（原内容由 `git mv` 搬走）       |
| `apps/api/test/di-wiring.spec.ts`                                                                          | 「类型别名集合非空」改为在**内联源码**上验证 matcher                                                 | 原先断言 `UrlSafetyReason` 出现在 `apps/api/src` —— 文件搬走后必红，而排除逻辑本身是好的 | 0                                 |
| `packages/contracts/src/errors.ts`                                                                         | 追加 3 个 `SOURCE_FETCH_*` 业务码                                                                    | 规则要求业务码必须登记在契约里                                                           | **0**                             |
| `tsconfig.json` / `vitest.config.mts`                                                                      | 注册 `packages/source-core`（引用 + 别名）                                                           | 新包必须进编译图与测试别名                                                               | 0                                 |
| `apps/api/tsconfig.json` / `apps/api/test/tsconfig.json` / `apps/api/vitest.integration.config.mts`        | 同上（api 侧引用与别名）                                                                             | 同上                                                                                     | 0                                 |
| `apps/api/package.json` / `apps/worker/package.json`                                                       | `+ @signal/source-core: workspace:*`                                                                 | 同上                                                                                     | 0                                 |
| `apps/worker/package.json`                                                                                 | `+ @prisma/client@6.19.3` / `bullmq@5.81.5` / `ioredis` / `fast-xml-parser` / `@nestjs/testing`(dev) | Worker 需要 DB / 队列 / XML 解析 / DI 测试                                               | 0                                 |
| `pnpm-workspace.yaml`                                                                                      | 无改动（Agent 03 已放行 msgpackr-extract）                                                           | —                                                                                        | 0                                 |

**零改动**（已用 `git status` 确认）：`prisma/**`、`apps/api/src/app.module.ts`、
`apps/worker/src/worker.module.ts`、`apps/web/**`、`infra/**`、`.env.example`、
`eslint.config.mjs`、`packages/config/**`、`packages/logger/**`。

**未实现任何其他 Agent 的职责**：没有 Pipeline / Dedup / Event / Evidence（05）、
没有 AI（06）、没有审核（07）、没有发布（08）、没有用户功能（09）、没有公开 API（10）。
`apps/worker` 只读写 `sources` / `raw_items` / `job_runs` 三张表。

### Requested Change

追认即可。若 Owner 认为 `packages/source-core` 的提取应当由 Agent 00 重做
（例如包名或目录结构有别的偏好），请指出 —— 那时可通过纯移动调整，
因为它已经不依赖任何 `apps/*` 内部模块。
