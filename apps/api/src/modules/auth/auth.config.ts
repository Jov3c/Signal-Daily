/**
 * Auth 模块的配置视图。
 *
 * 刻意不直接读 `process.env`：所有 env 都经 `@signal/config` 的 `parseEnv()` 校验
 * （schema 与 `docs/20` 一一对应）。模块只依赖这里的窄结构，
 * 测试就可以 override 一个普通对象，而不需要构造完整 env。
 *
 * **未新增任何 env 变量**，只使用 `docs/20` 已记录的那些。
 */

import { parseEnv, type AppEnv } from '@signal/config';

/** 注入 token。 */
export const AUTH_CONFIG = 'AUTH_CONFIG';

export type GithubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
};

export type SmtpConfig = {
  host: string;
  port: number;
  user: string | undefined;
  password: string | undefined;
  from: string;
};

export type AuthConfig = {
  nodeEnv: AppEnv['NODE_ENV'];
  /** 生产环境才给 Cookie 加 `Secure`（本地是 http）。 */
  secureCookies: boolean;
  accessTokenSecret: string;
  refreshTokenPepper: string;
  emailOtpPepper: string;
  /** GitHub OAuth 未配置时为 null → 端点返回 503，而不是崩。 */
  github: GithubOAuthConfig | null;
  /** SMTP 未配置时为 null。 */
  smtp: SmtpConfig | null;
  /** 登录成功后 302 回落的站点地址。 */
  appBaseUrl: string;
  /** Redis 连接串，限流用（`docs/01`：Redis 只做 Queue / Cache / Rate Limit）。 */
  redisUrl: string;
};

/** 从已校验的 env 构造 AuthConfig。 */
export function buildAuthConfig(env: AppEnv): AuthConfig {
  const github =
    env.GITHUB_CLIENT_ID !== undefined &&
    env.GITHUB_CLIENT_SECRET !== undefined &&
    env.GITHUB_CALLBACK_URL !== undefined
      ? {
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
          callbackUrl: env.GITHUB_CALLBACK_URL,
        }
      : null;

  const smtp =
    env.SMTP_HOST !== undefined && env.SMTP_FROM !== undefined
      ? {
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          user: env.SMTP_USER,
          password: env.SMTP_PASSWORD,
          from: env.SMTP_FROM,
        }
      : null;

  return {
    nodeEnv: env.NODE_ENV,
    secureCookies: env.NODE_ENV === 'production',
    accessTokenSecret: env.AUTH_ACCESS_TOKEN_SECRET,
    refreshTokenPepper: env.AUTH_REFRESH_TOKEN_PEPPER,
    emailOtpPepper: env.EMAIL_OTP_PEPPER,
    github,
    smtp,
    appBaseUrl: env.APP_BASE_URL,
    redisUrl: env.REDIS_URL,
  };
}

/** 默认工厂：校验 env → 构造配置。 */
export function createAuthConfig(raw: NodeJS.ProcessEnv = process.env): AuthConfig {
  return buildAuthConfig(parseEnv(raw));
}
