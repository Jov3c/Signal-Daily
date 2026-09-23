import { describe, expect, it } from 'vitest';
import { createTestEnv } from '@signal/test-utils';
import {
  DEFAULT_API_PORT,
  EnvValidationError,
  envSchema,
  findUnknownEnvKeys,
  isDevelopment,
  isProduction,
  isTest,
  parseEnv,
} from '../index';

describe('env 校验（docs/20）', () => {
  it('合法 env 可以通过校验并补齐默认值', () => {
    const env = parseEnv(createTestEnv());
    expect(env.NODE_ENV).toBe('test');
    expect(env.APP_TIMEZONE).toBe('Asia/Shanghai');
    expect(env.SMTP_PORT).toBe(587);
    expect(env.AI_DAILY_BUDGET_USD).toBe(5);
    expect(env.SOURCE_FETCH_MAX_BYTES).toBe(2_097_152);
    expect(env.SOURCE_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.S3_REGION).toBe('auto');
    expect(env.MAIL_PROVIDER).toBe('smtp');
  });

  it('数字型 env 会从字符串转换', () => {
    const env = parseEnv(createTestEnv({ SMTP_PORT: '2525', AI_DAILY_BUDGET_USD: '12.5' }));
    expect(env.SMTP_PORT).toBe(2525);
    expect(env.AI_DAILY_BUDGET_USD).toBe(12.5);
  });

  it('选填项留空视为未设置', () => {
    const env = parseEnv(createTestEnv({ GITHUB_CLIENT_ID: '', S3_ENDPOINT: '' }));
    expect(env.GITHUB_CLIENT_ID).toBeUndefined();
    expect(env.S3_ENDPOINT).toBeUndefined();
  });

  it('缺少 DATABASE_URL 时报错，并指明字段名', () => {
    const raw = createTestEnv();
    delete raw.DATABASE_URL;
    expect(() => parseEnv(raw)).toThrow(EnvValidationError);
    try {
      parseEnv(raw);
    } catch (error) {
      expect((error as EnvValidationError).issues.map((i) => i.path)).toContain('DATABASE_URL');
    }
  });

  it('DATABASE_URL 必须是 mysql:// 连接串', () => {
    expect(() => parseEnv(createTestEnv({ DATABASE_URL: 'postgres://a:b@h:5432/d' }))).toThrow(
      EnvValidationError,
    );
  });

  it('REDIS_URL 必须是 redis:// 连接串', () => {
    expect(() => parseEnv(createTestEnv({ REDIS_URL: 'http://localhost:6379' }))).toThrow(
      EnvValidationError,
    );
  });

  it('APP_TIMEZONE 冻结为 Asia/Shanghai', () => {
    expect(() => parseEnv(createTestEnv({ APP_TIMEZONE: 'UTC' }))).toThrow(EnvValidationError);
  });

  it('secret 不得沿用 .env.example 的占位值', () => {
    expect(() => parseEnv(createTestEnv({ AUTH_ACCESS_TOKEN_SECRET: 'change-me' }))).toThrow(
      EnvValidationError,
    );
    expect(() => parseEnv(createTestEnv({ EMAIL_OTP_PEPPER: 'change-me' }))).toThrow(
      EnvValidationError,
    );
  });

  it('非法数字与非法 LOG_LEVEL 被拒绝', () => {
    expect(() => parseEnv(createTestEnv({ SOURCE_FETCH_MAX_BYTES: 'abc' }))).toThrow(
      EnvValidationError,
    );
    expect(() => parseEnv(createTestEnv({ SOURCE_FETCH_TIMEOUT_MS: '-1' }))).toThrow(
      EnvValidationError,
    );
    expect(() => parseEnv(createTestEnv({ LOG_LEVEL: 'verbose' }))).toThrow(EnvValidationError);
  });

  it('校验失败信息不得回显 secret 原文（docs/14）', () => {
    const secret = 'super-secret-value-123';
    try {
      parseEnv(createTestEnv({ DATABASE_URL: `postgres://u:${secret}@h:5432/d` }));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('logLevel 为 silent 时仍可通过校验', () => {
    expect(parseEnv(createTestEnv({ LOG_LEVEL: 'silent' })).LOG_LEVEL).toBe('silent');
  });
});

describe('env 清单与 docs/20 保持一致', () => {
  const DOCUMENTED_KEYS = [
    'NODE_ENV',
    'APP_TIMEZONE',
    'APP_BASE_URL',
    'API_BASE_URL',
    'DATABASE_URL',
    'REDIS_URL',
    'AUTH_ACCESS_TOKEN_SECRET',
    'AUTH_REFRESH_TOKEN_PEPPER',
    'EMAIL_OTP_PEPPER',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_CALLBACK_URL',
    'MAIL_PROVIDER',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_FROM',
    'ADMIN_NOTIFICATION_EMAIL',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_PUBLIC_BASE_URL',
    'AI_DEFAULT_PROVIDER',
    'AI_DEFAULT_BASE_URL',
    'AI_DEFAULT_API_KEY',
    'AI_MODEL_CHEAP',
    'AI_MODEL_MEDIUM',
    'AI_MODEL_STRONG',
    'AI_DAILY_BUDGET_USD',
    'X_API_BEARER_TOKEN',
    'GITHUB_TOKEN',
    'SOURCE_FETCH_MAX_BYTES',
    'SOURCE_FETCH_TIMEOUT_MS',
    'LOG_LEVEL',
    'SENTRY_DSN',
  ];

  it('schema 恰好覆盖文档记录的变量，不多不少', () => {
    expect(Object.keys(envSchema.shape).sort()).toEqual([...DOCUMENTED_KEYS].sort());
  });

  it('findUnknownEnvKeys 能识别未记录的变量', () => {
    expect(findUnknownEnvKeys({ DATABASE_URL: 'x', TOTALLY_NEW_VAR: 'y' })).toEqual([
      'TOTALLY_NEW_VAR',
    ]);
  });
});

describe('运行环境判断与端口推导', () => {
  it('NODE_ENV 判断', () => {
    expect(isProduction(parseEnv(createTestEnv({ NODE_ENV: 'production' })))).toBe(true);
    expect(isTest(parseEnv(createTestEnv({ NODE_ENV: 'test' })))).toBe(true);
    expect(isDevelopment(parseEnv(createTestEnv({ NODE_ENV: 'development' })))).toBe(true);
  });

  it('API 监听端口是固定默认值，不从 API_BASE_URL 推导', () => {
    // 回归守卫：早期版本从 API_BASE_URL 推导监听端口，导致生产推出 443、
    // 开发推出 3000（与 Next.js 抢端口）。这里锁死为固定默认值。
    expect(DEFAULT_API_PORT).toBe(3001);
    expect(DEFAULT_API_PORT).not.toBe(3000); // 不与 web 冲突
    expect(DEFAULT_API_PORT).toBeGreaterThan(1023); // 非特权端口，非 root 也能监听
  });
});
