/**
 * 来源 URL 的安全校验（SSRF 防护的「语法层」）。
 *
 * `docs/06`：Manual / RSS URL 必须阻止 localhost、private / link-local / metadata IP。
 * `docs/14` 把「Source URL SSRF」列为第一号风险。
 *
 * 这一层是**同步、不做 DNS** 的：它负责
 *   1. 只允许 http / https；
 *   2. 拒绝 URL 内嵌凭据（`http://user:pass@host/`）—— 凭据会进库、进日志、进响应；
 *   3. 把 WHATWG 解析器归一化后的 hostname 拿去判黑名单。
 *
 * 第 3 步之所以成立，是因为已实测（`work/_agent03/probe-url-normalization.mjs`）
 * WHATWG 会把 `2130706433` / `0x7f000001` / `017700000001` / `127.1` / `ⓛocalhost`
 * / `local%68ost` 全部归一化成规范形式。**但 `localhost.` 的尾点会保留**，
 * 而 IPv6 里的 `::ffff:127.0.0.1` 会变成 `::ffff:7f00:1` —— 这两点在本文件里处理。
 *
 * ⚠ 本层**不做 DNS 解析**，因此挡不住「一个公网域名解析到 127.0.0.1」。
 * 那一层在 `safe-fetch.ts` 里，取用前必须先解析并校验**每一个**返回的地址
 * （实测 `localhost` 会同时返回 `::1` 与 `127.0.0.1`，只看第一条就会漏）。
 */

import { isIP } from 'node:net';
import { AppError, DomainErrorCode } from '@signal/contracts';
import { isBlockedIpAddress } from './ip';

/**
 * 被拒绝的具体原因。固定取值，不含任何用户输入，可以安全地放进 `details`。
 *
 * 这里**只放「这个 URL 永远不该被请求」的判定**。「请求了但没成功」
 * （超时 / 连不上 / DNS 查不到 / 重定向过多）不属于 URL 安全，见
 * `safe-fetch.ts` 的 `SourceFetchFailureReason` —— 两者混在一起会让
 * 「地址本身非法」与「地址合法但暂时不可达」无法区分，
 * 而这两件事对管理员要做的事完全不同。
 */
export type UrlSafetyReason =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'CREDENTIALS_IN_URL'
  | 'BLOCKED_PORT'
  | 'BLOCKED_HOST'
  | 'BLOCKED_IP';

const REASON_MESSAGE: Readonly<Record<UrlSafetyReason, string>> = {
  INVALID_URL: 'Source URL is not a valid absolute URL',
  UNSUPPORTED_SCHEME: 'Source URL must use http or https',
  CREDENTIALS_IN_URL: 'Source URL must not embed credentials',
  BLOCKED_PORT: 'Source URL must not use port 0',
  BLOCKED_HOST: 'Source URL must not point to a local or internal host',
  BLOCKED_IP: 'Source URL must not point to a private, loopback or link-local address',
};

/**
 * URL 被 SSRF 规则拒绝。
 *
 * `safeMessage` 刻意**只描述规则、不回显 URL** —— URL 的查询串里可能有
 * 一次性 token 或签名（`docs/14`：不得记录完整 URL 的查询串），
 * 而错误响应同样会进日志与前端。
 */
export class UrlSafetyError extends AppError {
  readonly reason: UrlSafetyReason;

  constructor(reason: UrlSafetyReason, cause?: unknown) {
    super({
      code: DomainErrorCode.SOURCE_URL_NOT_ALLOWED,
      httpStatus: 400,
      safeMessage: REASON_MESSAGE[reason],
      details: { reason },
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = 'UrlSafetyError';
    this.reason = reason;
  }
}

/**
 * 归一化 hostname，供黑名单比较。
 *
 * 三个必须做的处理（每一项都对应一个已实测的绕过手法）：
 *   - 去掉 IPv6 的方括号：`url.hostname` 对 IPv6 返回 `[::1]`；
 *   - **去掉尾点**：`localhost.` 与 `localhost` 是同一台机器，
 *     但 `localhost.endsWith('.localhost')` 为 false，会直接漏过；
 *   - 小写（WHATWG 已经小写，这里只是防御「直接调用本函数」的路径）。
 */
export function normalizeHostname(raw: string): string {
  let host = raw;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host.toLowerCase();
}

/** 明确不允许的内部域名后缀（`host` 必须已归一化）。 */
const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  'localhost',
  '.localhost',
  '.local', // mDNS
  '.internal', // 常见云内网域名，含 metadata.google.internal
  '.home.arpa',
];

/**
 * 域名是否指向本机 / 内网。
 *
 * 注意「单标签主机名」（`http://intranet/`）也一律拒绝：这类名字靠 DNS 搜索域
 * 解析，在企业网里通常落在内网服务上，而公网来源不应该依赖搜索域。
 */
export function isBlockedHostname(host: string): boolean {
  if (host === '') return true;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(suffix)) return true;
  }
  // 单标签（不含点）且不是 IP —— 交由 isIP 判过的调用方处理，这里直接拒。
  if (!host.includes('.')) return true;
  return false;
}

/** 解析一个绝对 URL；不合法就抛 `INVALID_URL`。 */
export function parseSourceUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed === '') throw new UrlSafetyError('INVALID_URL');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new UrlSafetyError('INVALID_URL', error);
  }
  return url;
}

/**
 * 校验并返回**归一化后**的 URL；不通过就抛 `UrlSafetyError`。
 *
 * 返回归一化结果很重要：调用方应当把 DNS 校验、连接、以及最终入库都建立
 * 在同一个 URL 对象上，避免「检查的和用的不是同一个字符串」。
 */
export function assertSafeSourceUrl(raw: string): URL {
  const url = parseSourceUrl(raw);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlSafetyError('UNSUPPORTED_SCHEME');
  }

  if (url.username !== '' || url.password !== '') {
    throw new UrlSafetyError('CREDENTIALS_IN_URL');
  }

  // 端口 0 在多数栈上语义未定义，且不是任何真实服务的端口。
  if (url.port === '0') throw new UrlSafetyError('BLOCKED_PORT');

  const host = normalizeHostname(url.hostname);
  if (host === '') throw new UrlSafetyError('BLOCKED_HOST');

  if (isIP(host) !== 0) {
    // 字面量 IP：直接判黑名单（已覆盖十进制 / 十六进制 / 八进制 / 短写 / IPv6
    // 内嵌 IPv4 等伪装写法）。
    if (isBlockedIpAddress(host)) throw new UrlSafetyError('BLOCKED_IP');
    return url;
  }

  if (isBlockedHostname(host)) throw new UrlSafetyError('BLOCKED_HOST');
  return url;
}

/**
 * 供展示 / 日志的安全形式：**去掉查询串、hash 与凭据**，只留
 * `scheme://host[:port]/path`。
 *
 * 用它的地方：`test` 端点的响应、任何需要提到 URL 的日志行。
 * 直接把原始 URL 写进日志等于把查询串里的 token 写进日志（`docs/14`）。
 */
export function redactUrlForDisplay(input: string | URL): string {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    // 解析不了的字符串不留任何内容，避免把畸形输入原样带出去。
    return '(invalid url)';
  }
  const port = url.port === '' ? '' : `:${url.port}`;
  // 尾斜杠只在 path 为空时补，`/a/b` 保持原样。
  const path = url.pathname === '' ? '/' : url.pathname;
  return `${url.protocol}//${url.hostname}${port}${path}`;
}
