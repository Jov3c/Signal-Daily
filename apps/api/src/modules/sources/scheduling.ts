/**
 * **re-export 垫片** —— 实现已搬到 `@signal/source-core`。
 *
 * 「什么算到期」与「抓完之后下次什么时候抓」这两条规则，写库的一方（本模块，
 * Agent 03）与读库的一方（Agent 04 的 Scheduler，位于
 * `apps/worker/src/jobs/collectors/`）必须是同一套。各写一份的结果是
 * 「后台显示已停用，worker 还在抓」—— 这类不一致在线上极难排查。
 *
 * 因此实现提升为 `packages/source-core`（CCR-agent-03 第 1 项），
 * 本文件只做转出，**不含任何逻辑**。
 *
 * ⚠ 那三条给 Agent 04 的硬警告（`NOW()` 时区陷阱 / 与 `docs/06` 字面表述分叉 /
 * 覆盖索引扫描形态）随实现一起搬走了，见 `packages/source-core/src/scheduling.ts`。
 */

export * from '@signal/source-core';
