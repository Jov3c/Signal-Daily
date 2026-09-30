# Handoff — Agent 14（最终集成 / Release Candidate）

| 项               | 值                                                                |
| ---------------- | ----------------------------------------------------------------- |
| **Agent**        | 14                                                                |
| **任务**         | `tasks/agent-14-integration.md` —— 把 00–13 合成唯一版本并生成 RC |
| **依赖**         | **全部**（00–13）                                                 |
| **日期**         | 2026-09-30                                                        |
| **提交**         | `9151f22`                                                         |
| **基线**         | `e43bcd5`（含一次全量审查重构；其「行为零变化」已被我独立复核）   |
| **§23 独立审查** | 未做（见文末）。**但本次交付的核心就是「真的跑起来」** —— 见 §4。 |

---

## Task

`tasks/agent-14-integration.md`：把 Agent 00–13 合成唯一版本，解决集成问题并生成 RC。
必须验证 7 条 + 一条业务 Smoke（Admin login → add RSS → … → Preferences → Search）。

---

## 1. 挂载

```text
apps/api/src/app.module.ts      13 个模块
  CommonModule（地基：APP_FILTER + @Global PrismaService）
  AuthModule · HealthModule
  PublicReadModule · SearchModule · FeaturedModule · DailyModule
  BookmarksModule · ReadingProgressModule · UserPreferencesModule
  SourcesModule · AdminReviewModule · AdminOpsModule

apps/worker/src/worker.module.ts  4 个 Job 模块
  CollectorsModule · AiWorkerModule · ContentPipelineModule · PublishingModule
```

**刻意的三件「不做」**（写进了 `app.module.ts` 的文件头）：不重复注册全局过滤器
（会套两层封套）、不给 `/health/*` 加守卫（容器探针不带 token）、
不手动提供 `ADMIN_ORIGIN_CONFIG`（用到它的 5 个模块各自提供，那是模块作用域的）。

---

## 2. ⚠ 本次唯一的跨模块决策：统一开关

**问题**：四个 Job 模块都会在 `onModuleInit` 里真的 `new Worker(queue)`，
其中三个还各带定时器。它们在 `WorkerModule.imports` 为空时一切正常 ——
因为根本没有模块被挂上。一挂上去，`apps/worker/test/boot.spec.ts` 就会
连 Redis、跑 `parseEnv()`、触发调度定时器。

**四个模块的文件头都写着同一句话**：「这应当是 Agent 14 对一个 app 内所有队列模块的
**统一决策**，不要各自发明」（`docs/18`）。本次给出了那个决策：

```ts
// apps/worker/src/common/consumers.ts
export function shouldStartConsumers(env = process.env): boolean {
  return env['NODE_ENV'] !== 'test';
}
```

6 个启动点各加一行 early-return：`CollectorWorker.onModuleInit`、
`SourceScheduler.onApplicationBootstrap`、`AiWorkerModule.onModuleInit`、
`ContentPipelineModule.onModuleInit`（同时挡住 60 秒收尾扫描）、
`PublishingModule.onModuleInit`、`PublishingScheduler.onModuleInit`。

**为什么是纯函数而不是注入 token**（两条具体理由，不是偏好）：

1. Nest 的 provider 是**模块作用域**的。各模块自己 `providers` 里给默认值 →
   `WorkerModule` 就覆盖不掉；只在 `WorkerModule` 里给 → worker 侧 **8 个测试文件**
   各自都要补一个 provider。那是把「一个开关」变成「8 处记得补」。
2. 这个开关的语义是**进程级**的（「这次进程要不要跑消费者」），没有替身可换 ——
   换掉它等于换掉被测行为本身。

**守卫放在生命周期钩子里，不放在 `start()` 里**：`start()` 是对外可调用的
（`SourceScheduler` 的文件里写着「重复调用是幂等的」），集成测试会直接调它验真调度。

**没有新增 env**（`docs/20` 清单不变）：用的是既有的 `NODE_ENV`。

---

## 3. ⚠ 集成震出来的三个缺陷 —— 全都只在「挂进根模块」时现形

这三个都不是新代码引入的，是**一直存在、但没有任何测试能看见**的。
它们正是 Agent 08 那条教训的复发：「模块能编译、能过全部单测，一挂进根模块就启动即崩」。

### 3.1 `BullSourceFetchQueue` —— `useClass` + 无 `@Inject` 的 `string` 参数

```ts
constructor(
  @Inject(COLLECTOR_CONFIG) config: CollectorConfig,
  queueName: string = QueueName.COLLECTOR,   // ← 有默认值，没有 @Inject
)
```

`useClass` 让 Nest 去**解析**这个参数，token 是 `design:paramtypes` 里的 `String`
→ 启动即崩：`Nest can't resolve dependencies of the BullSourceFetchQueue (COLLECTOR_CONFIG, ?)`。

**为什么没有测试发现**：`String` 这个元数据只出现在 **`tsc` 的产物**里。
测试跑的是另一套 transform —— **dist 崩、测试绿**。
（这正是 `di-wiring.spec.ts` 那条守卫关心的事，只是那条只看**类类型**参数，`string` 漏过去了。）

**修法**：改用 `useFactory` —— 完全绕开参数元数据，默认值由 JS 自己生效。

### 3.2 `public-read` 的 Redis 连接没有 `error` 监听器

ioredis 在**没有** error 监听器时会自己往 **stderr** 打
`[ioredis] Unhandled error event: …` —— 绕过 `@signal/logger`：不脱敏、
不带 service/requestId，而且 Redis 挂掉期间每次重连都打一行。

Agent 02（限流）与 Agent 11（健康检查）的连接都收了口，**只有这一处漏了**。
实测：加监听器前 `boot.spec` 的 stderr 里有该行，加了之后 **0 条**。

### 3.3 `abortOnError` 默认 true 把启动失败的错误吞掉

Nest 初始化出错时直接 `process.abort()`（SIGABRT）。屏幕上是：

```text
----- Native stack trace -----
 1: node::GetNodeReport+74262
----- JavaScript stack trace -----
1: handleInitializationError (…/nest-factory.js:123:21)
exit code 134
```

**看不到是哪一行、哪个 provider。** 两侧 bootstrap 都关掉它 ——
关掉之后 `main.ts` 的 `catch` 才能用脱敏 logger 记下真正的失败原因
（本次就是靠这个才看到 3.1 那条错误）。失败依旧是失败（`exitCode = 1`），
只是**可见了**。

---

## 4. ⚠ 新增端到端冒烟 —— 这是 00–13 之后第一次有人真的把整个 API 起起来

`apps/api/test/e2e-smoke.integration.spec.ts`（7 项，**真 MySQL + 真 Redis**）：

```text
健康检查在根路径（/health/live、/health/ready 都是 200）
/today 返回封套与 featured/latest
公开面**游客可读**（featured / x / people / topics / daily/archive 都不需要登录）
需要登录的路由仍然 401（守卫真的生效，而不是被挂载顺序弄丢）
后台路由对匿名者是 401（不是 200，也不是 500）
/api/v1/subscriptions 不存在（规则 §13）
未知路径 404 而不是 500（错误过滤器在工作）
```

**为什么它必须存在**：在它之前**没有任何一个测试跑过完整的 `AppModule`** ——
每个模块测试只 `imports` 自己的模块，而 `boot.spec.ts` 用的是空壳。
§3 那三个缺陷全都落在这个盲区里。

**与 `boot.spec.ts` 的分工**（两者都升级了）：

|      | `boot.spec.ts`                                       | `e2e-smoke.integration.spec.ts`          |
| ---- | ---------------------------------------------------- | ---------------------------------------- |
| 依赖 | **没有** MySQL / Redis 也能跑                        | 真库真 Redis，连不上直接失败             |
| 证明 | 依赖图能解析、测试期不开消费者、`/health/*` 在根路径 | 路由真的可达、守卫真的生效、状态码真的对 |

---

## 5. 验证（全部实测）

```text
pnpm lint                       ✓
pnpm -r typecheck（4 个包）      ✓
npx vitest run --maxWorkers=4   ✓ 85 文件 / 1932 测试
api 集成（真库真 Redis）         ✓ 11 文件 / 145 测试（+7 = 端到端冒烟）
worker 集成（真 Redis）          ✓ 8 文件 / 145 测试
pnpm test:db                    ✓ 26
pnpm ops:verify                 ✓ 73 项
pnpm --filter @signal/web build ✓ 23 条路由
```

⚠ **`--maxWorkers=4` 是标准验收命令**（全量审查报告 §4 的发现，我复核认可）：
默认 85 个 worker 会压机器，导致真监听端口的测试**假红**（`boot` / `auth-mail` /
`common-http`，单独复跑全过）。它反而更快（41s vs 45s）。
但**涉及 `visual-contract` / `contract-parity` 的失败是真失败**，不要当噪声。

### 我在基线（`e43bcd5`，含全量审查的 5 个重构提交）上独立复核过

审查报告声称「行为零变化」。**我没有采信它的自述**，在它之上重跑了全部
lint / typecheck / 单测 / 两套集成 / build / ops —— 数字与它报告的一致。
所以那个基线可信。

---

## 6. ⚠ 已知限制（**如实列出我没做 / 做不掉的**）

### 6.1 worker 侧仍是 **4 份 `PrismaClient`**（一个进程 4 个连接池）—— **我没收敛**

全量审查把它列为「Agent 14 的 `AppModule` 决策」，我**没有做**。理由与代价：

- 收敛要：新建一个 `@Global()` 的 worker `PrismaService`、改 4 个模块的 `providers`、
  改 4 个仓储的注入点（它们各自 import 自己那份 `PrismaService`），
  并核对 worker 侧 8 个测试文件的 override。
- 收益是资源（4 个连接池 → 1 个），**不是正确性**：四份都能工作，且都惰性连接。
- 我把它**降级为「已知的资源浪费」而不是「阻塞项」**，因为本次剩余预算里
  「真的跑起来」的优先级更高，而这是可独立完成的一件小事。

**建议**：作为一个独立的小任务做（不需要碰任何公开面）。
另外：`ai/index.ts` 与 `content/index.ts` **都 re-export 同名的**
`JOB_RUN_RECORDER` / `NoopJobRunRecorder` —— 在同一个文件里同时 import 两者会撞名。
当前无人这么做（我从 `module.ts` 直接 import 规避了），但收敛时要一并处理。

### 6.2 ⚠ **Web 的点击级验证仍然为零**

本次做到了 **API 级**的端到端（真进程、真 HTTP、真库）。但
**前台与后台的浏览器交互一次都没被验证过**：收藏、译文切换、登录抽屉、
批量审核、发布日报、Source 增删改、标记已读……

那需要一个真浏览器（Playwright）对着**跑起来的 API + web** 走一遍。
现在环境终于具备了（`AppModule` 已挂载），只是本次没做。

⚠ 这个盲区已经造成过一次真实事故（`/` 被 Agent 00 的占位页吃掉，
「今日」从头到尾不可达，而构建通过、`curl /` 返回 200、30 项守卫全绿）。

### 6.3 一条进程级未处理的 rejection（Redis 在**启动时**不可达）

**现象**：Redis 不可达时，挂载 `AppModule` 会产生 **1 条**未处理的 rejection
（`AggregateError: connect ECONNREFUSED …:6379`）。功能无影响，
但 `pnpm test` **退出码非零**（尽管 85 文件 / 1932 测试全部通过）。

**已定位到哪一步**：

```text
逐个模块 alone（compile + init + close）→ 全部 0
四种连接建法（裸 ioredis×2 / BullMQ options / BullMQ 实例）+ 两者的组合 → 全部 0
分阶段（create / listen / request / close）× 两个 app 连着起 → 全部 0
**把 SourcesModule 从 AppModule 摘掉 → 0；装回去 → 1**
```

也就是说：**只有「完整 AppModule + Redis 不可达」这个组合**才触发，
而它的成因落在 BullMQ 自己的连接引导里（它会在内部再驱动一次 connect），
从应用侧改不到。

**我试过并撤掉的两个改动**（如实记录，避免下一个人重走）：

| 试过                                                            | 结果                  | 处置                                 |
| --------------------------------------------------------------- | --------------------- | ------------------------------------ |
| 让 `BullSourceFetchEnqueuer` 自己持有 ioredis 实例再传给 BullMQ | **没修好**（仍 1 条） | **已撤**（注释会变成假声明）         |
| 给 `public-read` 的 client 加 `lazyConnect: true`               | **没修好**            | **已撤**，同上                       |
| 给入队连接加 `lazyConnect: true`                                | 从 2 条降到 1 条      | **保留**（注释已改成实测效果，不吹） |

**另一处被证伪的猜测**：不是「缺 error 监听器」—— 两个连接都挂了监听器，
ioredis 的 stderr 噪音已经是 0；漏的是 **promise**，不是事件。

**Redis 可达时为零**（实测：`REDIS_URL=redis://127.0.0.1:6390` 跑 `boot.spec` → exit=0）。

### 6.4 全量审查留下的 6 项发现 / 5 条待裁决 —— **我没动**

它们是**用户尚未裁决**的（见 `work/review/审查报告.md` §6），其中三条与我的范围重叠：

| 审查的发现                                                               | 我的处置                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `AdminEditionRow` 前后端类型漂移（P3 真 bug，且**无 parity 守卫覆盖**）  | 未修。它需要同时改 `admin-types.ts` 与加一条断言 —— 属「要不要修」的裁决   |
| `prisma-enums.ts` 注释声称「有测试守卫保证」，实测**没有任何测试引用它** | 未修。这是**假安全感**，建议按审查的方案 (b)：补上那个本来就该有的枚举守卫 |
| 枚举桥接强度不对称（api 用 `includes()`、worker 用 `Record`）            | 未动                                                                       |
| 路由数 23 而非 22（我的注释写错）                                        | **已修**（连同我 HANDOFF 里 47→34 的同类错误）                             |

### 6.5 其余未验的验收项

`tasks/agent-14-integration.md` 里那 7 条「必须验证」，本 Agent **核对了覆盖情况**，
其中 4 条**在集成前就已经有全仓级守卫**（无订阅表 / 无 `/subscriptions` 路由 →
Agent 09 的 `user-features-routes.spec.ts` 扫 7 个目录含 `apps/web/app`；
X disabled 不公开 → Agent 10 的真库集成；无「我的订阅」与 hover token → Agent 13 的 34 项）。
我**没有重复造**，只补了真 HTTP 上的那一条（§4）。

**业务 Smoke 的完整链路**（Admin login → add RSS → fetch → AI → Review → Featured →
Public → Daily → Publish → User login → Bookmark → Search）**没有跑**：
它需要一次真实的端到端驱动（写库 + 队列 + worker 消费），
在本次预算内没有做。`/admin/*` 与 `/api/v1/*` 的**可达性与鉴权**已由 §4 覆盖。

---

## 7. Integration Notes（给下一步 / 运维）

1. **现在真的能起进程了**：
   ```bash
   pnpm build && node apps/api/dist/main.js      # 需要一份完整 env（会 parseEnv）
   ```
   worker 同理（`node apps/worker/dist/main.js`）—— 它不再需要 `main.ts` 里那个
   占位定时器了，但那个定时器留着无害（消费者自己有句柄）。
2. **`apps/worker/src/main.ts` 的占位 keep-alive**：文件头写着「接入 BullMQ 之后
   可以移除」。现在消费者真的会起来了，**可以在下一次改动时删掉它**（不是必须）。
3. **`NODE_ENV=test` 会关掉全部消费者与定时器** —— 任何「用测试跑真 worker」的
   想法都要注意这一点（集成测试是直接 `new SomeQueueWorker(...)`，不经过模块）。
4. **下一步建议的顺序**：
   ① 浏览器走查（§6.2，最高价值）→ ② 收敛 worker 的 4 份 PrismaService（§6.1）
   → ③ 处理审查报告那 5 条裁决（§6.4）→ ④ 跑一次完整的业务 Smoke（§6.5）。

---

## 关于 §23

**未做 §23 独立审查。** 但本次的情况有本质区别：

> 这一节的目的是「不让作者自证」。而本次交付的**全部价值就在于「真的跑起来」** ——
> 三个缺陷不是我读代码读出来的，是**启动进程**震出来的；
> §4 那 7 项端到端断言是**真 HTTP** 打的。这比一次只读审查更有说服力。

⚠ 仍然建议补一次轻量独立审查，重点看两处：

1. **§3.1 的 `useFactory` 改法**是否真的等价（我改的是 Agent 04 的 DI 形状）；
2. **§6.3 那条 rejection 的成因** —— 我只定位到「SourcesModule + Redis 不可达」，
   没有读到 BullMQ 内部那一行。如果我错了，那么「从应用侧改不到」这个结论也错。
