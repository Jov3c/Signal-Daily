# Signal（信号）

编辑型科技阅读平台 monorepo —— 抓取全网科技资讯，经 LLM 打分与**人工审核**后精选成刊。

> 遵循《Signal 多 Agent 执行规则 v1.0》。
> 基线：Development Contract **v1.1** / Frontend Prototype **v1.7** / UI-UX Spec **v1.7**。

## 当前状态

**Agent 00–14 全部完成，进入上线前硬化与生产验证阶段。**

```text
✅ API（NestJS）        —— 13 个模块已挂进根 AppModule，端到端可跑
✅ Worker（NestJS）     —— 4 个 Job 模块 + 调度器，真实消费 BullMQ
✅ Public Web（Next.js）—— v1.7 视觉与信息架构
✅ Admin UI            —— 9 页
✅ 本地 Docker 全栈     —— docker compose 六容器（nginx/api/worker/web/mysql/redis）已跑通
✅ 采集 → 流水线 → AI → 审核 → 精选 → 日报 → 前台  全链路可跑通
```

⚠ **详细的分 Agent 历史以 [`handoffs/README.md`](./handoffs/README.md) 为真源**，
本文件只写「当前是什么、怎么跑、入口在哪」。

## 目录结构

```text
apps/
├─ web/         Next.js 前台 + 后台（App Router）
├─ api/         NestJS API（模块在 src/modules/<module>/）
└─ worker/      NestJS standalone worker（Job 在 src/jobs/<area>/）
packages/
├─ contracts/   全项目唯一公共 enum / DTO / Queue 名 / Error Code
├─ config/      env 校验（对齐 docs/20）+ 业务时区
├─ logger/      Pino JSON + secret 脱敏
├─ source-core/ 采集内核（SSRF 守卫 / 调度规则），api 与 worker 共用
└─ test-utils/  测试公共工具
prisma/          schema、migrations、seed
infra/           Dockerfile、nginx、MySQL 配置
e2e/             Playwright 真浏览器用例
scripts/         ops（部署校验、备份、健康检查）与 smoke（业务冒烟）
handoffs/        分 Agent 的交付记录与看板
```

## 环境要求

- Node.js **>= 22**（本机验证：v24.14.0）
- pnpm **>= 10**（本机验证：11.15.1）
- 本地开发需要 MySQL 8.4 与 Redis（`.env` 里配）

## 常用命令

| 命令                | 说明                                                        |
| ------------------- | ----------------------------------------------------------- |
| `pnpm install`      | 安装依赖                                                    |
| `pnpm build`        | `tsc -b`，编译全部 packages + api + worker                  |
| `pnpm typecheck`    | 类型检查（含 web 与 `e2e/`）                                |
| `pnpm -r typecheck` | 逐包类型检查 —— ⚠ **额外覆盖 `apps/*/test/`**，不能省       |
| `pnpm lint`         | ESLint                                                      |
| `pnpm format`       | Prettier 写入                                               |
| `pnpm test`         | Vitest 全量单测（无需先 build）                             |
| `pnpm test:ci`      | 同上，`--maxWorkers=4`（CI 用的就是它）                     |
| `pnpm test:db`      | 数据库集成测试（**需要真实 MySQL**）                        |
| `pnpm test:e2e`     | Playwright 真浏览器用例（**需要真实 API + Web 在跑**）      |
| `pnpm ops:verify`   | 部署形态静态校验（compose / nginx / Dockerfile / workflow） |
| `pnpm verify`       | `lint && typecheck && -r typecheck && test && ops:verify`   |

数据库：`pnpm db:generate` / `db:migrate` / `db:seed` / `db:reset` / `db:studio`。

### 本地起服务（需先 `pnpm build`）

```bash
pnpm build
pnpm --filter @signal/api start       # API  :3001
pnpm --filter @signal/worker start    # Worker
pnpm --filter @signal/web dev         # Web   :3000
```

### 本地起全栈（Docker，含 nginx / MySQL / Redis）

```bash
cp .env.example .env                  # 填好 secret（尤其 MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD）
mkdir -p infra/nginx/certs            # 自签证书，见 infra/nginx/README.md
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout infra/nginx/certs/privkey.pem \
  -out    infra/nginx/certs/fullchain.pem -subj "/CN=signal.local"
docker compose up -d --build
docker compose run --rm --no-deps api node_modules/.bin/prisma migrate deploy
docker compose ps                     # 全部 (healthy) 才算起来
```

⚠ 两个已知点：nginx 用 **HTTPS + 自签证书**（浏览器会拦一次，继续访问即可）；
`NODE_ENV=production` 且未配 `SMTP_*` 时**登录不可用**（`ConsoleMailSender` 按
`docs/14` 的设计拒绝在产线把验证码写日志）。本地要看后台请用上面的 `pnpm ... dev` 形态。

### 完整业务冒烟（采集 → 发布 → 前台）

```bash
node scripts/smoke/run-smoke.mjs
```

真库真 Redis 真 BullMQ 真 worker，跑完整条链路；mock 的是 AI provider 与
（用公网 feed 代替的）受控信源。细节与已知不稳定点见
[`scripts/smoke/README.md`](./scripts/smoke/README.md)。**不进 CI。**

## 公共契约（Frozen）

```text
packages/contracts        ← 公共枚举 / DTO / Queue 名 / Error Code
prisma/schema.prisma      ← 数据库结构
API 路径、Queue/Job 名、错误码、业务时区 Asia/Shanghai
```

需要改动时提交 `handoffs/CONTRACT_CHANGE_REQUEST-*.md`，**不要就地改**。

- 唯一枚举来源：`packages/contracts`，`no-duplicate-enums.spec.ts` 静态扫描全仓守卫。
- API 一律 `/api/v1`，Admin 一律 `/api/v1/admin`；成功 `{ data }`，列表带
  `meta.nextCursor`，错误 `{ error: { code, message, requestId, details } }`。
- 数据库 BIGINT 主键在 API 一律序列化为 **string**。
- DB 存 UTC，业务日按 `Asia/Shanghai` 换算。
- **不存在任何用户订阅能力**（无 `subscriptions` 表 / API / 页面）。

## 环境变量

清单见 `.env.example`，权威来源 `docs/20-environment-variables.md`。
不得新增未记录的 env；`@signal/config` 的测试会校验 schema 与文档一一对应。

## CI / 部署

`.github/workflows/deploy.yml` 四个 job：

```text
test         lint / typecheck / -r typecheck / 单测 / ops:verify
integration  真实 MySQL 8.4 + Redis：test:db + api 集成 + worker 集成（串行，共用同一个库）
e2e          Playwright 登录链路（真 API + 真 Web）
build        api / worker / web 三个镜像，推到 ghcr.io
deploy       拉镜像 → migration gate → 切应用 → 健康检查 → 失败自动回滚
```

`build` 依赖 `test` 与 `integration`；`e2e` 按计划**暂未**并入门禁（先跑一轮看稳定性）。

⚠ **`deploy` 目前跑不通**：VPS secrets（`VPS_HOST` / `VPS_USER` / `VPS_SSH_KEY`）
尚未配置。配好之后还需要处理 compose 的镜像引用（见
[`handoffs/CI-GATE-AND-LEAK-FIX-2026-10-01.md`](./handoffs/CI-GATE-AND-LEAK-FIX-2026-10-01.md) §6.3）。

## 已知限制

- 部署链未闭环（见上）。
- X / GitHub / HuggingFace 采集器需要各自的 token；未配置时按设计 fail-closed。
- 生产环境的登录依赖 `SMTP_*`。
- 后台审核页与部分运维页的只读视图未做移动端适配（`docs/23` 只要求前台）。
