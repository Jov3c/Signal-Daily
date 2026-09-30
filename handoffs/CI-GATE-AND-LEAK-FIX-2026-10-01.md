# CI 测试门禁 + 一条已解决的老问题 — 2026-10-01

| 项       | 值                                                                |
| -------- | ----------------------------------------------------------------- |
| **起因** | `WALKTHROUGH-FOLLOWUP-2026-09-30.md` §5.1：部署流水线没有测试门禁 |
| **提交** | （本次）                                                          |
| **基线** | `0e01050`                                                         |

---

## 1. CI 测试门禁（`deploy.yml` 新增 `test` job）

### 1.1 改之前是什么样

`.github/workflows/deploy.yml` 是**唯一**的工作流，它此前是：

```text
push to main → docker build ×3 → VPS pull → migrate → compose up → healthcheck → 切流量
```

**从头到尾没有一步跑 lint / typecheck / test。** 而仓库里有 1950 个测试。

所以：**一个会让登录链断掉的提交可以直接部署到生产。**
这不是假设 —— `ed0b1a1` 修掉的那个登录缺陷（`verifyEmailCode` 漏读
`{data:…}` 封套 → 登录成功后整页崩）在修好之前一直存在，
而它所在的提交是推到了 main 的。

### 1.2 改之后

```text
test ──► build ──► deploy
```

`build` 增加 `needs: test`。测试不过 → 不构建 → 不迁移 → 不切流量。
**回滚 job 不受影响**（它走 `failure()`，用的是已存在的镜像）。

`test` job 的步骤（**逐条在本地按同样顺序复现过**）：

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm -r typecheck        ← ⚠ 见下
pnpm test:ci
pnpm ops:verify
```

### 1.3 ⚠ 两个不能想当然的地方

**（a）`pnpm typecheck` 和 `pnpm -r typecheck` 都要，不是重复。**
根的 `pnpm typecheck` 只做 `tsc -b` + 单独跑 web；而 `@signal/api` 与
`@signal/worker` 各自的 typecheck 里还有一句 `tsc -p test/tsconfig.json` ——
**只有 `-r` 那一遍会检查 `apps/*/test/**`**。删掉它，两个 app 的测试目录
就重新变成「不参与类型检查」，而那正是 `mail-sender.ts` 里记着的老毛病。

**（b）新增了 `test:ci` 脚本**（`vitest run --maxWorkers=4`），CI 用它而不用 `pnpm test`。
理由：默认会给每个测试文件起一个 worker（本仓库 86 个），把机器压到
真监听端口的测试**假红**（`boot` / `auth-mail` / `common-http`）。
⚠ 但 `visual-contract` / `contract-parity` / `client-api` 的红**是真红**。
（`pnpm test` 本身**没有**改动，避免影响既有习惯。）

### 1.4 ⚠ 这个 job 一开始**是红的** —— 而这正是它的价值

写完 job 后我先在本地逐条复现，发现 `pnpm test:ci` 的**退出码是 1**
（1950 项全过，但报 1 条 unhandled rejection）。
**照那样提交，门禁会每次都失败、把部署全堵死 —— 比没有门禁更糟。**

于是没有绕开它，而是去查了。见 §2。

---

## 2. ⚠ 那条「从应用侧改不到」的 unhandled rejection —— **已解决**

`agent-14-HANDOFF.md` §6.3 把它列为已知限制，结论是
「成因落在 BullMQ 自己的连接引导里，从应用侧改不到」。**那个结论是错的。**

### 2.1 先更正两处失实的记录

| §6.3 的说法                                   | 2026-10-01 实测                                               |
| --------------------------------------------- | ------------------------------------------------------------- |
| `AggregateError: connect ECONNREFUSED …:6379` | 复现出来的是 `Error: Connection is closed.`（完全不同的形状） |
| 「Redis **可达**时为零」（实测 6390）         | **可达时照样复现**（`boot.spec` 单跑，exit=1）                |

所以 §6.3 里那句「Redis 可达时为零」**今天复现不出来**，不要再拿它作依据。

### 2.2 真正的根因（这次读到了确切的代码行）

```text
ioredis/built/Redis.js:220   ← connect() 内部注册的 connectionCloseHandler
    reject(new Error("Connection is closed."))
```

被拒绝的不是「某条 Redis 命令」，而是 **`client.connect()` 这个 promise 本身**。
它由 BullMQ 持有（`bullmq/dist/cjs/classes/node-redis-client.js` 的 `connectPromise`）。

BullMQ 的 `RedisConnection.close()` 只在 `status === 'ready'` 时走 `quit()` 那条干净路径；
**只要连接还在 `initializing`，它就走 `disconnect()`**，而那个 `connectPromise`
随之被拒绝、且**没有任何人接** —— 它 `disconnect()` 里那句
`this.initializing?.catch(() => {})` 只盖住了 `init()`，盖不住 `connectPromise`。

**而 `lazyConnect: true` 恰恰制造了「关闭时仍处于 initializing」这个状态**：
惰性连接意味着构造函数之后连接从未建立，于是 `app.close()` 来的时候状态
必然是 `initializing`。这是一个**自造的必现竞态**，不是运气问题。

### 2.3 修法：把同一个理由走完

`source-enqueuer.ts` 的文件头本来就说「入队是**用户触发**的，
启动期本来就不需要这条连接」。既然不需要连接，那就**也不需要 Queue**：

```ts
private queue: Queue<CollectorFetchSourcePayload> | null = null;

private getQueue(): Queue<CollectorFetchSourcePayload> {
  this.queue ??= new Queue(QueueName.COLLECTOR, { connection: this.connectionOptions });
  return this.queue;
}
```

`close()` 在从未入队时直接返回。于是**任何没有入队的进程**
（`boot.spec` 整条测试、端到端冒烟、以及生产里没人点「立即抓取」的时刻）
根本不会创建这个 Queue，也就没有那条连接。

### 2.4 效果（实测）

```text
boot.spec.ts 单跑              exit 1 → exit 0（零 error）
pnpm test:ci（86 文件 1950 项） exit 1 → exit 0
```

**执行语义零变化**：入队路径、JobId 幂等、超时、fail-closed 503 全都没动
（`sources-queue.integration.spec.ts` 用的是真实实现，145 项集成全绿）。

⚠ 顺带更正了 `sources-scheduling.spec.ts` 里那条注释 ——
它原本写着 `lazyConnect` 已经解决了这件事。**没有**，它只把 rejection
从 2 条降到 1 条。那个断言（精确 `toEqual`）**保留**：`lazyConnect` 仍然是
「连接不该在启动期建立」这条语义的一半。

---

## 3. 顺带修掉一条**随日历变红**的集成测试

`apps/api/test/admin-ops-db.integration.spec.ts` 的「按 jobType 筛选时看不到别的类型」
在 2026-10-01 变红（**确证与本次改动无关**：`git stash` 后同样红）。

原因：

```text
它往 job_runs 插了一条 startedAt = 2026-09-30T03:00:00Z 的行，
然后断言「未筛选的 page 1（50 条）里必须出现它」。
而 job_runs 是**共享表**，历次集成测试不断追加 startedAt 更新的行 —— 于是被挤出第一页。
```

也就是说那条断言随**日历**和**跑过多少次**而变。
仓库自己的约定是「共享库上的断言必须是**增量**，不是绝对值」，这条正好违反了它。

改为用**带筛选**的查询确认前提（「确实存在另一类 jobType」），
验的还是同一件事，但不再依赖「谁更新」。修完 `admin-ops` 16 项全绿。

---

## 4. 验证（全部实测，退出码均为 0）

```text
pnpm lint                          ✓
pnpm typecheck                     ✓
pnpm -r typecheck                  ✓
pnpm test:ci                       ✓ 86 文件 / 1950 项   exit=0（修复前是 1）
pnpm ops:verify                    ✓ 73 项
api 集成（真库真 Redis）            ✓ 11 文件 / 145 项
worker 集成（真 Redis）             ✓ 8 文件 / 145 项
pnpm test:db                       ✓ 26 项
```

---

## 5. 这次**没有**做的（如实列出）

### 5.1 集成测试**没有**进 CI 门禁

门禁目前只跑单元层。原因是**我无法在本地验证 GitHub Actions 的 service
container 配置**，而写一个「没验过、又会拦住部署」的 job，风险方向是错的
（假红 = 堵死部署）。

要加的话，配方是现成的：给 `test` job 加 `services: mysql:8.4` + `redis:7`
（都带 healthcheck），跑一次 `prisma migrate deploy`，再把
`pnpm --filter @signal/api test:integration` 与
`pnpm --filter @signal/worker test:integration` 接上。
**建议单独做一次，并且第一次推送时盯一眼。**

### 5.2 真浏览器层（Playwright）

按用户 2026-10-01 的决定「加，先只覆盖登录链路」——**尚未开始**。

### 5.3 其余

`agent-14-HANDOFF.md` §6.1（worker 侧 4 份 PrismaService）、§6.4（审查报告待裁决）、
§6.5（完整业务 Smoke）均**未动**。
