# Signal 完整业务 Smoke（清单 P2-06）

一条内容从 **Source 真正走到 Public** 的端到端冒烟。用来补上这个缺口：

```text
Admin 登录 → 添加 RSS Source → Fetch → RawItem → Normalize → AI
  → Event / Evidence → Review → Featured → Daily → Publish → Public API
  → 用户登录 → Bookmark → Search
```

> ⚠ **不要放进每次 CI。** 清单明确不建议：它依赖外部公网 RSS（不稳定），
> 并且要在宿主上起 api + worker（CI 里成本高、并发会互相抢端口/库）。
> 这是一个**手动 / staging** 冒烟。

---

## 1. 怎么跑

```bash
# 在仓库根目录
node scripts/smoke/run-smoke.mjs            # 会先 pnpm build，再跑整条链路
node scripts/smoke/run-smoke.mjs --skip-build   # 已构建过时跳过
node scripts/smoke/run-smoke.mjs --feed https://example.com/feed.xml
node scripts/smoke/run-smoke.mjs --keep      # 调试：跑完不杀进程、不清库
```

退出码：`0` 全绿；`1` 有步骤失败（失败原因与汇总会打印）。

### 前置条件

| 依赖            | 说明                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| Node ≥ 22、pnpm | 仓库存量工具链                                                           |
| MySQL 8.4       | 宿主 `127.0.0.1:3306`，`signal` 用户可写 `signal_shadow`                 |
| Redis           | 宿主 `127.0.0.1:6390`（**不是 `.env` 里的 6379**）                       |
| 公网出网        | 采集器要能访问真实 RSS（SSRF 守卫不允许本地/内网地址）                   |
| 端口            | `3001`（api）、`3899`（mock AI）、`3100`（web）—— 脚本自己起、跑完自己关 |
| 仓库根 `.env`   | 提供 `AUTH_*` / `APP_*` / `SOURCE_FETCH_*` 等。**不需要**改它            |

脚本**不需要**你提前起任何服务：它自己拉 mock AI、worker、api、web 四个子进程。
（`--skip-web` 可跳过第 13 步与 web 进程。）

### 环境变量覆盖

| 变量                 | 默认                                                 | 说明                                       |
| -------------------- | ---------------------------------------------------- | ------------------------------------------ |
| `SMOKE_DATABASE_URL` | `mysql://signal:signal@127.0.0.1:3306/signal_shadow` | 冒烟库（**会被清空**）                     |
| `SMOKE_REDIS_URL`    | `redis://127.0.0.1:6390/5`                           | 最后一段是 Redis **DB 序号**，用于隔离队列 |
| `SMOKE_API_PORT`     | `3001`                                               |                                            |
| `SMOKE_MOCK_PORT`    | `3899`                                               |                                            |
| `SMOKE_WEB_PORT`     | `3100`                                               | 第 13 步的 `next dev` 端口                 |

---

## 2. 每一步在验什么

| #   | 步骤                      | 判据（真的落到库 / 真的过 HTTP）                                                                                                                                 |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 清库 + 官方 seed          | `admin@signal.local` 存在、`topics > 0`                                                                                                                          |
| 2   | 起 mock AI / worker / api | `/health/ready` 200                                                                                                                                              |
| 3   | Admin 登录                | 真实 Email OTP；验证码从 **api stderr** 取；`GET /me` 返回 `role=ADMIN`                                                                                          |
| 4   | 添加 RSS Source           | `POST /admin/sources` 201                                                                                                                                        |
| 5   | Fetch                     | `POST /admin/sources/:id/fetch-now` 202 → 等 `raw_items` 出现                                                                                                    |
| 6   | Normalize                 | 等 `contents`（经 `raw_item_id` 关联）出现                                                                                                                       |
| 7   | Event / Evidence / AI     | `contents.event_id` 非空；`event_evidence` ≥ 1；`ai_runs` ≥ 2；`final_score` 落库；`body_translated` 含 marker                                                   |
| 8   | Review                    | 等 `pipeline_status = REVIEW_PENDING`（收尾扫描 60s 一轮）→ `GET /admin/review` 能查到 → `APPROVE_BOTH` 后 `APPROVED`                                            |
| 9   | Featured                  | `POST /admin/featured` 201 → `GET /featured`（公开）能读到                                                                                                       |
| 10  | Daily                     | `GET /admin/daily/:date` 补建草稿 → `PUT sections`（含一条 LEAD）→ `schedule` → `publish`（`PUBLISHED` + 期号）→ `GET /daily/:date`（公开）                      |
| 11  | Public API + Search       | `GET /contents/:id` 200；`GET /search?q=<marker>` 命中该 content                                                                                                 |
| 12  | 用户登录 + Bookmark       | 新用户走真实 OTP → `POST /bookmarks/:contentId` → `bookmarks` 表真的有一行                                                                                       |
| 13  | Web（Next.js）渲染        | 起 `next dev`（3100）+ `API_BASE_URL` 指向本次 api → `GET /article/:id` 200，且 HTML 里出现这条内容的标题或译文 marker（证明前台**真的渲染了**刚发布的这条内容） |

每一步**要么真的验了、要么脚本会红**。没有「应该可以」。

---

## 3. 用了哪些 mock、哪些必须真实

**Mock（本地）**

- **AI Provider**：`scripts/smoke/mock-ai-provider.mjs`，一个本地 OpenAI-compatible 服务。
  形状不是凭印象写的，是逐条对着
  `apps/worker/src/jobs/ai/provider/openai-compatible.provider.ts` 抄的：
  `POST {baseUrl}/chat/completions`、响应 `{model, choices[0].message.content, usage}`。
  输出字段严格匹配 `schema/classify-score.schema.ts` 与 `schema/translate.schema.ts`
  的 `.strict()` 形状（多一个键就会被判非法）。
  任务判定用 prompt 里 JSON 模板的**键名**（`dimensions` / `translatedText`），
  不依赖中文、不依赖终端编码。

**必须真实（不 mock）**

`MySQL` / `Redis` / `BullMQ` 队列 / `worker` 消费者 / `api` / 采集器的 SSRF 守卫 /
真实 Email-OTP 登录 / 真实公网 RSS。

---

## 4. 三个关键判断（为什么是这样）

### 4.1 受控测试 RSS 怎么解决 → **用真实公网 feed**

SSRF 守卫（`packages/source-core/src/url-safety/`）会拒绝任何解析到内网/回环的地址。
它的 DNS 解析器虽然可注入，但那**只在单测里有接缝**；真 worker 进程用的是真
`defaultDnsLookup`。本机没有一个可被公网访问的地址，所以在**不给 SSRF 守卫加逃生口**
（清单硬性要求）的前提下，「本地受控 feed」不可能成立。

因此走真实 feed（默认 `https://openai.com/news/rss.xml`）。代价是 feed 内容不可控，
但下游的可重复性由 **mock AI 注入的唯一 marker** 保证：
「Search 能搜到」验的是 marker，而不是某篇具体文章。
`config.maxItems = 1` 让每次采集只入库一条，避免 1200+ 条目把冒烟变成压力测试。

### 4.2 为什么跑宿主开发栈，而不是已经跑着的 docker 栈

实测（2026-10-02）：

```text
$ curl -sk -X POST https://localhost/api/v1/auth/email/request-code -d '{"email":"admin@signal.local"}'
HTTP 503 {"error":{"code":"AUTH_MAIL_NOT_CONFIGURED", ...}}
```

docker 栈的 api 是 `NODE_ENV=production` 且未配 SMTP → `UnavailableMailSender`
→ **真实登录在 docker 栈上根本发生不了**。而「Admin 登录 / 用户登录」是验收的一部分，
所以只能在 `NODE_ENV=development` 下跑宿主 api（`ConsoleMailSender` 会把验证码写到
stderr，脚本正是从那里取码）。docker 栈全程不动。

> 若将来 docker 栈配了 SMTP（或允许在 docker 里放开登录），这个判断可以重新评估。

### 4.3 用独立库 + 独立 Redis DB 序号

- **库**：默认 `signal_shadow`（本机 `signal` 用户对它有 ALL PRIVILEGES，且它本来就是
  一份空的 schema；而 `signal` 是开发库，不该被冒烟污染）。本机 `signal` 用户
  **没有 CREATE DATABASE 权限**，所以不能自建库。
- **Redis**：用 `redis://127.0.0.1:6390/5`，队列键全部落在 DB 5，与别的东西隔离。
- **安全闸**：目标库名不含 `shadow` / `smoke` / `test` 时脚本**拒绝运行**，
  除非显式 `--force-wipe`。这防止手滑清空 `signal` 开发库。

---

## 5. 清理与残留

- 跑前 `FLUSHDB`（只刷 DB 5）+ 清空冒烟库；跑后**再清一次**。
- 因此**正常跑完，冒烟库与 Redis DB 5 都是空的**，可以无限次重复执行。
- 若中途被强杀（`--keep` 或 Ctrl-C 打死），残留都在 `signal_shadow` 与 Redis DB 5 里：
  ```bash
  # 手动清理
  node scripts/smoke/run-smoke.mjs --skip-build   # 下一次运行会先清空再开始
  ```
  或者直接删库重建（该库是影子库，可安全重建）。

---

## 6. 已知不稳定点 / 残留风险

1. **外部 RSS 不稳定**：`openai.com/news/rss.xml` 可能改版、限流或 404；
   那时第 5 步会超时失败。可用 `--feed <别的公网 feed>` 换源。
   注意 seed 里那个 Anthropic feed 已经 404，**不要**用它。
2. **依赖出网**：离线 / 代理环境会停在 Fetch 步。SSRF 守卫不允许本地 feed。
3. **60s 定时器**：`REVIEW_PENDING` 由 worker 的收尾扫描产生，
   间隔 `REVIEW_SWEEP_INTERVAL_MS = 60s`（`content/module.ts`）。
   所以第 8 步通常要等约一分钟。脚本超时给到 180s。
4. **端口占用 / 残留进程**：api 用 3001、mock 用 3899。脚本**启动前会检查端口**
   并在占用时 fail-fast（可改 `SMOKE_API_PORT` / `SMOKE_MOCK_PORT`）。
   这条守卫是有来历的：调试时手动起过一个 mock 留在 3899，导致主脚本的 mock
   绑不上、worker 打到了旧 mock（marker 对不上），症状是「AI 明明成功、
   marker 却找不到」。
   正常退出时脚本会**按进程树**清理（Windows 上 `taskkill /T /F`）：因为
   `pnpm … next dev` 的真实服务是**孙子进程**，只杀直接子进程会把它孤儿化。
   若脚本被强杀（`--keep` / 直接 kill 父进程），可能残留：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -match 'dist[\\/]main\.js|mock-ai-provider|next dev' } |
     ForEach-Object { taskkill /PID $_.ProcessId /T /F }
   ```
5. **`signal_shadow` 是 Prisma 的 shadow 库**：如果之后有人跑
   `prisma migrate dev`，Prisma 会重建它、清掉里面的东西 —— 对本脚本无害
   （每次运行本来就先清空）。
6. **宿主 MySQL / Redis 是共享的**：脚本只清 `signal_shadow` 与 Redis DB 5，
   **绝不碰** `signal` 库与其它 DB 序号。但如果别人也往
   `signal_shadow` / Redis DB 5 写东西，会互相干扰。
7. **seed 的示例来源**：脚本在冒烟库里把 `sources.enabled` 全置 0，避免 worker
   的调度器（60s 一轮）去抓 seed 的示例源。这只影响冒烟库。
8. **未纳入 CI**：按清单要求，故意的。

---

## 7. 相关文件

| 文件                   | 作用                                              |
| ---------------------- | ------------------------------------------------- |
| `run-smoke.mjs`        | 编排：清库/seed、起进程、驱动 API、查库断言、清理 |
| `mock-ai-provider.mjs` | 本地 OpenAI-compatible mock（可单独运行）         |
| `README.md`            | 本文档                                            |
