import { describe, expect, it } from 'vitest';
import { REDACTED, isSecretKey, redactSecrets, redactString } from '../index';

describe('isSecretKey', () => {
  it('识别 secret 字段名', () => {
    for (const key of [
      'password',
      'passwordHash',
      'passwd',
      'token',
      'accessToken',
      'refresh_token',
      'secret',
      'clientSecret',
      'otp',
      'otpCode',
      'pepper',
      'apiKey',
      'api_key',
      'accessKeyId',
      'privateKey',
      'authorization',
      'Authorization',
      'cookie',
      'set-cookie',
      'credential',
      'sentryDsn',
      'sessionId',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('不误伤合法业务字段', () => {
    for (const key of ['code', 'errorCode', 'statusCode', 'sourceId', 'contentId', 'jobId']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe('redactString', () => {
  it('脱敏连接串密码', () => {
    expect(redactString('mysql://signal:sup3rsecret@db:3306/signal')).toBe(
      `mysql://signal:${REDACTED}@db:3306/signal`,
    );
    expect(redactString('redis://default:hunter2@localhost:6379')).toBe(
      `redis://default:${REDACTED}@localhost:6379`,
    );
  });

  it('脱敏内联凭据', () => {
    expect(redactString('Authorization: Bearer abcdef1234567890')).toContain(REDACTED);
    expect(redactString('Authorization: Bearer abcdef1234567890')).not.toContain(
      'abcdef1234567890',
    );
  });

  it('普通字符串不受影响', () => {
    expect(redactString('https://example.com/blog/post-1')).toBe('https://example.com/blog/post-1');
  });
});

describe('redactSecrets', () => {
  it('脱敏顶层 secret 字段', () => {
    const output = redactSecrets({ username: 'jov', password: 'hunter2' });
    expect(output).toEqual({ username: 'jov', password: REDACTED });
  });

  it('脱敏任意深度的嵌套 secret', () => {
    const output = redactSecrets({
      level: 'info',
      data: { auth: { accessToken: 'tok_live_123', refreshToken: 'rfr_456' } },
    });
    expect(JSON.stringify(output)).not.toContain('tok_live_123');
    expect(JSON.stringify(output)).not.toContain('rfr_456');
  });

  it('脱敏数组元素里的 secret', () => {
    const output = redactSecrets({ accounts: [{ name: 'a', secret: 's3cr3t' }] });
    expect(output).toEqual({ accounts: [{ name: 'a', secret: REDACTED }] });
  });

  it('对字符串值做模式脱敏', () => {
    const output = redactSecrets({ dsnInfo: 'mysql://signal:sup3rsecret@db:3306/signal' });
    expect(JSON.stringify(output)).not.toContain('sup3rsecret');
  });

  it('保留 errorCode 等业务字段', () => {
    const output = redactSecrets({ errorCode: 'SOURCE_NOT_FOUND', statusCode: 404 });
    expect(output).toEqual({ errorCode: 'SOURCE_NOT_FOUND', statusCode: 404 });
  });

  it('处理循环引用而不死循环', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    const output = redactSecrets(node) as Record<string, unknown>;
    expect(output.name).toBe('root');
    expect(output.self).toBe('[Circular]');
  });

  it('保留 Date / Error / 类实例的原型', () => {
    class Custom {
      constructor(readonly value = 1) {}
    }
    const date = new Date('2026-09-23T00:00:00.000Z');
    const error = new Error('boom');
    const custom = new Custom();
    const output = redactSecrets({ date, error, custom });
    expect(output.date).toBe(date);
    expect(output.error).toBe(error);
    expect(output.custom).toBe(custom);
  });
});
