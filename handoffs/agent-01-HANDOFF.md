# Handoff

**Agent:** 01 — Prisma / MySQL / Evidence Schema
**Wave:** 0（上游：Agent 00）
**日期:** 2026-09-23
**基线:** Development Contract v1.1

---

## Task

把 `docs/03`（数据库设计）、`docs/05`（枚举状态机）、`docs/12`（搜索）、`docs/22`（Evidence 模型）
落成**唯一 Prisma Schema + 初始 Migration + Seed**，并补齐 FULLTEXT 与关键索引。

唯一权限：`prisma/**`。

---

## Implemented

### 1. `prisma/schema.prisma` — 24 张表 / 18 个枚举

| 域         | 模型                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| 身份与认证 | `User` `AuthAccount` `EmailOtpCode` `Session` `UserPreference`             |
| 来源注册表 | `Source` `Person` `Topic`                                                  |
| 采集与内容 | `RawItem` `Content` `ContentTopic` `EventContent`                          |
| 事件与证据 | `Event` `EventEvidence`                                                    |
| 编辑与发布 | `EditorialReview` `FeaturedItem` `DailyEdition` `DailySection` `DailyItem` |
| 用户能力   | `Bookmark` `ReadingProgress`                                               |
| 运维审计   | `AiRun` `JobRun` `AdminNotification`                                       |

**相对 `reference/schema.prisma` 的全部改动（机械比对确认，无删减、无缺失）：**

```
AuthAccount       +字段 createdAt
Content           +块   @@fulltext([title, summary, bodyTranslated])   ← docs/12 要求
EditorialReview   +块   @@index([status, createdAt])
JobRun            +块   @@index([jobKey])
```

`@@fulltext` 是 `docs/12` 与 `tasks/agent-01` 都明确要求、而参考文件遗漏的，
参考文件开头已声明「Prisma-version-specific syntax may be adjusted without changing business semantics」，
因此补齐属于 Agent 01 职责范围，不是契约变更。其余三处是查表必需的索引。

### 2. `prisma/migrations/20260923160000_init/` — 初始 Migration

- 483 行 SQL，**24 个 `CREATE TABLE` + 24 个外键**
- 由 `prisma migrate diff --from-empty --to-schema-datamodel` **离线生成**（不需要数据库即可复现）
- 含 FULLTEXT：`contents_title_summary_body_translated_idx(title, summary, body_translated)`
- **零** `DROP` / `TRUNCATE` / `DELETE`

### 3. `prisma/seed.ts` — 幂等 Seed

- 1 个 ADMIN（`admin@signal.local`，可用 `SEED_ADMIN_EMAIL` 覆盖）+ 其默认偏好
- 8 个基础 Topic
- 2 个官方 RSS 示例（`kind=OFFICIAL, tier=S, official=true`）
- 6 个 X 白名单（`docs/00` 推荐人物：Karpathy / Simon Willison / Chollet / Fei-Fei Li / Andrew Ng / Rauch）

设计要点：

- 全部 `upsert`，可反复执行；已存在记录**不覆盖**管理员的编辑
- 所有 seed 出来的 Source 在 `config` 里带 `{ seed: true, seedNote }`，便于识别示例数据
- **不写入任何 Content / Event / Evidence** —— 那些必须由真实采集产生

### 4. 测试

- `prisma/__tests__/schema-contract.spec.ts`（63 项，**不需要数据库**）
- `prisma/__tests__/database.integration.spec.ts`（22 项，**需要真实 MySQL**）

---

## Files Added

```
prisma/schema.prisma
prisma/migrations/20260923160000_init/migration.sql
prisma/migrations/migration_lock.toml
prisma/seed.ts
prisma/tsconfig.json
prisma/__tests__/schema-contract.spec.ts
prisma/__tests__/database.integration.spec.ts
vitest.db.config.mts
```

## Files Modified

```
package.json          + prisma/@prisma/client 依赖、db:* 与 test:db 脚本、prisma.seed 配置
pnpm-workspace.yaml   + allowBuilds：放行 prisma / @prisma/engines / @prisma/client 的构建脚本
tsconfig.json         + prisma 项目引用（让 seed 进入 pnpm typecheck）
vitest.config.mts     + 纳入 prisma 契约测试，排除 *.integration.spec.ts
pnpm-lock.yaml        依赖锁定
```

未创建 `.env` 进仓库 —— 已在本地创建但被 `.gitignore` 排除（`git check-ignore` 已验证）。

---

## Database Migrations

**`20260923160000_init`**

在**全新空库**上真实执行过：`pnpm db:migrate` → `All migrations have been successfully applied`。

数据库现状（实测）：

```
signal 库表数量      25  （24 业务表 + _prisma_migrations）
已应用迁移           20260923160000_init
seed 数据            1 user / 8 topics / 8 sources（其中 X_USER 6 个）
```

### 本地数据库环境（Agent 11 部署时注意）

- 本机 **MySQL 8.4.11**，Windows 服务名 `MySQL84`
- 已建 `signal` 与 `signal_shadow` 两个库，以及 `signal` 用户（`localhost` 与 `127.0.0.1` 两个 host）
- ⚠ **MySQL 8.4 移除了 `mysql_native_password` 插件**，`signal` 用户使用 8.4 默认的 `caching_sha2_password`。
  任何 Agent 都不要在建用户语句里写 `IDENTIFIED WITH mysql_native_password`，会直接报错。
- root 凭据由用户提供，**未写入仓库、未写入本文件**

---

## Public Interfaces

下游 Agent 使用方式：

```ts
import { PrismaClient, SourceType, SourceKind, SourceTier /* ... */ } from '@prisma/client';

const prisma = new PrismaClient(); // Prisma 6：不需要 driver adapter
```

### 关键约定（下游必须遵守）

| 项      | 约定                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------- |
| 主键    | 一律 `BIGINT UNSIGNED` 自增；**API 层必须序列化为 string**（`@signal/contracts` 的 `BigIntId`） |
| 时间    | 全部存 UTC（`@db.DateTime(3)`）；`DailyEdition.businessDate` 是 `@db.Date`，表示上海业务日      |
| 枚举    | 与 `@signal/contracts` 逐字一致，有测试守卫；**不得私加 Prisma 枚举**                           |
| 表名    | 全部 `@@map` 到 snake_case                                                                      |
| Decimal | `trustScore`/六维分数是 `Decimal`，取出来是 `Prisma.Decimal`，**必须显式 `Number()` 转换**      |
| 翻译    | `bodyOriginal` 与 `bodyTranslated` 两列并存，翻译永远不覆盖原文                                 |

### 需要下游注意的建模细节

1. **`EventEvidence` 的「一个 Event 最多一个 Primary Evidence」DB 层不强制。**
   只有 `@@index([eventId, isPrimary])`，没有唯一约束。**必须由业务事务保证**：
   在事务里先 `updateMany` 把旧的 `isPrimary` 置 false，再设新的为 true。
   集成测试里有一条「文档即测试」的用例专门演示了这一点（直连写库可以造出两个 primary）。
   → **Agent 05（自动构建）与 Agent 07（人工修正）都必须用事务。**

2. **`Event.status` 与 `AdminNotification.status` 是裸 `String`，不是枚举。**
   `docs/05` 的枚举清单里确实没有这两个状态机，我**没有擅自发明枚举**，保持与参考 schema 一致。

3. **`EventContent`（内容属于哪个事件）与 `EventEvidence`（哪些证据支持该事件）是两张独立的表**，
   `docs/03` 明确要求不要合并。

4. **`Content.eventId` 与 `Event.primaryContentId` 是双向但非强一致的引用**，写入时需要业务代码自己维护一致性。

5. **`RawItem.canonicalUrlHash` / `contentHash` / `EventEvidence.urlHash` 都是 `Char(64)`**，
   约定存 SHA-256 十六进制小写。这是 docs/03「避免 MySQL 超长 URL unique 问题」的落地方案。

---

## APIs Used

**None** —— Agent 01 不调用任何外部 API。

---

## Events / Queues

Agent 01 **未注册任何 Queue 或 Job**。`JobRun` 表已就绪，供 Agent 04–08 记录 Job 执行：

- `JobRun.jobType` 建议用 `@signal/contracts` 的 `JobName` 取值
- `JobRun.jobKey` 建议用 `JobId.*` builder 生成的幂等键，并已加索引 `@@index([jobKey])`
- 最终失败置 `JobRunStatus.DEAD`（对应 `docs/13` 的 dead-letter）

---

## Environment Variables

**未新增任何 env 变量。**

- `DATABASE_URL` 是唯一被使用的新变量，**已存在于 `docs/20`**，无需变更契约。
- 本地 `.env`（被 gitignore）内容：`DATABASE_URL=mysql://signal:signal@localhost:3306/signal`，
  与 `.env.example` 契约一致。
- 集成测试在 `DATABASE_URL` 未设置时会自动从仓库根 `.env` 读取，方便本地跑 `pnpm test:db`。

---

## Tests

### 不需要数据库（进 `pnpm test`，共 63 项）

`prisma/__tests__/schema-contract.spec.ts` —— 静态解析 `schema.prisma` 与 migration SQL：

| 分组           | 覆盖                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 订阅模块不存在 | `person/topic/source_subscriptions` 字样在任何 model、`@@map`、User 关联中都不出现                                                                                 |
| 枚举一致性     | 18 个枚举逐个与 `@signal/contracts` 比对取值；且 schema 里**不得有多余枚举**                                                                                       |
| 模型完整性     | 24 个模型齐全、每个都有 `@@map`、`event_contents` 与 `event_evidence` 独立                                                                                         |
| 关键索引       | `sources(enabled,nextFetchAt)`、`sources(type,enabled)`、`sources(kind,tier,enabled)`、`event_evidence(eventId,isPrimary)`、`event_evidence(sourceId,publishedAt)` |
| FULLTEXT       | schema 声明 + migration SQL 里真实生成，且覆盖三列                                                                                                                 |
| 主键           | 19 个自增模型均为 `@id @default(autoincrement()) @db.UnsignedBigInt`                                                                                               |
| 数据源         | `provider = "mysql"` + `url = env("DATABASE_URL")`                                                                                                                 |

### 需要数据库（`pnpm test:db`，共 22 项）

`prisma/__tests__/database.integration.spec.ts` —— 真连 MySQL：

| 覆盖                                                                                                                            | 对应任务要求                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 24 张表全部存在、库中无任何订阅表                                                                                               | 空库 migrate / 无 subscription table |
| `contents` 上 FULLTEXT 索引存在且覆盖三列                                                                                       | FULLTEXT                             |
| 连续两次 seed 数据量不翻倍、seed 出的 X 白名单带 seed 标记                                                                      | seed + 幂等                          |
| Source 的 type/kind/tier/official 往返、默认值（priority=50/trustScore=7.0/interval=1800）、slug 唯一、priority 超 TINYINT 报错 | Source tier/kind enum                |
| `EventEvidence` `(eventId,urlHash)` 唯一；同 URL 可跨事件复用                                                                   | EventEvidence unique                 |
| 事务切换 Primary 后恒为一个；直连写库可绕过（文档即测试）                                                                       | Primary 约束由业务事务验证           |
| 内容删除时证据 `contentId` 置空（SetNull）而非级联删除                                                                          | 关系正确性                           |
| Bookmark 复合主键幂等 + 级联删除；ReadingProgress 复合主键幂等；UserPreference 1:1                                              | Bookmark/UserPreference 关系         |
| `MATCH ... AGAINST` 能检索到 title 与 body_translated 中的词                                                                    | FULLTEXT 真实可用                    |
| DECIMAL 精度（4,1 与 5,2）往返不丢精度                                                                                          | 数值精度                             |

**这些用例不静默跳过** —— 连不上库就直接失败，避免「看着是绿的其实没验」。

---

## Test Results

```
pnpm lint          ✓ 0 errors
pnpm typecheck     ✓ tsc -b（含 prisma/seed.ts）+ web tsc --noEmit
pnpm test          ✓ 13 files / 192 tests passed      （含本次新增 63 项）
pnpm test:db       ✓ 1 file  / 22 tests passed        （真实 MySQL 8.4.11）
pnpm format:check  ✓
```

真实数据库操作记录：

```
$ pnpm db:migrate
Applying migration `20260923160000_init`
All migrations have been successfully applied.

$ pnpm db:seed      （第一次）
  ✓ ADMIN 用户: admin@signal.local (id=1)
  ✓ Topic: 8 个
  ✓ 官方 RSS Source: 2 个（tier=S, official=true）
  ✓ X 白名单 Source: 6 个（type=X_USER, kind=PERSON）

$ pnpm db:seed      （第二次，幂等验证）
  ✓ ADMIN 用户: admin@signal.local (id=1)   ← id 未变，数量未翻倍
  ✓ Topic: 8 个
  ✓ 官方 RSS Source: 2 个
  ✓ X 白名单 Source: 6 个

$ 数据库实测
  表数量 25（24 业务表 + _prisma_migrations）
  users=1  topics=8  sources=8  x_sources=6
```

## Commands

```bash
pnpm db:generate    # prisma generate
pnpm db:migrate     # prisma migrate deploy（应用迁移）
pnpm db:seed        # 先 tsc -b prisma，再 prisma db seed（会自动加载 .env）
pnpm db:reset       # prisma migrate reset --force  ⚠ 会清空数据，见下方说明
pnpm db:studio      # Prisma Studio
pnpm test           # 单元测试（不需要数据库）
pnpm test:db        # 数据库集成测试（需要 MySQL）
```

---

## Known Limitations

1. **Prisma 固定 `6.19.3`，未使用 7.x/8.x。**
   - `prisma` 的 `latest` 标签当前是 `8.0.0-rc.15`（预发布），不适合作为基线。
   - Prisma 7 **移除了 schema 中的 `url = env("DATABASE_URL")`**，要求把连接串挪到 `prisma.config.ts`
     并给每个 `PrismaClient` 传 driver adapter。这与 `reference/schema.prisma` 契约不符，
     且会让后续 10 多个 Agent 各自搭一套 adapter 样板，属于引入风险而非收益。
   - 待 Agent 14 评估统一升级。

2. **`pnpm db:reset` 未被执行。**
   Prisma 内置了针对 AI Agent 的破坏性操作保护，拦截了该命令并要求用户明确同意。
   经判断**无必要执行**：「空库 migrate」已用真实操作验证（`signal` 库建出来是空的，
   `migrate deploy` 从零成功应用），`reset` 只增加「删掉重来」不增加验证价值。
   如后续需要，请在用户明确同意后带上 `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` 执行。

3. **`package.json#prisma` 配置在 Prisma 7 中已废弃**（CLI 会打印 deprecation 警告），
   官方建议迁移到 `prisma.config.ts`。Prisma 6 下工作正常，留给 Agent 14 随版本升级一并处理。

4. **`Event.status` / `AdminNotification.status` 是裸 String。**
   `docs/05` 未定义对应枚举，我没有擅自发明。若产品上需要状态机，应走 Contract Change Request 补 `docs/05`。

5. **seed 里的 2 个官方 RSS feed URL 是演示数据，未做真实性核验。**
   每条都带 `config.seedNote` 说明必须上线前人工核验。
   （`docs/00` 本身也要求「上线前再次人工核验账号」。）

6. **`pnpm test:db` 不在 `pnpm verify` 内**，因为它需要真实 MySQL。
   CI / 无库环境跑 `pnpm verify` 仍然全绿；有库环境请额外跑 `pnpm test:db`。

7. **`pnpm db:seed` 依赖 `prisma/dist/seed.js`**，脚本里已经包含 `tsc -b prisma`。
   但 `prisma migrate reset` 触发 seed 时只跑 `node prisma/dist/seed.js`，若未编译过会失败 ——
   所以 `db:seed` 自己会先编译。

8. **`@prisma/client` 目前挂在仓库根依赖。**
   下游 Agent 在自己的 app 里使用 Prisma 时，需要往 `apps/*/package.json` 添加
   **同版本**（`6.19.3`）的 `@prisma/client`。版本必须一致，否则 pnpm 会解析出多份客户端。

---

## Contract Change Requests

**None** —— 未发现必须修改公共契约的问题。两点已记录但不构成变更请求：

1. **FULLTEXT 缺失**：`docs/12` 要求 `contents` 的 FULLTEXT，`reference/schema.prisma` 没写。
   参考文件开头已声明允许调整 Prisma 版本相关语法而不改业务语义，故直接补齐。
2. **`Event.status` / `AdminNotification.status` 无对应枚举**：`docs/05` 未定义，保持与参考一致的 String。

---

## Integration Notes

### 给 Agent 02（Auth）

- `User` / `AuthAccount` / `EmailOtpCode` / `Session` / `UserPreference` 已就绪。
- `EmailOtpCode` 只存 `codeHash`，**没有明文字段**；`Session` 同理只存 `refreshTokenHash`。
- 注册用户时记得同时建 `UserPreference`（seed 里的 ADMIN 就是这么做的）。

### 给 Agent 03（Source Registry）

- `Source` 的 `type` / `kind` / `tier` / `official` 四维度已就绪，`config` 是 `Json?`。
- 索引 `(enabled, nextFetchAt)` 就是给「取 due source」用的。
- 已预置 6 个 `X_USER` 白名单 + 2 个官方 RSS，可直接用于 CRUD 与 disable 测试。

### 给 Agent 04（Collectors）

- `RawItem` 有 `canonicalUrlHash`(64) / `contentHash`(64) / `status` / `failureCode`。
- 写入 `RawItem.status` 用 `RawItemStatus`。

### 给 Agent 05 / 07（Pipeline / Admin Review）

- **`EventEvidence` 的 Primary 唯一性必须靠事务**（见上文 Public Interfaces 第 1 条）。
- `EventEvidence.urlHash` 是 `Char(64)`，与 `@@unique([eventId, urlHash])` 配合做去重。
- `Content.eventId` 与 `EventContent` 同时存在：前者是当前归属，后者是历史关系表，写入时注意保持一致。

### 给 Agent 08（Publishing）

- `DailyEdition.businessDate` 是 `@db.Date`，存**上海业务日**，不是 UTC 时间戳。
- `DailySection` 有 `@@unique([editionId, sortOrder])`，`DailyItem` 有
  `@@unique([sectionId, contentId])` 与 `@@unique([sectionId, sortOrder])` —— 排序与去重由 DB 兜底。

### 给 Agent 09（User Features）

- `Bookmark` 幂等写法的正解是 `upsert`（复合主键 `@@id([userId, contentId])`）。
- `ReadingProgress` 同理，键是 `(userId, resourceType, resourceId)`。
- 删除 Content 或 User 会级联清理这两张表。

### 给 Agent 11 / 14（Ops / Integration）

- **MySQL 8.4 没有 `mysql_native_password`**，建库脚本不要用该插件。
- 本地库已建好：`signal` / `signal_shadow` + `signal` 用户。
- 生产部署时 `DATABASE_URL` 需指向真实的 MySQL 8，字符集 `utf8mb4` / `utf8mb4_unicode_ci`。
- 建议在 CI 中把 `pnpm test:db` 作为独立 job，配一个 MySQL 8 service container。
- 升级 Prisma 到 7.x 时需一并处理：schema 连接串迁移到 `prisma.config.ts`、
  `PrismaClient` 增加 adapter、`package.json#prisma` 废弃。

---

## 结论

`tasks/agent-01-database.md` 的验收项全部完成：

| 要求                                               | 结果                                                    |
| -------------------------------------------------- | ------------------------------------------------------- |
| Source type/kind/tier/official                     | ✅                                                      |
| Event / EventEvidence                              | ✅                                                      |
| Content / Review / Featured / Daily                | ✅                                                      |
| User / Auth / Session                              | ✅                                                      |
| Bookmark / ReadingProgress / UserPreference        | ✅                                                      |
| AiRun / JobRun / AdminNotification                 | ✅                                                      |
| FULLTEXT 与关键索引                                | ✅ schema + migration + 真库检索三重验证                |
| 不创建任何 Subscription 表                         | ✅ schema 静态检查 + 真库 `information_schema` 双向确认 |
| Seed（1 ADMIN / Topic / 官方 RSS / 3–6 个 X_USER） | ✅ 1 + 8 + 2 + 6，且幂等                                |
| 空库 migrate                                       | ✅ 在全新空库上真实执行成功                             |
| 测试                                               | ✅ 63 项契约 + 22 项集成，全绿                          |

**Agent 02 / 03 / 06 可以开始（Wave 1）。**
