/**
 * Signal 环境变量契约 — 校验与类型化。
 *
 * 权威清单：`docs/20-environment-variables.md`。
 * 规则：任何 Agent 不得新增未记录 env。此 schema 与文档一一对应，不多不少。
 *
 * 安全（`docs/14`）：校验失败时绝不回显 secret 原文。
 */

import { z } from 'zod';
import { BUSINESS_TIMEZONE } from '@signal/contracts';

/** `FOO=` 视为未设置，而不是空字符串。 */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** 可选字符串：空串 → undefined。 */
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

/** 可选 URL：空串 → undefined。 */
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

/** 必填 secret：不允许为空，也不允许沿用示例占位值。 */
const requiredSecret = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .min(1)
    .refine((v) => v !== 'change-me', {
      message: 'must not be the .env.example placeholder value',
    }),
);

/** 形如 `mysql://` / `redis://` 的连接串。 */
const mysqlUrl = z.string().refine((v) => v.startsWith('mysql://'), {
  message: 'must be a mysql:// connection string',
});
const redisUrl = z.string().refine((v) => v.startsWith('redis://') || v.startsWith('rediss://'), {
  message: 'must be a redis:// or rediss:// connection string',
});

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** 全系统业务时区。冻结为 Asia/Shanghai（docs/00 / docs/01）。 */
  APP_TIMEZONE: z.literal(BUSINESS_TIMEZONE).default(BUSINESS_TIMEZONE),
  APP_BASE_URL: z.string().url(),
  API_BASE_URL: z.string().url(),

  DATABASE_URL: mysqlUrl,
  REDIS_URL: redisUrl,

  AUTH_ACCESS_TOKEN_SECRET: requiredSecret,
  AUTH_REFRESH_TOKEN_PEPPER: requiredSecret,
  EMAIL_OTP_PEPPER: requiredSecret,

  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  GITHUB_CALLBACK_URL: optionalUrl,

  MAIL_PROVIDER: z.enum(['smtp']).default('smtp'),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: optionalString,
  ADMIN_NOTIFICATION_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),

  S3_ENDPOINT: optionalUrl,
  S3_REGION: z.string().min(1).default('auto'),
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_PUBLIC_BASE_URL: optionalUrl,

  AI_DEFAULT_PROVIDER: z.string().min(1).default('openai-compatible'),
  AI_DEFAULT_BASE_URL: optionalUrl,
  AI_DEFAULT_API_KEY: optionalString,
  AI_MODEL_CHEAP: optionalString,
  AI_MODEL_MEDIUM: optionalString,
  AI_MODEL_STRONG: optionalString,
  AI_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(5),

  X_API_BEARER_TOKEN: optionalString,
  GITHUB_TOKEN: optionalString,

  SOURCE_FETCH_MAX_BYTES: z.coerce.number().int().positive().default(2_097_152),
  SOURCE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SENTRY_DSN: optionalUrl,
});

export type AppEnv = z.infer<typeof envSchema>;

/** 环境中出现但不在 docs/20 清单内的变量名（用于告警，不阻断启动）。 */
export function findUnknownEnvKeys(raw: NodeJS.ProcessEnv | Record<string, unknown>): string[] {
  const known = new Set(Object.keys(envSchema.shape));
  return Object.keys(raw).filter((key) => !known.has(key));
}

/** 校验失败时抛出的错误。只包含字段名与原因，不包含字段值。 */
export class EnvValidationError extends Error {
  readonly issues: { path: string; message: string }[];

  constructor(issues: { path: string; message: string }[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((i) => `  - ${i.path || '(root)'}: ${i.message}`)
        .join('\n')}`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * 校验并返回类型化 env。
 *
 * @param raw 默认 `process.env`。测试可传入自定义对象。
 * @throws EnvValidationError 当必填项缺失或格式非法。
 */
export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, unknown> = process.env): AppEnv {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * 从 API_BASE_URL 推导 API 监听端口。
 *
 * 说明：docs/20 的 env 清单里没有 `API_PORT`，因此不新增变量，
 * 而是从已记录变量推导。Agent 11 若需要显式端口，应提交 Contract Change Request。
 */
export const DEFAULT_API_PORT = 3001;

export function resolveApiPort(env: Pick<AppEnv, 'API_BASE_URL'>): number {
  try {
    const parsed = new URL(env.API_BASE_URL);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return DEFAULT_API_PORT;
  }
}

export function isProduction(env: Pick<AppEnv, 'NODE_ENV'>): boolean {
  return env.NODE_ENV === 'production';
}

export function isTest(env: Pick<AppEnv, 'NODE_ENV'>): boolean {
  return env.NODE_ENV === 'test';
}

export function isDevelopment(env: Pick<AppEnv, 'NODE_ENV'>): boolean {
  return env.NODE_ENV === 'development';
}
