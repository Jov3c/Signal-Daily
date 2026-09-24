/**
 * 调度规则 —— **Source Registry 与 Collector 共用的唯一一份**。
 *
 * ── 为什么单独放一个文件 ────────────────────────────────────────────
 * 「什么算到期」和「抓完之后下次什么时候抓」这两条规则，
 * 写库的一方（本模块）与读库的一方（Agent 04 的 Scheduler，
 * 位于 `apps/worker/src/jobs/collectors/`）必须是同一套。
 * 各写一份的结果是：后台看到「已停用」，worker 却还在抓 ——
 * 这类不一致在线上极难排查。
 *
 * 因此本文件**不 import 任何东西**（连 `@signal/*` 都没有），
 * 只导出纯对象与纯函数。Agent 04 可以：
 *   - 直接 `import { buildDueSourcesWhere, DUE_SOURCES_ORDER_BY }` 喂给自己的
 *     Prisma client；
 *   - 或者在本文件被提升为共享包之后原样搬走（见
 *     `handoffs/CONTRACT_CHANGE_REQUEST-agent-03.md`）。
 *
 * 对应的索引是 Agent 01 已建好的 `sources(enabled, next_fetch_at)`
 * （`docs/03`），正是为这条查询准备的。
 */

/* ------------------------------------------------------------------ */
/* Fetch interval                                                      */
/* ------------------------------------------------------------------ */

/** 最小抓取间隔：1 分钟（`docs/06` 的调度精度就是每分钟一轮）。 */
export const MIN_FETCH_INTERVAL_SECONDS = 60;

/** 最大抓取间隔：7 天。再长就不像「自动采集」了，几乎一定是填错了。 */
export const MAX_FETCH_INTERVAL_SECONDS = 604_800;

/** 建库默认值，与 `prisma/schema.prisma` 的 `@default(1800)` 一致。 */
export const DEFAULT_FETCH_INTERVAL_SECONDS = 1_800;

/** 单轮调度最多取多少个到期来源，避免一次把队列灌满。 */
export const DUE_SOURCES_BATCH_SIZE = 100;

export function isValidFetchInterval(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= MIN_FETCH_INTERVAL_SECONDS &&
    seconds <= MAX_FETCH_INTERVAL_SECONDS
  );
}

/**
 * 下一次该抓的时间 = 基准时刻 + 抓取间隔。
 *
 * 刻意以**「本轮开始的时刻」**为基准而不是「本轮结束的时刻」：
 * 后者会让实际周期变成 `interval + 抓取耗时`，抓得越慢周期越长，
 * 在慢源上会持续退化。
 */
export function computeNextFetchAt(fetchIntervalSeconds: number, from: Date): Date {
  return new Date(from.getTime() + fetchIntervalSeconds * 1_000);
}

/* ------------------------------------------------------------------ */
/* Due sources                                                         */
/* ------------------------------------------------------------------ */

/**
 * 「到期」的 Prisma `where` 片段。
 *
 * 两个条件缺一不可：
 *   - `enabled: true` —— **停用之后必须立刻不再被采到**（`docs/06`：
 *     「停用后停止产生新抓取任务」）。任务要求里有一条专门的测试就是它。
 *   - `nextFetchAt <= now`（**或为 NULL**）—— `next_fetch_at` 是可空列，
 *     且 Agent 01 的 seed 建的 8 个来源**都没有写这一列**。
 *     只判 `lte` 会让所有 seed 出来的来源永远不到期，静默不采集。
 *     这是实测确认过的（见 HANDOFF）。
 *
 * 返回值是普通对象而不是 Prisma 生成类型：这样它不依赖 `@prisma/client`，
 * Agent 04 在自己的 Prisma client 上可以直接用。
 *
 * ── ⚠⚠ 给 Agent 04 的三条硬警告（独立审查提出，都是跨 Agent 的坑）──────────
 *
 * **① `now` 必须是应用侧时钟。绝不要用 SQL 的 `NOW()` 代替它。**
 *
 *    本机的 MySQL `time_zone = SYSTEM = Asia/Shanghai`，而 `next_fetch_at`
 *    存的是 **UTC**（Prisma 按 UTC 读写 `DateTime`）。实测：
 *
 *    ```
 *    NOW(3)           = 2026-09-24T09:55:05.129Z   ← MySQL 认为的「现在」
 *    UTC_TIMESTAMP(3) = 2026-09-24T01:55:05.129Z   ← 真正的 UTC
 *    ```
 *
 *    任何手写 SQL / 迁移 / 运维脚本里的 `WHERE next_fetch_at <= NOW()`
 *    都会让来源**提前 8 小时**到期 —— 静默、无报错、后台完全看不出来。
 *    要用 SQL 表达就用 `UTC_TIMESTAMP()`，或者直接绑定 Prisma 的 `Date`。
 *
 * **② 本规则与 `docs/06` 的**字面**表述不一致，以本文件为准。**
 *
 *    `docs/06` 写的是「每分钟查 `enabled && next_fetch_at <= now`」，
 *    没有提 NULL。若照字面实现，Agent 01 seed 出来的 8 个来源
 *    （`next_fetch_at` 全是 NULL）**永远不会被采集**，而且是静默的。
 *    已提交 `CONTRACT_CHANGE_REQUEST-agent-03.md` 第 5 项请求把这条写进文档；
 *    在文档更新前，**以本文件为准**。
 *
 * **③ 这条查询走的是覆盖索引扫描（`type=index`），不是范围扫描（`type=range`）。**
 *
 *    `OR ... IS NULL` 会让优化器放弃 range 访问路径。实测 `EXPLAIN`：
 *
 *    ```
 *    带 OR IS NULL     -> type=index  key=sources_enabled_next_fetch_at_idx  rows=8
 *    只判 <= now       -> type=range  key=sources_enabled_next_fetch_at_idx  rows=1
 *    ```
 *
 *    当前规模（几十到几千行）代价可忽略：`enabled` 是索引前导列且是覆盖索引，
 *    `ORDER BY next_fetch_at, id` 与索引顺序一致，`LIMIT` 仍可提前结束。
 *    记录在此以免将来有人看到 `type=index` 时误以为是缺索引。
 */
export type DueSourcesFilter = {
  enabled: true;
  OR: [{ nextFetchAt: null }, { nextFetchAt: { lte: Date } }];
};

export function buildDueSourcesWhere(now: Date): DueSourcesFilter {
  return {
    enabled: true,
    OR: [{ nextFetchAt: null }, { nextFetchAt: { lte: now } }],
  };
}

/**
 * 到期的排序：**先到期的先抓**，同一时刻按 id 兜底保证顺序稳定
 * （否则同一批来源在两轮之间的顺序会随机漂移，出问题时无法复现）。
 *
 * 刻意**不按 priority 排序**：`priority` 是编辑权重（影响前台排序与
 * 人工判断），不是调度优先级。按它排会让一个高 priority 的慢源
 * 反复插队，把 `nextFetchAt` 早的来源饿死 —— 而 `nextFetchAt` 的语义
 * 就是「该轮到它了」。
 */
export const DUE_SOURCES_ORDER_BY = [
  { nextFetchAt: 'asc' },
  { id: 'asc' },
] as const;

/** 这条查询依赖的索引，写在这里以便和 Agent 01 的 schema 对齐。 */
export const DUE_SOURCES_INDEX = 'sources(enabled, next_fetch_at)';
