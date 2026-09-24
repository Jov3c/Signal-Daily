/**
 * 适配器共用的出网取数。
 *
 * ── 唯一的取数入口 ──────────────────────────────────────────────────
 * **所有**适配器的网络请求都必须走 `@signal/source-core` 的 `safeFetchText`，
 * 不允许任何适配器自己调 `fetch`。理由不是洁癖，是 `docs/14` 把
 * 「Source URL SSRF」列为第一号风险，而它需要三层同时成立：
 *
 *   1. URL 语法 + 内网 IP 黑名单（`assertSafeSourceUrl`）
 *   2. **DNS 解析后逐个地址校验**（只看第一条就是漏洞）
 *   3. **逐跳重定向再校验** + 超时/体积上限（流式边读边停）
 *
 * 任何一处绕过，前面几处就都白做了。收在一个文件里，新加适配器时
 * 就没有「忘记校验」这个选项。
 *
 * ── 固定厂商端点为什么也走这一层 ────────────────────────────────────
 * `api.github.com` / `hacker-news.firebaseio.com` 这些地址是硬编码的，
 * 看起来不需要 SSRF 防护。但它们仍然走 `safeFetchText`，因为
 * 另外两个能力是**每个**出网请求都需要的：**超时预算**与**体积上限**。
 * 一个卡住的 HN 请求会占满 collector 队列的并发额度（`docs/13`：并发 5），
 * 把其他来源一起饿死。
 *
 * ── 网络依赖只从 `CollectorContext` 取（只有一套机制）────────────────
 * 超时、体积、凭据、`fetchImpl`、`lookup` **全部**在 `CollectorContext` 上，
 * 适配器不再另设一份构造参数。这一点是被测试逼出来的：曾经
 * `fetchImpl` 走构造函数、`timeoutMs` 走上下文，结果测试注入的网络替身
 * 根本没生效 —— 所有适配器测试都在打真实网络并撞 5 秒超时。
 * 两套机制并存时，「注入了但没生效」是一个不会报错的故障。
 */

import type { SafeFetchResult } from '@signal/source-core';
import { safeFetchText } from '@signal/source-core';
import { fetchFailed, upstreamUnauthorized } from '../errors';
import type { CollectorContext } from '../types';

export type HttpRequest = {
  url: string;
  headers?: Record<string, string>;
  /**
   * 这一个请求自己的**更严**的体积上限（可选）。
   *
   * 与 `context.maxBytes` 取较小值。用途：返回元数据的端点
   * （HN 的榜单列表约 4KB、X 的用户查找约几百字节）不该有机会
   * 拉回 2MB —— 那不会报错，只是白白占用连接与内存。
   * 放宽（大于全局上限）是不允许的：那等于绕过 `docs/20` 的配置。
   */
  maxBytes?: number;
  /** 人类可读的来源描述，只用于错误信息（**不含凭据**）。 */
  what: string;
};

/** 取文本。失败一律收敛成 `CollectorError`。 */
export async function getText(
  request: HttpRequest,
  context: CollectorContext,
): Promise<SafeFetchResult> {
  const result = await safeFetchText(
    request.url,
    {
      method: 'GET',
      headers: request.headers,
      timeoutMs: context.timeoutMs,
      maxBytes:
        request.maxBytes === undefined
          ? context.maxBytes
          : Math.min(context.maxBytes, request.maxBytes),
    },
    { fetchImpl: context.fetchImpl, lookup: context.lookup },
  );

  assertOkStatus(result, request);
  return result;
}

/**
 * 取 JSON 并解析。
 *
 * ⚠ **不做 `as T` 硬转**：外部 JSON 的形状是**不可信输入**，
 * 一个上游改字段就能让 `data.items.length` 变成
 * 「Cannot read properties of undefined」这类 500 级异常。
 * 因此返回 `unknown`，由每个适配器用类型守卫取值（见 `json.ts`）。
 */
export async function getJson(request: HttpRequest, context: CollectorContext): Promise<unknown> {
  const result = await getText(request, context);
  try {
    return JSON.parse(result.body) as unknown;
  } catch (error) {
    // ⚠ 刻意**不**把响应体的内容拼进错误信息。
    //
    // 原先放的是前 120 个字符，理由是「上游维护时返回 HTML 错误页」时
    // 这条信息有用。但响应体是**对端完全可控**的输入：一个恶意/被入侵的
    // 上游可以把我们发过去的凭据回显在错误页里（`token=…`、
    // `access_token=…` 这类不带 `Bearer ` 前缀的形式**不会**被
    // `@signal/logger` 的脱敏器识别），而这条消息会进日志与
    // `Source.last_error_code`。`docs/14`：「禁止记录完整 Authorization header」。
    //
    // 改成只记录**形状**（content-type 与字节数）—— 足够定位
    // 「返回的不是 JSON」，又不携带任何对端内容。
    throw fetchFailed(
      `${request.what}: response is not valid JSON ` +
        `(content-type: ${result.contentType ?? 'unknown'}, ${result.bytes} bytes)`,
      error,
    );
  }
}

/**
 * 状态码判定。
 *
 * 401 / 403 单独拎出来：它对管理员意味着完全不同的事（去换令牌，
 * 而不是「等上游恢复」），而且**不该重试** —— 重试一份坏令牌
 * 只会把上游额度烧光，甚至触发风控。
 */
function assertOkStatus(result: SafeFetchResult, request: HttpRequest): void {
  if (result.status >= 200 && result.status < 300) return;

  if (result.status === 401 || result.status === 403) {
    throw upstreamUnauthorized(
      `${request.what}: upstream rejected our credentials with HTTP ${result.status}`,
    );
  }
  throw fetchFailed(`${request.what}: upstream responded with HTTP ${result.status}`);
}
