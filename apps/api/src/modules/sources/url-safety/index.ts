/**
 * **re-export 垫片** —— 实现已搬到 `@signal/source-core`。
 *
 * ── 为什么保留这个文件 ──────────────────────────────────────────────
 * 本模块（Agent 03）与 Collector（Agent 04，位于 `apps/worker`）必须共用
 * **同一份** SSRF 防护 —— `docs/06`：「Manual / RSS URL 必须阻止 localhost、
 * private / link-local / metadata IP，并对 redirect 重新校验」。
 * 两份实现迟早会漂移，最终等于没有防护。
 *
 * 原先把实现放在这里，但跨 app 相对路径 import 会触发 `TS6059`
 * （文件不在 worker 的 `rootDir` 内，已实测），因此按
 * `handoffs/CONTRACT_CHANGE_REQUEST-agent-03.md` 第 1 项把它提升为
 * `packages/source-core`。
 *
 * 本文件只做转出，**不含任何逻辑**：既有调用方与既有测试的 import 路径
 * 一行都不用改。新代码请直接从 `@signal/source-core` import，
 * 不要再新增对本路径的依赖。
 *
 * 两个错误类型仍然要分开处理（原说明保留在 `@signal/source-core` 的文件头）：
 * `UrlSafetyError` = 这个地址永远不该被请求；`SourceFetchError` = 可重试的运行时故障。
 */

export * from '@signal/source-core';
