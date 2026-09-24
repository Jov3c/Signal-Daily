/**
 * `@signal/source-core` —— **信源采集内核，API 与 Worker 共用的唯一一份实现。**
 *
 * ── 为什么会有这个包 ────────────────────────────────────────────────
 * 这三样东西写库的一方（`apps/api` 的 Source Registry，Agent 03）与
 * 读库/抓取的一方（`apps/worker` 的 Collector，Agent 04）**必须完全一致**：
 *
 * | 单元                  | 若各写一份的后果                                                     |
 * | --------------------- | -------------------------------------------------------------------- |
 * | SSRF / URL 安全       | `docs/06` 明令「对 redirect 重新校验」；两份实现必然漂移，最终等于没有防护 |
 * | 「什么算到期」        | 后台显示「已停用」，worker 却还在抓 —— 线上极难排查                  |
 * | 每种类型的 config 形状 | Collector 读的就是这份 JSON；默认值假设不一致 → 采集行为静默变化    |
 *
 * 原先这三样都放在 `apps/api/src/modules/sources/` 下，而 Agent 04 在
 * `apps/worker` —— 跨 app 相对路径 import 会直接触发 `TS6059`
 * （文件不在 `rootDir` 内），实测确认。复制一份则被 `docs/06` 禁止。
 * 因此按 `handoffs/CONTRACT_CHANGE_REQUEST-agent-03.md` 第 1 项提取为本包。
 *
 * ── 依赖约束（**不要破坏**）────────────────────────────────────────
 * 本包只允许依赖 Node 内置模块与 `@signal/contracts`（两个 app 都已依赖它）。
 * **不得**引入 Nest、Prisma、ioredis 或任何 `apps/*` 内部模块 ——
 * 一旦引入，worker 就会被拖进整个 API 的依赖树。
 *
 * ── 兼容性 ────────────────────────────────────────────────────────
 * 本次是**纯搬迁**：`apps/api/src/modules/sources/` 下保留了同名的
 * re-export 垫片，Agent 03 的模块与全部既有测试的 import 路径一行未改。
 */

export * from './url-safety';

export {
  DUE_SOURCES_BATCH_SIZE,
  DUE_SOURCES_INDEX,
  DUE_SOURCES_ORDER_BY,
  DEFAULT_FETCH_INTERVAL_SECONDS,
  MAX_FETCH_INTERVAL_SECONDS,
  MIN_FETCH_INTERVAL_SECONDS,
  computeNextFetchAt,
  isValidFetchInterval,
  type DueSourcesFilter,
  buildDueSourcesWhere,
} from './scheduling';

export {
  DEFAULT_RSS_MAX_ITEMS,
  HACKER_NEWS_FEEDS,
  HUGGINGFACE_REPO_TYPES,
  MAX_RSS_MAX_ITEMS,
  MIN_RSS_MAX_ITEMS,
  buildSourceConfig,
  type HackerNewsFeed,
  type HuggingFaceRepoType,
  type SourceConfigInput,
  type ValidatedSourceConfig,
} from './source-config.schema';
