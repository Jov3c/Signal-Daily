# Contract Change Request — Agent 13（前台 v1.7 → Next.js）

**Agent:** 13
**Module:** Public Web（`apps/web`）
**日期:** 2026-09-30
**基线:** Development Contract v1.1 / Frontend Prototype v1.7

> | #   | 事项                                                 | 影响                   | 阻塞 |
> | --- | ---------------------------------------------------- | ---------------------- | ---- |
> | 1   | ⚠ **删了 Agent 00 的 `apps/web/app/page.tsx`**       | Agent 00（**P0**）     | ❌   |
> | 2   | `/featured` 把后台内部状态漏给公开响应               | **安全**（docs/14）    | ❌   |
> | 3   | `PublicPerson` 缺 `bio`/`category`，且无分类清单接口 | 原型的一个控件做不出来 | ❌   |
> | 4   | 主题做成三档（原型两档）                             | 产品                   | ❌   |
> | 5   | 收藏页的分类标签只能筛当前页                         | 产品                   | ❌   |
> | 6   | 响应 DTO 应该提升到 `contracts`（**第三次请求**）    | 三个前端 Agent         | ❌   |
> | 7   | `shiftBusinessDate` 在 api 与 web 各有一份           | 复用                   | ❌   |
> | 8   | 登录做成抽屉（用户决定）                             | 已裁决                 | ❌   |
>
> **没有一项阻塞本次交付。**

---

## 1. ⚠⚠ 删除了 Agent 00 的 `apps/web/app/page.tsx` —— 它把整个「今日」吃掉了

### Current Problem

Agent 00 留了一个占位首页 `apps/web/app/page.tsx`（渲染一句话
「Signal web shell」）。而本 Agent 把真的首页放在
`apps/web/app/(site)/page.tsx`。

**路由组 `(site)` 不产生路径段** —— 于是两者**都解析到 `/`**。
Next **没有报任何错**，占位页赢了。

后果链条（每一环看起来都正常）：

```text
「今日」从头到尾不可达
构建通过；22 条路由都在；curl / 返回 200
Next 还把它预渲染成静态页（○ /，7.4KB 空壳，只有 <title>，0 个 nav-item）
30 项视觉守卫全绿 —— 它们断言的是「app/(site)/page.tsx 存在」，
而它确实存在。没有任何一条断言「谁在服务 /」
```

**是「把服务真的起起来 curl 一下」才发现的** —— 测试与构建都不会告诉你。

### 本模块的取值（**已实现**）

- 删除 `apps/web/app/page.tsx`；
- 两个 layout 加 `export const dynamic = 'force-dynamic'`（并**实测**：
  `/` 从 `○ (Static)` 变成 `ƒ (Dynamic)`，不再出现在 prerender-manifest 里）；
- 新增 `app/error.tsx`：接口不可达时返回 **500 与一句能行动的说明**，
  而不是一张永远 200 的空壳；
- 新增守卫：**把每个 `page.tsx` 的路径去掉路由组段之后比对，
  有重复就红**，并断言 `app/page.tsx` 不存在。

### Requested Change

确认删除。`app/page.tsx` 是 Agent 00 用来证明「web 空壳可启动」的，
那个目的已经由 `apps/api/test/boot.spec.ts` 之类的方式覆盖；
而它留在这里的**唯一效果**是让首页不可达。

⚠ **建议把这条写进 `docs/18`**：路由组与根路径的冲突不会被 Next 报错，
新增 `app/(group)/page.tsx` 时必须同时删掉 `app/page.tsx`。

---

## 2. ⚠ `/featured` 把后台内部状态漏进公开响应

### Current Problem

`GET /featured`（公开接口）返回的是 Agent 08 的仓储行**原样**：

```ts
// apps/api/src/modules/featured/controller.ts
return cursorEnvelope(result.rows, result.nextCursor);
```

而 `FeaturedRow.content` 里带着三个**编辑台内部字段**：

```text
pipelineStatus   内容审核状态（docs/14：不把后台 debug 信息搬给用户）
reviewStatus     同上
publishFeatured  同上
```

**日报有投影层，精选没有**：`apps/api/src/modules/daily/public-view.ts`
的文件头写着「投影层让**新增字段默认不外泄**」，理由是
「以后给编辑台加一个内部字段会变成意外泄漏，而这类泄漏不会让任何测试变红」。
同一段理由对精选完全成立，但精选那边没有那层投影。

### 本模块的取值（**只做了前端这一半**）

前台**不读**这三个字段（`lib/types.ts` 的 `FeaturedRow` 刻意不声明它们，
并写明了原因）。但这不改变「它们能被 curl 到」的事实。

### Requested Change

给 `/featured` 加一层 `toPublicFeatured()`（照 `daily/public-view.ts` 写），
或明确「精选的这三个字段可以公开」。

⚠ 这**不在本 Agent 的权限内**（改 Agent 08 的公开响应形状是契约变更），
所以只是上报，**没有动**。

---

## 3. ⚠ 原型里的 X 分类标签**做不出来**

### Current Problem

`x.html` 有五个标签：`全部 / AI / 研究 / 开发 / 产品`。
而 API 的 `/x?category=` 过滤的是 **`person.category`**：

```ts
// prisma-public-read.repository.ts
...(input.category === undefined ? {} : { authorPerson: { is: { category: input.category } } })
```

而 `person.category` 是一个 `VarChar(120)` 自由文本，问题在于：

```text
1. `PublicPerson`（contracts）**没有** category 字段  → 前端拿不到每人的分类
2. 没有任何接口能列出「有哪些分类」                     → 5 个标签的取值无从得知
3. 管理端（Agent 12 的 Source 表单）也没有写它的地方    → 这个字段目前是空的
```

**照抄那五个标签，点下去必然 0 条** —— 那是一个看起来能点、
实际永远为空的控件，比换一组标签更糟。

### 本模块的取值（**已实现**）

标签改成 `全部` + `/people` 的**前四位人物**，用 `personId` 过滤 ——
那是唯一一个真的能服务端过滤的参数。视觉形状（`.tabs` 里的按钮）
与原型一致，语义换成了能工作的那个。前端有一条注释完整说明了这件事。

### Requested Change

三选一：

- **A**：`PublicPerson` 增加 `category`，并加 `GET /people/categories`
  （或在 `/people` 里返回 `categories: string[]`）→ 可以还原原型的分类标签；
- **B**：明确「V1 的 X 动态按人物筛选」，把 `x.html` 的五个标签改成人物；
- **C**：明确 V1 不做分类浏览，并把 `/x` 的 `category` 参数标为未使用。

⚠ 顺带：`person.category` 目前**没有任何写入路径**（管理端没有这个字段），
所以即使做了 A，管理员也无处设置它。若要它有意义，
Agent 12 的 Source 表单也要加这一项。

---

## 4. 主题做成**三档**，原型只有两档

### Current Problem

`settings.html` 只有「浅色 / 深色」两个按钮（`UI-DESIGN-v1.7` 也这么写）。
而 `docs/11` 定义的是 `theme: LIGHT / DARK / **SYSTEM**`。

只做两档 → **`SYSTEM` 这个取值在界面上永远无法被选中** ——
与「收藏 API 有了但没有登录入口」是同一类缺陷。

### 本模块的取值（**已实现**）

三档（浅色 / 深色 / 跟随系统），默认 `LIGHT`（原型：浅色是产品默认视觉），
`SYSTEM` 时跟随 `prefers-color-scheme`。

### Requested Change

确认三档，或把 `docs/11` 的 `UserTheme.SYSTEM` 标为「V1 未实现」。
（后者会连带影响 Agent 09 的 `/me/preferences` 校验 —— 它现在接受 SYSTEM。）

---

## 5. 收藏页的分类标签只能筛**当前页**

### Current Problem

原型 `bookmarks.html` 有四个标签：`全部 / 文章 / X / 日报`。
而 `GET /bookmarks`（`docs/04`）**没有 type 过滤参数**，
只按时间倒序返回。

### 本模块的取值（**已实现**）

- 三个标签（`全部 / 文章 / X`）+ 一句「仅筛本页（N 条）」的说明；
- **去掉「日报」标签**：日报不是 `ContentType`（它是一期编排），
  所以收藏里永远不会有它 —— 那个标签必然是空的。

### Requested Change

- 若希望分类是**全量**的：`GET /bookmarks` 加 `?type=`；
- 若接受「只筛本页」：请确认，并把「日报」标签的删除记入原型变更。

---

## 6. 响应 DTO 应该提升到 `@signal/contracts`（**第三个 Agent 提这件事**）

`apps/web` 里有一批类型是**后端模块内 DTO 的镜像**，因为
`@signal/contracts` 只冻结了公共枚举与 `dto/public.ts`：

| 镜像                 | 真源                                  | 谁先提过 |
| -------------------- | ------------------------------------- | -------- |
| `MeDto`              | `users/dto/me.dto.ts`（Agent 02）     | Agent 02 |
| `UserPreferences`    | `user-preferences/dto.ts`（Agent 09） | Agent 09 |
| `PublicDailyEdition` | `daily/public-view.ts`（Agent 08）    | Agent 08 |
| `FeaturedRow`        | `featured/repository.ts`（Agent 08）  | —        |
| `DashboardStats` 等  | `admin-review/*`（Agent 07）          | Agent 07 |
| `SourceDto`          | `sources/dto/*`（Agent 03）           | Agent 03 |

**每一个前端 Agent 都要重新镜像一遍**，而每一次镜像都是一次漂移机会
（后端起个新名字，前端读 `undefined`，表格里那一列静静变空）。

本模块的缓解措施是 `apps/web/test/contract-parity.spec.ts`
（8 个镜像类型的字段必须都能在后端真源里找到，改名就红）。
但那是**补丁**，不是修法。

### Requested Change

把上表这些**响应形状**提升到 `packages/contracts/src/dto/`。

---

## 7. `shiftBusinessDate` 在 api 与 web 各有一份

`apps/api/src/modules/admin-ops/service.ts` 与本模块的
`apps/web/lib/format.ts` 各有一个「业务日 ±N 天」的纯函数，逻辑相同。

前端 import 不了 `apps/api`，而 `@signal/contracts` 的 `time.ts`
目前只有常量与 `isBusinessDate`。**两处都有测试**，函数也只有 6 行，
所以重复的代价可以接受 —— 但若要修，把它放进
`packages/contracts/src/time.ts` 是最自然的位置（业务日算术本就是领域概念）。

---

## 8. 登录做成**抽屉**、只做邮箱验证码（用户 2026-09-30 的决定）

已裁决，此处只做记录：

- 原型**没有任何登录界面**（它是静态 mock），而 `docs/11` 明说 V1 的
  登录用户能力是收藏 / 阅读进度 / 阅读偏好同步 —— 三条 API 都要登录；
- 用户选择：**抽屉弹窗**（复用原型的 `.drawer` 视觉，日历面板就是它）、
  **只做邮箱验证码**、**先不接 GitHub**；
- 后端的 `GET /auth/github` 与回调**照常工作**，只是界面不给入口 ——
  将来要加只需在抽屉里补一个按钮，后端不用动。

### ⚠ 文案契约（服务端语义决定，前端不能改）

`POST /auth/email/request-code` 的响应恒为 `{sent:true}` ——
**服务端刻意不透露该邮箱是否已注册**（防账号枚举）。
所以界面只能写「**如果这个邮箱可用**，验证码已经发出」。

写成「已发送，请查收」就等于把「这个邮箱没注册」变成一个可观测的差异，
把服务端堵住的洞重新打开。本模块的文案严格跟随这条语义。

---

## 附：本 Agent **没有**做的事（如实记录）

1. **没有跑真浏览器 E2E。** 原因是一个**排期**问题而不是取舍：
   前台要接的真 API 需要根 `AppModule` 挂载各模块，而那归 Agent 14。
   在此之前没有「能跑起来的完整环境」。
   已做的替代验证见 HANDOFF 的「验证记录」——包括**真进程 curl**
   （正是它发现了第 1 项那个 P0）。
2. **没有做 Agent 12 的后台**（那是它的范围，已由 Agent 12 交付）。
3. **没有改任何 API 的响应形状**（第 2、3、5 项都是上报而非修改）。
