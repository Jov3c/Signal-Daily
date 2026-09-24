/**
 * `url-safety` —— **SSRF 防护的唯一实现，供 Collector 复用。**
 *
 * ── 给 Agent 04（Collectors）的复用说明 ──────────────────────────────
 * 禁止另写一份。`docs/06`：「Manual / RSS URL 必须阻止 localhost、private /
 * link-local / metadata IP，并对 redirect 重新校验」—— 两份实现迟早会漂移。
 *
 * 典型用法：
 *
 * ```ts
 * import {
 *   safeFetchText,
 *   assertSafeSourceUrl,
 *   assertHostResolvesToPublicAddress,
 *   SourceFetchError,
 *   UrlSafetyError,
 *   redactUrlForDisplay,
 *   isBlockedIpAddress,
 * } from '../sources/url-safety';
 *
 * // ① 新增 / 编辑来源时（同步、不联网）：
 * const url = assertSafeSourceUrl(rawUrl);
 *
 * // ② 真正抓取时（含 DNS 校验、逐跳重定向再校验、超时与大小上限）：
 * const result = await safeFetchText(url.toString(), {
 *   timeoutMs: 10_000,   // ← 取自 docs/20 的 SOURCE_FETCH_TIMEOUT_MS
 *   maxBytes: 2_097_152, // ← 取自 docs/20 的 SOURCE_FETCH_MAX_BYTES
 *   headers: { accept: 'application/rss+xml, application/xml;q=0.9' },
 * });
 * // result.status / result.body / result.truncated …
 * // 记日志时用 result.displayUrl，不要用 result.finalUrl（后者含查询串）
 * ```
 *
 * 两个错误类型要分开处理，它们对调用方意味着不同的事：
 *   - `UrlSafetyError`（`AppError`，`SOURCE_URL_NOT_ALLOWED`）→
 *     **这个地址永远不该被请求**。写库时应当直接拒绝；抓取时应当把
 *     该 Source 标记为配置错误，而不是当普通失败重试。
 *   - `SourceFetchError` → 请求了但没成功（超时 / 连不上 / 5xx / 重定向过多）。
 *     属于可重试的运行时故障。
 *
 * ── 本目录的依赖约束 ───────────────────────────────────────────────
 * 只依赖 Node 内置模块与 `@signal/contracts`（两个 app 都已依赖它）。
 * **不得**引入 Nest、Prisma、ioredis 或任何 `apps/*` 内部模块 ——
 * 否则 `apps/worker` 就无法复用（会把整个 API 的依赖树拖进 worker 构建）。
 * 见 `handoffs/CONTRACT_CHANGE_REQUEST-agent-03.md` 第 1 项。
 */

export {
  type Ipv4Bytes,
  type Ipv6Bytes,
  embeddedIpv4Of,
  isBlockedIpAddress,
  isBlockedIpv4,
  isBlockedIpv6,
  parseIpv4Bytes,
  parseIpv6ToBytes,
} from './ip';

export {
  type UrlSafetyReason,
  UrlSafetyError,
  assertSafeSourceUrl,
  isBlockedHostname,
  normalizeHostname,
  parseSourceUrl,
  redactUrlForDisplay,
} from './url-safety';

export {
  DEFAULT_MAX_REDIRECTS,
  type DnsAddress,
  type DnsLookup,
  type SafeFetchDeps,
  type SafeFetchRequest,
  type SafeFetchResult,
  type SourceFetchFailureReason,
  SourceFetchError,
  assertHostResolvesToPublicAddress,
  charsetOf,
  decodeChunks,
  defaultDnsLookup,
  safeFetchText,
} from './safe-fetch';
