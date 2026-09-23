# Handoff

**Agent:** 00 — Foundation / 共享契约
**Wave:** 0（无上游依赖）
**日期:** 2026-09-23
**基线:** Development Contract v1.1 / Frontend Prototype v1.7 / Agent Rule v1.0

---

## Task

建立所有 Agent 共同工作的仓库骨架与公共契约：

- pnpm workspace、TypeScript strict、lint / format 基线
- `packages/contracts` / `packages/config` / `packages/logger`（+ `packages/test-utils`）
- `apps/web` / `apps/api` / `apps/worker` 三个可启动空壳
- test skeleton 与 root scripts

`docs/05` 的枚举必须成为全项目唯一共享 enum。

---

## Implemented

### 1. Monorepo 骨架

- pnpm workspace（`apps/*`、`packages/*`），Node >= 22，pnpm 11.15.1。
- TypeScript strict（`strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `noFallthroughCasesInSwitch`）。
- Project references（`tsc -b` 单命令编译全部 packages + api + worker）。
- `module: node16` / `moduleResolution: node16`，输出 CommonJS。
- ESLint 9+ flat config、Prettier（LF、单引号、100 列）、`.gitattributes` 统一 LF。
- Vitest 单入口，测试通过 alias 直连包源码，**`pnpm test` 无需先 build**。

### 2. `@signal/contracts`（全项目唯一公共契约）

| 文件                | 内容                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/enums.ts`      | `docs/05` 全部枚举，含 `SourceType` / `SourceKind` / `SourceTier` / `EvidenceType` / `ContentType` / `RawItemStatus` / `ContentPipelineStatus` / `EditorialReviewStatus` / `DailyEditionStatus` / `DailySectionType` / `DailyDisplayStyle` / `UserRole` / `UserStatus` / `UserTheme` / `ArticleFontSize` / `AiTaskType` / `AiRunStatus` / `JobRunStatus`，以及配套的 `*_LIST` 运行期数组 |
| `src/api.ts`        | `API_PREFIX` / `ADMIN_API_PREFIX` / `REQUEST_ID_HEADER`；`ApiEnvelope` / `CursorEnvelope` / `OffsetEnvelope` / `ApiErrorBody`；`BigIntId` / `IsoDateTimeString` / `BusinessDate`；分页常量与封套构造函数                                                                                                                                                                                 |
| `src/errors.ts`     | Error Code 命名规则（`DOMAIN_REASON`）、平台级码、文档已具名业务码、`defaultHttpStatusForCode`、`AppError`、`toApiErrorBody`（未知异常降级为 `INTERNAL_ERROR`）                                                                                                                                                                                                                          |
| `src/queues.ts`     | 6 个固定 Queue 名、10 个固定 Job 名、`JOB_TO_QUEUE` 映射、4 个幂等 JobId builder、初始并发度、重试策略                                                                                                                                                                                                                                                                                   |
| `src/time.ts`       | `BUSINESS_TIMEZONE = 'Asia/Shanghai'`、日报目标/告警时刻、`isBusinessDate`                                                                                                                                                                                                                                                                                                               |
| `src/dto/public.ts` | `PublicSource` / `EvidenceSummary` / `PublicPerson` / `PublicTopic` / `PublicContent`（逐字对齐 `reference/contracts.ts`）                                                                                                                                                                                                                                                               |

### 3. `@signal/config`

- `parseEnv()`：基于 zod 的 env 校验，**schema 与 `docs/20` 一一对应，不多不少**（有测试断言）。
- 校验失败抛 `EnvValidationError`，**只含字段名与原因，不回显字段值**。
- secret 变量拒绝 `.env.example` 的 `change-me` 占位值。
- `APP_TIMEZONE` 用 `z.literal` 冻结为 `Asia/Shanghai`。
- 业务时区工具：`businessTimezoneOffsetMs` / `businessDateOf` / `businessDayRangeUtc` / `businessTimeToUtc` / `formatInBusinessTimezone`。
- `resolveApiPort()`：从 `API_BASE_URL` 推导监听端口，**不新增 env 变量**。

### 4. `@signal/logger`

- Pino JSON，字段名严格按 `docs/15`：`timestamp`（非 pino 默认的 `time`）、`level`（字符串）、`service`，以及可选的 `requestId` / `userId` / `sourceId` / `contentId` / `jobId` / `errorCode` / `durationMs`。
- 深度 secret 脱敏（`formatters.log` 钩子）：
  - 按字段名整值脱敏 password / token / secret / otp / apiKey / authorization / cookie / dsn / credential / sessionId 等；
  - 按内容模式脱敏连接串密码（`mysql://u:***@h`）与内联 `Bearer`/`Basic` 凭据；
  - **不误伤** `code` / `errorCode` / `statusCode` 等业务字段；
  - 处理循环引用，保留 Date / Error / 类实例原型。
- `childLogger()`、`serializeError()`、`silentLogger()`。
- `createNestLoggerBridge()`：把 logger 接到 Nest 内部日志，**不引入 `@nestjs/*` 依赖**（结构化类型满足 `LoggerService`）。

### 5. 三个 app 空壳

| App           | 内容                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`    | NestJS + Express 适配器；`createApiApp()` 设置全局前缀 `/api/v1` 并开启 shutdown hooks；`main.ts` 做 env → logger → listen |
| `apps/worker` | NestJS standalone（不监听端口）；`createWorkerApp()` 返回应用上下文；`main.ts` 保持进程存活并优雅关闭                      |
| `apps/web`    | Next.js App Router；`layout.tsx` / `page.tsx` 为空壳占位，**不含任何 v1.7 设计**                                           |

`app.module.ts` / `worker.module.ts` 均为空壳，文件头注明：**总注册由 Agent 14 集成**，其他 Agent 不要在此挂载模块。

---

## Files Added

```
.gitattributes  .gitignore  .npmrc  .prettierignore  .prettierrc.json  .env.example
README.md  package.json  pnpm-workspace.yaml  pnpm-lock.yaml
tsconfig.base.json  tsconfig.json  eslint.config.mjs  vitest.config.mts

packages/contracts/{package.json,tsconfig.json}
packages/contracts/src/{index,enums,api,errors,queues,time}.ts
packages/contracts/src/dto/public.ts
packages/contracts/src/__tests__/{enums,api,errors,queues,time,no-duplicate-enums}.spec.ts

packages/config/{package.json,tsconfig.json}
packages/config/src/{index,env,timezone}.ts
packages/config/src/__tests__/{env,timezone}.spec.ts

packages/logger/{package.json,tsconfig.json}
packages/logger/src/{index,logger,redact}.ts
packages/logger/src/__tests__/{logger,redact}.spec.ts

packages/test-utils/{package.json,tsconfig.json}
packages/test-utils/src/index.ts

apps/api/{package.json,tsconfig.json}
apps/api/src/{main,bootstrap,app.module}.ts
apps/api/test/boot.spec.ts

apps/worker/{package.json,tsconfig.json}
apps/worker/src/{main,bootstrap,worker.module}.ts
apps/worker/test/boot.spec.ts

apps/web/{package.json,tsconfig.json,next.config.mjs,next-env.d.ts}
apps/web/app/{layout,page}.tsx

handoffs/agent-00-HANDOFF.md
```

## Files Modified

无（本仓库为 Agent 00 首次提交，全部为新增文件）。

---

## Database Migrations

**None**

Agent 00 未创建 `prisma/` 目录、未定义任何业务表、未生成任何 Migration。
`prisma/schema.prisma` 与 migrations 由 **Agent 01** 独占。

---

## Public Interfaces

下游 Agent 必须从这里 import，**不得复制**：

```ts
// 枚举（唯一来源）
import {
  SourceType,
  SourceKind,
  SourceTier,
  EvidenceType,
  ContentType,
  ContentPipelineStatus,
  EditorialReviewStatus,
  DailyEditionStatus,
  DailySectionType,
  DailyDisplayStyle,
  UserRole,
  UserStatus,
  UserTheme,
  ArticleFontSize,
  AiTaskType,
  AiRunStatus,
  JobRunStatus,
} from '@signal/contracts';

// API 契约
import {
  API_PREFIX,
  ADMIN_API_PREFIX,
  REQUEST_ID_HEADER,
  AppError,
  PlatformErrorCode,
  DomainErrorCode,
  toApiErrorBody,
  validationError,
  notFoundError,
  envelope,
  cursorEnvelope,
  DEFAULT_CURSOR_LIMIT,
} from '@signal/contracts';

// Queue / Job
import {
  QueueName,
  JobName,
  JOB_TO_QUEUE,
  JobId,
  QUEUE_CONCURRENCY,
  COLLECTOR_RETRY,
  AI_RETRY,
  PUBLISHING_RETRY,
} from '@signal/contracts';

// 时间
import { BUSINESS_TIMEZONE, isBusinessDate, DAILY_TARGET_PUBLISH_HOUR } from '@signal/contracts';

// 公开 DTO
import type {
  PublicSource,
  PublicContent,
  PublicPerson,
  PublicTopic,
  EvidenceSummary,
} from '@signal/contracts';

// 配置
import {
  parseEnv,
  type AppEnv,
  resolveApiPort,
  businessDateOf,
  businessDayRangeUtc,
  businessTimeToUtc,
  formatInBusinessTimezone,
} from '@signal/config';

// 日志
import {
  createLogger,
  childLogger,
  createNestLoggerBridge,
  serializeError,
  type Logger,
  type LogLevel,
} from '@signal/logger';
```

### Error Code 规则（新增，下游必须遵守）

1. 形状 `DOMAIN_REASON`，全大写 SNAKE_CASE，正则 `^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$`。
2. **一个语义只能有一个 code**，禁止 `SOURCE_MISSING` / `SOURCE_NOT_EXIST` 这类同义码。
3. 平台级码见 `PlatformErrorCode`；文档已具名的业务码见 `DomainErrorCode`。
4. 模块自己的业务码请**追加到 `packages/contracts/src/errors.ts`**，不要散落在模块内。
5. 未知错误一律 `INTERNAL_ERROR`，`toApiErrorBody()` 已保证不外泄内部信息。

---

## APIs Used

**None** —— Agent 00 不调用任何外部 API，也不注册任何业务路由。

`apps/api` 只设置了全局前缀 `/api/v1`，无 controller。

---

## Events / Queues

Agent 00 **未注册任何 Queue 或 Job**，只在 `@signal/contracts/src/queues.ts` 中**声明契约**：

Queue：`collector` / `content-pipeline` / `ai` / `publishing` / `notification` / `maintenance`

Job：`collector.fetch-source` / `content.normalize` / `content.dedup` / `content.event-cluster` / `ai.translate` / `ai.classify-score` / `publishing.daily-draft` / `publishing.daily-publish` / `notification.admin-email` / `maintenance.cleanup`

JobId 幂等格式由 `JobId.*` builder 统一生成，**禁止各模块自行拼字符串**。

---

## Environment Variables

`.env.example` 逐字复制 `docs/20`。**未新增任何变量。**

`@signal/config` 的 `envSchema` 恰好覆盖 `docs/20` 的 38 个变量（有测试断言）。
`findUnknownEnvKeys()` 可用于检测未记录变量。

必填（无默认值）：`APP_BASE_URL`、`API_BASE_URL`、`DATABASE_URL`、`REDIS_URL`、`AUTH_ACCESS_TOKEN_SECRET`、`AUTH_REFRESH_TOKEN_PEPPER`、`EMAIL_OTP_PEPPER`。

主要默认值：`NODE_ENV=development`、`APP_TIMEZONE=Asia/Shanghai`（literal 冻结）、`SMTP_PORT=587`、`S3_REGION=auto`、`AI_DAILY_BUDGET_USD=5`、`SOURCE_FETCH_MAX_BYTES=2097152`、`SOURCE_FETCH_TIMEOUT_MS=10000`、`LOG_LEVEL=info`。

---

## Tests

| 测试文件                                                 | 覆盖验收项                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/.../enums.spec.ts` (15)              | 逐条对照 `docs/05` 的枚举值，禁止改名不改值                                                                                   |
| `packages/contracts/.../no-duplicate-enums.spec.ts` (28) | **`无重复 enum`**：静态扫描仓库，27 个公共类型名只允许在 `packages/contracts` 声明                                            |
| `packages/contracts/.../api.spec.ts` (5)                 | API 前缀、封套形状、默认分页                                                                                                  |
| `packages/contracts/.../errors.spec.ts` (9)              | Error Code 命名规则、HTTP status 映射、`AppError` 序列化、内部异常不外泄                                                      |
| `packages/contracts/.../queues.spec.ts` (6)              | Queue / Job 名、Job→Queue 映射、JobId 幂等格式、并发度、重试策略                                                              |
| `packages/contracts/.../time.spec.ts` (6)                | 业务时区常量、业务日格式校验                                                                                                  |
| `packages/config/.../env.spec.ts` (16)                   | **`env validation`**：合法性、缺字段、非法值、占位 secret 拒绝、错误信息不含 secret、**schema 与 docs/20 一一对应**、端口推导 |
| `packages/config/.../timezone.spec.ts` (13)              | 业务日边界（UTC 16:00 跨日）、UTC 区间、上海钟点换算                                                                          |
| `packages/logger/.../redact.spec.ts` (12)                | 字段名判定、连接串/内联凭据脱敏、嵌套与数组、循环引用、不误伤业务字段                                                         |
| `packages/logger/.../logger.spec.ts` (15)                | **`logger secret redaction`**：字段契约、`timestamp` 而非 `time`、密码/token/OTP/Authorization 不明文、child logger           |
| `apps/api/test/boot.spec.ts` (2)                         | **`contracts import`** + api 空壳**真实监听 HTTP**（`fetch` 得到 404 证明 HTTP 栈已起）                                       |
| `apps/worker/test/boot.spec.ts` (2)                      | **`contracts import`** + worker standalone 上下文可创建/关闭                                                                  |

## Test Results

```
pnpm lint          ✓ 0 errors
pnpm typecheck     ✓ tsc -b 全绿 + web tsc --noEmit 全绿
pnpm test          ✓ 12 files / 129 tests passed
pnpm format:check  ✓ All matched files use Prettier code style
```

额外的**进程级验证**（真实启动，非进程内）：

```
$ node work/probe-apps.mjs
--- API ---
http status from /api/v1/__probe__ : 404      ← HTTP 栈已起
logged "signal api started"        : true
RESULT: PASS
--- WORKER ---
logged "signal worker started"     : true
still alive after 3s               : true     ← 进程持续存活
RESULT: PASS
OVERALL: PASS

$ pnpm --filter @signal/web build
✓ Compiled successfully in 3.4s
✓ Generating static pages (4/4)                ← Next.js 15.5.25
```

## Commands

```bash
pnpm install          # 安装依赖
pnpm build            # tsc -b：编译 packages + api + worker
pnpm typecheck        # tsc -b + web tsc --noEmit
pnpm lint             # ESLint
pnpm test             # Vitest（无需先 build）
pnpm format           # Prettier
pnpm verify           # lint && typecheck && test  ← 验收命令
pnpm clean            # 清理 dist / tsbuildinfo
```

启动：

```bash
pnpm build
pnpm --filter @signal/api start       # 端口取自 API_BASE_URL
pnpm --filter @signal/worker start
pnpm --filter @signal/web dev
```

---

## Known Limitations

1. **`apps/api` 监听端口由 `API_BASE_URL` 推导，而非独立 env。**
   `docs/20` 没有 `API_PORT`，为遵守「不得新增未记录 env」，实现为从 URL 推导（无端口时回退 3001）。
   如需显式端口，应由 Agent 11 提交 Contract Change Request。

2. **Worker 使用占位定时器保持进程存活。**
   空的 Nest standalone 上下文没有任何句柄持有事件循环，进程会立刻退出。
   `apps/worker/src/main.ts` 放了一个占位 `setInterval`，接入 BullMQ 后应移除。

3. **App 测试文件不在 `tsc` 项目内。**
   `apps/*/test/**` 被 `tsconfig` 的 `include` 排除（避免污染 `dist`）。
   它们仍受 ESLint 检查、由 Vitest 真实执行，但不参与 `tsc --noEmit` 类型检查。

4. **TypeScript 固定在 6.0.3，未使用 7.x。**
   `typescript-eslint@8.70.1` 明确不支持 TS 7.0（会直接报错退出），且 TS 7 移除了 `moduleResolution: node10`。
   待 typescript-eslint 支持 TS 7.1 后可由 Agent 14 统一升级。

5. **Next.js 提示 ESLint 插件未接入。**
   `next build` 输出 `The Next.js plugin was not detected in your ESLint configuration`。
   我们使用仓库级 flat config，未引入 `eslint-config-next`。属于提示，不影响构建。

6. **`apps/web` 是纯占位页，不含任何 v1.7 设计。**
   `layout.tsx` / `page.tsx` 仅有 bootstrap 文本。颜色 token、版式、交互由 Agent 13 实现。

7. **未创建 `prisma/`、`infra/`、`docs/` 目录。**
   分别属于 Agent 01、Agent 11 与后续 Agent。

---

## Contract Change Requests

**None** —— Agent 00 未发现必须修改公共契约的问题。以下 2 项已记录但**不构成变更请求**，不阻塞任何下游：

1. **Error Code 无完整清单。**
   文档只给了规则（`DOMAIN_REASON`）与两个具名码（`SOURCE_NOT_FOUND`、`INTERNAL_ERROR`）。
   Agent 00 在 `packages/contracts/src/errors.ts` 落地了规则 + 注册表位置，并**刻意只预置文档已具名的业务码**，避免替其他 Agent 发明语义。
   各模块 Owner 请按规则把业务码追加到该文件。

2. **`docs/02` 提到的 `ContentStatus` 在 `docs/05` 中实际叫 `ContentPipelineStatus`。**
   文档措辞不一致，非契约冲突。Agent 00 以 `docs/05` 为准，未另建 `ContentStatus`。

---

## Integration Notes

### 给所有下游 Agent（01–13）

1. **公共类型只能从 `@signal/contracts` import。**
   复制 `SourceType`、`ContentPipelineStatus` 等会直接让 `pnpm test` 失败（`no-duplicate-enums.spec.ts`）。
2. **不要碰 `prisma/`**（Agent 01）、**不要碰 `infra/`**（Agent 11）。
3. **不要在 `apps/api/src/app.module.ts` 或 `apps/worker/src/worker.module.ts` 挂模块。**
   根注册由 Agent 14 统一完成，否则并行开发必然冲突。
   模块请放 `apps/api/src/modules/<module>/`，Job 放 `apps/worker/src/jobs/<area>/`。
4. 新增数据库字段 → `CONTRACT_CHANGE_REQUEST.md`，不要改 schema。
5. 新增 env → 先改 `docs/20` 契约，再改 `envSchema`，两者必须同步（有测试断言）。
6. 业务错误码追加到 `packages/contracts/src/errors.ts`。

### 给 Agent 01（Prisma / MySQL）

- 需要 `prisma/schema.prisma` 的 enum 与 `@signal/contracts` 保持一致，**值名逐字相同**。
- `packages/contracts/src/__tests__/enums.spec.ts` 是枚举的守卫，改动枚举会立刻暴露。
- 主键统一 `BIGINT UNSIGNED`，API 层序列化为 string（`BigIntId`）。

### 给 Agent 02（Auth）

- `UserRole` / `UserStatus` / `UserTheme` / `ArticleFontSize` 已就绪。
- AdminGuard 请复用 `PlatformErrorCode.FORBIDDEN` / `UNAUTHORIZED`。
- Auth 相关业务码请按 `DOMAIN_REASON` 追加到 contracts。

### 给 Agent 03（Source Registry）

- `SourceType` / `SourceKind` / `SourceTier` 及对应 `*_LIST` 运行期数组已就绪，可直接用于 type-specific config 校验。
- `DomainErrorCode.SOURCE_NOT_FOUND` 已按 `docs/02` 预置。
- `SOURCE_FETCH_MAX_BYTES` / `SOURCE_FETCH_TIMEOUT_MS` 已在 `AppEnv` 中可用，SSRF 校验器请复用。

### 给 Agent 04–08（Collector / Pipeline / AI / Publishing）

- **必须使用 `JobId.*` builder 生成 JobId**，不要自行拼字符串，否则幂等会被破坏。
- `JOB_TO_QUEUE` 可用于注册时避免挂错队列；并发度与重试策略取 `QUEUE_CONCURRENCY` / `*_RETRY`。
- 日志请用 `createLogger({ service: 'worker' })` + `childLogger(logger, { jobId, requestId })`。

### 给 Agent 11 / 14（Ops / Integration）

- `@signal/logger` 提供 `createNestLoggerBridge()`，可直接 `app.useLogger(...)`，无需额外依赖 pino。
- `/health/*` 按契约**不在** `/api/v1` 下。`createApiApp()` 已设置全局前缀，接入健康检查时请用 `setGlobalPrefix` 的 `exclude` 选项，不要改常量。
- `apps/worker/src/main.ts` 的占位定时器在 BullMQ 接入后应移除。
- 建议由 Agent 14 评估把 TypeScript 升级到 7.x（等 typescript-eslint 支持后）。

### Git

- 仓库：`E:\desk\Signal-Project-Package-v1.2\Signal`，初始分支 `main`。
- Agent 00 的提交即 trunk 基线，**Agent 01 及之后请从 `main` 开分支**（如 `agent/01-database`），合回 `main`。
- 提交署名：Jov3c。

---

## 结论

Agent 00 的 5 项验收全部通过：

| 验收项                                          | 结果                                                          |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `pnpm lint && pnpm typecheck && pnpm test` 通过 | ✅ 129/129                                                    |
| 三个 app 空壳可启动                             | ✅ api 真实监听 HTTP、worker 持续存活、web `next build` 成功  |
| 无重复 enum                                     | ✅ 27 个公共类型名静态扫描唯一                                |
| contracts import                                | ✅ api / worker 测试断言，web 构建通过                        |
| env validation                                  | ✅ 16 项测试，schema 与 docs/20 一一对应                      |
| logger secret redaction                         | ✅ 27 项测试，密码/token/OTP/Authorization/连接串凭据均不明文 |

**Agent 01 / 02 / 03 / 06 可以开始（Wave 0 剩余 + Wave 1）。**
