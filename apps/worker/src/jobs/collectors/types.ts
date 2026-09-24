/**
 * Collector 的统一输出契约 —— `tasks/agent-04-collectors.md`：
 *
 * > 所有 Adapter 返回统一 CollectedItem，并携带 sourceId。
 * > Source tier/kind/official **不复制到 Raw payload 作为事实源**，
 * > 处理时通过 Source 关联读取。
 *
 * ── 「不复制 tier/kind/official」是什么意思（下游必读）──────────────
 * `Source` 的 `kind` / `tier` / `official` 是**编辑配置**，管理员随时可改。
 * 如果把当时的取值写进 `RawItem.payload`，那条 RawItem 就带上了一份
 * **会过期的历史快照**：管理员把某个来源从 `tier=B` 提到 `tier=S` 之后，
 * 老 RawItem 里仍然写着 `B`，而 Pipeline（Agent 05）与 Review（Agent 07）
 * 到底该信谁就成了说不清的事（`docs/22`：Tier 由管理员维护）。
 *
 * 因此规则是：**RawItem 只存「源侧事实」**，一切「这个来源有多可信」
 * 都在读取时经 `source_id` 关联现查。
 * 这条规则的守卫是 `payload-keys.ts` 的**按类型白名单** ——
 * 不是键名黑名单：黑名单会误杀（X 的 `postKind` 曾经因为叫 `kind`
 * 撞上 Source 的 `kind`，让整种来源不可用），也会漏网（嵌套键查不到）。
 *
 * ── 与 `docs/06` 的 CollectorAdapter 接口的关系 ───────────────────────
 * `docs/06` 给的是概念签名 `fetch(source, cursor?) => CollectorBatch`。
 * 这里把它落成可执行类型，并明确了两件 `docs/06` 没写的事：
 *   1. `sourceId` 是 BIGINT → **string**（`docs/02`）；
 *   2. cursor 从**库里已有的事实**推出来（见 `CollectorCursor`）。
 */

import type { ContentType } from '@signal/contracts';
import type { DnsLookup } from '@signal/source-core';
import type { CollectorSource } from './ports';

/* ------------------------------------------------------------------ */
/* Cursor                                                              */
/* ------------------------------------------------------------------ */

/**
 * 增量游标：**「上次已经抓到哪里」**。
 *
 * ⚠ **只有上游真正支持增量语义的适配器才该用它。**
 * 目前只有 X（`since_id` 是单调递增的雪花 id，语义成立）。
 * HN 与 RSS **刻意不用**：它们的「窗口」是榜单顺序 / feed 顺序，
 * 而 id 与顺序不是一回事 —— 拿 id 比较会让「发布较早、后来涨上榜单」
 * 的条目被**永久**跳过（一次真实的 P1 缺陷，见
 * `hacker-news.adapter.ts` 的注释）。那两处改用「取窗口 + 靠库去重」。
 *
 * ── 为什么不是 Adapter 自己维护一个游标字符串 ────────────────────────
 * `sources.config` 是 `Json?`，看起来可以把游标塞进去 —— 但不行：
 * `@signal/source-core` 的 `source-config.schema.ts` 对每种 `SourceType`
 * 都是**严格白名单**，未知键一律 400。往里加 `cursor` 会让管理员在
 * Admin UI 里回传一次 config 就被拒，也等于私自扩了 config 契约（§6/§7）。
 *
 * 而且 `docs/20` 禁止新增 env，`prisma/schema.prisma` 又属 Agent 01
 * （**Agent 04 不得建 Migration**，§10）。
 *
 * 所以游标从**已经落库的事实**推导：这个来源目前最新的
 * `published_at` / `external_id` 就是「上次抓到哪」。这既是唯一
 * 不越界的做法，也比额外存一份状态更不容易不一致 ——
 * 状态只有一个来源，就是 `raw_items` 本身。
 */
export type CollectorCursor = {
  /** 已抓到的最新发布时间（UTC）。上游不支持时间过滤时适配器可忽略它。 */
  sincePublishedAt: Date | null;
  /** 已抓到的最新上游 id（X 的 `since_id`、HN 的自增 id 都用它）。 */
  sinceExternalId: string | null;
};

/* ------------------------------------------------------------------ */
/* CollectedItem                                                       */
/* ------------------------------------------------------------------ */

/**
 * 一条**源侧事实**。
 *
 * 字段选择的依据是 `docs/00`「前台必须至少显示：来源、作者、原发布时间、
 * 阅读原文、原始 URL」+ `docs/03` 的 `raw_items` 列 —— 不多不少，
 * 因为多出来的字段一旦没人消费就会开始漂移。
 */
export type CollectedItem = {
  /** 所属来源，BIGINT → string（`docs/02`）。 */
  sourceId: string;
  /**
   * 源侧自己的 id（RSS 的 guid、X 的 tweet id、GitHub release id、
   * HN item id、HF commit sha）。取不到时为 null，此时靠 URL 去重。
   */
  externalId: string | null;
  /** 原始链接。**必须有** —— `docs/00` 要求公开内容可追溯。 */
  originalUrl: string;
  /** 归一化后的链接，用于跨来源去重（见 `url/canonical.ts`）。 */
  canonicalUrl: string;
  /** 纯文本标题（已去标签与实体）。取不到为 null。 */
  title: string | null;
  /**
   * 原文正文。
   *
   * ⚠ **可能含未清洗的第三方 HTML**（RSS 的 `content:encoded`、
   * MANUAL_URL 的整页 HTML）。`docs/14` 要求「前端不得渲染未清洗 HTML」，
   * 清洗发生在 Pipeline 的 Normalize 阶段（Agent 05）。
   * 采集端保留原文是**刻意**的：RawItem 的语义就是「外部原始抓取事实」
   * （`docs/03`），在这里清洗等于把不可逆的处理提前做掉，
   * 之后再也无法判断原文到底是什么。
   */
  body: string | null;
  /** BCP-47 语言标签，取不到为 null（Pipeline 会用 AI 补 LANGUAGE_DETECT）。 */
  language: string | null;
  /** 原发布时间（UTC）。取不到为 null。 */
  publishedAt: Date | null;
  /** 作者展示名（X handle / RSS 的 dc:creator / GitHub 发布者 / HN by）。 */
  author: string | null;
  /** 建议的内容类型，供 Pipeline 使用（`docs/05` 的 `ContentType`）。 */
  type: ContentType;
  /** 源侧结构化元数据。**只放源侧事实**，见文件头。 */
  payload: Record<string, unknown>;
};

/**
 * 一次采集的产出。
 *
 * `complete` 表示「这一轮把上游给的东西都取回来了」，而不是
 * 「上游已经没有更多内容」—— 后者无法判断。失败**不通过** `complete`
 * 表达：适配器失败就抛异常，由 service 记进 `Source.lastErrorCode`，
 * 不返回一个「看起来成功但 items 为空」的批次。
 */
export type CollectorBatch = {
  items: CollectedItem[];
  /**
   * 「上游这一次能给的，我**都**取回来了」。
   *
   * ⚠ 这个字段曾经恒为 `true`，而实现会在 `maxItems` 截断时静默丢弃
   * 超出窗口的条目 —— 字段的含义与它的取值直接矛盾（`docs/00`：
   * 「同一事件优先聚合，不重复刷屏」的前提是**我们知道少了什么**）。
   * 现在它必须如实反映：截断、分页没取完、窗口小于上游给的量，
   * 全部为 `false`，并由 service 记一条 warn 日志。
   *
   * 刻意**没有** `nextCursor`：适配器不维护游标，游标由 service 从
   * 已落库的事实推导（见 `CollectorCursor`）。一个从没被消费过的
   * 字段比没有这个字段更糟 —— 它会让读者以为适配器可以自己管游标。
   */
  complete: boolean;
  /**
   * 适配器声明的「**每轮最多入库多少条**」（null / 省略 = 不限）。
   *
   * ⚠ 这个上限由 **service 在去重之后**施加，而不是由适配器在解析时施加。
   * 差别是决定性的：
   *
   * - 适配器在解析时截断 → 每轮都取**同一批**最新条目，第 N+1 条之后
   *   **永远轮不到**（feed 顺序稳定）。这正是第一轮审查报的 P1（F-03）：
   *   12 条 feed + `maxItems=2`，连采 4 轮仍只有 2 条，其余 10 条永久丢失。
   * - service 在去重后截断 → 已经采到的被幂等键挡掉，下一轮从上次停下的
   *   地方继续 —— **窗口随轮次向下推进**，`maxItems` 才真的是「单轮上限」。
   *
   * 因此各适配器应当**返回整个窗口**（受一个硬上限约束，避免病态 feed），
   * 把「每轮入库多少」交给这里。
   */
  roundLimit?: number | null;
  /**
   * 非致命的解析问题（例如上游 feed 里有未转义的 `&`）。
   *
   * 与 `skippedCount` 一样属于「必须被看见但不能让采集失败」的信息：
   * 数据是完整的，所以不该失败；但上游确实有问题，所以要进日志。
   */
  warnings: string[];
  /**
   * 因为「追溯不到原始来源」而被跳过的条目数。
   *
   * 单独计数而不是静默丢弃：一个源长期跳过大量条目（例如它只发
   * `<guid>` 而 guid 不是 URL）时，症状是「这个源内容很少」，
   * 而这与「它本来就没什么内容」在数据上长得一模一样。
   * 有了这个数，它会出现在日志与 `JobRun.metadata` 里。
   */
  skippedCount: number;
};

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

/**
 * `docs/06` 的 `CollectorAdapter`。
 *
 * 只保留 `fetch`：`docs/06` 里还有一个 `test(source)`，那是
 * `POST /admin/sources/:id/test` 的实现（Agent 03 的 `source-tester.ts`），
 * 已经存在且已交付。在 Worker 里再实现一份「探测」会让
 * 「后台点 Test 说没问题」与「采集器实际抓取」变成两套判定 ——
 * 正是 `docs/06` 要防的那种不一致，因此**不重复实现**。
 */
export interface CollectorAdapter {
  /** 该适配器处理的 `SourceType`。 */
  readonly type: string;
  fetch(
    source: CollectorSource,
    cursor: CollectorCursor,
    context: CollectorContext,
  ): Promise<CollectorBatch>;
}

/**
 * 适配器运行时上下文。
 *
 * `fetchImpl` / `lookup` 可注入，让测试能在**不联网**的前提下
 * 跑真实的解析与判定逻辑（与 Agent 03 的 `source-tester.ts` 同一手法）。
 * 只把网络那一层换掉，其余全是真代码 —— 避免「测试全绿但真代码从没跑过」。
 */
export type CollectorContext = {
  fetchImpl?: typeof fetch;
  lookup?: DnsLookup;
  /** 单次取数超时预算（毫秒）。 */
  timeoutMs: number;
  /** 单次取数响应体上限（字节）。 */
  maxBytes: number;
  /** 适配器需要的凭据。 */
  credentials: CollectorCredentials;
};

export type CollectorCredentials = {
  xApiBearerToken: string | null;
  githubToken: string | null;
};
