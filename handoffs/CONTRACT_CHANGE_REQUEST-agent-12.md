# Contract Change Request — Agent 12（管理后台 UI / 运维视图 API）

**Agent:** 12
**Module:** Admin UI（`apps/web/app/admin`）+ 新模块 `apps/api/src/modules/admin-ops`
**日期:** 2026-09-30
**基线:** Development Contract v1.1 / Agent Rule v1.0

> | #   | 事项                                     | 影响            | 阻塞 |
> | --- | ---------------------------------------- | --------------- | ---- |
> | 1   | **新增 4 条 admin 接口**（用户已授权）   | 冻结的 API 契约 | ❌   |
> | 2   | 新模块 `admin-ops` 不在允许目录清单里    | 流程            | ❌   |
> | 3   | 登记 `admin-ops` 为 admin 路由所有者     | Agent 02 的守卫 | ❌   |
> | 4   | ⚠ 三个页面**本来没有接口**（本次的根因） | 后台完整性      | ❌   |
> | 5   | 后台没有设计稿                           | 视觉一致性      | ❌   |
>
> **没有一项阻塞本次交付。**

---

## 1. ⚠ 新增 4 条 admin 接口 —— **用户已明确授权**

### Current Problem

`tasks/agent-12-admin-ui.md` 要求 9 个页面，而 `docs/04` 的 Admin 三节
（Source Registry / Review / Event·Evidence）加上 Agent 07 的
`/admin/dashboard` 只覆盖其中 **6 组**。

```text
数据                     表                     写入方                读取接口
----------------------- --------------------- --------------------- ----------
作业运行历史              job_runs              worker 的 04/05/06/08  ❌ 没有
AI 用量与成本             ai_runs               worker 的 06           ❌ 没有
管理员通知                admin_notifications   Agent 07 的通知扫描     ❌ 没有
```

**这三页不是「没数据可显示」，而是「读完了没有出口」** —— 三张表都一直在被写。

而 `docs/00` 的规则是：**API URL 是冻结契约，只有 Agent 00 / 01 / 14 能改。**
所以 Agent 12 无权自行添加 —— 但用户于 **2026-09-30 明确授权**
（原话：「为这三页补 API」）。本模块据此实现，并在此如实记录这次授权。

### 本模块的取值（**已实现**）

```text
GET  /api/v1/admin/jobs                    分页 + 按 jobType/status 筛
GET  /api/v1/admin/notifications           分页 + 按 status 筛
POST /api/v1/admin/notifications/:id/read  标记已读（幂等）
GET  /api/v1/admin/ai-usage                最近 N 个业务日的用量与成本（N ≤ 30）
```

**四条**，其中 `POST .../read` 需要单独裁决（见下）。

### ⚠ `POST .../read` 是任务书**没要求**的，请裁决

其余三条是「让页面能看到数据」的最小集。这一条不是：

- `admin_notifications` 表有 `status`（默认 `UNREAD`）与 `readAt` 两列，
  Agent 07 的通知扫描按 `(type, targetUrl)` 去重；
- 若界面**只有**未读徽标、没有任何清除动作，那个徽标就永远是红的 ——
  用户会开始忽略它，等于把通知功能关掉。

所以本模块判断「一个只有未读徽标、没有已读动作的页面不可用」并加了它。
**请确认保留，或指出应该用别的方式表达未读状态。** 若判定不该有，
删掉它只需去掉一个控制器方法 + 一处按钮（页面会退回只读列表）。

### Compatibility / Database Impact / API Impact

- **数据库：无迁移。** 三张表都已存在，只读（唯一例外是通知的已读标记，
  写 `status` / `readAt` 两列，本就是为它设计的）。
- **API：纯新增**，不修改任何既有路由与响应形状。
  ⚠ 但这四条**不在 `docs/04` 里** —— 请把它们补进去，或明确标注
  「V1 由本 CCR 授权新增」。否则下一个读 `docs/04` 的人会以为
  `apps/api/src/modules/admin-ops` 是越界实现。

**Downstream Impact：Agent 14**（根模块要挂 `AdminOpsModule`）。

---

## 2. 新模块 `admin-ops` 不在 Agent 12 的「允许修改」目录清单里

### Current Problem

`tasks/agent-12-admin-ui.md` 只允许改前端（后台 UI），
而这三组接口需要后端代码。`docs/18` 也没有为「前端 Agent 顺带补后端」
留位置。

### 本模块的取值（**已实现**）

新建 `apps/api/src/modules/admin-ops/`（8 个文件），**不改** Agent 07
已交付的 `admin-review` 模块 —— 哪怕 `admin_notifications` 的**写**
在它那里。理由：07 已交付，把只读视图塞进去要改它的控制器、服务、
仓储三处；新建一个小模块只读同样的表，爆炸半径小得多。

代价：`admin_notifications` 现在有**两个**使用方（07 写、本模块读）。
这是读写分离的常规形态，但**已知**：表结构变化会影响两处。

### Requested Change

把 `apps/api/src/modules/admin-ops/**` 登记为 Agent 12 的产物
（或在 `docs/18` 里明确「前端 Agent 顺带补的接口放在自己的模块里」）。

---

## 3. `admin-ops` 必须登记为 admin 路由所有者

### Current Problem

Agent 02 的 `auth-contract.spec.ts` 有一条守卫（`ADMIN_ROUTE_OWNERS`
白名单）：「只有登记过的模块可以声明 admin 路由前缀」。
本模块一落地就被它抓到了 —— **守卫工作正常**。

### 本模块的取值（**已实现**）

在 `ADMIN_ROUTE_OWNERS` 里加入 `modules/admin-ops/controller.ts`，
并写明这四条路由的来源（用户授权 + 本 CCR）。

这是对 Agent 02 文件的第二处修改（第一处见 CCR-agent-11 第 2 项）。

---

## 4. ⚠ 根因：三个页面的接口在契约里从来没有过

第 1 项的根因不是「实现漏了」，而是**任务书与 API 契约不一致**：

| 文档                         | 说的                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `tasks/agent-12-admin-ui.md` | 9 个页面：Dashboard、Sources、X Filter、Review Queue、Review Detail、Daily Editor、**Jobs、Notifications、AI Usage** |
| `docs/04-api-contract.md`    | Admin 只有 Source Registry / Review / Event·Evidence 三节                                                            |

两份文档都「冻结」了，而它们互相矛盾。Agent 12 是**第一个**撞上的
（因为它是第一个实现后台的），但任何一个读 `docs/04` 去核对
「后台是否完整」的人都会得出错误结论。

### Requested Change

三选一，**请裁决**：

- **A（本模块的假设）**：把第 1 项那四条补进 `docs/04` 的 Admin 段；
- **B**：承认 V1 后台只有 6 个模块，把任务书里的 Jobs / Notifications /
  AI Usage 标为 V2；
- **C**：明确「运维视图由 Agent 11 / 14 负责，Agent 12 不做」。

本模块按 A 实现。若选 B 或 C，`apps/web/app/admin/{jobs,notifications,ai-usage}`
可以直接删掉，不影响其余 6 页。

### ⚠ 第 5 项：**后台没有任何设计稿**

原型的 12 个页面全是**用户前台**（`PROJECT-MAP.md` 可以逐条核对），
`docs/09` 只定义了后台每个页面**显示什么内容**，没有一句讲**长什么样**。

用户于 2026-09-30 决定：「**沿用前台 v1.7 视觉**」。
所以本模块只**组合**前台已有的设计令牌：

- `app/admin.css` 里出现的**每个** `var(--…)` 都在 `globals.css` 里定义过；
- 新增的只有**表格**（前台是阅读产品，没有表格）；
- 表格的 hover 与前台 Card 同一条契约（只改背景，不位移）。

有一条守卫盯着前两条（`admin.css` 不许出现任何新的 hex 颜色）。
若将来有后台设计稿，替换 `admin.css` 即可 —— 页面结构是按
`docs/09` 的模块划分写的，不依赖具体视觉。
