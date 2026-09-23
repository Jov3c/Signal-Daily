# Handoff

**Agent:** 02 — Auth / Users
**Wave:** 1（上游：Agent 00、Agent 01）
**日期:** 2026-09-23
**提交:** `cc3e4be` `7537180` `b1d4548` `bfc6bad`
**状态:** ✅ **已合并进 `main` 并推送到 GitHub**（`origin/main` = `bfc6bad`，分支 `agent/02-auth` 保留）
**基线:** Development Contract v1.1 / Frontend Prototype v1.7 / Agent Rule v1.0

> 下游直接 `git pull` `main` 即可，不必先合分支。

> ⚠ **先读文末的「补遗（§23 独立审查）」再看正文结论。**
> 正文记录了交付时的实现与验证；补遗记录了独立审查在「全绿」状态下查出的
> 1 个 P1 + 5 个 P2，以及它们的修复与**下游必须注意的破坏性变更**。

---

## Task

`tasks/agent-02-auth.md`：实现 Email OTP、GitHub OAuth、Session、用户身份、AdminGuard。

- 允许修改：`apps/api/src/modules/auth/**`、`apps/api/src/modules/users/**`、`apps/api/src/common/guards/**`
- 禁止：不改 Prisma、不改 shared enums、不开放 USER→ADMIN API
- 输出：稳定 `AuthGuard` 与 `AdminGuard`

---

## Implemented

### 1. Email OTP 登录（`docs/11`：6 位 / 10 分钟 / hash 存储 / 限流 / 防重放）

| 项 | 实现 |
| --- | --- |
| 验证码 | `crypto.randomInt`（CSPRNG）生成 6 位数字 |
| 存储 | `HMAC-SHA256(EMAIL_OTP_PEPPER, "signal:otp:v1:<email>:<code>")`，只存 64 位 hex；**库中无明文字段** |
| 时效 | 10 分钟（`expiresAt`），过期即失效 |
| 消费 | `updateMany({ where: { id, consumedAt: null } })` + 影响行数判定 —— 并发下只有一个请求能消费成功 |
| 重放 | 已被消费的码再次提交 → `AUTH_OTP_ALREADY_USED`（与「码错误」区分开） |
| 防枚举 | 无论邮箱是否已注册，`request-code` 一律返回 `{sent:true,expiresInSeconds:600}` |
| 作废旧码 | 每次 `request-code` 在一个事务里先作废该邮箱未消费的码，再插入新码 |
| 写冲突 | 并发 `request-code` 的 InnoDB 写冲突（P2034）做有限重试，不再冒泡成 500 |

首次验证通过即注册（`findOrCreateByEmail`，同时写默认 `UserPreference`）。

### 2. GitHub OAuth

- `GET /auth/github` → 写 HttpOnly state Cookie 后 302 到 GitHub（scope 只要 `read:user user:email`）
- `GET /auth/github/callback` → state **三重校验**后换 token、读资料、建/找用户、签发会话，302 回 `APP_BASE_URL`
- state = `<nonce>.<issuedAt>.<HMAC>`：签名防伪造、时间戳防重放（10 分钟）、Cookie 双提交防登录 CSRF；同名 Cookie 出现多次直接拒绝
- 未配置 `GITHUB_CLIENT_ID/SECRET` → 503 `AUTH_GITHUB_NOT_CONFIGURED`（本地未配，属预期）
- **账号合并只认「已验证邮箱」**（见补遗 P1）；不持久化 provider access token（两列为 NULL）

### 3. Session（`docs/11`：Access 15min / Refresh 30d）

- Access Token：HS256 JWT，显式锁定 `algorithms:['HS256']` + `iss`/`aud`/`exp` 校验，载荷只放 `sub`/`sid`/`role`
- Refresh Token：32 字节随机串，库中只存 `HMAC-SHA256(AUTH_REFRESH_TOKEN_PEPPER, ...)`
- Cookie：`HttpOnly` + `SameSite=Lax` + 生产 `Secure`；access `Path=/`，refresh 收窄到 `Path=/api/v1/auth`
- **严格轮换**：每次 refresh 作废旧会话、建新会话；提交已轮换的 token 视为凭据泄露 → **撤销该用户全部会话**
- 登出：refresh Cookie 与 `Authorization` 头两条路径都能定位会话，**不需要有效的 access token**，幂等
- 会话过期与撤销**都会**让认证立刻失效（见补遗 P4）

### 4. `AuthGuard` / `AdminGuard`（交付给下游的稳定能力）

- 每次认证请求 = **一次数据库查询**（`sessions` join `users`），因此**登出 / 撤权 / 禁用立刻生效**，而不是等 access token 过期（最长 15 分钟）
- `AdminGuard` 显式委托 `AuthGuard`（不用继承：TS 不会把基类的 `design:paramtypes` 带给子类）
- 未认证 → 401 `UNAUTHORIZED`；已认证但非 ADMIN → 403 `FORBIDDEN`

### 5. Rate limit（`docs/14`：Redis 控制）

- 维度：`otp:request:email`(3/10min)、`otp:request:ip`(10/1h)、`otp:verify:email`(5/10min)、`auth:refresh:user`(60/1h)、`auth:refresh:unknown`(10/1h)
- Redis 固定窗口用 **Lua 原子**执行（`INCR` + 首次 `PEXPIRE`）——分成两条命令时进程中断会留下**永不过期的计数器**，该用户被永久限流
- **fail-closed**：Redis 不可用时 `consume()` 抛错（请求 500），绝不静默放行
- 键里存的是邮箱/IP 的 SHA-256 摘要（`docs/11`：不建立用户画像，Redis 里不留明文）
- 超限复用平台码 `RATE_LIMITED`（429），**没有新造 `AUTH_RATE_LIMITED` 同义码**

### 6. 公共地基（Agent 02 落地，**下游复用，勿重复实现**）

| 位置 | 内容 |
| --- | --- |
| `common/prisma/` | `PrismaService`（`@Global()`）、`toBigIntId`/`toIdString`、`toContractEnum`（Prisma↔契约枚举桥接） |
| `common/http/` | 统一错误封套 `APP_FILTER`、requestId 解析、Cookie 序列化/解析 |
| `common/logger/` | `APP_LOGGER` 注入点（`main.ts` 用它接管 Nest 内部日志） |
| `common/common.module.ts` | 汇总以上并 `@Global()` |

---

## Files Added

```
apps/api/src/common/common.module.ts
apps/api/src/common/guards/{admin.guard,auth.guard,current-user.decorator,index,ports}.ts
apps/api/src/common/http/{app-error.filter,cookies,http-types,index,request-id}.ts
apps/api/src/common/logger/app-logger.ts
apps/api/src/common/prisma/{bigint-id,prisma-enums,prisma.module,prisma.service}.ts

apps/api/src/modules/auth/
  access-token.service.ts  auth-cookies.ts  auth.config.ts  auth.constants.ts
  auth.controller.ts  auth.module.ts  auth.service.ts  clock.ts
  github.client.ts  mail-sender.ts  oauth-state.ts  otp.service.ts
  prisma-auth.repository.ts  rate-limit.service.ts  rate-limiter.ts
  redis-rate-limiter.ts  repository.ts  session.service.ts
  dto/auth.dto.ts

apps/api/src/modules/users/
  users.module.ts  users.service.ts  user.repository.ts
  prisma-user.repository.ts  dto/me.dto.ts

apps/api/test/
  auth-email-otp.spec.ts  auth-session.spec.ts  auth-github.spec.ts
  auth-guards.spec.ts  auth-mail.spec.ts  github-client.spec.ts
  common-http.spec.ts  auth-contract.spec.ts  di-wiring.spec.ts
  auth-review-regressions.spec.ts
  auth.integration.spec.ts            (真 MySQL + 真 Redis)
  auth-db-semantics.integration.spec.ts (真 MySQL 仓储语义)
  support/{fakes,test-app,source-scan}.ts
  tsconfig.json

apps/api/vitest.integration.config.mts
handoffs/agent-02-HANDOFF.md
handoffs/CONTRACT_CHANGE_REQUEST-agent-02.md
```

## Files Modified

```
apps/api/package.json            + 依赖（@prisma/client 6.19.3 / ioredis / jsonwebtoken /
                                   nodemailer / @nestjs/testing）、typecheck 纳入测试目录、
                                   + test:integration 脚本
packages/contracts/src/errors.ts 仅**追加** AUTH_* / USER_* 业务码（新增 33 行，删除 0 行）
pnpm-lock.yaml                   依赖锁定
```

**未改动**：`prisma/**`、`apps/api/src/app.module.ts`、`bootstrap.ts`、`main.ts`、
`packages/contracts` 的其余文件、`apps/web/**`、`apps/worker/**`、根 `package.json`、`eslint.config.mjs`。

---

## Database Migrations

**None**

Agent 02 未创建任何 Migration，未改动 `prisma/schema.prisma`。

实际用到的表（均由 Agent 01 建好）：`users`、`user_preferences`、`auth_accounts`、
`email_otp_codes`、`sessions`。

---

## Public Interfaces

### 给下游 Agent 用的守卫

```ts
import { AuthGuard, AdminGuard, CurrentUser, requireAuthUser } from '../../common/guards';
import type { AuthUser } from '../../common/guards';

@UseGuards(AuthGuard)  @Controller('bookmarks')  class BookmarksController { ... }
@UseGuards(AdminGuard) @Controller('admin/xxx')  class AdminController { ... }
```

所在模块 **必须** `imports: [AuthModule]`（AuthModule 已 export 守卫及其依赖 token）。
`@CurrentUser()` 返回 `AuthUser = { id: string; role: UserRole; sessionId: string }`（id 是 string）。

### 给下游 Agent 用的公共能力

```ts
import { PrismaService } from '../../common/prisma/prisma.service';   // @Global，直接注入
import { toBigIntId, toIdString } from '../../common/prisma/bigint-id';
import { toContractEnum, toUserRole, toUserStatus } from '../../common/prisma/prisma-enums';
import { envelope, cursorEnvelope } from '@signal/contracts';
import appErrorFilter 相关：见 common/http（**不要重复注册**）
```

错误响应统一由 `common/http/app-error.filter.ts` 输出，业务代码只要
`throw new AppError({ code, httpStatus, safeMessage, details })` 即可。

### 本模块对外契约（与 `docs/04` 逐字一致）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/auth/email/request-code` | `{email}` → `{data:{sent:true,expiresInSeconds}}` |
| POST | `/api/v1/auth/email/verify` | `{email,code}` → `{data:{user,accessTokenExpiresInSeconds}}` + 会话 Cookie |
| GET | `/api/v1/auth/github` | 302 到 GitHub（未配置 → 503） |
| GET | `/api/v1/auth/github/callback` | 302 回站点；失败 → JSON 错误（`AUTH_OAUTH_STATE_INVALID` 等） |
| POST | `/api/v1/auth/refresh` | 读 refresh Cookie → `{data:{user,...}}` + 轮换后的 Cookie |
| POST | `/api/v1/auth/logout` | → `{data:{loggedOut:true}}` + 清除 Cookie（幂等） |
| GET | `/api/v1/me` | `{data:{id,email,displayName,avatarUrl,role,createdAt}}`（需认证） |

路由表**精确等于**上表 7 条（有测试枚举 express 路由表做守卫，多一条即红）。

---

## APIs Used

**None** —— 不调用任何外部业务 API。

对外只有两处 HTTP 出站，均在 `github.client.ts` 内且**只在配置了 GitHub 时才发生**：

- `https://github.com/login/oauth/access_token`（换 token，10s 超时）
- `https://api.github.com/user` 与 `/user/emails`（读资料；强制 `User-Agent`）

---

## Events / Queues

**None** —— Agent 02 未注册任何 Queue 或 Job，未 import `@signal/contracts` 的队列常量。

---

## Environment Variables

**未新增任何 env 变量**，只使用 `docs/20` 已记录的那些：

`AUTH_ACCESS_TOKEN_SECRET`、`AUTH_REFRESH_TOKEN_PEPPER`、`EMAIL_OTP_PEPPER`、
`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL`、
`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM`、
`DATABASE_URL`、`REDIS_URL`、`APP_BASE_URL`、`NODE_ENV`、`LOG_LEVEL`。

本地现状：三个 secret 已配置；**GitHub 与 SMTP 未配置**。

### 邮件通道（重要，本地登录要用）

| 条件 | 行为 |
| --- | --- |
| 配了 `SMTP_HOST` + `SMTP_FROM` | 真实 SMTP 投递（nodemailer） |
| 未配 + `NODE_ENV=production` | **503 `AUTH_MAIL_NOT_CONFIGURED`**，绝不降级 |
| 未配 + 非生产 | 把验证码写到 **stderr**（`[signal dev-mail] ... code=xxxxxx`），本地才登得进去 |

设计取舍：`docs/14` 禁止把 OTP 明文写进日志，而本地又必须拿到验证码。
折中是「仅非生产 + 直写 stderr（不经过 pino）」，因此**验证码不会进入结构化日志流**。
已用测试证明结构化日志里不含验证码（`auth-contract.spec.ts`）。

---

## Tests

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `auth-email-otp.spec.ts` | 19 | 契约形状、只存 hash、防枚举、旧码作废、限流 429、错误/过期/重放/未请求、并发双消费、邮箱归一化、requestId 回显 |
| `auth-session.spec.ts` | 16 | 无凭据 401、Bearer 形态、篡改/别密钥/alg=none/过期/结构非法、refresh 轮换与重放撤销、30 天过期、登出即时失效、禁用用户 |
| `auth-github.spec.ts` | 16 | 302 + state Cookie、state 不匹配/缺失/篡改/过期/重复 Cookie、取消授权、换取失败 502、未配置 503、账号复用与绑定 |
| `auth-guards.spec.ts` | 18 | 守卫真 HTTP 行为（403/401 区分、升权/撤权即时生效）、无 HTTP 的单元分支、token 提取顺序 |
| `github-client.spec.ts` | 15 | **真实客户端**（stub fetch）：授权 URL、HTTP 200 + body.error、非 2xx、网络异常、**未验证邮箱不得采用**、超长邮箱丢弃 |
| `auth-mail.spec.ts` | 10 | 通道选择（生产无 SMTP → 503）、SMTP 发信内容、控制台实现的生产双保险、装配真跑 |
| `common-http.spec.ts` | 25 | Cookie 序列化/解析边界、requestId 形状与幂等、异常→错误封套映射、真 HTTP 过滤器不外泄 |
| `auth-contract.spec.ts` | 21 | 路由**精确等于**契约、订阅/提权端点不存在、源码围栏（无 subscription / 无角色写入 / 无原生 SQL）、错误码在册、日志无查询串、/me 字段白名单、413 |
| `di-wiring.spec.ts` | 7 | 构造参数必须显式 `@Inject`（防 `emitDecoratorMetadata` 退化）+ 真解析依赖 |
| `auth-review-regressions.spec.ts` | 19 | §23 审查发现的逐条回归守卫（见补遗） |
| `auth.integration.spec.ts` | 11 | **真 MySQL + 真 Redis**：OTP 全流程、hash 形态、重放、轮换、登出、限流真计数与 TTL、fail-closed、env→config |
| `auth-db-semantics.integration.spec.ts` | 10 | **真 MySQL 仓储语义**：条件更新的二次失败与时间戳不被覆盖、并发消费恰好一次、并发 request-code 无 P2034、列宽收敛、utf8mb4 往返、默认偏好、findOrCreate 不覆盖 |

## Test Results

```
$ pnpm verify
✓ lint 0 errors
✓ typecheck（tsc -b + web tsc --noEmit + apps/api/test 首次纳入类型检查）
✓ 23 files / 381 tests passed

$ pnpm test:db
✓ 1 file / 26 tests passed        （Agent 01 的库集成测试，回归确认未被我破坏）

$ REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration
✓ 2 files / 21 tests passed       （真实 MySQL 8.4.11 + 真实 Redis 8.8.0）

$ node work/_agent02/probe-dist-auth.mjs      （进程级 E2E，直接跑编译产物 dist）
PASS POST /auth/email/request-code -> 200
PASS 开发用验证码已投递到 stderr（ConsoleMailSender 装配正确）
PASS POST /auth/email/verify -> 200
PASS GET /me -> 200 且 id 是 string（BIGINT 序列化）
PASS POST /auth/refresh -> 200（SessionService/AccessTokenService 均已注入）
PASS GET /auth/github -> 503（本机未配 GitHub）
PASS POST /auth/logout -> 200 且之后 /me 立刻 401
OVERALL: PASS

$ python work/_agent02/counterproof-agent02.py   （反证：故意改坏实现，确认守卫变红）
16/16 RED（有牙齿），0 条无牙齿 / 0 条 harness 错误
```

> `prod` 形态的 Cookie（`Secure`）由 `auth-review-regressions.spec.ts` 与
> `auth-contract.spec.ts` 的 `secureCookies: true` 用例覆盖。

## Commands

```bash
pnpm verify                                                    # lint + typecheck + 单测（无需数据库）
pnpm test:db                                                   # Agent 01 的库集成测试
REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @signal/api test:integration
pnpm --filter @signal/api run build                            # 构建后跑 dist E2E 需要
REDIS_URL=redis://127.0.0.1:6390 node work/_agent02/probe-dist-auth.mjs
python work/_agent02/counterproof-agent02.py                   # 反证（会自动还原，需干净工作区）
```

本地 Redis（`docs/20` 默认 6379 未运行，集成测试用临时实例）：

```bash
"E:/redis/Redis-8.8.0-Windows-x64-cygwin-with-Service/redis-server" \
  --port 6390 --save '' --appendonly no
```

---

## Known Limitations

1. **`apps/api/src/app.module.ts` 没有挂载 AuthModule**（按 `docs/18` 归属 Agent 14）。
   因此 `node apps/api/dist/main.js` 起来后 `/api/v1/auth/*` 全是 404。
   集成前必须由 Agent 14 在根模块 `imports: [CommonModule, AuthModule]`。见「Integration Notes」第 1 条。
2. **`pnpm db:seed` 里的 ADMIN 用户没有任何登录凭据**（无密码字段）。
   用 `admin@signal.local` 走 OTP 登录**会被 `AUTH_MAIL_NOT_CONFIGURED` 之外的路径挡住**吗？
   不会 —— 只要邮箱能收信即可登录，`role=ADMIN` 由库里的行决定。本地未配 SMTP 时
   走 stderr 打印的验证码即可。**AUTH 模块不提供任何改角色的接口**（`docs/13`）。
3. **测试目录的类型检查没有接入根 `pnpm verify`**。
   `apps/api` 的 `typecheck` 脚本已包含 `tsc -p test/tsconfig.json`，
   但根 `typecheck` 直接跑 `tsc -b`（Agent 00 的脚本），不会调用它。
   建议 Agent 14 在根脚本里补 `pnpm --filter @signal/api run typecheck`。
4. **`pnpm format:check` 在 `handoffs/README.md` 上失败**，且**在我改动之前就是如此**
   （Agent 01 提交的看板文件未过 Prettier）。我按 §24.4「只改自己那一行」没有重排整份文件。
5. **access token 的 `exp` 用系统时间**（jsonwebtoken 内部取 `Date.now()`），
   而 OTP / 会话时长走可注入的 `Clock`。生产两者同源；测试里用「签发已过期 token」
   与「直接改会话 expiresAt」两种方式覆盖，而不是推进假时钟。
6. **`display_name` / `avatar_url` 超长会被**截断**到列宽（120 / 1024）**。
   取舍：截断好过 P2000 → 该用户永久无法用 GitHub 登录。超长邮箱则**丢弃**（不截断）。
7. **未实现 TOTP 二次验证**（`docs/14` 注明「TOTP 可作为 V1.1」）。
8. **未做 CSRF token**。会话 Cookie 是 `SameSite=Lax`，跨站 POST 不带 Cookie；
   所有变更类端点都是 POST。`docs/14` 提到「敏感 Admin mutation 进行 Origin check + CSRF token」——
   `/admin/*` 属 Agent 03/07/12，若需要请在那里补（`AuthModule` 未注册全局 CSRF 中间件）。
9. **`X-Forwarded-For` 取最后一段**，前提是 api 端口不直接对公网暴露（见 CCR-02-3）。
   若直连，`req.socket.remoteAddress` 才是可信来源。
10. **`auth.integration.spec.ts` 的限流用例会清空 `ratelimit:auth:*` 键**。
    与其它 Agent 的集成测试并行跑时可能互相影响（脚本已 `fileParallelism: false`）。

---

## Contract Change Requests

见 **`handoffs/CONTRACT_CHANGE_REQUEST-agent-02.md`**（3 项，均不阻塞下游）：

1. 把 `MeDto` / Auth 响应 DTO 提升到 `packages/contracts`（供 09 / 12 / 13 共享）
2. `PlatformErrorCode` 增加 `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE`
3. `docs/16` 写明「api 不得直接对公网暴露 / XFF 信任边界」

对 `packages/contracts/src/errors.ts` 的改动是**纯追加**（新增 33 行，删除 0 行），
未改动任何既有 code 或规则，符合 Agent 00 HANDOFF「模块业务码追加到该文件」的要求。

---

## Integration Notes

### 1. 给 Agent 14（最终集成）—— **阻塞项**

- **根模块必须挂载**，否则整个 Auth 在真实进程里不可用：
  ```ts
  // apps/api/src/app.module.ts
  @Module({ imports: [CommonModule, AuthModule] })
  ```
- **不要再注册全局异常过滤器**：`CommonModule` 已经提供 `APP_FILTER`（统一错误封套）。
  重复注册会导致封套被套两层。
- `CommonModule` / `PrismaModule` 是 `@Global()`：下游不必重复 import。
- 建议把 `pnpm --filter @signal/api run typecheck` 接进根 `typecheck`（见 Known Limitations 3）。

### 2. 给 Agent 03 / 07 / 12（Admin 相关）

- `/api/v1/admin/*` 用 `@UseGuards(AdminGuard)`，并在模块里 `imports: [AuthModule]`。
- AdminGuard 按**库里的当前角色**判权：撤权立刻生效（不必等 token 过期）。
- 403 = 已认证但非管理员；401 = 未认证。前端据此区分「去登录」与「无权限」。
- 业务错误码请按 `DOMAIN_REASON` 追加到 `packages/contracts/src/errors.ts`（勿在本模块内散落）。

### 3. 给 Agent 09（Bookmark / Reading / Preferences）

- 直接用 `@UseGuards(AuthGuard)` + `@CurrentUser()`，`user.id` 是 string（BIGINT 已转）。
- `GET/PUT /me/preferences` 属你的范围：本模块**只提供 `GET /me`**，
  且路由面守卫断言「表里只有 7 条路由」——你新增 controller 后该断言只对 Auth 模块的路由表生效
  （守卫读的是自己那套测试应用），不会误伤你。
- 用户偏好由 `findOrCreateByEmail` 在建号时自动创建，不必你补行。

### 4. 给 Agent 13（Public Web v1.7）

- **刷新必须 single-flight**：refresh 是**严格轮换**，
  同一个 refresh token 并发刷新两次，其中一次会被判定为重放并**撤销该用户全部会话**
  （用户会被强制登出）。请在客户端串行化刷新（或加互斥锁）。
- 登录/登出的回调：`GET /auth/github` → callback 成功后 **302 到 `APP_BASE_URL`**，
  **不附带任何状态查询参数**。需要 `?auth=ok` 之类请走 CCR。
- `GET /me` 只返回身份字段（6 个），不含偏好与收藏。
- 401 表示「未登录或会话已失效」，前端应清理本地状态并静默走刷新或跳登录。

### 5. 给 Agent 11（Ops）

- **Redis 是登录路径的硬依赖**：限流 fail-closed，Redis 挂了 OTP 登录直接失败（500）。
  请确保 Redis 与 MySQL 一样有存活监控。
- 未配 `SMTP_HOST` 时**生产环境登录不可用**（503），必须先在部署里配好 SMTP。
- nginx 的 XFF 与 api 端口暴露要求见 CCR-02-3。
- MySQL 8.4 无 `mysql_native_password`（Agent 01 已提醒）。

---

# 补遗（2026-09-23）：§23 独立审查后的缺陷修复

> 本文正文的验证结果（lint / typecheck / 381 项测试 / 真库集成 / dist E2E 全绿）
> **在审查前就已经成立**，但审查仍然查出 **1 个 P1 + 5 个 P2 + 8 个 P3**。
> 以下记录「原先哪条声称过于乐观」「改了什么」「下游必须注意什么」。
>
> 审查由**两个没有本次开发上下文**的独立执行者完成（安全向 / 工程向），
> 报告与全部原始输出：
> - `work/_agent02/review-A-security.md`
> - `work/_agent02/review-B-engineering.md`

## 1. 原先过于乐观的声称（逐条更正）

| 正文/代码里的声称 | 事实 |
| --- | --- |
| 「`/user/emails` 拿不到就不绑定，**不允许用未验证邮箱**」 | **假**。代码无条件回落到 `GET /user` 的公开邮箱（GitHub 不保证其已验证），而调用方会按邮箱并入已有账号 → 可接管他人账号。**P1** |
| 「登出即便 Cookie 里有有效 access token 也一并按 sessionId 撤销」 | **假**。控制器永远传 `sessionId: undefined`，那条分支是**死码**；只带 `Authorization` 头的客户端登出后会话仍在。**P2** |
| 「refresh 限流按用户」 | **名不副实**。主体是 refresh token 的摘要，而 token 每次都轮换 → 计数器每次都是新的，限额**永不触发**。 |
| 「`X-Forwarded-For` 取第一跳」（当时作为已记录的设计取舍） | 取第一段时客户端可**完全伪造**，per-IP 限流实测 30/30 放行。已改为取最后一段。**P2** |
| 「会话过期」 | 只由 refresh 路径判定；已过期但未撤销的会话在 `/me` 上**仍能用**（最长 15 分钟）。 |
| 「外部字段超长」 | GitHub 昵称 > 120 字符 → Prisma P2000 → **该用户永久无法用 GitHub 登录**。**P2** |
| 「错误日志只记 method/url/status」 | url 含**查询串** → `/auth/github/callback?code=...` 的 **OAuth code 进了日志**。**P3** |
| 「并发安全」 | `request-code` 并发时 InnoDB 写冲突 P2034 未捕获，稳定复现 `200 + 500`。**P2** |
| 「测试全绿 = 验过了」 | 反证发现 **5 处关键安全行为**（算法锁定、iss/aud、OTP 哈希绑邮箱、refresh 原子轮换、access Cookie 清除 Path）改坏后测试**依然全绿**；真实仓储的条件更新删掉后也全绿（测试只打内存替身）。**P3** |

**新发现（本轮自查）**：首次 GitHub 登录只要带了邮箱，就会走
`findOrCreateByEmail(email)` 建号，**昵称与头像被丢掉**。

## 2. 修复内容与影响范围

| # | 修复 |
| --- | --- |
| P1 | `github.client.ts` 删掉对公开邮箱的回落：只认 `/user/emails` 里 `verified === true`；超长邮箱**丢弃**（不截断，截断会指向另一个人） |
| P2 | `replaceActiveOtp` 捕获 P2034 做**有限重试**（3 次 + 退避），数据不变量不变 |
| P2 | 登出改为「refresh token + access token 两条路径都试」；access token 过期不影响登出 |
| P2 | 仓储边界按列宽截断 `displayName`/`avatarUrl`（`email` 不截断） |
| P2 | `clientIp()` 改取 XFF **最后一段**（两种 nginx 写法下都不可伪造，无需 nginx 特殊配合） |
| P2 | `findAuthenticatedSession` 加 `expiresAt > now`；内存替身同步 |
| P3 | `refresh` 限流主体改为 **userId**（认不出身份时按 token 摘要兜底） |
| P3 | `AppErrorFilter` 日志 URL **去掉查询串**（`pathForLog`） |
| P3 | `AppErrorFilter` 识别 `err.status` 4xx（body-parser），413 不再变 500 |
| P3 | OTP `requestIpHash` 改用 `EMAIL_OTP_PEPPER`（不再与 refresh 共用密钥材料） |
| 新 | `findOrCreateByEmail(email, defaults)`：**仅新建时**采用昵称/头像，已有用户不覆盖 |
| P3 | 路由面守卫改为**精确等于**契约（枚举 express 路由表）；源码围栏补「原生 SQL / ADMIN 字面量」并写入残余缺口 |
| P3 | `apps/api/test` **首次纳入类型检查**，并修掉此前看不见的 3 个类型错误 |

## 3. ⚠ 下游必须注意的破坏性变更

1. **`refresh` 的限流键语义变了**：从「按 token 摘要」改为「按 userId」
   （更早的版本等于没限流）。行为上更严，不会误伤正常客户端。
2. **登出会真的撤销会话**（此前对「只带 Bearer」的客户端是静默失效）。
   若前端此前依赖「登出后旧 token 还能用一会」，现在会立刻 401。
3. **`GET /auth/github` 的 `state` Cookie 名与 Path 未变**，但 **callback 会清掉它**；
   前端不要缓存该 Cookie。
4. **错误码**：错误/过期/重放的验证码分别是 `AUTH_OTP_INVALID` / `AUTH_OTP_EXPIRED` /
   `AUTH_OTP_ALREADY_USED`；登出后刷新得到 `AUTH_SESSION_REVOKED`（不是 `AUTH_SESSION_INVALID`）。
   **Agent 13 请按这三个码分别提示**。
5. **413 请求体现在返回 413（此前是 500）**；`details` 里带
   `retryAfterSeconds`（仅 429）。
6. `apps/api` 的 `typecheck` 脚本现在**也检查测试目录**（更慢一点，但没有副作用）。

## 4. 反证（§23.4 要求「确认守卫有牙齿」）

`work/_agent02/counterproof-agent02.py` 对 16 条关键修复逐条「故意改坏 → 跑测试 → 还原」：

```
最终结果：16/16 RED（有牙齿），0 条无牙齿，0 条 harness 错误

过程中发现并修掉的两条**假绿**（重要）：
- JWT 算法锁定 / iss·aud：原用例随便写了 sid='1'，token 校验被绕过时
  401 依然出现，只是原因变成了「会话不存在」。改为使用真实会话的 sid/sub，
  并配「同载荷 + 正确算法 → 200」的对照。
- OTP 哈希绑邮箱：原用例走「A 的码验 B」，但 B 根本没有未消费的码，
  401 与哈希无关。改为直接断言密码学属性（同码不同邮箱 → 哈希不同、≠明文）。
```

## 5. 审查确认「没问题」的项（附证据）

路由与 `docs/04` 逐字一致；`{data}` / `{error:{code,message,requestId,details}}` 封套一致；
BIGINT id 序列化为 string；错误码全为 `DOMAIN_REASON` 且在册；
**未使用任何 `docs/20` 之外的 env**；未实现订阅/收藏/偏好/admin 业务接口；
`prisma/`、`app.module.ts`、`bootstrap.ts`、`main.ts` 零改动；
`errors.ts` 纯追加（删除行数 = 0）；
OTP 只存 HMAC 哈希、6 位 / 10 分钟、重放 / 并发 / 跨邮箱均被拒；
限流原子 + 有 TTL + fail-closed；JWT alg / iss / aud / exp / 结构校验；
refresh 轮换与重放全撤销；带 Cookie 登出即时失效；AdminGuard 以库中角色为准；
无 USER→ADMIN 运行入口；Cookie 四项属性与清除 Path；无明文凭据进日志；
provider access token 未持久化（两列保持 NULL）；
**dist 的 `design:paramtypes` 完好、Nest 能解析全部依赖**；
并发 verify 与 `findOrCreateByEmail` 无 5xx 且幂等。

## 6. 无法在本环境验证（需人工确认）

1. GitHub 是否允许把**未验证**邮箱设为公开邮箱（影响 P1 的真实可利用性；
   修复后无论如何都不会采信，属纵深防御）。
2. 生产 nginx 是否会覆盖/追加写 `X-Forwarded-For`（已改为末段取值，
   两种写法都安全，但仍需确认 api 不对公网暴露）。
3. 前端是否会做 refresh single-flight（已作为要求写进 Integration Notes 第 4 条）。
4. 生产 SMTP 是否能投递（本地未配）。
5. `SENTRY_DSN` 若启用，日志是否会外发（本模块只保证**不产生**含凭据的日志行）。
6. `pnpm format:check` 对 `handoffs/README.md` 的既有失败（Agent 01 的文件，未改动）。
