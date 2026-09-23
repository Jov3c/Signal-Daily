import { describe, expect, it } from 'vitest';
import { createMemoryStream } from '@signal/test-utils';
import { REDACTED } from '../redact';
import { childLogger, createLogger, isLogLevel, serializeError, silentLogger } from '../logger';

function readSingle(stream: ReturnType<typeof createMemoryStream>): Record<string, unknown> {
  const records = stream.records();
  expect(records).toHaveLength(1);
  return records[0] as Record<string, unknown>;
}

describe('createLogger — 契约字段（docs/15）', () => {
  it('输出 JSON，且包含 timestamp / level / service / msg', () => {
    const stream = createMemoryStream();
    const logger = createLogger({ service: 'api', destination: stream });

    logger.info('signal api started');

    const record = readSingle(stream);
    expect(typeof record.timestamp).toBe('string');
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.level).toBe('info');
    expect(record.service).toBe('api');
    expect(record.msg).toBe('signal api started');
  });

  it('时间戳字段名为 timestamp，而不是 pino 默认的 time', () => {
    const stream = createMemoryStream();
    createLogger({ service: 'api', destination: stream }).info('x');
    const record = readSingle(stream);
    expect(record).toHaveProperty('timestamp');
    expect(record).not.toHaveProperty('time');
  });

  it('level 输出为可读字符串', () => {
    const stream = createMemoryStream();
    const logger = createLogger({ service: 'worker', destination: stream });
    logger.warn('careful');
    expect(readSingle(stream).level).toBe('warn');
  });

  it('关联字段可以直接写入', () => {
    const stream = createMemoryStream();
    createLogger({ service: 'worker', destination: stream }).info(
      {
        requestId: 'req_1',
        userId: '42',
        sourceId: '7',
        contentId: '9',
        jobId: 'normalize:9',
        errorCode: 'SOURCE_NOT_FOUND',
        durationMs: 12,
      },
      'job done',
    );
    const record = readSingle(stream);
    expect(record.requestId).toBe('req_1');
    expect(record.userId).toBe('42');
    expect(record.sourceId).toBe('7');
    expect(record.contentId).toBe('9');
    expect(record.jobId).toBe('normalize:9');
    expect(record.errorCode).toBe('SOURCE_NOT_FOUND');
    expect(record.durationMs).toBe(12);
  });
});

describe('createLogger — secret 脱敏（docs/14 / docs/15）', () => {
  it('不记录密码与 token 明文', () => {
    const stream = createMemoryStream();
    createLogger({ service: 'api', destination: stream }).info({
      username: 'jov',
      password: 'hunter2',
      accessToken: 'tok_live_abcdef',
    });

    const raw = stream.lines.join('');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('tok_live_abcdef');

    const record = readSingle(stream);
    expect(record.password).toBe(REDACTED);
    expect(record.accessToken).toBe(REDACTED);
    expect(record.username).toBe('jov');
  });

  it('不记录完整 Authorization header', () => {
    const stream = createMemoryStream();
    createLogger({ service: 'api', destination: stream }).info({
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' },
    });

    const raw = stream.lines.join('');
    expect(raw).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect((readSingle(stream).headers as Record<string, unknown>).authorization).toBe(REDACTED);
  });

  it('不记录 OTP 明文', () => {
    const stream = createMemoryStream();
    createLogger({ service: 'api', destination: stream }).info({
      email: 'a@b.com',
      otpCode: '483920',
    });
    expect(stream.lines.join('')).not.toContain('483920');
  });

  it('不记录连接串中的密码', () => {
    const stream = createMemoryStream();
    createLogger({ service: 'api', destination: stream }).info({
      note: 'connected to mysql://signal:sup3rsecret@db:3306/signal',
    });
    expect(stream.lines.join('')).not.toContain('sup3rsecret');
  });

  it('脱敏后仍是合法 JSON，且业务字段完好', () => {
    const stream = createMemoryStream();
    createLogger({ service: 'api', destination: stream }).info({
      errorCode: 'SOURCE_NOT_FOUND',
      statusCode: 404,
      password: 'x',
    });
    const record = readSingle(stream);
    expect(record.errorCode).toBe('SOURCE_NOT_FOUND');
    expect(record.statusCode).toBe(404);
  });
});

describe('原生 .child() 也必须脱敏（回归守卫）', () => {
  it('pino 原生 child() 的 bindings 里的 secret 不落盘', () => {
    // 实测：formatters.log 看不到 child bindings，formatters.bindings 也只在
    // 创建时对 base 生效一次 —— 所以必须包装 .child() 本身，否则这里会明文泄漏。
    const stream = createMemoryStream();
    const logger = createLogger({ service: 'api', destination: stream });

    logger.child({ password: 'P@ssw0rd123', authorization: 'Bearer SUPER_SECRET_JWT' }).info('x');

    const raw = stream.lines.join('');
    expect(raw).not.toContain('P@ssw0rd123');
    expect(raw).not.toContain('SUPER_SECRET_JWT');
    expect(raw).toContain(REDACTED);
  });

  it('多层 child() 依然脱敏', () => {
    const stream = createMemoryStream();
    const logger = createLogger({ service: 'api', destination: stream });

    logger.child({ token: 'tok_live_abcdef' }).child({ password: 'hunter2' }).info('deep');

    const raw = stream.lines.join('');
    expect(raw).not.toContain('tok_live_abcdef');
    expect(raw).not.toContain('hunter2');
  });

  it('child() 保留 requestId 等合法关联字段', () => {
    const stream = createMemoryStream();
    const logger = createLogger({ service: 'api', destination: stream });

    logger.child({ requestId: 'req_1', userId: '42' }).info('ok');

    const record = readSingle(stream);
    expect(record.requestId).toBe('req_1');
    expect(record.userId).toBe('42');
  });
});

describe('childLogger', () => {
  it('绑定关联字段并继承脱敏', () => {
    const stream = createMemoryStream();
    const logger = createLogger({ service: 'api', destination: stream });
    const scoped = childLogger(logger, { requestId: 'req_1', userId: '42' });

    scoped.info({ password: 'hunter2' }, 'scoped');

    const record = readSingle(stream);
    expect(record.requestId).toBe('req_1');
    expect(record.userId).toBe('42');
    expect(record.password).toBe(REDACTED);
    expect(stream.lines.join('')).not.toContain('hunter2');
  });
});

describe('serializeError', () => {
  it('只保留 name / message / stack / code', () => {
    const error = Object.assign(new Error('boom'), { code: 'SOURCE_NOT_FOUND' });
    const serialized = serializeError(error);
    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('boom');
    expect(serialized.code).toBe('SOURCE_NOT_FOUND');
  });

  it('处理非 Error 输入', () => {
    expect(serializeError('plain string')).toEqual({ message: 'plain string' });
  });
});

describe('辅助函数', () => {
  it('isLogLevel 校验取值', () => {
    expect(isLogLevel('info')).toBe(true);
    expect(isLogLevel('silent')).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
  });

  it('level=silent 时不产生输出', () => {
    const stream = createMemoryStream();
    createLogger({ service: 'test', level: 'silent', destination: stream }).info(
      'should not appear',
    );
    expect(stream.lines).toHaveLength(0);
  });

  it('silentLogger 可构造且不抛错', () => {
    expect(() => silentLogger('test').info('quiet')).not.toThrow();
  });
});
