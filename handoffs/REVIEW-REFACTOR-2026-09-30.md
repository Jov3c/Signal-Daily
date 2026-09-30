# 全量审查 + 纯整理重构 —— 交接说明（给 Agent 14）

> 2026-09-30 · 起点 `66ff7c1` → 终点 `646f437`（5 个提交，已在 `main`）
> **这不是 Agent 14 的任务书**，只是一次「不改行为的整理」留下的说明。
> 读它的理由：有两条路径变了、有几件事刻意留给你。

---

## 0. 一句话

对 00–13 的全部代码做了一次**纯整理**：消除重复、收敛副本。
**公开导出名零变化、行为零变化、测试代码零改动。**
1930 单测 + 138 api 集成 + 145 worker 集成 + 23 条路由构建 + ops:verify 73 项，全部实测通过。

---

## 1. ⚠ 给 Agent 14 的三条要点

### 1.1 两个文件被删除，路径变了（**导出名不变**）

| 被删 | 新家 |
|---|---|
| `apps/worker/src/jobs/ai/enum-guard.ts` | `apps/worker/src/common/contract-enum.ts` |
| `apps/worker/src/jobs/collectors/contract-enum.ts` | 同上 |

两个文件**整个文件只有 `toContractEnum` 一个函数**，而这一函数在 worker 里有三份逐字相同的副本，已收敛为一份。

- `apps/worker/src/jobs/content/contract-enum.ts` **仍在**（另有 5 个内容专属映射函数），只是把 `toContractEnum` 改为转出。
- **全仓已无任何指向那两个旧路径的 import**（已核）。
- ⚠ 但**三份历史文档仍指向它们**，读到时请以本节为准：
  - `handoffs/agent-06-HANDOFF.md:119`
  - `handoffs/CONTRACT_CHANGE_REQUEST-agent-06.md:182`、`:183`

### 1.2 `JOB_RUN_RECORDER` 同名注册 —— 挂根模块时请看一眼

```
apps/worker/src/jobs/ai/module.ts:67        { provide: JOB_RUN_RECORDER, ... }
apps/worker/src/jobs/content/module.ts:68   { provide: JOB_RUN_RECORDER, ... }
apps/worker/src/jobs/publishing/module.ts   PUBLISHING_JOB_RUN_RECORDER  ← 刻意换了名字
```

`ai` 与 `content` 用的是**同名 token**，而 `publishing` 当初**刻意**改成 `PUBLISHING_JOB_RUN_RECORDER`，理由写在它的文件里：「同名 token 在多模块同一 Nest app 里排查时分不清」。

把三个模块挂进同一个根模块时，这一处值得你确认一次。（NestJS 的 provider 是模块作用域的，通常没问题 —— 但这是别人踩过并主动绕开的点，**本次重构没有动它**。）

### 1.3 刻意留给你决策的两件事（我没有越权做）

1. **三份近乎相同的 `PrismaService`（content / ai / publishing）** —— 正确解法是**全局单例**，那是 `AppModule` 层面的事，属你的活。本次未动。
2. **跨 app 的重复** —— 剩下的生产代码重复**基本都是 api ↔ worker 跨 app 的**（`preflight.ts`、日/发布仓储、`source-enqueuer` ↔ `source-queue`、scoring、枚举桥接的 api 那份、Redis 连接解析的 api 那份）。项目约束是「跨 app 只能共享 `packages/*`」，而**已有 3 个 Agent 把它写进 CCR 等你裁决**。为一个 8 行函数新建工作区包会净增加复杂度，所以我没建。

> 另：`preflight.ts` 的两份 225 行重复**经用户裁决保持不动** —— 它有 `daily-preflight-parity.spec.ts` 逐字节守卫，搬家会让那条守卫空转。

---

## 2. 改了什么（5 个提交）

```
ebfdc81  worker: content 复用 ai 的 Redis 连接解析
696a2d1  worker: 枚举桥接收敛为一份（删掉 2 个整文件）
cf98f0b  api:    校验工具收敛到 common/validation（新建）
e36af1f  web:    后台 9 页收敛取数/标签/翻页（新建 lib/admin-fetch.ts）
646f437  worker,api: JobId 段数判定回收到契约；auth 登录响应去重
```

| 重复的东西 | 改前 → 改后 |
|---|---|
| `invalid()` 校验抛出 | 10 → 1（`apps/api/src/common/validation/`） |
| 后台取数 + 401/403 兜底 | 9 → 1（`apps/web/lib/admin-fetch.ts`） |
| `isBullMqAcceptableJobId()` | 4 → 1（回收到 `@signal/contracts` —— 它**本来就在契约里**） |
| `toContractEnum()` | 4 → 2 |
| 本地 `ListResponse` 类型 | 5 → 0（改用 `lib/api.ts` 已有的 `OffsetPage<T>`） |
| Redis 连接解析 / `hasControlCharacter` / `parsePositiveInt` / 翻页块 / 登录响应 | 各 2～3 → 1 |

**36 个文件，+409 / −470 行。**

### 对你可能有影响的接口面（**名字都没变**）

- `@signal/contracts` 的 `BULLMQ_JOBID_SEGMENTS` / `isBullMqAcceptableJobId` 现在被 worker 的 ai / content / publishing **直接使用**（以前是各抄一份）。三个模块仍导出旧名（`BULLMQ_JOBID_MIN_SEGMENTS` 等），**下游无感**。
- api 各模块的 `invalid` 等仍从原路径导出（新增的唯一实现在 `common/validation`）。
- `apps/web/lib/admin-types.ts` 与 `lib/types.ts` **一个字没动**（它们被 `contract-parity.spec.ts` 用字面量 `type X = {` 死死绑定，动了一定红）。

---

## 3. 顺带核实的既有问题（**只报未改**，供你决定要不要碰）

| # | 问题 | 级别 |
|---|---|---|
| 1 | 前端 `AdminEditionRow`（`apps/web/lib/admin-types.ts:230`）声明了后端**不存在**的 `id`（后端是 `editionId`），且漏了后端确实存在的 `editionNoLabel`；注释把真源指错（`repository.ts` → 实为 `service.ts` 的 `EditionSummary`）；**无任何 parity 守卫覆盖** | P3 真 bug（潜伏） |
| 2 | `apps/api/src/common/prisma/prisma-enums.ts:6` 的注释写「两套值完全相同（**有测试守卫保证**）」—— 实测**没有任何测试引用该文件** | P3 真 bug（假安全感） |
| 3 | 枚举桥接强度不对称：worker 用 `Record<契约,Prisma>`（缺键即**编译错**），api 用 `includes()` 白名单（契约加值**不报错**，仅运行期抛） | P3 设计取舍 |
| 4 | 实际路由是 **23 条**（14 前台 + 9 后台），而 `visual-contract.spec.ts:264` 的注释与交接说明都写 22 | P4 文档 |

---

## 4. 一条会反复坑到验收的环境问题

本次全量测试**两次**出现超时假红，两次都集中在**真监听端口**的测试（`boot` / `auth-mail` / `common-http`），单独复跑全部通过 —— 原因是并行压机器（vitest 默认一次开 85 个 worker）。

**建议标准验收命令**：

```bash
npx vitest run --maxWorkers=4
```

**反而更快**（36s vs 45s）且不再假红。

⚠ 但请注意区分：**若失败涉及 `visual-contract.spec.ts` 或 `contract-parity.spec.ts`，那是真失败**，不要当成环境噪声。

---

## 5. 完整报告

`work/review/审查报告.md`（在仓库外，**不进仓库**）。含逐批说明、9 项发现、5 条待用户裁决、以及「明确不做的事」及理由。
