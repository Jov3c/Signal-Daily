/**
 * 邮件通道 —— 本地 OTP 登录能不能用、生产会不会把验证码写进日志，都取决于这里。
 *
 * 关键安全点：**生产环境没有 SMTP 时必须失败，而不是降级成打印验证码**。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppError, DomainErrorCode } from '@signal/contracts';
import {
  ConsoleMailSender,
  SmtpMailSender,
  UnavailableMailSender,
  type MailTransportFactory,
  type SmtpConfig,
} from '../src/modules/auth/mail-sender';
import { selectMailSender } from '../src/modules/auth/auth.module';
import { createTestAuthConfig } from './support/fakes';
import { createAuthTestApp, type AuthTestApp } from './support/test-app';

const SMTP: SmtpConfig = {
  host: 'smtp.example.com',
  port: 587,
  user: 'mailer',
  password: 'pw',
  from: 'Signal <no-reply@signal.example.com>',
};

let app: AuthTestApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

describe('selectMailSender（安全决策）', () => {
  const senders = {
    smtp: new SmtpMailSender(createTestAuthConfig(), () => ({}) as never),
    unavailable: new UnavailableMailSender(),
    consoleSender: new ConsoleMailSender(createTestAuthConfig({ nodeEnv: 'development' })),
  };

  it('配了 SMTP → 用 SMTP', () => {
    expect(selectMailSender({ smtp: SMTP, nodeEnv: 'production' }, senders)).toBe(senders.smtp);
  });

  it('生产且未配 SMTP → 用「不可用」实现（503），绝不降级为控制台输出', () => {
    expect(selectMailSender({ smtp: null, nodeEnv: 'production' }, senders)).toBe(
      senders.unavailable,
    );
  });

  it('开发 / 测试且未配 SMTP → 用控制台实现，否则本地无法登录', () => {
    expect(selectMailSender({ smtp: null, nodeEnv: 'development' }, senders)).toBe(
      senders.consoleSender,
    );
    expect(selectMailSender({ smtp: null, nodeEnv: 'test' }, senders)).toBe(senders.consoleSender);
  });
});

describe('SmtpMailSender', () => {
  it('用配置好的 transport 发信，正文含验证码与有效期', async () => {
    const sent: Record<string, unknown>[] = [];
    const factory: MailTransportFactory = (smtp) => {
      expect(smtp).toEqual(SMTP);
      return {
        sendMail: async (options: Record<string, unknown>) => {
          sent.push(options);
          return {};
        },
      } as never;
    };

    const sender = new SmtpMailSender(createTestAuthConfig({ smtp: SMTP }), factory);
    await sender.sendOtpEmail({ to: 'a@b.com', code: '424242', expiresInSeconds: 600 });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.from).toBe(SMTP.from);
    expect(sent[0]?.to).toBe('a@b.com');
    expect(String(sent[0]?.subject)).toContain('424242');
    expect(String(sent[0]?.text)).toContain('424242');
    expect(String(sent[0]?.text)).toContain('10 分钟');
  });

  it('没有 SMTP 配置时不构造 transport，直接 503', async () => {
    const factory = vi.fn();
    const sender = new SmtpMailSender(createTestAuthConfig({ smtp: null }), factory as never);

    await expect(
      sender.sendOtpEmail({ to: 'a@b.com', code: '424242', expiresInSeconds: 600 }),
    ).rejects.toMatchObject({ code: DomainErrorCode.AUTH_MAIL_NOT_CONFIGURED, httpStatus: 503 });
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('ConsoleMailSender（开发专用）', () => {
  it('把验证码写到 stderr，且不经过结构化日志', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    const sender = new ConsoleMailSender(createTestAuthConfig({ nodeEnv: 'development' }));
    await sender.sendOtpEmail({ to: 'a@b.com', code: '424242', expiresInSeconds: 600 });

    const output = writes.join('');
    expect(output).toContain('424242');
    expect(output).toContain('a@b.com');
    expect(output).toContain('dev-mail');
  });

  it('★ 双保险：即使装配错了，生产环境也必须抛 503 而不是打印验证码', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    const sender = new ConsoleMailSender(createTestAuthConfig({ nodeEnv: 'production' }));

    await expect(
      sender.sendOtpEmail({ to: 'a@b.com', code: '424242', expiresInSeconds: 600 }),
    ).rejects.toMatchObject({ code: DomainErrorCode.AUTH_MAIL_NOT_CONFIGURED });
    expect(writes.join('')).not.toContain('424242');
  });
});

describe('UnavailableMailSender', () => {
  it('永远是 503，不带任何信息', async () => {
    const sender = new UnavailableMailSender();
    try {
      await sender.sendOtpEmail({ to: 'a@b.com', code: '1', expiresInSeconds: 60 });
      expect.unreachable('应当抛错');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe(DomainErrorCode.AUTH_MAIL_NOT_CONFIGURED);
      expect(appError.httpStatus).toBe(503);
      expect(appError.details).toBeNull();
    }
  });
});

describe('模块装配（真实 HTTP）', () => {
  it('生产 + 无 SMTP → 请求验证码返回 503 AUTH_MAIL_NOT_CONFIGURED', async () => {
    app = await createAuthTestApp({
      config: { nodeEnv: 'production', smtp: null, secureCookies: true },
      realMailSender: true,
    });

    const response = await app.request('/api/v1/auth/email/request-code', {
      method: 'POST',
      body: JSON.stringify({ email: 'reader@example.com' }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe(DomainErrorCode.AUTH_MAIL_NOT_CONFIGURED);
  });

  it('开发 + 无 SMTP → 请求成功（走控制台投递）', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    app = await createAuthTestApp({
      config: { nodeEnv: 'development', smtp: null },
      realMailSender: true,
    });

    const response = await app.request('/api/v1/auth/email/request-code', {
      method: 'POST',
      body: JSON.stringify({ email: 'reader@example.com' }),
    });

    expect(response.status).toBe(200);
  });
});
