/**
 * Worker 的**统一开关**：这次进程要不要真的启动队列消费者与定时器。
 *
 * ── 为什么必须有这个东西（Agent 14 的决策）──────────────────────────
 * 四个 Job 模块（collectors / ai / content / publishing）都会在
 * `onModuleInit` 里真的 `new Worker(queue)`，其中三个还各带定时器。
 * 它们在 `WorkerModule.imports` 为**空数组**时一切正常 —— 因为根本没有模块被挂上。
 *
 * 而集成（把四个模块挂进 `WorkerModule`）会让 `apps/worker/test/boot.spec.ts`
 * 立刻开始：连 Redis（BullMQ 不会同步抛错，而是**后台无限重连**）、
 * 在 provider 工厂里跑 `parseEnv()`（缺 env 直接抛）、
 * 并触发 `OnApplicationBootstrap` 的调度定时器。
 *
 * **四个模块的文件头都写了同一句话**：统一开关「应当是 Agent 14 对一个 app 内
 * 所有队列模块的**统一决策**」，它们刻意没有各自发明（`docs/18`：不要在
 * 自己的模块里解决跨模块的问题）。这个文件就是那个统一决策。
 *
 * ── 为什么是一个函数，而不是一个注入 token ──────────────────────────
 * 直觉方案是 `WORKER_START_CONSUMERS` 这个 provider token + 各模块 `@Inject`。
 * **不这么做**有两个具体理由：
 *
 * 1. **Nest 的 provider 是模块作用域的。** 若各业务模块自己 `providers` 里给
 *    一个默认值，`WorkerModule` 就**覆盖不掉**它（模块内那份赢）；若只在
 *    `WorkerModule` 里给，那么**每一个**单独 `Test.createTestingModule({imports:
 *    [AiWorkerModule]})` 的测试（worker 侧有 8 个测试文件）都必须自己再补一个
 *    provider —— 那是把「一个开关」变成「8 处记得补」。
 * 2. 这个开关的语义是**进程级**的（「这次进程要不要跑消费者」），不是依赖注入
 *    意义上的协作对象。它没有替身可换 —— 换掉它等于换掉被测行为本身。
 *
 * 所以：一个纯函数，模块在 `onModuleInit` / `onApplicationBootstrap` 的**第一行**
 * 调用它并 early-return。要改判定规则只改这一个文件。
 *
 * ── 判定规则 ────────────────────────────────────────────────────────
 * `NODE_ENV === 'test'` → 不启动。
 *
 * - Vitest 默认就会把 `NODE_ENV` 设成 `test`，所以普通单测自动安全；
 * - **集成测试不受影响**：那些测试是**直接 `new SomeQueueWorker(...)`**
 *   （见 `apps/worker/test/publishing-queue.integration.spec.ts`），
 *   根本不经过模块，所以它们照样能验真消费者。
 * - `development` / `production` 都不匹配 → 照常启动（本地 `pnpm dev` 要真跑）。
 *
 * ⚠ **没有新增 env**（`docs/20` 的清单不变）：用的是既有的 `NODE_ENV`，
 * 而它已经在 `@signal/config` 的 schema 里被校验为
 * `'development' | 'test' | 'production'` 三选一。
 *
 * ── 它**不**管什么（边界要清楚）─────────────────────────────────────
 * 它只管「**消费者与定时器**」。provider 的**实例化**照常发生 ——
 * `parseEnv()` 仍会被调用（那些是 `useFactory` 的 config 与连接），
 * Prisma 客户端仍会被构造（惰性连接，不会真连）。
 * 所以 `NODE_ENV=test` 下启动一个 worker 上下文**仍需要一份合法的 env** ——
 * 那是刻意的：**不想要的连接**与**没有配置**是两件事，后者应该报错。
 */

/** 该进程是否应当启动队列消费者与调度定时器。 */
export function shouldStartConsumers(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NODE_ENV'] !== 'test';
}
