/**
 * Collector 的配置视图。
 *
 * 与 `apps/api/src/modules/sources/source.config.ts` 同一套做法：
 * **不直接读 `process.env`**，而是由 `@signal/config` 的 `parseEnv()` 统一校验后传进来。
 * 模块只依赖下面这个窄结构，测试就能 override 一个普通对象，不必构造完整 env。
 *
 * ⚠ **未新增任何 env 变量。** 用到的都是 `docs/20` 已记录的：
 *   - `SOURCE_FETCH_TIMEOUT_MS` / `SOURCE_FETCH_MAX_BYTES` —— 取数上限，
 *     交给 `@signal/source-core` 的 `safeFetchText` 用
 *     （**不要在这里另定一套默认值**，默认值只有 `envSchema` 一处）；
 *   - `X_API_BEARER_TOKEN` / `GITHUB_TOKEN` —— X 与 GitHub 采集用，
 *     未配置时**如实失败**并把原因记到 `Source.lastErrorCode`，绝不静默返回空结果；
 *   - `REDIS_URL` —— 入队与分布式锁。
 */

import { parseEnv, type AppEnv } from '@signal/config';
import type { DnsLookup } from '@signal/source-core';

/** 注入 token。 */
export const COLLECTOR_CONFIG = 'COLLECTOR_CONFIG';

export type CollectorConfig = {
  nodeEnv: AppEnv['NODE_ENV'];
  /** 单次取数的超时预算（毫秒），整条重定向链共享。 */
  fetchTimeoutMs: number;
  /** 单次取数的响应体上限（字节）。 */
  fetchMaxBytes: number;
  /** X API 令牌；未配置为 null → X_USER 采集如实失败（不假装成功）。 */
  xApiBearerToken: string | null;
  /** GitHub 令牌；未配置为 null → 匿名调用 GitHub API（有速率限制但仍可用）。 */
  githubToken: string | null;
  /** BullMQ 与分布式锁的连接串。 */
  redisUrl: string;
  /** 调度轮询间隔（毫秒）。 */
  schedulerIntervalMs: number;
  /**
   * 出网依赖的**测试接缝**（生产恒为 undefined）。
   *
   * ⚠ 这两个字段不是配置项，是让「真适配器 × 真 service」这条路径
   * **可测**的唯一入口。它们曾经只存在于 `CollectorContext` 上，
   * 而 service 构造 context 时不透传 —— 于是那种测试在结构上写不出来
   * （会打真网），而正是在那条路径上藏着「X 适配器的 payload 被守卫拦下」
   * 这个 P0：适配器测试不过 service、service 测试用替身，两条断言
   * 互相矛盾却从未同时执行。
   *
   * 生产代码**不要**设置它们（`buildCollectorConfig` 刻意不读 env）。
   */
  fetchImpl?: typeof fetch;
  lookup?: DnsLookup;
};

/**
 * 调度轮询间隔：1 分钟。
 *
 * `docs/06`：「每分钟查 `enabled && next_fetch_at <= now`」。
 * 这是**规则**而不是可调参数，因此写死在这里；
 * 要改它应当先改 `docs/06`，而不是加一个 env。
 */
export const SCHEDULER_INTERVAL_MS = 60_000;

/** 从已校验的 env 构造 CollectorConfig。 */
export function buildCollectorConfig(env: AppEnv): CollectorConfig {
  return {
    nodeEnv: env.NODE_ENV,
    fetchTimeoutMs: env.SOURCE_FETCH_TIMEOUT_MS,
    fetchMaxBytes: env.SOURCE_FETCH_MAX_BYTES,
    xApiBearerToken: env.X_API_BEARER_TOKEN ?? null,
    githubToken: env.GITHUB_TOKEN ?? null,
    redisUrl: env.REDIS_URL,
    schedulerIntervalMs: SCHEDULER_INTERVAL_MS,
  };
}

/** 默认工厂：校验 env → 构造配置。 */
export function createCollectorConfig(raw: NodeJS.ProcessEnv = process.env): CollectorConfig {
  return buildCollectorConfig(parseEnv(raw));
}
