/**
 * Source 模块的配置视图。
 *
 * 与 `auth.config.ts` 同一套做法：**不直接读 `process.env`**，
 * 而是由 `@signal/config` 的 `parseEnv()` 统一校验后传进来。
 * 模块只依赖下面这个窄结构，测试就能 override 一个普通对象，
 * 不必构造完整 env。
 *
 * ⚠ **未新增任何 env 变量。** 用到的都是 `docs/20` 已记录的：
 *   - `SOURCE_FETCH_TIMEOUT_MS` / `SOURCE_FETCH_MAX_BYTES` —— 取数上限，
 *     交给 `url-safety` 用（**不要在这里另定一套默认值**，
 *     默认值只有 `envSchema` 一处，见 `packages/config/src/env.ts`）；
 *   - `X_API_BEARER_TOKEN` / `GITHUB_TOKEN` —— `test` 端点探测外部服务用，
 *     未配置时该端点如实报告「未配置」，而不是假装成功；
 *   - `REDIS_URL` —— BullMQ 入队。
 */

import { parseEnv, type AppEnv } from '@signal/config';

/** 注入 token。 */
export const SOURCE_CONFIG = 'SOURCE_CONFIG';

export type SourceConfig = {
  nodeEnv: AppEnv['NODE_ENV'];
  /** 站点地址（`APP_BASE_URL`）。Admin Origin 校验用。 */
  appBaseUrl: string;
  /** API 地址（`API_BASE_URL`）。Admin Origin 校验用。 */
  apiBaseUrl: string;
  /** 单次取数的超时预算（毫秒），整条重定向链共享。 */
  fetchTimeoutMs: number;
  /** 单次取数的响应体上限（字节）。 */
  fetchMaxBytes: number;
  /** X API 令牌；未配置为 null → `test` 对 X_USER 如实报告未配置。 */
  xApiBearerToken: string | null;
  /** GitHub 令牌；未配置为 null → 匿名调用 GitHub API（有速率限制但仍可用）。 */
  githubToken: string | null;
  /** BullMQ 连接串。 */
  redisUrl: string;
};

/** 从已校验的 env 构造 SourceConfig。 */
export function buildSourceConfig(env: AppEnv): SourceConfig {
  return {
    nodeEnv: env.NODE_ENV,
    appBaseUrl: env.APP_BASE_URL,
    apiBaseUrl: env.API_BASE_URL,
    fetchTimeoutMs: env.SOURCE_FETCH_TIMEOUT_MS,
    fetchMaxBytes: env.SOURCE_FETCH_MAX_BYTES,
    xApiBearerToken: env.X_API_BEARER_TOKEN ?? null,
    githubToken: env.GITHUB_TOKEN ?? null,
    redisUrl: env.REDIS_URL,
  };
}

/** 默认工厂：校验 env → 构造配置。 */
export function createSourceConfig(raw: NodeJS.ProcessEnv = process.env): SourceConfig {
  return buildSourceConfig(parseEnv(raw));
}
