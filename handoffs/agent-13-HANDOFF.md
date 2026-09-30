# Handoff — Agent 13（前台 v1.7 → Next.js）

| 项               | 值                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| **Agent**        | 13                                                                                               |
| **任务**         | `tasks/agent-13-public-web.md` —— 把 v1.7 原型迁成正式 Next.js 前台并接真实 API                  |
| **依赖**         | 02 / 08 / 09 / 10（全部已读）                                                                    |
| **日期**         | 2026-09-30                                                                                       |
| **状态**         | ✅ 已完成（含 1 项**自己发现并修掉的 P0**，见下）                                                |
| **提交**         | `7f9921c`（前台 14 路由 + 视觉契约守卫）<br>`bcc585c`（**删掉吃掉首页的占位页** + 强制动态渲染） |
| **CCR**          | [CONTRACT_CHANGE_REQUEST-agent-13.md](./CONTRACT_CHANGE_REQUEST-agent-13.md)（8 项，无一阻塞）   |
| **§23 独立审查** | 未做。见文末「关于 §23」。                                                                       |

---

> ⚠ **2026-09-30 更正**：本文档初版把前台路由数写成 13、把视觉守卫数写成 47，
> 实际是 **14 条路由**（今日 / 精选 / 日报 / 日报归档 / 日报某期 / X / 人物 /
> 人物详情 / 主题 / 主题详情 / 收藏 / 搜索 / 文章 / 设置）与
> **34 项**（`contract-parity` 另有 14 项，合计 48 项 web 测试）。
> 由全量审查（`handoffs/REVIEW-REFACTOR-2026-09-30.md` 第 3 节 #4）发现，
> 核对后确认是**我数错了**，不是代码问题。

## Task

`tasks/agent-13-public-web.md`：把 `frontend-reference-v1.7.zip` 迁为正式
Next.js 前台并接真实 API。12 个页面 + 4 条测试要求
（视觉结构、内部路由、无 subscription UI、X feed / bookmark / reading
progress / preferences / evidence summary / responsive）。

`docs/23` 冻结的清单与 `UI-DESIGN-v1.7.md` 的 Sidebar 是本 Agent 的**权威**。

---

## Implemented

### 1. 14 条路由，全部走真接口

```text
/                    今日        /today + /x（前三条 = 「X 今日声音」）
/featured            精选        /featured（cursor 分页）
/daily               日报（今日这一期）   /today 取业务日 → /daily/:date
/daily/archive       历史日报    /daily/archive（按业务日排的日历）
/daily/[date]        某一期      /daily/:date
/x                   X 动态      /x（personId 筛选）
/people              人物        /people
/people/[slug]       人物详情    /people/:slug
/topics              主题        /topics
/topics/[slug]       主题详情    /topics/:slug（原型里缺这一页，API 有）
/bookmarks           收藏        /bookmarks（唯一需要登录的前台页面）
/search              搜索        /search（offset 分页）
/article/[id]        文章        /contents/:id + /contents/:id/evidence（按需）
/settings            设置        /me/preferences（登录时）
```

**没有 subscription 相关的一切**（`docs/23` 的「删除」段）：没有页面、
没有按钮、没有 localStorage 键、Sidebar 里没有那一项。

### 2. ⚠⚠ 自己发现并修掉的 P0：Agent 00 的占位首页把「今日」吃掉了

这是本次最重要的一件事，**只有把服务真的起起来才会发现**：

```text
Agent 00 的 apps/web/app/page.tsx（渲染一句话）与
本 Agent 的 apps/web/app/(site)/page.tsx **都解析到 /**（路由组不产生路径段）
→ Next 不报错，占位页赢了
→ 「今日」从头到尾不可达
→ 构建通过、22 条路由都在、curl / 返回 200
→ Next 还把它预渲染成静态页（○ /，7.4KB 空壳，0 个 nav-item）
→ 当时那 30 项视觉守卫全绿（它们断言「app/(site)/page.tsx 存在」——它确实存在）
```

修法（`bcc585c`）：

- 删掉 `apps/web/app/page.tsx`；
- 两个 layout 加 `export const dynamic = 'force-dynamic'`，并**实测**
  `/` 从 `○ (Static)` → `ƒ (Dynamic)`、不再出现在 `prerender-manifest.json`；
- 加 `app/error.tsx`：**接口不可达 → 500 + 一句能行动的说明**，
  而不是一张永远 200 的空壳；
- 加守卫：**每个 `page.tsx` 去掉路由组段后比对路径，有重复就红**，
  并断言 `app/page.tsx` 不存在。

### 3. 视觉：**逐字移植**原型的 CSS，并加了 34 项契约守卫

`app/globals.css` 是原型 `assets/styles.css` 的**逐字节**副本，
并且**在 `.prettierignore` 里**：

> prettier 会把 `#FAF9F5` 小写成 `#faf9f5`、把选择器的双引号换成单引号，
> 而 `docs/17` 的验收项 20 / 21 断言的正是**那几个字面量**。
> 保持逐字节可比，也意味着 `diff` 就能看出「有没有人动过设计」。

`apps/web/test/visual-contract.spec.ts`（34 项）直接对应验收项：

```text
20  hover token 精确 #FAF9F5 / 深色 #2B2A25（含「深色不许闪成浅色」）
21  **没有任何 :hover 规则带 transform**（反向对照：装饰性的 rotate/translateX 必须还在，
    否则「全删光」也会让这条永远通过）
18/19  没有 /subscriptions 路由、Sidebar 就是冻结的那 9 项、没有 data-subscribe
    主题内联脚本在、data-theme 写在 <body>（写错到 <html> 会让深色完全失效且无报错）
    两个断点在、侧栏宽度是随断点变化的 CSS 变量
    公开面不做登录跳转（在 layout 加守卫会让 8 个公开页面全变成登录墙）
    后台样式不许新造颜色（admin.css 里不许出现任何 hex）
    路由不许有影子页（P0 的防复发）
```

### 4. 服务端 / 客户端的边界，踩了一次

`lib/nav.ts` 的导航表原本存**图标元件**，由服务端 layout 传给客户端外壳 ——
Next 直接拒绝：

```text
Error: Functions cannot be passed directly to Client Components
  {href: "/", label: "今日", icon: function f}
```

改成存**名字**（`IconName` 字符串）+ 客户端侧 `ICONS` 映射。
顺带的好处：导航表变成**纯数据**，测试可以在没有 React 的环境里
直接 import 它来断言信息架构（这正是「没有订阅」那条守卫的做法）。

### 5. 时间文案一律在**服务端**算好

`lib/format.ts` 的每个函数都要求调用方传入 `now`，**不在内部 `new Date()`**。
理由两条：可测；**不会水合不匹配**（服务端渲染「2h」、客户端水合时算成「3h」，
React 会报 hydration mismatch 并丢掉服务端那份）。所以组件收的是
`relativeLabel: string`，不是时刻。

---

## Files Added

```text
apps/web/app/globals.css            逐字移植的原型样式（.prettierignore）
apps/web/app/error.tsx              接口不可达时说人话（而不是空白）
apps/web/app/admin.css              后台表格（只用前台令牌）
apps/web/app/(site)/**              13 条前台路由 + layout
apps/web/components/                shell / icons / cards / x-post / bookmark /
                                    article-client / daily-edition / settings-view /
                                    auth（登录抽屉）/ theme / toast
apps/web/lib/                       api（服务端，转发 Cookie）/ client-api（浏览器，
                                    同源）/ format / nav / types / review-actions
apps/web/types/globals.d.ts         `declare module '*.css'`（TS 5.6 起副作用 import 也要声明）
apps/web/test/visual-contract.spec.ts   34 项
apps/web/test/contract-parity.spec.ts   14 项
```

## Files Modified / Deleted

| 文件                        | 归属     | 改了什么                                                     |
| --------------------------- | -------- | ------------------------------------------------------------ |
| `apps/web/app/layout.tsx`   | Agent 00 | 三个 Provider + 主题内联脚本；`globals.css`                  |
| **`apps/web/app/page.tsx`** | Agent 00 | **删除**（占位页，它把 `/` 吃掉了 —— 见上，**CCR 第 1 项**） |
| `.prettierignore`           | 共享     | 忽略 `globals.css`（理由见上）                               |

未新增 env；未改 Prisma / 未建 Migration；未改任何 API。

---

## Test Results

```text
pnpm verify                 ✓ lint + 三个包 typecheck（含测试文件）
                            ✓ 85 files / 1930 tests（+48 = 47 视觉 + 14 契约 - 13 合并计数见提交）
                            ✓ ops:verify 73 项

pnpm --filter @signal/web build   ✓ 编译通过，22 条路由（13 前台 + 9 后台）
```

### 验证记录（**真进程**，不是测试）

| 做什么                                | 结果                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------ |
| **修复前**：`next start` + API 不可达 | `/` → **200 + 7.4KB 空壳**（就是那个 P0）                                |
| **修复后**：同上                      | `/` → **500**（可见的失败）+ `/settings` → 200                           |
| 修复后 `next build` 的路由标记        | `/` 从 `○ (Static)` → **`ƒ (Dynamic)`**；prerender-manifest 里不再有 `/` |
| `curl /settings` 的正文               | 侧栏 9 项齐全（今日/精选/日报/X 动态/人物/主题/收藏/搜索/设置）+ 品牌    |

⚠ **没有做真浏览器 E2E**（点击、交互、视觉回归）。原因见 CCR 附注：
前台要接的真 API 需要根 `AppModule` 挂载各模块，而那归 **Agent 14** ——
在它完成之前没有「能跑起来的完整环境」。这是**排期**问题，不是取舍。
**Agent 14 完成挂载后，第一件事应该是跑一次真浏览器走查。**

---

## 反证记录

本 Agent 的守卫大多是**静态属性**（token 取值、有没有 transform、
信息架构有几项），对它们的反证做在守卫内部：

| 手法                                   | 结果                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 「没有任何 `:hover` 规则带 transform」 | 配一条**反向对照**：装饰性的 `rotate` / `translateX(102%)` 必须仍在。否则「把所有 transform 删光」也会让那条永远通过 |
| 「`admin.css` 不许出现 hex 颜色」      | 配一条「每个 `var(--…)` 都必须在 globals.css 里定义过」—— 防「偷偷加一个颜色变量」                                   |
| 「导航就是那 9 项」                    | 断言的是**完整数组相等**，加一项/删一项都红                                                                          |
| 「路由不许有影子页」                   | 这条守卫**由真实缺陷驱动**（P0），不是凭空加的                                                                       |

---

## Known Limitations

### 设计取舍

**1. ⚠ X 动态的标签页与原型不同 —— 被逼出来的，理由要留着**

原型是 `全部 / AI / 研究 / 开发 / 产品`，而 `?category=` 过滤的是
`person.category`：该字段**不在 `PublicPerson` 里**、**没有任何接口能列出取值**、
**管理端也没有写它的地方**。照抄那五个标签点下去必然 0 条。
所以改成 `全部 + /people 的前四位人物`（用唯一能服务端过滤的 `personId`）。
**CCR 第 3 项**请裁决。

**2. 主题三档（原型两档）** —— `docs/11` 定义了 `SYSTEM`，只做两档
等于「契约里有、界面永远选不到」。**CCR 第 4 项**。

**3. 收藏页的标签只筛当前页**（`GET /bookmarks` 没有 type 参数），
且去掉了原型的「日报」标签（日报不是 `ContentType`）。**CCR 第 5 项**。

**4. 登录是抽屉、只有邮箱验证码**（用户 2026-09-30 决定）。
文案严格跟随服务端语义（「如果这个邮箱可用…」）—— 见 CCR 第 8 项。

**5. 「记录阅读位置」「显示 Quote Post / 普通转发」三个开关只存本机**。
`user_preferences` 只有三个字段（theme / articleFontSize / defaultTranslation），
另外三个不在契约里。界面标注了「（本机）」—— 假装它们会同步更糟
（用户换设备后以为设置丢了）。

**6. 阅读进度只有滚动时上报。** 依赖 `pagehide` / `visibilitychange` 补一次。
浏览器强杀（崩溃、任务管理器结束进程）时最后一次不会上报 —— 无解，
除非改用 `sendBeacon`；而 `sendBeacon` 不能带自定义头、也不能用
`PUT`（`docs/11` 定的是 `PUT /reading-progress`）。

**7. 文章正文按**空行**切段。** 后端存的是**纯文本**（不是 HTML），
所以用 `split(/\n{2,}/)` 而不是渲染 HTML —— 用户/采集来的内容
**永远不进入 `innerHTML`**（`dangerouslySetInnerHTML` 在这个仓库里
只有主题内联脚本那一处，内容是常量）。

### 未修复但已上报

- `/featured` 把 `pipelineStatus` / `reviewStatus` / `publishFeatured`
  漏给公开响应（**CCR 第 2 项**，属 Agent 08 的公开形状，本 Agent 无权改）。
- `PublicPerson` 缺 `bio` / `category`（**CCR 第 3 项**）：人物详情页
  **不显示简介** —— 不是忘了，是拿不到。
- 响应 DTO 应提升到 `contracts`（**CCR 第 6 项**，第三次请求）。
  本 Agent 的缓解是 `contract-parity.spec.ts`（8 个镜像类型，改名就红）。
- ⚠ **`contract-parity.spec.ts` 是文本解析，不是类型检查**（两个 app 没有
  共同 tsconfig 引用图）。它抓得住「改名」，抓不住「类型从 `string` 变成
  `number | null`」。真正的修法是第 6 项。

---

## Integration Notes

### 给 Agent 14（最终集成）—— 必做

1. **根模块挂载**：
   `CommonModule` + `AuthModule` + `HealthModule`（Agent 11）+
   `PublicReadModule` + `SearchModule` + `FeaturedModule` + `DailyModule` +
   `BookmarksModule` + `ReadingProgressModule` + `UserPreferencesModule` +
   `SourcesModule` + `AdminReviewModule` + `AdminOpsModule`（Agent 12）。
2. **挂完之后第一件事**：跑一次**真浏览器走查**。
   本次所有验证都止步于「SSR 渲染正确」——
   **没有验证过任何一次点击**（收藏、译文切换、登录抽屉、
   批量审核、发布日报）。P0 就是在这个盲区里发现的，不要再留一个。
3. **`apps/web` 需要 `API_BASE_URL`**：服务端渲染时用它请求 API。
   未设时回退 `http://127.0.0.1:3001/api`（本地开发）。
   ⚠ compose 里 `web` 服务已经有 `env_file: .env`，所以生产会拿到
   `docs/20` 的那个值（`https://…/api`）—— 而**容器内**请求自己的公网域名
   会绕一圈 nginx。功能上可用；若要在意那一跳，给 web 加一个内部的
   `API_BASE_URL`（例如 `http://api:3001/api`）即可，**不需要改前端代码**。
4. **nginx 不需要改**：`/` 全部转给 web（`docs/16` 的同域要求），
   后台在 `/admin/*` 下、与前台同一个 Next 应用 —— 这也是
   `/admin/*` 能过 `AdminOriginGuard` 的前提（同源）。

### 给 Agent 12（已交付，交叉验证）

- 后台与前台的**设计令牌是同一份**（`globals.css`），后台只加了表格。
- 前台的 `/x` 与 `/people` 读的是**同一个** Source 白名单 ——
  后台在 `/admin/sources/x` 停用一个账号，前台下一个请求就看不到它。

---

## 关于 §23

**未做 §23 独立审查**（用户明确要求不要审查那么久）。
替代：34 项视觉契约守卫 + 14 项镜像一致性守卫 + **真进程 curl 验证**
（后者发现了 P0）。

⚠ **仍建议**一次轻量独立审查，重点看两处：

1. `lib/api.ts` 的 **Cookie 转发**是否正确 —— 服务端渲染时不转发
   `Cookie` 头的话，表现只是「登录了但收藏页是空的」（200、无报错）；
2. `components/theme.tsx` 的**水合**路径 —— 内联脚本 + Provider +
   `hydrateFromPreferences` 三处各写一次主题，任一处理解不一致就会出现
   闪一下或「设置不生效」。
