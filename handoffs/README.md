# Signal — Agent 进度看板

> **所有 Agent 必读、必更新。**
> 每个 Agent 在 **§23 独立审查通过之后、生成本文件同目录的 HANDOFF 时**，必须同时更新本看板。
> 规则见《Signal 多 Agent 执行规则 v1.0》§24。

**最后更新：** 2026-09-23 · Agent 02

---

## 总览

| Wave | Agent | 任务 | 上游 HANDOFF | 状态 | 提交 | HANDOFF |
| ---- | ----- | ---- | ------------ | ---- | ---- | ------- |
| 0 | **00** | Foundation / 共享契约 | — | ✅ 已完成 | `6b5eab4` `31006c2` | [agent-00-HANDOFF.md](./agent-00-HANDOFF.md) |
| 0 | **01** | Prisma / MySQL / Evidence | 00 | ✅ 已完成 | `b8f9f36` `5cf51ef` `31006c2` | [agent-01-HANDOFF.md](./agent-01-HANDOFF.md) |
| 1 | **02** | Auth / User | 00, 01 | ✅ 已完成 | `cc3e4be` `7537180` `b1d4548` | [agent-02-HANDOFF.md](./agent-02-HANDOFF.md) |
| 1 | **03** | Source Registry / X 白名单 | 00, 01, 02 | ⬜ 未开始 | — | — |
| 1 | **06** | AI Provider / Score | 00, 01 | ⬜ 未开始 | — | — |
| 1B | **04** | Collectors | 00, 01, 03 | ⬜ 未开始 | — | — |
| 1B | **05** | Pipeline / Event / Evidence | 00, 01, 04, 06 | ⬜ 未开始 | — | — |
| 2 | **07** | Admin Review / Evidence API | 00, 01, 02, 03, 05, 06 | ⬜ 未开始 | — | — |
| 2 | **09** | Bookmark / Reading / Preferences | 00, 01, 02 | ⬜ 未开始 | — | — |
| 2B | **08** | Featured / Daily | 00, 01, 05, 06, 07 | ⬜ 未开始 | — | — |
| 3 | **10** | Search / Public API | 00, 01, 02, 05, 08, 09 | ⬜ 未开始 | — | — |
| 3 | **11** | Ops | 00（完整部署前再读 01,02,04,05,06,08,10） | ⬜ 未开始 | — | — |
| 3 | **12** | Admin UI | 02, 03, 07, 08, 10 | ⬜ 未开始 | — | — |
| 3 | **13** | Public Web v1.7 | 02, 08, 09, 10 | ⬜ 未开始 | — | — |
| 4 | **14** | Final Integration | **全部** | ⬜ 未开始 | — | — |

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

| Agent | 说明 |
| ----- | ---- |
| **03** | 上游 00、01、02 均已完成。**AuthGuard / AdminGuard 已就绪**，`imports: [AuthModule]` 即可用 |
| **06** | 上游 00、01 均已完成，完全畅通 |
| **09** | 上游 00、01、02 均已完成；V1 只做 Bookmark / Reading / Preferences |

> 规则 §18：建议同时最多跑 3–4 个 Agent。
> Wave 1 剩余：**03 / 06**；Wave 2 的 **09** 也已解锁。

---

## 当前阻塞

无。

> ⚠ 有一项**已知集成缺口**（不阻塞 03 / 06 / 09，但 Agent 14 必做）：
> `apps/api/src/app.module.ts` 尚未挂载 `CommonModule` + `AuthModule`，
> 因此 `node apps/api/dist/main.js` 起真实进程时 `/api/v1/auth/*` 全是 404。
> 详见下方「Agent 02 — Auth / Users」要点。

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

---

## 更新方法（Agent 完成后照做）

1. 把**自己那一行**的「状态」改为 `✅ 已完成`
2. 填入本次提交的短 SHA（多个提交用空格分隔）
3. 填入 HANDOFF 的相对链接
4. 更新顶部「最后更新」
5. 更新「当前可开工」与「当前阻塞」
6. 若自己的实现有**下游必须知道的坑或破坏性变更**，补进「已完成 Agent 的要点速查」

**只改自己那一行和上面几处**，不要动其他 Agent 的行。
