/**
 * **re-export 垫片** —— 实现已搬到 `@signal/source-core`。
 *
 * 每种 `SourceType` 的 config 形状是 Collector（Agent 04）**直接消费**的数据结构：
 * 采集器读的就是 `sources.config` 这份 JSON，两边默认值假设一旦不一致，
 * 采集行为会静默变化且无处报错。因此实现提升为共享包
 * （`handoffs/CONTRACT_CHANGE_REQUEST-agent-03.md` 第 1 项、第 6 项），
 * 本文件只做转出，**不含任何逻辑**。
 *
 * 完整契约表（键 / 默认值 / 必填）见 `CONTRACT_CHANGE_REQUEST-agent-03.md` 第 6 项。
 */

export * from '@signal/source-core';
