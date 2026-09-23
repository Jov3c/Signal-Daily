/**
 * 邮件投递端口。
 *
 * 三种绑定，由 `AuthModule` 按配置与 `NODE_ENV` 选择：
 *   - `SmtpMailSender`          —— 生产：`SMTP_*` 配置齐全时。
 *   - `ConsoleMailSender`       —— 开发/测试：把验证码写到 **stderr**，便于本地登录。
 *   - `UnavailableMailSender`   —— 生产但没配 SMTP：直接 503，**绝不降级成写日志**。
 *
 * 设计取舍（已记入 HANDOFF）：
 *   `docs/14` 禁止把 OTP 明文写进日志。开发环境又必须能拿到验证码，否则本地
 *   完全无法登录。折中方案是把「开发专用投递」限制在
 *     (1) `NODE_ENV !== 'production'`，(2) 走 `process.stderr.write` 而不经 pino，
 *   这样验证码不会进入结构化日志流（也就不会被采集/落盘）。
 *   生产环境若缺 SMTP，宁可登录不可用 —— 见 `AUTH_MAIL_NOT_CONFIGURED`。
 */

import { Inject, Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppError, DomainErrorCode } from '@signal/contracts';
import { AUTH_CONFIG, type AuthConfig, type SmtpConfig } from './auth.config';

/** 注入 token。 */
export const MAIL_SENDER = 'MAIL_SENDER';

/** 注入 token：便于用假 transport 测 SMTP 分支，无需真 SMTP 服务器。 */
export const MAIL_TRANSPORT_FACTORY = 'MAIL_TRANSPORT_FACTORY';

export type SendOtpEmailParams = {
  to: string;
  code: string;
  expiresInSeconds: number;
};

export interface MailSender {
  sendOtpEmail(params: SendOtpEmailParams): Promise<void>;
}

/** 由 SMTP 配置创建 transport。 */
export type MailTransportFactory = (smtp: SmtpConfig) => Transporter;

export const defaultMailTransportFactory: MailTransportFactory = (smtp) =>
  nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user === undefined ? undefined : { user: smtp.user, pass: smtp.password },
  });

@Injectable()
export class SmtpMailSender implements MailSender {
  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(MAIL_TRANSPORT_FACTORY) private readonly createTransport: MailTransportFactory,
  ) {}

  async sendOtpEmail(params: SendOtpEmailParams): Promise<void> {
    const smtp = this.config.smtp;
    if (smtp === null) throw mailNotConfigured();

    const minutes = Math.round(params.expiresInSeconds / 60);
    const transport = this.createTransport(smtp);

    await transport.sendMail({
      from: smtp.from,
      to: params.to,
      subject: `Signal 登录验证码：${params.code}`,
      text: [
        `你的 Signal 登录验证码是 ${params.code}。`,
        `验证码 ${minutes} 分钟内有效，请勿转发给任何人。`,
        '如果不是你本人操作，忽略本邮件即可。',
      ].join('\n'),
    });
  }
}

@Injectable()
export class ConsoleMailSender implements MailSender {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  async sendOtpEmail(params: SendOtpEmailParams): Promise<void> {
    // 双保险：即使装配错，生产也不允许把验证码写到控制台。
    if (this.config.nodeEnv === 'production') throw mailNotConfigured();

    process.stderr.write(
      `\n[signal dev-mail] 开发环境专用：未配置 SMTP，验证码直接打印在这里。\n` +
        `[signal dev-mail] to=${params.to} code=${params.code} ` +
        `expires_in=${params.expiresInSeconds}s\n\n`,
    );
  }
}

@Injectable()
export class UnavailableMailSender implements MailSender {
  async sendOtpEmail(): Promise<void> {
    throw mailNotConfigured();
  }
}

function mailNotConfigured(): AppError {
  return new AppError({
    code: DomainErrorCode.AUTH_MAIL_NOT_CONFIGURED,
    httpStatus: 503,
    safeMessage: 'Email delivery is not configured',
  });
}
