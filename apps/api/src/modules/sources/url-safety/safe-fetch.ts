/**
 * 带 SSRF 防护的 HTTP 取数。
 *
 * ── 为什么必须有这一层（语法层不够）────────────────────────────────────
 * `assertSafeSourceUrl()` 只能看到**字面量**。`http://evil.example/` 是完全合法的
 * 公网域名，但它可以解析到 `127.0.0.1`。所以真正发起请求之前必须：
 *
 *   1. **解析 DNS，并校验返回的每一个地址**。实测
 *      `lookup('localhost', { all: true })` 会同时返回 `::1` 与 `127.0.0.1` ——
 *      只看第一条就会漏。任一地址被阻止即整体拒绝（fail-closed）。
 *   2. **手动跟随重定向，并在每一跳重新做一次完整校验**（URL 语法 + DNS）。
 *      `docs/06` 明确要求「对 redirect 重新校验」：一个公网地址
 *      302 到 `http://169.254.169.254/` 是最经典的 metadata 窃取路径。
 *   3. **限制总耗时与响应大小**，上限取 `docs/20` 已有的
 *      `SOURCE_FETCH_TIMEOUT_MS` / `SOURCE_FETCH_MAX_BYTES`
 *      （**不新增 env**）。大小上限必须在**流式读取过程中**生效 ——
 *      读完再判大小等于让服务器随意把内存打满。
 *
 * ── 已知残留风险（已记录在 HANDOFF，不假装已解决）─────────────────────
 * TOCTOU / DNS rebinding：本实现的「解析 → 校验 → 连接」之间，
 * DNS 仍可能改答案。彻底消除需要把已校验的 IP **钉住**再连接
 * （自定义 agent / 直连 IP + Host 头），那属于 Collector（Agent 04）的
 * 连接层职责。当前实现显著收窄了攻击面，但不等价于完全消除。
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBlockedIpAddress } from './ip';
import {
  UrlSafetyError,
  assertSafeSourceUrl,
  normalizeHostname,
  redactUrlForDisplay,
} from './url-safety';

/** DNS 解析结果（只保留我们需要的字段）。 */
export type DnsAddress = { address: string; family: number };

/** DNS 解析端口。做成可注入的，测试不必真的联网。 */
export type DnsLookup = (hostname: string) => Promise<DnsAddress[]>;

/** 默认实现：`all: true` 是关键 —— 要拿到**全部**地址才能逐个校验。 */
export const defaultDnsLookup: DnsLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family }));
};

/** 请求失败（**不是** URL 非法）的原因。 */
export type SourceFetchFailureReason =
  | 'TIMEOUT'
  | 'NETWORK'
  | 'DNS_RESOLUTION_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'REDIRECT_WITHOUT_LOCATION'
  /**
   * 重定向的 `Location` 无法解析成 URL。
   *
   * ⚠ 这个成员是**独立审查发现后补上的**：原先 `new URL(location, current)`
   * 没有兜住 `TypeError(ERR_INVALID_URL)`，一个远端返回的畸形 `Location`
   * 就能让 `POST /:id/test` 变成 500 —— 直接击穿「探测失败也是 200 + {ok:false}」
   * 这条契约。`Location` 是完全由对端控制的输入。
   */
  | 'INVALID_REDIRECT';

/**
 * 取数失败。
 *
 * 刻意**不**是 `AppError`：它没有「该回什么 HTTP 状态码」的答案 ——
 * `POST /:id/test` 会把它变成一条诊断结论（`{ok:false}`），
 * Collector 会把它变成 `RawItem.failureCode`。把它做成 AppError 会诱导
 * 调用方把一个「上游暂时不可用」报成 4xx/5xx 给管理员。
 */
export class SourceFetchError extends Error {
  readonly reason: SourceFetchFailureReason;
  /** 触发失败的那一跳的 HTTP 状态码（重定向类失败时有值）。 */
  readonly status: number | null;

  constructor(
    reason: SourceFetchFailureReason,
    message: string,
    extras: { status?: number; cause?: unknown } = {},
  ) {
    super(message, extras.cause === undefined ? undefined : { cause: extras.cause });
    this.name = 'SourceFetchError';
    this.reason = reason;
    this.status = extras.status ?? null;
  }
}

export type SafeFetchDeps = {
  /** 默认用全局 `fetch`。测试注入替身即可，无需联网。 */
  fetchImpl?: typeof fetch;
  lookup?: DnsLookup;
  /** 默认 `Date.now`。测试注入假时钟以确定性地覆盖超时分支。 */
  now?: () => number;
};

export type SafeFetchRequest = {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
};

export type SafeFetchResult = {
  status: number;
  /**
   * 真实最终 URL（完成重定向之后）。
   *
   * ⚠ 采集器需要它来解析相对链接，所以这里给的是**真值**。
   * 任何要记日志 / 回响应的地方请改用 `displayUrl`。
   */
  finalUrl: string;
  /** 已去掉查询串与凭据的展示形式，可直接进日志与响应。 */
  displayUrl: string;
  contentType: string | null;
  body: string;
  bytes: number;
  /** 是否因为超过 `maxBytes` 被截断。 */
  truncated: boolean;
  /** 经过的重定向（展示形式）。 */
  redirects: string[];
  elapsedMs: number;
};

/** 默认最多跟随 5 跳重定向。 */
export const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * **跨主机**重定向时必须丢弃的请求头。
 *
 * ── 为什么需要（独立审查发现）──────────────────────────────────────
 * 逐跳重新校验解决了「目标是不是公网地址」，但没有解决
 * 「**还是不是同一台主机**」。`X_USER` 与 `GITHUB_REPO` 的探测会带上真实的
 * `X_API_BEARER_TOKEN` / `GITHUB_TOKEN`，而 `headers` 原样带到了每一跳 ——
 * 只要任何一跳落在别的公网主机上，令牌就跟着走了。
 *
 * 实测（`work/_agent03/repro-cross-host-redirect.mjs`）：302 跳到
 * 第三方主机时，第二个请求的 `authorization` 仍是完整的
 * `Bearer SUPER_SECRET_TOKEN`。
 *
 * 可达性说明：目前只有两个**硬编码**的厂商端点会带头（`api.x.com` /
 * `api.github.com`），管理员无法把目标改到别处，因此真实利用需要厂商端点
 * 自己跨域跳转。但这是「公网 → 公网」维度上唯一没被校验的地方，
 * 补上它几乎零成本。
 */
const SENSITIVE_HEADERS: readonly string[] = ['authorization', 'cookie', 'proxy-authorization'];

/** 丢弃敏感头（大小写不敏感）。跨主机跳转时使用。 */
export function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.includes(name.toLowerCase())) continue;
    kept[name] = value;
  }
  return kept;
}

/**
 * 解析 hostname 并确认**每一个**解析结果都是公网地址。
 *
 * 字面量 IP 直接跳过（`assertSafeSourceUrl()` 已经校验过）。
 * DNS 查不到 → `DNS_RESOLUTION_FAILED`；查到内网地址 → `UrlSafetyError('BLOCKED_IP')`
 * —— 后者是「这个 URL 不该被请求」，用 URL 安全的错误类型才是对的。
 */
export async function assertHostResolvesToPublicAddress(
  url: URL,
  lookup: DnsLookup,
): Promise<void> {
  const host = normalizeHostname(url.hostname);
  if (isIP(host) !== 0) return;

  let addresses: DnsAddress[];
  try {
    addresses = await lookup(host);
  } catch (error) {
    throw new SourceFetchError('DNS_RESOLUTION_FAILED', 'Source host could not be resolved', {
      cause: error,
    });
  }

  if (addresses.length === 0) {
    throw new SourceFetchError('DNS_RESOLUTION_FAILED', 'Source host resolved to no address');
  }

  for (const entry of addresses) {
    if (isBlockedIpAddress(entry.address)) {
      // 走到这里说明「域名看着正常，实际指向内网」——典型的 SSRF。
      throw new UrlSafetyError('BLOCKED_IP');
    }
  }
}

/** 取 `content-type` 里的 charset，取不到就用 utf-8。 */
export function charsetOf(contentType: string | null): string {
  if (contentType === null) return 'utf-8';
  const match = /charset\s*=\s*"?([A-Za-z0-9._-]+)"?/i.exec(contentType);
  return match?.[1] ?? 'utf-8';
}

/**
 * 流式读取响应体，超过 `maxBytes` 立刻停止并取消流。
 *
 * 关键点：**边读边判**。先 `await response.text()` 再 `slice(0, maxBytes)`
 * 看着等价，实则已经让对端把任意大小的数据写进了内存。
 */
async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<{ chunks: Uint8Array[]; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (body === null) return { chunks: [], bytes: 0, truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    // `done` 必须先判：这样「长度恰好等于上限」的响应不会被误标为截断。
    if (done) break;
    if (value === undefined) continue;

    const remaining = maxBytes - bytes;
    if (value.byteLength > remaining) {
      if (remaining > 0) {
        chunks.push(value.subarray(0, remaining));
        bytes += remaining;
      }
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    bytes += value.byteLength;
  }

  return { chunks, bytes, truncated };
}

/** 合并分片并按 charset 解码。未知 charset 回退 utf-8（中文 RSS 常见 GBK）。 */
export function decodeChunks(chunks: Uint8Array[], contentType: string | null): string {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const charset = charsetOf(contentType);
  try {
    return new TextDecoder(charset).decode(merged);
  } catch {
    return new TextDecoder('utf-8').decode(merged);
  }
}

/**
 * 取回一个 URL 的文本内容，全程带 SSRF 防护。
 *
 * 超时是**整条重定向链共享的一个预算**，不是「每跳各给一份」——
 * 否则 5 跳重定向会把最坏耗时放大 5 倍。
 */
export async function safeFetchText(
  rawUrl: string,
  request: SafeFetchRequest,
  deps: SafeFetchDeps = {},
): Promise<SafeFetchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookupImpl = deps.lookup ?? defaultDnsLookup;
  const now = deps.now ?? Date.now;
  const maxRedirects = request.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const startedAt = now();
  const deadline = startedAt + request.timeoutMs;

  let method: 'GET' | 'HEAD' = request.method ?? 'GET';
  let current = assertSafeSourceUrl(rawUrl);
  // 请求头是**逐跳可变**的：跨主机跳转时要丢掉敏感头（见 SENSITIVE_HEADERS）。
  let headers: Record<string, string> = { ...(request.headers ?? {}) };
  const redirects: string[] = [];

  for (let hop = 0; ; hop += 1) {
    // ★ 每一跳都重新做 DNS 校验（含第一跳）。
    await assertHostResolvesToPublicAddress(current, lookupImpl);

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new SourceFetchError('TIMEOUT', 'Source request timed out');
    }

    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        method,
        redirect: 'manual',
        headers,
        // 剩余预算给整个请求（含响应体读取）。
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch (error) {
      // AbortSignal.timeout 触发时抛的是 TimeoutError。
      if (isAbortError(error)) {
        throw new SourceFetchError('TIMEOUT', 'Source request timed out', { cause: error });
      }
      throw new SourceFetchError('NETWORK', 'Source request failed', { cause: error });
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      // 重定向响应体没有价值，早点放弃，避免占用连接。
      await response.body?.cancel().catch(() => undefined);

      if (location === null || location.trim() === '') {
        throw new SourceFetchError(
          'REDIRECT_WITHOUT_LOCATION',
          `Source responded ${response.status} without a Location header`,
          { status: response.status },
        );
      }
      if (hop >= maxRedirects) {
        throw new SourceFetchError('TOO_MANY_REDIRECTS', 'Source redirected too many times', {
          status: response.status,
        });
      }

      // ★ 重新校验下一跳：先解析成绝对地址，再走一遍完整的语法 + 主机校验。
      //   公网 → 内网的重定向在这里被挡下。
      //
      // ⚠ 解析必须兜住 `TypeError(ERR_INVALID_URL)`：`Location` 是**对端完全可控**
      //   的输入，一个畸形值（`http://[::1`、`https://%%%`、越界端口）会让
      //   `new URL()` 抛错。不兜的话它会一路冒泡成 500，击穿
      //   「探测失败也是 200 + {ok:false}」这条契约（独立审查实测 4/4 复现）。
      let next: URL;
      try {
        next = new URL(location, current);
      } catch (error) {
        throw new SourceFetchError('INVALID_REDIRECT', 'Source redirected to an unparseable URL', {
          status: response.status,
          cause: error,
        });
      }

      const validated = assertSafeSourceUrl(next.toString());

      // ★ 跨主机跳转必须丢掉敏感头 —— 否则 X / GitHub 的令牌会跟着跳到第三方。
      if (validated.origin !== current.origin) {
        headers = stripSensitiveHeaders(headers);
      }

      redirects.push(redactUrlForDisplay(validated));
      current = validated;
      // 303 语义上等价于「去 GET 那个地址」。
      if (response.status === 303) method = 'GET';
      continue;
    }

    const contentType = response.headers.get('content-type');
    const { chunks, bytes, truncated } = await readCappedBody(response, request.maxBytes);

    return {
      status: response.status,
      finalUrl: current.toString(),
      displayUrl: redactUrlForDisplay(current),
      contentType,
      body: decodeChunks(chunks, contentType),
      bytes,
      truncated,
      redirects,
      elapsedMs: now() - startedAt,
    };
  }
}

/** `AbortSignal.timeout()` 触发时抛出的 DOMException（name 为 `TimeoutError`）。 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}
