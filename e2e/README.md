# E2E：登录链路

一条 Playwright 用例，守住登录链路上**三类真实发生过**的缺陷
（2026-09-30 浏览器走查发现，修复见 `ed0b1a1` / `0e01050`）：

|       | 缺陷                                                                                        | 修复                                                 |
| ----- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **A** | 开发形态没有 nginx，浏览器侧的 `/api/v1/*` 相对路径请求打到 Next 自己 → 404 →「点了没反应」 | `apps/web/next.config.mjs` 的 `rewrites()`           |
| **B** | `verifyEmailCode` 漏读 API 的 `{data:…}` 封套 → 登录后整页 `TypeError`                      | `0e01050`（把解包下沉进 `apiRequest`，结构性根治）   |
| **C** | 登录成功后**服务端组件不重渲染** → 页面仍显示「未登录」，直到手动刷新                       | `apps/web/components/auth.tsx` 的 `router.refresh()` |

## 怎么跑

```bash
# 前提：先构建（harness 跑的是构建产物，不是源码）
pnpm build
pnpm --filter @signal/web build

pnpm test:e2e
```

**前提清单**

- MySQL 在 `localhost:3306`、Redis 在 `localhost:6390` —— 两个都必须是运行中。
  - ⚠ Redis 是 **6390**。仓库 `.env` 里写的是 6379，与实机不符；harness 在把
    `REDIS_URL` 喂给子进程之前**强制改成 6390**（见 `helpers.ts` 的 `rewriteRedisPort`）。
    不改 `.env`：那是提交进仓库的配置，改了只在你这台机器上对。
- 端口 **3000 / 3001 空闲**。被占用时 harness 会拒绝运行并给出占用者 PID。
- 构建产物存在（`apps/api/dist`、`apps/web/.next`）。

## 为什么这么设计

### 一条用例，而不是三条

三类缺陷落在同一条时间线上，且互为上下游：

```text
点「发送验证码」
  └─ A 类：代理不通 → 404 → 停在第一步（「验证码」输入框永不出现）
     └─ 填验证码、点「登录」
        └─ B 类：封套没解 → session.user 是 undefined → 登录动作整个炸掉
           → 抽屉不关、页面不变
           └─ C 类：会话建了，但服务端组件没重渲染
              → 页面仍挂着「登录后才能使用收藏」
```

所以每个下游断言同时是上游的探针。拆成三条用例的话，上游一坏就要收三条红，
而其中两条描述的是同一个原因 —— 排查反而更慢。

补充一条**显式**的 A 类守卫（`GET /api/v1/today` 断言 200）：主用例里也能覆盖 A，
但它给出的失败信息是「等不到验证码输入框」，指向登录抽屉而不是「代理断了」。
单列一条，失败时状态码会直接印在报错里。

### ⚠ C 类只能用 `/bookmarks` 测，且**绝不能 reload**

- **不能 `reload()`**：`reload()` 正是 C 类要守的东西。手动刷新会让服务端带着
  新 Cookie 重新渲染，页面当然就对了 —— 一条会自己刷新的用例对 C 类是恒绿的。
  用例里没有任何 `page.reload()`，而且**有一条可执行的守卫**：登录前往 `window`
  放一个哨兵，登录后读回来比对。软刷新（`router.refresh()`）保留客户端上下文，
  哨兵还在；`reload()` 会换掉整个 JS 环境，哨兵消失。这样「将来有人为了让用例
  稳定顺手加一句 reload」会当场变红，而不是悄悄让用例失去意义。
- **不能用 `/settings`**：它的账户区是**客户端组件**（读 `useAuth()`），
  登录后本来就会重渲染，测不出 C 类。`/bookmarks` 是唯一一个依赖 Cookie 的
  **服务端**前台页面。

### 验证码怎么拿

OTP 在库里是**哈希存储**的，读库拿不到明文，接口也不回显。唯一的明文来源是
`apps/api/src/modules/auth/mail-sender.ts` 的 `ConsoleMailSender` ——
`NODE_ENV !== 'production'` 且未配 SMTP 时，它把验证码写到 **stderr**
（刻意不走 pino，免得进结构化日志流）。

所以 `globalSetup` 把 API 子进程的 stderr **重定向到文件**，用例轮询该文件解析
最新一条（`helpers.ts` 的 `readOtpCode`）。stdout 也一起扫，是刻意的冗余：
万一将来有人把它改成 `console.log`，用例不该静默变成「拿不到验证码」。

### 限流：不清就必然偶发假红

键格式 `ratelimit:auth:<scope>:<subject>`，两条策略：

```text
otpRequestPerEmail  3 次 / 600 秒     ← 用「每次运行唯一」的邮箱自然规避
otpRequestPerIp     10 次 / 3600 秒   ← 换邮箱没用，必须清
```

`globalSetup` 用仓库自带的 `ioredis` 做 SCAN + DEL 清掉 `ratelimit:auth:*`。
不清的话，连着跑第 11 次就会拿到 429，表现是「点发送验证码没反应」——
一条看起来随机的假红，重跑还可能变绿，于是没人会去查。

**安全护栏（硬性）**：这一步会删 Redis 键，所以 harness 在动任何东西之前先拒绝
非本机目标 —— `NODE_ENV=production`、或 `DATABASE_URL` / `REDIS_URL` 的 host
不是 `localhost` / `127.0.0.1` / `::1`，直接报错退出。判断标准刻意保守：
宁可让人手动改一行，也不让一次误配悄悄打到线上。

### 用唯一邮箱，不用种子用户

登录会 `findOrCreateByEmail` 自动建号，所以新邮箱不需要任何前置数据，
也**不依赖限流清理是否成功**（per-email 那层永不累积）。
种子用户 `admin@signal.local` 也能跑，但它会把 per-email 限流变成一个
跨运行的隐藏依赖。代价：每跑一次会在库里多一个 `e2e+…@signal.local` 用户。

### 构建新鲜度：拒绝「假绿」

用例跑的是 `apps/web/.next` 与 `apps/api/dist`，都是**构建产物**。
改了源码没重建 → 跑的还是旧代码 → 用例**绿得毫无意义**。

所以 `globalSetup` 会按目标分别比对源码与产物的 mtime（api 产物对 api 源码负责、
web 产物对 web 源码负责，`packages/` 与 `prisma/` 两边都算），源码更新就直接
**拒绝运行**并告诉你该敲哪条命令。逃生舱：`E2E_SKIP_FRESHNESS_CHECK=1`。

这条不是洁癖 —— 它正好是「有牙齿」验证时的陷阱（见下）。

### 进程管理

- API / Web 都用 `node <入口>` **直接起**，不经 `pnpm --filter`：
  后者会派生 `pnpm → node → next` 的树，Windows 上多杀少杀一层都会出问题。
- 收尾用 `taskkill /pid <pid> /T /F`（`/T` 才是「连同子树」；
  `process.kill()` 在 Windows 上不递归，会留下占着端口的孤儿）。
- `globalTeardown` 只在**正常退出**时跑。超时 / Ctrl-C / 用例失败后进程被强杀，
  子进程会活下来。所以 `globalSetup` 的第一步就是读台账**收上一轮的尸体**。
  两处叠起来才敢说「重复运行是安全的」。

## 「有牙齿」验证（实际做过）

不要只相信它现在是绿的 —— 这条用例的价值全在于**它会不会红**。

```text
1. 把 apps/web/components/auth.tsx 里 onLoggedIn 的 router.refresh() 注释掉
2. pnpm --filter @signal/web build
3. pnpm test:e2e
```

**实际结果：**

```text
  ✓  1 [chromium] › A 类守卫：… /api/v1/* 经 Next rewrite 打到了 API（200，不是 404） (52ms)
  ✘  2 [chromium] › 登录链路：…（全程不 reload） (21.2s)

    Error: expect(locator).toBeVisible() failed
    Locator: getByText('还没有收藏')
    Expected: visible
    Timeout: 20000ms
    Error: element(s) not found

    > 140 |   await expect(page.getByText('还没有收藏')).toBeVisible({ timeout: 20_000 });

  1 failed
  1 passed (26.1s)
    [ELIFECYCLE] Command failed with exit code 1.
```

失败的正是 C 类那一步：抽屉正常关闭、会话也真的建了，**只有服务端组件没重渲染**，
页面还停在「登录后才能使用收藏」上 —— 与当初浏览器走查看到的现象一致。
A 类守卫仍绿（它独立于这条链路）。

**恢复**：`git checkout -- apps/web/components/auth.tsx`（或把 `router.refresh()` 放回去）
→ `pnpm --filter @signal/web build` → 再跑一次，`2 passed`，退出码 0。
`git diff --stat` 确认 `apps/web` 无残留改动。

顺带一提，这一步也被新鲜度检查拦过一次：第一版检查把两边的构建时间取 `min`
再和所有源码比，只改 web 时**误报**了。改成「按目标分别比对」后正常 ——
误报本身说明「源码」与「产物」是两张各有各的对应关系的表。

## 已知限制

- **必须先构建，harness 不替你构建。** 构建是分钟级的，用例是秒级的；
  捆在一起会让每次迭代都付一遍构建的代价，最后没人愿意跑。
  代价是「忘了构建」——所以新鲜度检查把它变成一个明确的报错，而不是一次静默的假绿。
- **整套约 6–30 秒**（其中起服务 ~4 秒；失败用例要等 20 秒超时）。
  首次运行会多花几秒（Windows 上 `next start` 冷启动）。
- **会往库里写数据**：每次运行创建一个 `e2e+…@signal.local` 用户。
  长期跑会积累。要清理就按邮箱前缀删。
- **会清 Redis 的 `ratelimit:auth:*`**（有意为之，见上）。只对本机生效。
- **端口写死 3000 / 3001，不可配。** `next.config.mjs` 的 rewrite 目标在
  `next build` 时求值一次并写进 `routes-manifest.json`（默认 `http://127.0.0.1:3001/api`），
  所以「api 在 3001、web 在 3000」是**烤进构建产物**的事实。
  让端口可配会产生一种极具迷惑性的失败：网页正常、只有 `/api/*` 静默 502。
- **`retries: 0`**（有意为之）。重试会把「偶发」洗成「通过」，而这条用例的全部价值就是它的红。
- **只覆盖登录链路**：收藏 / 阅读进度 / 偏好同步的写路径没有覆盖。
  将来加用例时注意两件事：默认 `workers: 1`（只有一套服务与 Redis），
  以及新用例应当复用 `helpers.ts` 的 `WEB_BASE_URL` / `readOtpCode` / `uniqueEmail`，
  不要复制字面量。
- **不覆盖部署形态**：nginx 同域、容器健康检查走的是
  `scripts/ops/verify-deploy.mjs` 与 compose。这里只守「没有 nginx 的开发形态」，
  因为那三个缺陷只在这个形态下才出现。

## 文件

| 文件                     | 作用                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `playwright.config.ts`   | 根配置：`testDir` 指 `e2e/`，串起 setup/teardown，`workers: 1`、`retries: 0`          |
| `e2e/global-setup.ts`    | 安全护栏 → 收上一轮尸体 → 构建新鲜度 → 清限流键 → 起 api/web → 等就绪 → 写台账        |
| `e2e/global-teardown.ts` | 按台账 `taskkill /T /F` 杀掉进程树，删台账                                            |
| `e2e/helpers.ts`         | 共享工具：`.env` 装载、安全护栏、Redis 清键、进程树、就绪探测、验证码解析、构建新鲜度 |
| `e2e/login.spec.ts`      | A 类显式守卫 + 登录链路主用例                                                         |
| `e2e/.artifacts/`        | 运行时产物（已 gitignore）：api/web 日志、台账、trace、截图、HTML 报告                |
