# Signal — Agent 进度看板

> **所有 Agent 必读、必更新。**
> 每个 Agent 在 **§23 独立审查通过之后、生成本文件同目录的 HANDOFF 时**，必须同时更新本看板。
> 规则见《Signal 多 Agent 执行规则 v1.0》§24。

**最后更新：** 2026-09-24 · Agent 04

---

## 总览

| Wave | Agent  | 任务                             | 上游 HANDOFF                              | 状态      | 提交                                                                  | HANDOFF                                      |
| ---- | ------ | -------------------------------- | ----------------------------------------- | --------- | --------------------------------------------------------------------- | -------------------------------------------- |
| 0    | **00** | Foundation / 共享契约            | —                                         | ✅ 已完成 | `6b5eab4` `31006c2`                                                   | [agent-00-HANDOFF.md](./agent-00-HANDOFF.md) |
| 0    | **01** | Prisma / MySQL / Evidence        | 00                                        | ✅ 已完成 | `b8f9f36` `5cf51ef` `31006c2`                                         | [agent-01-HANDOFF.md](./agent-01-HANDOFF.md) |
| 1    | **02** | Auth / User                      | 00, 01                                    | ✅ 已完成 | `cc3e4be` `7537180` `b1d4548`                                         | [agent-02-HANDOFF.md](./agent-02-HANDOFF.md) |
| 1    | **03** | Source Registry / X 白名单       | 00, 01, 02                                | ✅ 已完成 | `84214d3` `22d9dd9` `917388b` `0d2ee19` `3306ed1` `a496ea2` `967df9d` | [agent-03-HANDOFF.md](./agent-03-HANDOFF.md) |
| 1    | **06** | AI Provider / Score              | 00, 01                                    | ✅ 已完成 | `56335c7` `dae01be` `2a7eb2b`                                         | [agent-06-HANDOFF.md](./agent-06-HANDOFF.md) |
| 1B   | **04** | Collectors                       | 00, 01, 03                                | ✅ 已完成 | `c88c935` `c0100d6`                                                   | [agent-04-HANDOFF.md](./agent-04-HANDOFF.md) |
| 1B   | **05** | Pipeline / Event / Evidence      | 00, 01, 04, 06                            | ⬜ 未开始 | —                                                                     | —                                            |
| 2    | **07** | Admin Review / Evidence API      | 00, 01, 02, 03, 05, 06                    | ⬜ 未开始 | —                                                                     | —                                            |
| 2    | **09** | Bookmark / Reading / Preferences | 00, 01, 02                                | ⬜ 未开始 | —                                                                     | —                                            |
| 2B   | **08** | Featured / Daily                 | 00, 01, 05, 06, 07                        | ⬜ 未开始 | —                                                                     | —                                            |
| 3    | **10** | Search / Public API              | 00, 01, 02, 05, 08, 09                    | ⬜ 未开始 | —                                                                     | —                                            |
| 3    | **11** | Ops                              | 00（完整部署前再读 01,02,04,05,06,08,10） | ⬜ 未开始 | —                                                                     | —                                            |
| 3    | **12** | Admin UI                         | 02, 03, 07, 08, 10                        | ⬜ 未开始 | —                                                                     | —                                            |
| 3    | **13** | Public Web v1.7                  | 02, 08, 09, 10                            | ⬜ 未开始 | —                                                                     | —                                            |
| 4    | **14** | Final Integration                | **全部**                                  | ⬜ 未开始 | —                                                                     | —                                            |

### 状态取值（只用这五个）

```text
⬜ 未开始   尚未开工
🟡 进行中   正在开发
🔵 待审查   开发完成，§23 独立审查尚未通过
✅ 已完成   §23 审查通过，HANDOFF 已出
⛔ 阻塞    缺上游 / 契约问题未解决（必须在备注里写清原因）
```

**`🔵 待审查` 不算完成。** 按 §23.7，P0/P1 未修复即视为未完成，不得进入下一波次。

---

## 当前可开工

| Agent  | 说明                                                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **05** | 上游 00、01、04、06 **均已完成 → 已解锁**。开工前必读 Agent 04 HANDOFF 的两节：「给 Agent 05」与「§23 补遗的 7 条行为变更」（正文不做清洗、幂等第 3 条归你、游标不再表示「已处理完」） |
| **09** | 上游 00、01、02 均已完成；V1 只做 Bookmark / Reading / Preferences                                                                                                                     |

> 规则 §18：建议同时最多跑 3–4 个 Agent。
> **Wave 1 与 Wave 1B 均已全部完成**（02 / 03 / 04 / 06）；Wave 2 的 **09** 可开工。

---

## 当前阻塞

无。

> ⚠ 有两项**已知集成缺口**（不阻塞 05 / 09，但 Agent 14 必做）：
>
> 1. `apps/api/src/app.module.ts` 尚未挂载 `CommonModule` + `AuthModule` + `SourcesModule`，
>    因此 `node apps/api/dist/main.js` 起真实进程时 `/api/v1/auth/*` 与
>    `/api/v1/admin/sources/*` 全是 404。
> 2. `apps/worker/src/worker.module.ts` 尚未挂载 `CollectorsModule`（Agent 04）与
>    `AiWorkerModule`（Agent 06），因此 worker 起真实进程时**不会采集、也不会跑 AI**。
>    两个模块都会在 `onModuleInit` 真启动 BullMQ 消费者 —— 需要一个**统一的**
>    测试期开关，别让各模块自己发明（Agent 06 也提过这一点）。
>
> 详见下方各 Agent 的要点。

---

## 已完成 Agent 的要点速查

### Agent 00 — Foundation

- 交付 `@signal/contracts`（唯一枚举来源）/ `@signal/config` / `@signal/logger`
- 三个 app 空壳可启动
- **⚠ 破坏性变更**：`resolveApiPort()` 已删除，API 固定监听 `DEFAULT_API_PORT = 3001`
- **⚠ 注意**：`createLogger()` 返回的对象已包装 `.child()`，无论用 `.child()` 还是 `childLogger()` 都会脱敏

### Agent 01 — Prisma / MySQL / Evidence

- 24 张表 / 18 个枚举；**两个迁移必须都应用**（第二个是中文搜索修复）
- **⚠ 重大**：`contents` 的 FULLTEXT 必须带 `WITH PARSER ngram`，否则中文搜索恒返回 0 条
- **⚠ 注意**：`EventEvidence` 的「一个事件最多一个 Primary Evidence」**DB 层不强制**，必须用事务
- 本地库：MySQL 8.4.11，`signal` / `signal_shadow` 已建，`.env` 已配

### Agent 02 — Auth / Users

**已合并进 `main` 并推送**（`origin/main` = `bfc6bad`），下游直接 `git pull` 即可。

**先读 HANDOFF 的补遗章节**：正文的全绿验证在独立审查前就已成立，
但审查仍查出 1 个 P1 + 5 个 P2（含「未验证邮箱可接管账号」），已全部修复。

- 交付 `AuthGuard` / `AdminGuard`（`apps/api/src/common/guards`）+ Email OTP / GitHub OAuth / Session / `GET /me`
- **⚠ 必做（Agent 14）**：根模块要 `imports: [CommonModule, AuthModule]`；
  **不要再注册全局异常过滤器**（`CommonModule` 已提供 `APP_FILTER`，重复会套两层封套）
- **⚠ 复用勿重造**：`common/prisma`（`PrismaService` @Global、BIGINT 转换、Prisma↔契约枚举桥接）、
  `common/http`（错误封套、requestId、Cookie 读写）、`common/logger`（`APP_LOGGER`）
- **⚠ 下游用守卫**：所在模块 `imports: [AuthModule]`，然后 `@UseGuards(AuthGuard)` / `AdminGuard`。
  授权按**库里的当前角色**判：登出 / 撤权 / 禁用**立刻生效**（每个认证请求一次 DB 查询）
- **⚠ Agent 13（前端）**：refresh 是**严格轮换**，同一 refresh token 并发刷新会被判定为重放
  并撤销该用户全部会话 → **刷新必须 single-flight**；OAuth 回调只 302 到 `APP_BASE_URL`，
  无状态参数
- **⚠ 错误码**：`AUTH_OTP_INVALID` / `AUTH_OTP_EXPIRED` / `AUTH_OTP_ALREADY_USED` 三态分开；
  登出后刷新得 `AUTH_SESSION_REVOKED`（不是 `AUTH_SESSION_INVALID`）
- **⚠ Agent 11**：Redis 是登录路径硬依赖（限流 fail-closed，Redis 挂了 OTP 登录 500）；
  **生产未配 SMTP 时登录不可用（503，刻意不降级）**；本地未配 SMTP 时验证码打在 **stderr**
- **⚠ 部署前提**：per-IP 限流取 `X-Forwarded-For` **最后一段**（不可伪造），
  前提是 **api 端口不直接对公网暴露**（见 `CONTRACT_CHANGE_REQUEST-agent-02.md` 第 3 项）
- 未新增任何 env；未改 Prisma / 未建 Migration；无任何 USER→ADMIN 接口；
  `errors.ts` 仅**追加** 10 个业务码

### Agent 03 — Source Registry / X 白名单

**先读 HANDOFF 的补遗章节**：正文的全绿验证在独立审查前就已成立，
但两轮审查（安全向 / 工程向）仍查出 **2 个 P2 + 2 个 P3 + 6 个 P4**，已全部修复。

- 交付 `/api/v1/admin/sources` 的 **8 条**路由（CRUD、启停、`test`、`fetch-now`）
  - **SSRF 三层防护** + **类型化 config 校验** + **调度规则** + **Admin Origin 校验**
- **⚠ 破坏性变更（下游必看）**：`PATCH {config:null}` 现在 **400**（此前 200 且静默重置为默认值）；
  顶层未知字段现在 **400**；`PATCH {name:null}` 现在 **400**；超出 Int64 的 `:id` 现在 **404**
  （此前 500）；变更类请求带不匹配 `Origin` 现在 **403**
- **⚠ Agent 04 必读（跨 Agent 的三个坑）**：
  1. **绝不要用 SQL `NOW()`** 做到期比较 —— 本机 MySQL `time_zone=SYSTEM=Asia/Shanghai`
     而 `next_fetch_at` 存 UTC，实测差 8 小时，会让来源**提前 8 小时**到期，静默无报错；
  2. **「到期」必须包含 `next_fetch_at IS NULL`** —— 否则 Agent 01 seed 的 8 个来源
     **永远不会被采集**（`docs/06` 的字面写法就有这个洞，CCR 第 5 项请求裁决）；
  3. 抓完之后要**自己推进** `next_fetch_at`（用 `computeNextFetchAt`），本模块只查询不到期
- **⚠ 复用勿重造**：`url-safety/`（SSRF）、`scheduling.ts`（到期规则）、
  `source-config.schema.ts`（config 形状）必须共用同一份。
  三处都是**零依赖纯函数**，但**位置跨 app**（在 `apps/api`，Agent 04 在 `apps/worker`）——
  已提 CCR 第 1 项请求提升为共享包，HANDOFF 给了临时接法
- **⚠ Agent 11**：**Redis 是 `fetch-now` 的硬依赖**（fail-closed → 503 `SOURCE_ENQUEUE_FAILED`）；
  `apps/api` 新增直接依赖 `bullmq@5.81.5`；`msgpackr-extract` 原生构建已关闭（不需要 node-gyp）
- **⚠ Agent 12**：`test` 失败也是 **200**，请读 `data.ok`；`fetch-now` 返回 **202**
  且同一分钟重复点击返回同一 jobId 但**不会再次执行**（CCR 第 9 项）；
  分页封套是 `{data, meta:{page,pageSize,total,totalPages}}`
- **⚠ 错误码**：`SOURCE_DUPLICATE_SLUG`(409) / `SOURCE_URL_NOT_ALLOWED`(400) /
  `SOURCE_CONFIG_INVALID`(400) / `SOURCE_ENQUEUE_FAILED`(503)；
  通用字段校验仍走平台码 `VALIDATION_FAILED`
- 未新增 env；未改 Prisma / 未建 Migration；`errors.ts` 仅**追加** 4 个业务码（删除 0 行）
- **未修复但已上报**：`common/prisma/bigint-id.ts` 缺 BIGINT 上界（属 Agent 02，
  会影响 07/08/09/10），见 CCR 第 8 项

### Agent 04 — Collectors / Scheduler

**先读 HANDOFF 的「补遗」与「补遗二」**：正文的验证结果在独立审查前就已成立，
但两轮审查在「全绿」状态下共查出 **1 个 P0 + 4 个 P1 + 2 个 P2 + 一批 P3/P4**，已全部修复。

- 交付 `apps/worker/src/jobs/collectors/**`（六种来源的适配器、幂等落库、状态推进、
  Scheduler、BullMQ 消费者）+ **提取了 `packages/source-core`**（按 Agent 03 的 CCR 第 1 项）
- **⚠ 下游必读的 7 条行为变更**（见 HANDOFF 补遗 §3）：payload 改为**按类型白名单**校验
  （X 的推文类别键改名 `postKind`）；采集端**不再做时间 / id 增量过滤**（每轮可能返回
  已落库的条目，靠幂等键挡掉 —— 不要假设「这一轮的新 RawItem 就是全部新内容」）；
  `CollectorBatch.nextCursor` 已删除、`complete` 语义收窄；`JobRun` 的不可重试失败
  现在是**直接终态 `DEAD`**（不是 FAILED）；`raw_items.language` 不再接受编程语言名；
  超长字段改为截断 / 丢弃并计数（不再整批失败）；`roundLimit` 是新的每轮入库上限
- **⚠ Agent 05（下一个）**：采集端**不做任何清洗**，`RawItem.bodyRaw` 里可能有 HTML
  （`docs/14` 的清洗点是你的 Normalize）；`titleRaw` 是纯文本但**不是**「已净化的 HTML」；
  幂等第 3 条（content hash）采集端只计算、不拦截，Near Dedup 归你
- **⚠ Agent 14 必做**：`worker.module.ts` 加 `imports: [CollectorsModule]`
  （`exports: [CollectorService, SourceScheduler]`）；**不要**在别处重复注册
  `SourceScheduler` / `CollectorWorker`（会跑两遍）
- **⚠ Agent 11**：Redis 是硬依赖；`rediss:`（TLS）分支**无测试覆盖**；
  worker 的集成测试需要真 Redis，且**已改为先 ping 再跑**（Redis 挂时会给出指向 Redis 的错误）
- **⚠ 本模块的 JobId 是 3 段**（`collector:{sourceId}:{window}`），
  已在真 Redis 上验证能被 BullMQ 接受 —— 与 Agent 06 报的 CCR 第 0 项
  （`JobId.normalize` / `JobId.dailyDraft` 只有 2 段会被拒）无关
- **⚠ 未新增任何 env**；未改 Prisma / 未建 Migration；`errors.ts` 仅**追加** 3 个
  `SOURCE_FETCH_*` 码（删除 0 行）
- 仍未解决、已记录：X 的真实令牌路径与 Hugging Face 的端点形状**本机无法验证**；
  DNS rebinding / TOCTOU 未消除；`fetchWindow` / `redisConnectionOptions` / `bigint-id`
  仍是跨 app 的三处重复（CCR 第 8 项）

---

### Agent 06 — AI Provider / 翻译 / 分类 / 评分

**先读 HANDOFF 的补遗章节**：正文的验证（938 项单测 + 28 项集成测试全绿、16 个反证变体）
在独立审查前就已成立，但**两轮独立审查仍查出 1 个 P0 + 2 个 P1 + 6 个 P2**，已全部修复。

- 交付 `AiProvider` + OpenAI-compatible 实现（只用内置 `fetch`）、Prompt Registry（版本 + 指纹守卫）、
  zod 严格结构化输出、六维评分、成本与预算、Evidence 上下文、注入防护、`ai.translate` /
  `ai.classify-score` 两个 Job（含 `docs/13` 的 Dead Letter → `job_runs = DEAD`）
- **⚠ 破坏性变更（下游必看）**：
  1. `translateJobId(contentId, promptVersion)` —— **签名加了一个参数**（编译期即可发现）；
  2. `ai_analysis` 结构变成 **`{ score: {...}, translation: {...} }`**（运行时变更，无编译期保护）；
  3. `hasOfficialConfirmation` 的**判定口径变了**（改判**证据那条来源**的 official，
     同一份数据可能得出不同结论）；
  4. 六维列与 `final_score` 的**量化方式变了** —— 历史数据与新数据之间最多差 0.1，**档位可能不同**
- **⚠ Agent 05 必读（边界）**：`AiService` **不写** `contents.pipelineStatus`（状态机归你）、
  **不写** `ContentTopic`。分类结果经返回值给你：`outcome.topics`（kebab-case slug）/
  `outcome.summary` / `outcome.detectedLanguage`。入队必须带 `...AI_JOB_OPTIONS`
  （用默认 `attempts: 1` 会**静默关掉**重试分档）
- **⚠ Agent 07 必读**：`ai_analysis` 读法是 `aiAnalysis.score.*`；
  **档位不落库**，用 `scoreBand(finalScore)` 现算；`AiTaskType.CLASSIFY` **永不出现**在
  `ai_runs`（分类与评分共用一次调用，`taskType = SCORE`），按它筛会永远查不到
- **⚠ Agent 14 必读**：
  1. **引用 `AiWorkerModule` 会真的起一个 BullMQ 消费者**（`onModuleInit` 自启动，
     与 Agent 04 的 `CollectorWorker` 对齐）。若 `boot.spec.ts` 把它纳入 `WorkerModule`，
     无 Redis 的机器上会刷重连错误 —— 需要一个**统一的**测试期开关，别让各模块自己发明；
  2. **跨 Agent 契约缺陷（CCR 第 0 项，最高优先）**：`JobId` 里 **3/4 个 builder 的产物
     会被 BullMQ 拒绝**（含 `:` 的 custom jobId 必须**恰好 3 段**）。
     `JobId.normalize`（Agent 04）与 `JobId.dailyDraft`（Agent 08）是 2 段，
     照契约使用会在**入队时同步抛错**；
  3. worker 侧有 **5 处重复实现**（PrismaService / 枚举桥接双向 / Redis 连接解析 / JobRun 落库），
     见 CCR 第 2 项
- **⚠ 未新增任何 env**；未改 Prisma / 未建 Migration；`errors.ts` 仅**追加** 7 个 `AI_*` 码（删除 0 行）
- **⚠ 集成测试不能并行跑**：`pnpm test:db` 与 worker 的 `test:integration` 共用同一个 MySQL 实例，
  两个进程同时跑会互相干扰（实测随机挂 4 项）。CI 上请串行
- **给 Agent 11**：Redis 是硬依赖；成本是**估算**（价格表是代码常量，未知模型走兜底价）；
  `ai_runs` 可能残留永远 `RUNNING` 的行，建议加巡检

---

## 更新方法（Agent 完成后照做）

1. 把**自己那一行**的「状态」改为 `✅ 已完成`
2. 填入本次提交的短 SHA（多个提交用空格分隔）
3. 填入 HANDOFF 的相对链接
4. 更新顶部「最后更新」
5. 更新「当前可开工」与「当前阻塞」
6. 若自己的实现有**下游必须知道的坑或破坏性变更**，补进「已完成 Agent 的要点速查」

**只改自己那一行和上面几处**，不要动其他 Agent 的行。
