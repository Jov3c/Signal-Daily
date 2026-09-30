# Handoff — Agent 12（管理后台 UI + 运维视图 API）

| 项               | 值                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| **Agent**        | 12                                                                                             |
| **任务**         | `tasks/agent-12-admin-ui.md` —— 管理工作台（9 页）                                             |
| **依赖**         | 02 / 03 / 07 / 08 / 10（全部已读）                                                             |
| **日期**         | 2026-09-30                                                                                     |
| **状态**         | ✅ 已完成                                                                                      |
| **提交**         | `515dec5`（后台运维视图 API）<br>`6fd3851`（后台 9 页）                                        |
| **CCR**          | [CONTRACT_CHANGE_REQUEST-agent-12.md](./CONTRACT_CHANGE_REQUEST-agent-12.md)（5 项，无一阻塞） |
| **§23 独立审查** | 未做。见文末「关于 §23」。                                                                     |

---

## Task

`tasks/agent-12-admin-ui.md`：实现管理工作台，覆盖 Source / X 白名单 /
Review / Evidence / Daily。9 个页面：Dashboard、Sources、Sources-X Filter、
Review Queue、Review Detail + Evidence Chain、Daily Editor、Jobs、
Notifications、AI Usage。

品牌要求：继续 Signal 暖纸色；Card / 选择控件 light hover `#FAF9F5`；无 lift 动画。

---

## Implemented

### 1. ⚠ 先说这次的**根因**：三个页面在契约里本来就没有接口

| 文档                         | 说的                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `tasks/agent-12-admin-ui.md` | 9 个页面，含 **Jobs / Notifications / AI Usage**                                              |
| `docs/04-api-contract.md`    | Admin 只有 Source Registry / Review / Event·Evidence 三节（+ Agent 07 的 `/admin/dashboard`） |

**两份文档都「冻结」了，而它们互相矛盾。** 而 `docs/00` 规定
**API URL 是冻结契约，只有 Agent 00 / 01 / 14 能改**。

数据其实一直在：`job_runs`（worker 的 04/05/06/08 写）、`ai_runs`（06 写）、
`admin_notifications`（Agent 07 的通知扫描写）—— **不是没数据，是读完了没有出口**。

用户于 2026-09-30 **明确授权**补这三组接口，本 Agent 据此实现，
并记入 CCR 第 1 项（含「这次授权本身」）。

### 2. 新增模块 `apps/api/src/modules/admin-ops/`（4 条路由）

```text
GET  /admin/jobs                    分页 + 按 jobType/status 筛
GET  /admin/notifications           分页 + 按 status 筛
POST /admin/notifications/:id/read  标记已读（幂等）
GET  /admin/ai-usage                最近 N 个业务日的用量与成本
```

**新建模块而不是改 Agent 07 的 `admin-review`**（哪怕
`admin_notifications` 的**写**在那里）：07 已交付，把只读视图塞进去要改它的
控制器 / 服务 / 仓储三处；新建一个小模块只读同样的表，爆炸半径小得多。

四个刻意的决定：

| 决定                                                  | 不这么做会怎样                                                                                                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 按天聚合是 **N 次查询**，不是一条 `GROUP BY` 原生 SQL | 时区换算只有 `@signal/config` 的 `businessDayRangeUtc()` 一个真源。在 SQL 里重写一遍等于把 +08:00 硬编码进第二处 —— Agent 03 已为同类错误付过代价（本机 MySQL `time_zone=SYSTEM=Asia/Shanghai` 而列存 UTC） |
| **半开区间** `[fromUtc, toUtc)`                       | 闭区间会让边界那一毫秒被相邻两天各算一次，总额偏高                                                                                                                                                          |
| 响应体里**只有枚举值**（`UNREACHABLE/TIMEOUT/ERROR`） | 这些接口要 ADMIN，但仍然**不回显**底层错误（原文进日志）。名字里带 `admin` 不等于可以漏内网拓扑                                                                                                             |
| 通知已读用 `updateMany` + `status='UNREAD'` 条件      | 先读再写会让两个管理员同时点开时互相覆盖 `readAt`，那一列就失真了                                                                                                                                           |

⚠ `POST .../read` **不在任务书里**：本模块判断「一个只有未读徽标、
没有已读动作的页面不可用」而加的。已在 CCR 第 1 项**单列请裁决**。

### 3. 后台 9 页（`apps/web/app/admin/`）

Dashboard / 审核队列 / 审核详情（含证据链编辑）/ 日报编排 / Source 管理 /
X 白名单 / Jobs / 通知 / AI 用量。

**视觉：沿用前台 v1.7（用户 2026-09-30 的决定）。** 后台没有任何设计稿
（原型的 12 页全是用户前台；`docs/09` 只定义「显示什么内容」，
没有一句讲「长什么样」）。所以：

- `app/admin.css` 里出现的**每个** `var(--…)` 都在前台的 `globals.css` 里定义过；
- 新增的只有**表格**（前台是阅读产品，没有表格）；
- 表格的 hover 与前台 Card 同一条契约（只改背景，不位移）；
- 有守卫盯着这三条（`admin.css` 里**不许出现任何 hex 颜色**）。

九个决定：

| 决定                                                            | 理由                                                                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Dashboard **不显示队列积压**                                    | `DashboardStats` 里没有这个数（队列在 Redis，后台首页的查询不碰它）。**不编一个「队列 0」** —— 那会让人以为队列是空的 |
| 审核队列 **不显示独立来源数**                                   | `docs/09` 要求列表显示它，但那是**事件**的属性，只有详情页给。用 `eventId` 是否存在去「猜」一个数字是更糟的           |
| 批量只有 **Defer / Reject**（`docs/09`）                        | 批量通过会把「逐条看过」变成可跳过的，而 Signal 的定位正是「编辑挑过」                                                |
| ⚠ 动作名是 `DEFER`/`REJECT`，**状态**是 `DEFERRED`/`REJECTED`   | 把后者当动作发出去会 **400**，而那只在运行时才看得见。有守卫直接读后端 dto 比对这两个数组                             |
| 日报每行**只显示当前状态允许的动作**                            | 给 DRAFT 显示「发布」= 后端会拒而用户以为是 bug。「按钮看起来能用但其实不能」比「按钮不存在」更糟                     |
| 发布的 preflight 结果（`published:false` + issues）**必须显示** | 吞掉它等于让「没发出去」看起来像成功；审核员要知道**是哪一条**没过                                                    |
| `test` 与 `fetch-now` **分开**                                  | 前者只验证可达性与解析（不写库），后者**真的入队一次采集**。混成一个按钮会让人只想看看通不通的时候往生产库灌数据      |
| X 白名单是 `?type=X_USER` 的**过滤视图**                        | 任务书明确要求「使用 Source API，不创建第二套 X account backend」。两条路由、一个数据源                               |
| **401 与 403 分开说**                                           | 401 有解决路径（去登录），403 没有（找运维）。合成一句「无权访问」会让普通用户反复登录 —— 登录一百次也不会变成管理员  |

### 4. 顺带修了两处「能编译、能渲染、点了没反应」的错位

这两处都是**同一类**：拆成两个元件之后，状态与 UI 不在一个元件里。

```text
1. 批量动作栏（客户端，管选中集）与表格（服务端渲染）
   → **行里根本没有勾选框**，选中集只被「全选本页」写、永远不会被行写
   → 合并成一个客户端元件（ReviewQueue）

2. BULK_REVIEW_ACTIONS 原本放在 .tsx 元件文件里
   → 守卫只能读文本（而「读文本」正是它要防的脆弱做法）
   → 移到 lib/review-actions.ts，测试可以直接 import
```

---

## Files Added

```text
apps/api/src/modules/admin-ops/
  repository.ts  prisma-admin-ops.repository.ts  service.ts
  controller.ts  module.ts  index.ts  dto/parse.ts
apps/api/test/admin-ops-units.spec.ts          29 项（路由面 4 条 / 业务日算术 / +08:00 钉死）
apps/api/test/admin-ops-routes.spec.ts         30 项（真 HTTP、真守卫、真过滤器）
apps/api/test/admin-ops-db.integration.spec.ts 16 项（真 MySQL）
apps/web/app/admin/**                          9 页 + layout
apps/web/components/admin-*.tsx                表格 / 动作 / 证据编辑
apps/web/lib/admin-types.ts                    后端响应类型的镜像
apps/web/test/contract-parity.spec.ts          14 项（镜像不许漂移）
```

## Files Modified

| 文件                                  | 归属     | 改了什么                                                                                                          |
| ------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/auth-contract.spec.ts` | Agent 02 | `ADMIN_ROUTE_OWNERS` 登记 `admin-ops`（**CCR 第 3 项**；这是对该文件的第二次修改，第一次见 CCR-agent-11 第 2 项） |

未改 Prisma / **未建 Migration**；未新增 env；未改任何既有 API 的响应形状。

---

## Test Results

```text
pnpm verify                                  ✓ 85 files / 1930 tests
                                             ✓ ops:verify 73 项
pnpm --filter @signal/api test:integration    ✓ 10 files / 138 tests（真 MySQL + 真 Redis）
  新增 16 = admin-ops-db.integration.spec.ts
pnpm --filter @signal/web build               ✓ 22 条路由（9 后台 + 13 前台）
```

### 反证（4 条，**全部实测**）

| #   | 变异                                                   | 结果                                                |
| --- | ------------------------------------------------------ | --------------------------------------------------- |
| M1  | 通知已读去掉 `status: 'UNREAD'` 条件（改成无条件写）   | 🔴「已读的那条再标记，`readAt` 保持原值」变红       |
| M2  | 半开区间改成闭区间（`lt` → `lte`）                     | 🔴「`toUtc` 那一刻不算」变红                        |
| M3  | 批量动作写成 `'DEFERRED'/'REJECTED'`（状态名当动作名） | 🔴 与后端 dto 比对的两条**都**变红                  |
| M4  | `lib/admin-types.ts` 里把 `finalScore` 改名            | 🔴 `contract-parity.spec.ts` 变红（镜像守卫有牙齿） |

⚠ M4 是设计时确认（先看守卫会不会红再定稿），M1–M3 是**改完真跑**的。
没有做完整变异矩阵 —— 与 Agent 11 / 13 的深度保持一致。

### 一处被测试**指出**的实现错误（值得记）

`admin-ops-db.integration.spec.ts` 第一版断言 `totals.runs === 4`，
本机实测拿到 **42** —— 那不是实现错了，是**测试在断言「这台机器上碰巧
没有别的数据」**。开发机是**共享**数据库（别的集成测试与手工验证都往里写）。

改成**先量基线再比增量**。这条对后来的人有用：**在这个仓库里写集成测试，
绝对值断言几乎总是错的。**

---

## Known Limitations

### 设计取舍

**1. ⚠ 后台没有设计稿，视觉是「沿用前台」推出来的。**
用户已于 2026-09-30 裁决。若将来有后台设计稿，替换 `app/admin.css`
即可 —— 页面结构按 `docs/09` 的模块划分写，不依赖具体视觉。
**但这意味着「后台好不好看」没有权威标准可对照**，这是本次最大的未知。

**2. `admin_notifications` 现在有两个使用方**（Agent 07 写、本模块读）。
读写分离的常规形态，但表结构变化会影响两处。已在 CCR 第 2 项写明。

**3. AI 用量的按天聚合是 `days` 次查询**（默认 14、上限 30）。
上限就是为了给这个代价封顶。若某天真的需要 90 天，应当先改成
一条原生 SQL **并同时**解决时区真源的问题（见 `service.ts` 的文件头）。

**4. 成本是 `Number(Decimal)`。** `estimated_cost_usd` 是 `Decimal(12,6)`，
12+6 位有效数字正好在 JS double 的边缘。跟随 Agent 07 的
`aiCostTodayUsd: number` 先例，没有改成字符串 —— **若将来要做对账，
应当改成字符串**（那是钱的语义）。

**5. 后台没有分页组件，每页自己拼 `page` 链接。**
三个列表页各有一份 `hrefOf()`/`pageHref()`（十几行）。抽成共用组件
会在「保住筛选条件」这件事上引入一个抽象（每个列表的筛选参数不同），
目前重复的代价更小。

### 未修复但已上报

- **`docs/04` 与任务书矛盾**（CCR 第 4 项）：请三选一。
  若判定「V1 后台只有 6 个模块」，`app/admin/{jobs,notifications,ai-usage}`
  可以直接删掉，不影响其余 6 页。
- **worker 的 healthcheck 是个空壳**（`test -d /proc/1`）——
  这是 Agent 11 上报的（CCR-agent-11 第 6 项），与后台的 Jobs 页有关：
  **Jobs 页能看到失败，但「进程活着但消费者卡死」在 `job_runs` 里
  不产生任何行**，所以那一页也发现不了它。同一个盲区，两处都值得记。

---

## Integration Notes

### 给 Agent 14（最终集成）—— 必做

1. **根模块挂 `AdminOpsModule`**（与 Agent 07 的 `AdminReviewModule` 并列）。
   它自己 `imports: [AuthModule]` 并提供 `ADMIN_ORIGIN_CONFIG` ——
   ⚠ **不要**再手动注册一次守卫或过滤器。
2. **`/admin/*` 与前台同域**是硬前提：`AdminOriginGuard` 按 `Origin`
   判敏感操作，跨域的后台会让**所有变更类请求 403**。
   本模块把后台放在 `apps/web` 的 `/admin/*` 下正是为此（不需要额外配置）。
3. ⚠ **X 白名单停用一个账号之后，前台下一个请求就看不到它的内容** ——
   那是 `source.enabled` 决定的（`docs/04`）。集成验证时别把它当成缓存问题。

### 给 Agent 13（已交付）—— 交叉点

前台的 `/x` 与 `/people` 读的是**同一份** Source 白名单。
后台的 `/admin/sources/x` 改的就是它 —— 两边不共享任何前端代码，
共享的是 API。
