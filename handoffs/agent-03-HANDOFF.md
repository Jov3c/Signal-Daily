# Handoff

**Agent:** 03 — Source Registry / X 白名单
**Wave:** 1（上游：Agent 00、Agent 01、Agent 02）
**日期:** 2026-09-24
**提交:** `84214d3` `22d9dd9` `917388b` `0d2ee19` `3306ed1` `a496ea2` `967df9d`
**基线:** Development Contract v1.1 / Frontend Prototype v1.7 / Agent Rule v1.0
**允许修改:** `apps/api/src/modules/sources/**`

> ⚠ **先读文末的「补遗（§23 独立审查）」再看正文结论。**
> 正文记录交付时的实现与验证；补遗记录两轮独立审查在「全绿」状态下查出的
> **2 个 P2 + 2 个 P3 + 6 个 P4**，以及它们的修复与**下游必须注意的破坏性变更**。
> 审查由**两个没有本次开发上下文**的独立执行者完成（安全向 / 工程向），
> 原始产物在 `work/_agent03/` 与 `work/_agent03/review-eng/`。

---

## Task

`tasks/agent-03-sources.md`：

- Source CRUD、启停、`test`、`fetch-now`
- 把 X 动态账号管理纳入同一个 Source Registry（`type=X_USER` 即白名单实体）
- `SourceType` / `SourceKind` / `SourceTier` / `official` / `priority` / `trustScore`
- **type-specific config validation**
- **SSRF 验证器必须可供 Collector 复用**

**V1 没有用户订阅**（规则 §13）。`type=X_USER` 只是后台白名单实体，
不存在用户自己的 X follow list。

---

## Implemented

### 1. Admin Source Registry —— 8 条路由，逐字等于 `docs/04`

| 方法  | 路径                                  | 状态码                        |
| ----- | ------------------------------------- | ----------------------------- |
| GET   | `/api/v1/admin/sources`               | 200（`OffsetEnvelope` 分页）  |
| POST  | `/api/v1/admin/sources`               | **201**                       |
| GET   | `/api/v1/admin/sources/:id`           | 200                           |
| PATCH | `/api/v1/admin/sources/:id`           | 200                           |
| POST  | `/api/v1/admin/sources/:id/enable`    | 200（幂等）                   |
| POST  | `/api/v1/admin/sources/:id/disable`   | 200（幂等）                   |
| POST  | `/api/v1/admin/sources/:id/test`      | **200**（成功与失败都是 200） |
| POST  | `/api/v1/admin/sources/:id/fetch-now` | **202**                       |

`docs/04` 里**没有 DELETE**，所以「增删改查」不含删除 —— 这是对的，不是漏做。
`docs/09` 要求的「X 账号 Filter/Tab」就是 `GET /admin/sources?type=X_USER`，不需要新端点。

### 2. SSRF 防护（三层，`url-safety/`）—— 本模块最重要的产物

| 层     | 文件            | 做什么                                                                        |
| ------ | --------------- | ----------------------------------------------------------------------------- |
| ① 语法 | `url-safety.ts` | 只允许 http(s)；拒绝 URL 内嵌凭据与端口 0；把**归一化后**的 hostname 判黑名单 |
| ② IP   | `ip.ts`         | IPv4 各类伪装写法；IPv6 用 **`2000::/3` 白名单**而不是枚举坏前缀              |
| ③ 取数 | `safe-fetch.ts` | **DNS 全地址校验** + **逐跳重定向再校验** + 超时/体积上限（流式边读边停）     |

判定依据全部来自**实测**而非假设（`work/_agent03/probe-url-normalization.mjs`）：

- `2130706433` / `0x7f000001` / `017700000001` / `127.1` 都被 WHATWG 归一化成 `127.0.0.1`
- **`localhost.` 的尾点会被保留** —— 不去尾点就会漏
- `::ffff:127.0.0.1` 归一化成 `[::ffff:7f00:1]`，点分四段没了，必须自行解出内嵌 IPv4
- DNS 查 `localhost` 返回**两条**（`::1` 与 `127.0.0.1`）—— 只校验第一条就是漏洞

### 3. 类型化 config 校验

每种 `SourceType` 有**严格白名单**（未声明的键一律拒绝，
防止 `includeQuotes` 敲成 `includQuotes` 后静默生效）。完整表见
`CONTRACT_CHANGE_REQUEST-agent-03.md` 第 6 项。

写入时是**全量快照**（该类型的全部已声明键都显式写下，含默认值），
不是「只写偏离默认值的键」—— 因为 Collector 读的就是这份 JSON，
稀疏存储下两边默认值假设不一致会让采集行为静默变化。

### 4. 调度规则（`scheduling.ts`）—— 给 Agent 04 共用

`buildDueSourcesWhere(now)` / `DUE_SOURCES_ORDER_BY` / `computeNextFetchAt`。
过滤与排序**只有这一份实现**，内存替身也是直接解释这个规则对象。

### 5. 入队（`source-enqueuer.ts`）

真实 BullMQ → `collector` 队列，Job 名 `collector.fetch-source`，
JobId 用契约的 `JobId.collectorFetchSource(sourceId, window)`（window = epoch 分钟）。

### 6. `test` —— 真实出网探测

按类型拼目标（X 官方 API / GitHub API / HF API / HN API / RSS feed / Manual URL），
用 `safeFetchText` 取数并判定。**失败是诊断结论**（`{ok:false, message}` + HTTP 200），
不是 HTTP 错误 —— 只有「来源不存在」才是 404。

### 7. Admin Origin 校验（`admin-origin.guard.ts`）

`docs/14` 要求「敏感 Admin mutation 进行 Origin check + CSRF token」，
Agent 02 的 HANDOFF 把 `/admin/*` 这块留给 03/07/12。本模块实现了 **Origin check**：
变更类请求**带了** `Origin` 就必须匹配 `APP_BASE_URL` / `API_BASE_URL` 的 origin，
**不带**则放行（curl / 运维脚本不该被打死）。CSRF token 未做，见 Known Limitations。

---

## Files Added

```
apps/api/src/modules/sources/
  module.ts  controller.ts  service.ts  clock.ts
  repository.ts              端口 + BIGINT 边界（toSourceId / MAX_BINDABLE_ID）
  prisma-source.repository.ts
  source.config.ts           env 视图（不新增 env）
  source-config.schema.ts    六种类型的 config 校验
  scheduling.ts              ★ 零依赖，Agent 04 共用
  source-enqueuer.ts         BullMQ 入队（含入队超时）
  source-tester.ts           真实探测
  admin-origin.guard.ts      ★ Origin check
  dto/source.dto.ts
  url-safety/                ★ 零依赖子目录，Agent 04 必须复用
    index.ts  ip.ts  url-safety.ts  safe-fetch.ts

apps/api/test/
  sources-url-safety.spec.ts          (149)
  sources-api.spec.ts                 (67)
  sources-config.spec.ts              (46)
  sources-tester.spec.ts              (32)
  sources-scheduling.spec.ts          (25)
  sources-db.integration.spec.ts      (19)  真 MySQL
  sources-queue.integration.spec.ts   (6)   真 Redis + BullMQ
  support/source-fakes.ts             内存替身（忠实复刻规则对象）
  support/sources-test-app.ts         真实链路测试装配

handoffs/agent-03-HANDOFF.md
handoffs/CONTRACT_CHANGE_REQUEST-agent-03.md   (10 项)
```

工作脚本（不属于交付物，在 `work/_agent03/`）：
`probe-url-normalization.mjs`（URL 归一化事实探针）、
`probe-dist-sources.mjs`（进程级 E2E）、`counterproof-agent03.py`（63 条反证）、
`repro-bigint-bound.mjs` / `repro-malformed-location.mjs`（审查发现的复现）。

## Files Modified

```
packages/contracts/src/errors.ts       仅**追加** 4 个业务码（新增行 / 删除行 = +N / 0）
apps/api/test/auth-contract.spec.ts    admin 路由围栏改为白名单 + 补反证
apps/api/test/di-wiring.spec.ts        排除 `type X = …` 字符串联合别名（误报修复）
apps/api/package.json                  + bullmq 5.81.5
pnpm-workspace.yaml                    + msgpackr-extract: false
pnpm-lock.yaml                         依赖锁定
```

**零改动**（已 `git diff` 确认）：`prisma/**`、`apps/api/src/app.module.ts`、
`bootstrap.ts`、`main.ts`、`apps/worker/**`、`apps/web/**`、根 `package.json`、`eslint.config.mjs`。

> 后 4 个文件**超出**了「允许修改」的目录。逐条理由见
> `CONTRACT_CHANGE_REQUEST-agent-03.md` 第 10 项（含删除行数）。

---

## Database Migrations

**None**

未创建任何 Migration，未改动 `prisma/schema.prisma`。
用到的表（Agent 01 已建好）：`sources`。**没有新字段需求** ——
`type/kind/tier/official/config(Json?)` + 三个索引已经够用。

---

## Public Interfaces

### 给 Agent 04（Collectors / Scheduler）—— **最重要的一节**

三样东西必须复用**同一份**实现，不要各写一份：

```ts
// ① SSRF / URL 安全（零依赖：只用 node:* 与 @signal/contracts）
import {
  assertSafeSourceUrl, // 写库时：同步、不联网
  safeFetchText, // 抓取时：DNS 校验 + 逐跳重定向再校验 + 超时/体积上限
  assertHostResolvesToPublicAddress,
  stripSensitiveHeaders,
  UrlSafetyError, // 「这个地址永远不该被请求」
  SourceFetchError, // 「请求了但没成功」（可重试）
  redactUrlForDisplay,
} from '../sources/url-safety'; // ← 从 apps/worker 看是跨 app，见下

// ② 调度规则（零依赖）
import {
  buildDueSourcesWhere, // 直接喂给 Prisma 的 where
  DUE_SOURCES_ORDER_BY,
  computeNextFetchAt,
  DUE_SOURCES_BATCH_SIZE,
} from '../sources/scheduling';

// ③ config 形状（消费端）
//    完整表见 CONTRACT_CHANGE_REQUEST-agent-03.md 第 6 项
```

**跨 app 的现实问题**：Agent 04 在 `apps/worker`，而这三样在 `apps/api`。
直接 import 会把 Nest / Express 依赖树拖进 worker 构建图。
已提交 **CCR 第 1 项**请求提升为共享包；**在此之前**的临时方案：

- 三个文件都是**零依赖、无副作用**的纯函数/普通对象，搬迁是**纯移动**，不需要改写；
- 临时可以加 `tsconfig` project reference 后相对路径 import，
  但**只 import 那三个文件**（它们不会传递引入 Nest）。

**`collector.fetch-source` 的载荷**（CCR 第 2 项请求固化）：

```jsonc
{ "sourceId": "123", "trigger": "manual", "requestedAt": "2026-09-24T01:00:56.616Z" }
```

### 给 Agent 07 / 12

- 复用 `AdminOriginGuard` 的思路（`apps/api/src/modules/sources/admin-origin.guard.ts`）——
  CCR 第 7 项建议把它提升到 `common/` 一次覆盖 03/07/12。
- `GET /admin/sources?type=X_USER` 就是 `docs/09` 要的「X 账号 Tab」。
- 业务错误码请继续**追加**到 `packages/contracts/src/errors.ts`，不要在本模块内散落。

### 本模块对外的错误码（4 个新增，全部无同义冲突）

| 码                       | HTTP | 何时                                                     |
| ------------------------ | ---- | -------------------------------------------------------- |
| `SOURCE_NOT_FOUND`       | 404  | （Agent 00 预置）id 不存在**或畸形或超出可绑定范围**     |
| `SOURCE_DUPLICATE_SLUG`  | 409  | slug 撞车                                                |
| `SOURCE_URL_NOT_ALLOWED` | 400  | URL 被 SSRF 规则拒绝（`details.reason` 给出具体原因）    |
| `SOURCE_CONFIG_INVALID`  | 400  | 该类型的 config 校验失败（`details.fields` 列出字段）    |
| `SOURCE_ENQUEUE_FAILED`  | 503  | 入队失败（Redis 不可用）—— **Agent 11 看到它去查 Redis** |

`VALIDATION_FAILED`（平台码）负责**通用字段**（name / slug / tier / 数值范围 / 未知键），
上面两个 `SOURCE_*_INVALID` 负责 `config`。这个分工是刻意的：
「表单项填错了」与「这个类型的配置不对」对管理员要做的事不同。

---

## APIs Used

外部出网**只发生在 `POST /:id/test`**，且只探测管理员配置的目标：

- 管理员配置的 RSS feed / Manual URL（**经完整 SSRF 三层校验**）
- `https://api.x.com/2/users/by/username/{handle}`（需要 `X_API_BEARER_TOKEN`）
- `https://api.github.com/repos/{owner}/{repo}`（`GITHUB_TOKEN` 可选）
- `https://huggingface.co/api/{models|datasets|spaces}/{repoId}`
- `https://hacker-news.firebaseio.com/v0/maxitem.json`

**未配置令牌时如实报告，不假装成功**：`X_USER` 在 `X_API_BEARER_TOKEN` 未配置时
返回 `{ok:false, message:'X API bearer token is not configured...'}`，且**完全不发请求**。

## Events / Queues

- 入队：`QueueName.COLLECTOR`（`collector`）/ `JobName.COLLECTOR_FETCH_SOURCE`
  （`collector.fetch-source`）/ `JobId.collectorFetchSource(sourceId, window)` /
  `COLLECTOR_RETRY`（3 次指数退避）。全部逐字取自 `docs/13` 与契约，**未新造近义名**。
- 未注册任何 Worker（那是 Agent 04）。
- Redis **不是**本模块的启动依赖，但**是 `fetch-now` 的硬依赖**：
  Redis 不可用 → 503（fail-closed，绝不返回「已入队」）。

## Environment Variables

**未新增任何 env。** 只读 `docs/20` 已记录的：

`SOURCE_FETCH_TIMEOUT_MS` / `SOURCE_FETCH_MAX_BYTES`（取数上限，**默认值只有
`envSchema` 一处**，本模块不另定）、`X_API_BEARER_TOKEN` / `GITHUB_TOKEN`（探测用）、
`REDIS_URL`（入队）、`APP_BASE_URL` / `API_BASE_URL`（Origin 校验）。

本地 `.env` 现状：`X_API_BEARER_TOKEN` 与 `GITHUB_TOKEN` **未配置** → X 的 `test` 会如实报未配置。

### 依赖变更（Agent 11 部署注意）

- `apps/api` **新增直接依赖 `bullmq@5.81.5`**（`ioredis` 是 Agent 02 已有的间接依赖）。
- `pnpm-workspace.yaml` 关闭了 `msgpackr-extract` 的**可选**原生构建：
  msgpackr 会自动回退纯 JS，**部署机不需要 node-gyp 工具链**。
- **Redis 是 `fetch-now` 的硬依赖**（Agent 11 请与 MySQL 一并做存活监控）。

---

## Tests

| 文件                                | 项数 | 覆盖                                                                                                                                                                                                                          |
| ----------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources-url-safety.spec.ts`        | 149  | 伪装 IP、域名、scheme、凭据、端口；DNS 全地址校验；逐跳重定向再校验；**流式边读边停**；GBK 解码；跨主机丢敏感头；畸形 Location                                                                                                |
| `sources-api.spec.ts`               | 67   | **真实链路**（真 HTTP → 真 AdminGuard → 真 JWT → 真会话 → 真控制器 → 真错误过滤器）：401/403/撤权即时生效、路由面精确等于 8 条、CRUD、409、私网 URL、config 校验、启停幂等、due 语义、test/fetch-now、Origin 校验、P2002 兜底 |
| `sources-config.spec.ts`            | 46   | 六种类型的 config 校验（真实代码，不经 HTTP）：必填、取值范围、未知键、别名提升、seed 标记继承                                                                                                                                |
| `sources-tester.spec.ts`            | 32   | **真实 `HttpSourceTester`** + stub 掉的 fetch/DNS：URL 拼法、状态码判定、feed 识别、GBK、X 令牌缺失不发请求、重定向到内网、target 去查询串                                                                                    |
| `sources-scheduling.spec.ts`        | 25   | 到期规则对象、幂等窗口、JobId 格式、Redis 连接参数（含 `rediss:` → tls）                                                                                                                                                      |
| `sources-db.integration.spec.ts`    | 19   | **真 MySQL**：停用即不到期、NULL 算到期、BIGINT/DECIMAL/Json 形态、**BIGINT 上界**、**并发同 slug**、**真 SQL 的 q/enabled/分页**、与 seed 数据共处                                                                           |
| `sources-queue.integration.spec.ts` | 6    | **真 Redis + BullMQ**：任务真的进队列、载荷/重试策略、JobId 幂等、Redis 不可用 503（含可用 Redis 的对照组）                                                                                                                   |

**测试数据刻意对齐真实形态**（§23.3）：中文 config 与 emoji 走真库（utf8mb4）、
**GBK 字节**断言解码出「中文」、`Math.random()` 拼 slug 的坑已记录在测试注释里、
seed 的稀疏 config 与 `next_fetch_at IS NULL` 都在真库上验过。

### 反证（§23.4）

`work/_agent03/counterproof-agent03.py` —— 63 条「故意改坏 → 跑测试 → 确认变红 → 还原」：

```
有牙齿（改坏→变红）     : 62/63
冗余层兜住（预期，非缺陷）: 1
无牙齿（改坏仍绿=空跑）  : 0
harness 错误            : 0
```

脚本能**区分「测试没红」与「测试根本没跑起来」**（后者报 `HARNESS`，不计入通过），
并在 Windows 上按字节读写以避免 CRLF 污染。

唯一「冗余」的一条是 `assertSlugAvailable`（服务层预查）：真正的唯一性由
`sources.slug` 唯一索引 + P2002 → 409 映射保证，两层都能给出同样的行为 ——
这是纵深防御，**不是缺陷**，但已显式记录而不是混进「有牙齿」里充数。

---

## Test Results

```
$ pnpm verify
✓ lint 0 errors
✓ typecheck（tsc -b + web tsc --noEmit + apps/api/test 纳入类型检查）
✓ 28 files / 703 tests passed          ← 交付前基线 381

$ REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration
✓ 4 files / 46 tests passed            （真实 MySQL 8.4.11 + 真实 Redis 8.8.0）

$ pnpm --filter @signal/api run build
$ REDIS_URL=redis://127.0.0.1:6390 node ../work/_agent03/probe-dist-sources.mjs
16/16 PASS（进程级 E2E，直接跑编译产物 + 真库 + 真 Redis + 真网络）
OVERALL: PASS

$ python work/_agent03/counterproof-agent03.py
62/63 有牙齿，1 冗余（已记录），0 空跑，0 harness 错误
```

dist 探针逐项：未认证 401 → OTP 登录 → 列表（seed 8 条）→ 建源（id 是 string）
→ DECIMAL 是 number → 详情 → PATCH → 畸形 id 404 → 私网 URL 400 →
**停用后直查真库确认不再是 due source** → 启用 → test（真实出网，`example.com/feed.xml`
返回 HTTP 404，如实报告）→ fetch-now 202 且**任务真的能从 Redis 读回** →
**dist 产物里 Nest 能解析全部依赖**（`design:paramtypes` 未退化）。

## Commands

```bash
pnpm verify                                                    # lint + typecheck + 单测（无需数据库）
pnpm --filter @signal/api run typecheck                        # 含 apps/api/test
REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration
pnpm --filter @signal/api run build
REDIS_URL=redis://127.0.0.1:6390 node ../work/_agent03/probe-dist-sources.mjs
python ../work/_agent03/counterproof-agent03.py                # 反证（需干净工作区，会自动还原）
python ../work/_agent03/repro-bigint-bound.mjs                 # 审查发现的复现脚本
```

本地 Redis（`docs/20` 默认 6379 未运行，集成测试用临时实例）：

```bash
"E:/redis/Redis-8.8.0-Windows-x64-cygwin-with-Service/redis-server" \
  --port 6390 --save '' --appendonly no
```

---

## Known Limitations

1. **CSRF token 未做**，只做了 Origin check。理由：`SameSite=Lax` 会话 Cookie 已挡住
   跨站表单 POST；Origin check 补上「同站不同子域」那一段。真正的 CSRF token 是
   横切关注点（需要会话绑定 + SPA 取 token 的接口），更适合公共层 —— 见 CCR 第 7 项。
2. **SSRF 有 TOCTOU / DNS rebinding 的残余风险**：解析 → 校验 → 连接之间 DNS
   仍可能改答案。彻底消除要把已校验的 IP **钉住**再连接（自定义 agent / 直连 IP + Host 头），
   那属于 Collector 的连接层职责。当前实现显著收窄了攻击面，但**不等价于完全消除**。
3. **DNS 校验依赖解析器返回全部地址**。本机 Node 24 的 `dns.lookup({all:true, verbatim:true})`
   实测返回全部（`localhost` → `::1` + `127.0.0.1`）。部署容器的解析器行为未验证。
4. **`prisma/seed.ts` 是唯一绕过 URL 校验的写库路径**（独立审查 F4，P4）。
   当前不可利用（写入的都是硬编码的公网厂商地址），但将来往清单里加内网地址不会有任何东西报错。
   建议 seed 也复用 `buildSourceConfig` —— 属 Agent 01 的文件，未越界修改。
5. **已停用的来源仍可 `test` / `fetch-now`**（独立审查 P4-3）。这是**刻意的**：
   `disable` 的语义是「停止产生**调度**任务」，管理员手动触发仍应可用
   （`payload.trigger: 'manual'` 就是为区分这个）。已在测试里钉住。
6. **`fetch-now` 被幂等去重时，响应与「真正入队」无法区分**（P4-6）。
   同一窗口内重复请求返回相同 jobId 但不会再次执行。见 CCR 第 9 项。
7. **`common/prisma/bigint-id.ts` 缺 BIGINT 上界**（独立审查 F2）。
   本模块已在自己的边界收口（`toSourceId`），但 Agent 07/09/10 会各自踩到。
   见 CCR 第 8 项 —— 应由 Agent 02 / 14 修。
8. **`docs/06` 的字面表述与实现不一致**：`docs/06` 写「查 `enabled && next_fetch_at <= now`」，
   本模块的实现**额外把 NULL 视为到期**（否则 Agent 01 seed 的 8 个来源永远不被采集）。
   **以 `scheduling.ts` 为准**，见 CCR 第 5 项。
9. **到期查询走覆盖索引扫描而非范围扫描**（`type=index` 而非 `type=range`），
   原因是 `OR ... IS NULL`。当前规模可忽略，已写进 `scheduling.ts` 的注释与 EXPLAIN 实测。
10. **`X_USER` / `GITHUB_REPO` 的真实令牌路径未做端到端验证**：本地未配置这两个令牌，
    只验证了「未配置时如实报告且不发请求」与单测级注入。
11. **`hrrss.org` / `hacker-news.firebaseio.com` 在冷连接时会触到 10s 预算**（独立审查实测），
    单独复测确认 RSS 探测路径本身正常（热连接 255ms）。**生产环境对慢源的 `test` 表现需人工确认。**
12. **`pnpm format:check` 对 `handoffs/README.md` 的既有失败**（Agent 01 的文件，未改动）；
    本次交付的文件已全部通过 Prettier。

---

## Contract Change Requests

见 **`handoffs/CONTRACT_CHANGE_REQUEST-agent-03.md`**（**10 项**）。
前 7 项在开发期提交，后 3 项在 §23 审查后追加。

其中**最需要尽快裁决**的三项（会实际影响 Agent 04）：

1. **第 1 项**：SSRF 验证器 / 调度规则 / config 形状需要被 `apps/worker` 复用，
   建议提升为共享包。
2. **第 5 项**：`next_fetch_at IS NULL` 算不算到期 —— `docs/06` 的字面写法会让
   seed 的 8 个来源永远不被采集。
3. **第 6 项**：每种 `SourceType` 的 config 契约（键、默认值、必填）。

对 `packages/contracts/src/errors.ts` 的改动是**纯追加**（新增 4 个码，**删除 0 行**），
未改动任何既有 code 或规则。

---

## Integration Notes

### 1. 给 Agent 14（最终集成）—— 必做

- **根模块必须挂载**，否则整块 Source Registry 在真实进程里不可用：
  ```ts
  // apps/api/src/app.module.ts
  @Module({ imports: [CommonModule, AuthModule, SourcesModule] })
  ```
- **不要再注册全局异常过滤器**：`CommonModule` 已提供 `APP_FILTER`（重复会套两层封套）。
- `CommonModule` / `PrismaModule` 是 `@Global()`，不必重复 import。
- **核对超出允许目录的 5 个文件**（CCR 第 10 项有逐条理由与删除行数）。
- 建议把 `pnpm --filter @signal/api run typecheck` 接进根 `typecheck`（Agent 02 已提过）。

### 2. 给 Agent 04（Collectors）—— **开工前必读**

- **三样东西必须复用，不要各写一份**：`url-safety/`、`scheduling.ts`、config 形状（见上）。
- **⚠ 绝不要用 SQL 的 `NOW()` 做到期比较。** 本机 MySQL `time_zone = SYSTEM = Asia/Shanghai`，
  而 `next_fetch_at` 存 **UTC**。实测 `NOW(3)` 与 `UTC_TIMESTAMP(3)` 差 8 小时 ——
  用 `NOW()` 会让来源**提前 8 小时**到期，静默无报错。用 `UTC_TIMESTAMP()` 或绑定 Prisma 的 `Date`。
- **⚠ 「到期」必须包含 `next_fetch_at IS NULL`**，否则 seed 的 8 个来源永远不被采集。
  用 `buildDueSourcesWhere()`，别照 `docs/06` 的字面写。
- **抓完之后要自己推进 `next_fetch_at`**，规则用 `computeNextFetchAt(interval, from)`；
  本模块只负责「查询"什么到期"，不负责推进（那是调度器的状态机）。
- **Job 载荷**：`{sourceId, trigger, requestedAt}`；`trigger: 'manual'` 表示管理员手动触发
  （`fetch-now`），调度器触发请用 `'schedule'`。
- `url-safety` 的两个错误类型要分开处理：`UrlSafetyError` = 地址永远不该请求
  （应标记为配置错误，而不是当普通失败重试）；`SourceFetchError` = 可重试的运行时故障。

### 3. 给 Agent 11（Ops）

- **Redis 是 `fetch-now` 的硬依赖**（fail-closed → 503 `SOURCE_ENQUEUE_FAILED`），
  请与 MySQL 一并做存活监控。
- `apps/api` 新增直接依赖 `bullmq@5.81.5`；`msgpackr-extract` 的原生构建已关闭
  （msgpackr 回退纯 JS，**不需要 node-gyp**）。
- **本模块没有后台定时任务**，不需要常驻 Worker 就能启动。
- `APP_BASE_URL` / `API_BASE_URL` 必须与实际访问域名一致，否则 Admin 的
  变更类请求会被 Origin 校验拒成 403（非浏览器客户端不带 `Origin`，不受影响）。

### 4. 给 Agent 12（Admin UI）

- `test` 端点**失败也是 HTTP 200**，请读 `data.ok` 而不是看状态码。
- `fetch-now` 返回 **202**，且**同一分钟内重复点击返回同一个 jobId 但不会再次执行** ——
  文案不要说「已排队两次」（见 CCR 第 9 项）。
- `PATCH {config: null}` 会返回 400：**config 不能清空**，只能提交完整的
  类型化配置（省略 config 表示不改动）。
- 顶层未知字段会返回 400 `VALIDATION_FAILED`（`details.fields` 指出是哪个键）——
  表单请只提交本模块声明的字段。
- `description` / X 账号筛选不需要新接口：`?type=X_USER`。

### 5. 给 Agent 13（Public Web）

- 本模块**不提供公开读接口**（那是 Agent 10）。前台展示来源信息请用 `@signal/contracts`
  的 `PublicSource`。

---

# 补遗（2026-09-24）：§23 独立审查后的缺陷修复

> 本文正文的验证结果（lint / typecheck / 703 项测试 / 真库集成 / dist E2E 全绿）
> **在审查前就已经成立**，但两轮审查仍然查出 **2 个 P2 + 2 个 P3 + 6 个 P4 + 1 个 F2/F1**。
> 以下记录「原先哪条声称过于乐观」「改了什么」「下游必须注意什么」。
>
> 审查由**两个没有本次开发上下文**的独立执行者完成（安全向 / 工程向），
> 报告与全部原始输出在 `work/_agent03/` 与 `work/_agent03/review-eng/`。
> **两个审查者都独立发现了「我的验证方式有盲区」这类问题**，这正是 §23 存在的理由。

## 1. 原先过于乐观的声称（逐条更正）

| 正文/代码里的声称                                                    | 事实                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「`test` 成功与失败都返回 200 —— 只有来源不存在才是 404」            | **假**。畸形的 `Location` 头会让 `new URL()` 抛 `TypeError`，它不是 `UrlSafetyError`/`SourceFetchError`，于是**逃出** tester 的 catch，变成 **500**。而 `Location` 是**对端完全可控**的输入。**F1 / P2**               |
| 「逐跳重新校验重定向」                                               | **不完整**。校验了「目标是不是公网」，没校验「**还是不是同一台主机**」—— `X_API_BEARER_TOKEN` / `GITHUB_TOKEN` 原样带到每一跳，实测跳到第三方时 `authorization` 仍是完整的 `Bearer SUPER_SECRET_TOKEN`。**F3 / P3**    |
| 「`config: null` 是有意义的（清空 config）」（`repository.ts` 注释） | **假**。实现把 `null` 当「空对象 → 全部走默认值」，于是「清空」被执行成「**静默重置成默认值**」：管理员设的 `maxItems=250` 被悄悄改回 50，返回 200；而对 `X_USER` 同一操作是 400。**注释与实现不符本身就是缺陷。P3-1** |
| 「`enable` / `disable` 的幂等与 nextFetchAt 语义」                   | **只对专用端点成立**。`PATCH {enabled:true}` 是**另一条合法的启用路径**，它**不**推进 `next_fetch_at` —— 界面显示「已启用」，调度器却可能一周不碰它。正是本模块自己要防的那类不一致。**P2-1**                          |
| 「局部 config 的 PATCH 不会破坏已有配置」                            | **假**。`copyPassthrough` 只从**请求体**取 seed 标记，于是「只改 handle」的 PATCH 会把 `seed`/`seedNote` **静默抹掉** —— 而那是区分 seed 演示数据与真实数据的唯一标记。**P3-2**                                        |
| 「`slug` 唯一索引真的生效，且被翻译成 409 而不是 500」（用例名）     | **后半句证明不了**。顺序请求永远先命中服务层预检，**P2002 兜底分支在任何测试里都没被执行过**（反证：单独关掉它依然全绿）。**P3-3**                                                                                     |
| 「`list()` 的过滤与分页」                                            | 单元测试里那几个过滤是**替身自己实现的**，真实现（真 SQL 的 `q` / `enabled` / `skip`）**从未被执行过**（反证：分别改坏 → 全部 GREEN）。**P3-4**                                                                        |
| 「`id` 边界已验过（畸形 id 是 404 不是 500）」                       | **只验了字母 id**。数字上界没验：连**合法上限** `18446744073709551615` 都会让 Prisma 抛错 → **500**。内存替身复刻不了这件事。**F2**                                                                                    |
| 「字符串长度上限与列宽一致」                                         | **不完全**。用 JS `.length`（UTF-16 码元）而 MySQL `VARCHAR(255)` 按**字符**计 —— 128 个 emoji 被误判为 256 而拒。**P4-1**                                                                                             |
| 「未知键会被拒绝」                                                   | **只对 `config` 成立**。顶层 `tierr` 拼错返回 200 而什么都没改 —— 与「`includQuotes` 必须报错」是**完全相同的论证**，但顶层没做。**P4-2**                                                                              |
| 「我加了一条有牙齿的守卫」（`auth-contract` 的 admin 路由围栏）      | **同义反复**。那条 `it(...)` 只对字符串数组调了一次 `filter`，**连正则都没碰到**。审查者指出后改为真正跑同一套过滤，并把正则的已知缺口显式钉住。**P4-5**                                                               |

**审查确认「没问题」的项**（附证据）：SSRF 语法层 130 条绕过尝试 0 条成功（含十进制 /
十六进制 / 八进制 / 短写 / 全角 / 带圈字符 / 百分号编码 / zone id）；
真实 DNS 下 `127.0.0.1.nip.io` 与 `localtest.me` **在发起连接之前**被拦住；
8 条路由 401/403 逐条正确；无订阅语义；错误码全为 `DOMAIN_REASON` 且在册；
Queue/Job/JobId 与 `docs/13` 逐字一致；未新增 env；
`prisma/**` / `app.module.ts` / `bootstrap.ts` / `main.ts` 零改动；
dist 产物里 DI 完好；错误封套不回显输入值；探针结束后库里 `sources` 回到 seed 的 8 行
（清理纪律是真的）。

## 2. 修复内容与影响范围

| #        | 修复                                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**   | 重定向解析包 try/catch → `SourceFetchError('INVALID_REDIRECT')`；联合类型补该成员；**顺带移除死成员 `HTTP_STATUS`**（`safeFetchText` 从不抛它，留着会诱导 Agent 04 写一个永远不进的分支） |
| **F3**   | 跨 origin 重定向时丢弃 `authorization` / `cookie` / `proxy-authorization`；**同 origin 的相对跳转不受影响**（有对照用例）                                                                 |
| **F2**   | 本模块边界加 `MAX_BINDABLE_ID`（Int64 max）+ `toSourceId()`；超界当作「不存在」→ 404                                                                                                      |
| **P2-1** | `PATCH` 的 `enabled` 走与 `/enable` 相同的状态跃迁（仅「停用→启用」推进，且幂等）                                                                                                         |
| **P3-1** | `config: null` **明确拒绝**（400）+ 修正 `repository.ts` 里与实现不符的注释                                                                                                               |
| **P3-2** | `copyPassthrough` 从**已有 config** 继承 seed 标记（请求体优先）                                                                                                                          |
| **P3-3** | 补竞态用例（预检通过、插入撞唯一约束）+ 真库并发用例（4 并发 → 1×201 / 3×409 / 无 5xx）                                                                                                   |
| **P3-4** | 补 4 条真库用例：**中文** `q` 命中（+ 对照 0 条）、`q` 命中 slug、`enabled` 过滤、`page=2/3` 的 skip/offset 不重叠不重不漏                                                                |
| **P4-1** | 长度改按**码点**计（`[...value].length`）                                                                                                                                                 |
| **P4-2** | 顶层未知键 → 400；`PATCH {name:null}` / `{slug:null}` → 400（不再静默 no-op）                                                                                                             |
| **P4-5** | 把 admin 路由围栏的判定抽成函数，反证改为**真正跑同一套过滤**；正则的已知缺口写进测试                                                                                                     |
| **新增** | **Admin Origin 校验**（`docs/14` 的 CSRF 部分，Agent 02 交接时留给 03/07/12）                                                                                                             |
| **新增** | `scheduling.ts` 补三条给 Agent 04 的硬警告（`NOW()` 时区陷阱 / 与 `docs/06` 分叉 / 索引形态）                                                                                             |

## 3. ⚠ 下游必须注意的破坏性变更

1. **`PATCH {config: null}` 现在返回 400**（此前返回 200 且静默重置为默认值）。
   Admin UI（Agent 12）若用它表示「清空配置」，需要改成提交完整配置。
   —— 这是**修复**（此前会静默改数据），但确实是行为变更。
2. **`PATCH` 带顶层未知字段现在返回 400**（此前静默忽略）。
   表单若提交了本模块未声明的字段会被拒。`details.fields` 会指出是哪个键。
3. **`PATCH {name:null}` / `{slug:null}` 现在返回 400**（此前是静默 no-op，返回 200）。
4. **超出 Int64 范围的 `:id` 现在返回 404**（此前 500）。
5. **变更类请求带不匹配的 `Origin` 现在返回 403**。非浏览器客户端不受影响（不带 `Origin`）。
6. **探测遇到畸形 `Location` 现在返回 `{ok:false}` + 200**（此前 500）。
   `SourceFetchFailureReason` 新增 `INVALID_REDIRECT`、**移除 `HTTP_STATUS`** ——
   Agent 04 若已按那个联合类型写过分支，请同步。
7. **跨主机重定向不再携带 `Authorization`**。若将来有厂商端点依赖跨域跳转携带令牌，
   会受影响（当前 `api.x.com` / `api.github.com` 均为硬编码端点，实测不受影响）。

## 4. 反证（§23.4 要求「确认守卫有牙齿」）

`work/_agent03/counterproof-agent03.py`，63 条变异，**62 有牙齿 / 1 冗余（已记录）/ 0 空跑 / 0 harness 错误**。

两次「反证抓出真问题」的记录（都写进了上面的更正表）：

- 第一轮：把 IPv6 内嵌 IPv4 解码改坏，**103 条测试依然全绿** ——
  说明那批「IPv6 伪装」用例其实是靠**前缀表**通过的，解码逻辑从未被触发。
  顺带发现 `::1:7f00:1`（保留段）确实会漏 → **把 IPv6 改成 `2000::/3` 白名单**，
  并为解码逻辑补**直接单测**。
- 第二轮：审查者的独立反证发现「预检 + P2002 兜底两层互相掩护，各自单独失效都查不出来」。

## 5. 审查者指出、但我**没有改**的项（附理由）

1. **`docs/06` 与实现的分叉**（P2-2）：不越界改文档，改为在 `scheduling.ts` 写死警告 +
   CCR 第 5 项请 Owner 裁决。
2. **`common/prisma/bigint-id.ts` 的上界**（F2 根因）：属 Agent 02，不越界改；
   本模块边界已收口，CCR 第 8 项请 Owner 修。
3. **`prisma/seed.ts` 绕过 URL 校验**（F4）：属 Agent 01，当前不可利用，
   Known Limitations 第 4 条已记录。
4. **到期查询的索引形态**（P3-5）：不改成范围扫描（那需要回填 `next_fetch_at`，
   属 Agent 01 的迁移）；已在 `scheduling.ts` 写下 EXPLAIN 实测与代价评估。

## 6. 无法在本环境验证（需人工确认）

1. `X_API_BEARER_TOKEN` / `GITHUB_TOKEN` 的**真实令牌路径**（本地未配）。
2. **F3 的真实可利用性**：证明了「跨主机跳转会带走 Authorization」，但没能证明
   `api.x.com` / `api.github.com` 在真实调用中会跨域跳转。**修复后无论如何都不会带走令牌。**
3. **TOCTOU / DNS rebinding** 的实际可利用性（原理成立，构造需要控制权威 DNS）。
4. 生产环境 DNS 解析器与 Node 版本（`verbatim` 行为）。
5. 「Redis 进程存在但网络黑洞」形态下的 5 秒入队超时。
6. 真实 GBK 编码的线上 feed（单测级已验证解码）。
7. 慢源（>10s）在生产环境下的 `test` 表现。
8. `docs/04` 未定义 `test` / `fetch-now` 的响应形状，因此这两个端点的返回体
   是否符合契约**无法判定** —— 属上游文档缺口，CCR 第 3 项。
9. Agent 12 的 Admin UI 与 Agent 04 的采集器尚未开工，端到端语义无法验证。
