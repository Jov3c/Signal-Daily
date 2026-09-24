/**
 * 采集失败的类型化错误。
 *
 * ── 为什么需要它，而不直接抛 `Error` ─────────────────────────────────
 * `Source.lastErrorCode` / `RawItem.failure_code` / `JobRun.error_code`
 * 都是给人看的**可行动结论**（`docs/15` 的 `errorCode` 字段）。
 * 管理员看到的是「令牌过期了，去换令牌」还是「上游暂时挂了，等下一轮」，
 * 决定了他要不要动手。所以错误码必须在抛出点就确定，
 * 而不是在 catch 里靠 `error.message` 猜。
 *
 * ── `retryable` 的用途 ──────────────────────────────────────────────
 * Collector 的重试策略是 3 次指数退避（`docs/13`）。对「上游 502」重试是对的；
 * 对「这个来源的配置里没填 handle」重试 3 次毫无意义，只是把失败延迟
 * 15 秒，还会让日志里出现三条同样的记录。因此配置类错误标 `retryable: false`，
 * 由 BullMQ 处理器转成 `UnrecoverableError` 直接终止重试。
 *
 * 一个反例值得记住：如果所有错误都当可重试，那么一个配置错的来源
 * 每天会稳定产生 3 倍噪声日志，真正的问题会被淹掉。
 */

import { DomainErrorCode } from '@signal/contracts';
import { SourceFetchError, UrlSafetyError } from '@signal/source-core';

export class CollectorError extends Error {
  /** 契约里的 Error Code（`DOMAIN_REASON`），进 `last_error_code`。 */
  readonly code: string;
  /** 是否值得重试。配置类错误为 false。 */
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    extras: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, extras.cause === undefined ? undefined : { cause: extras.cause });
    this.name = 'CollectorError';
    this.code = code;
    this.retryable = extras.retryable ?? true;
  }
}

/** 上游暂时不可用 / 超时 / 非 2xx / 响应无法解析。可重试。 */
export function fetchFailed(message: string, cause?: unknown): CollectorError {
  return new CollectorError(DomainErrorCode.SOURCE_FETCH_FAILED, message, { cause });
}

/** 该来源类型需要凭据但没配。不可重试 —— 等管理员去配。 */
export function credentialsMissing(message: string): CollectorError {
  return new CollectorError(DomainErrorCode.SOURCE_FETCH_CREDENTIALS_MISSING, message, {
    retryable: false,
  });
}

/** 上游明确拒绝（401 / 403）。不可重试 —— 重试同一份坏令牌没有意义。 */
export function upstreamUnauthorized(message: string): CollectorError {
  return new CollectorError(DomainErrorCode.SOURCE_FETCH_UNAUTHORIZED, message, {
    retryable: false,
  });
}

/**
 * 适配器产出的 payload 不符合契约表（`payload-keys.ts`）。
 *
 * 这是**代码缺陷**（改了适配器却忘了登记新键），重试 3 次不会自己变好 ——
 * 只会把一条本该立刻暴露的问题延迟 15 秒、并写 3 条同样的日志。
 * 与 `sourceConfigInvalid` 同一类：**人要去改代码**。不可重试。
 */
export function payloadContractViolated(message: string): CollectorError {
  return new CollectorError(DomainErrorCode.SOURCE_CONFIG_INVALID, message, { retryable: false });
}

/** 来源配置缺失或非法（缺 `handle`、缺 `url` 等）。不可重试。 */
export function sourceConfigInvalid(message: string): CollectorError {
  return new CollectorError(DomainErrorCode.SOURCE_CONFIG_INVALID, message, { retryable: false });
}

/** 地址被 SSRF 规则拒绝。不可重试 —— 这个地址永远不该被请求。 */
export function urlNotAllowed(message: string): CollectorError {
  return new CollectorError(DomainErrorCode.SOURCE_URL_NOT_ALLOWED, message, { retryable: false });
}

/**
 * 把底层异常收敛成 `CollectorError`。
 *
 * 两类来自 `@signal/source-core` 的错误要分开处理 —— 这是它文件头就写明的约定：
 *   - `UrlSafetyError`：地址**永远不该**被请求。属于配置错误，不可重试；
 *   - `SourceFetchError`：请求了但没成功（超时 / 连不上 / 5xx / 重定向过多），
 *     属于可重试的运行时故障。
 *
 * 混在一起会让「管理员把内网地址填进了源地址」这种需要改配置的问题，
 * 表现成「源站偶尔不稳定」，从而永远查不出来。
 */
export function toCollectorError(error: unknown, context: string): CollectorError {
  if (error instanceof CollectorError) return error;

  if (error instanceof UrlSafetyError) {
    return urlNotAllowed(`${context}: ${error.safeMessage}`);
  }
  if (error instanceof SourceFetchError) {
    // 带上 `reason`（TIMEOUT / NETWORK / TOO_MANY_REDIRECTS …）——
    // 它是「为什么失败」里唯一不用看日志就能行动的部分。
    return fetchFailed(`${context}: ${error.message} (${error.reason})`, error);
  }

  return fetchFailed(
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
    error,
  );
}
