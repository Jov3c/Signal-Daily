import { describe, expect, it } from 'vitest';
import { CIRCULAR, REDACTED, isSecretKey, redactSecrets, redactString } from '../index';

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

  it('Date 保留实例（pino 会按 JSON 语义把它写成 ISO 字符串）', () => {
    const date = new Date('2026-09-23T00:00:00.000Z');
    const output = redactSecrets({ date });
    expect(output.date).toBe(date);
    // 序列化结果与 pino 实际写出的完全一致
    expect(JSON.parse(JSON.stringify(output))).toEqual({ date: '2026-09-23T00:00:00.000Z' });
  });

  it('带 toJSON 的对象按其 JSON 语义展开，不退化成内部字段', () => {
    class Money {
      constructor(readonly cents: number) {}
      toJSON(): number {
        return this.cents / 100;
      }
    }
    expect(redactSecrets({ price: new Money(8725) })).toEqual({ price: 87.25 });
  });

  it('Error 收敛为 name / message / stack，不丢信息', () => {
    const error = new Error('boom');
    const output = redactSecrets({ failure: error }) as { failure: Record<string, unknown> };
    expect(output.failure.name).toBe('Error');
    expect(output.failure.message).toBe('boom');
    expect(typeof output.failure.stack).toBe('string');
  });

  it('Error 上的自定义 secret 属性被脱敏（回归守卫）', () => {
    const error = Object.assign(new Error('boom'), { password: 'P@ssw0rd123' });
    const output = redactSecrets({ failure: error });
    expect(JSON.stringify(output)).not.toContain('P@ssw0rd123');
    expect((output as { failure: Record<string, unknown> }).failure.password).toBe(REDACTED);
  });
});

/* ------------------------------------------------------------------ */
/* 类实例必须同样被脱敏 —— 这是最容易踩的泄漏路径                        */
/* ------------------------------------------------------------------ */

describe('类实例（回归守卫：曾导致完整 Authorization header 落盘）', () => {
  /** 模拟 Node 的 IncomingMessage：`logger.info({ req })` 必然传进来的是类实例。 */
  class FakeRequest {
    method = 'POST';
    url = '/api/v1/auth/login';
    headers = {
      authorization: 'Bearer SUPER_SECRET_JWT_VALUE',
      cookie: 'sid=SECRET_COOKIE',
    };
  }

  it('类实例的自有属性被递归脱敏', () => {
    const output = redactSecrets({ req: new FakeRequest() });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('SUPER_SECRET_JWT_VALUE');
    expect(serialized).not.toContain('SECRET_COOKIE');
    expect(serialized).toContain('/api/v1/auth/login'); // 非敏感字段保留
  });

  it('嵌套一层同样被脱敏', () => {
    const output = redactSecrets({ http: { req: new FakeRequest() } });
    expect(JSON.stringify(output)).not.toContain('SUPER_SECRET_JWT_VALUE');
  });
});

/* ------------------------------------------------------------------ */
/* 循环引用 vs 共享引用                                                 */
/* ------------------------------------------------------------------ */

describe('循环引用判定（回归守卫：曾把共享引用误判为 [Circular]）', () => {
  it('真循环标记为 [Circular]', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    const output = redactSecrets(node) as Record<string, unknown>;
    expect(output.self).toBe(CIRCULAR);
  });

  it('非循环的共享引用正常展开，不误判', () => {
    const shared = { v: 1 };
    expect(redactSecrets({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it('同一对象在数组里重复出现也正常展开', () => {
    const shared = { v: 1 };
    expect(redactSecrets({ list: [shared, shared, shared] })).toEqual({
      list: [{ v: 1 }, { v: 1 }, { v: 1 }],
    });
  });

  it('同一请求对象被引用两次时，两处都被脱敏', () => {
    const req = { headers: { authorization: 'Bearer SUPER_SECRET_JWT_VALUE' } };
    const output = redactSecrets({ before: req, after: req });
    expect(JSON.stringify(output)).not.toContain('SUPER_SECRET_JWT_VALUE');
  });
});
