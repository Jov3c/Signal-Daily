import { describe, expect, it } from 'vitest';
import {
  ADMIN_API_PREFIX,
  API_PREFIX,
  DEFAULT_CURSOR_LIMIT,
  REQUEST_ID_HEADER,
  cursorEnvelope,
  envelope,
} from '../index';

describe('API 契约常量与封套（docs/02 / docs/04）', () => {
  it('API 前缀固定为 /api/v1', () => {
    expect(API_PREFIX).toBe('/api/v1');
    expect(ADMIN_API_PREFIX).toBe('/api/v1/admin');
  });

  it('请求追踪头为 X-Request-Id', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });

  it('成功单对象封套为 { data }', () => {
    expect(envelope({ id: '1' })).toEqual({ data: { id: '1' } });
  });

  it('列表封套为 { data, meta: { nextCursor } }', () => {
    expect(cursorEnvelope([1, 2], 'cursor-2')).toEqual({
      data: [1, 2],
      meta: { nextCursor: 'cursor-2' },
    });
    expect(cursorEnvelope([], null)).toEqual({ data: [], meta: { nextCursor: null } });
  });

  it('默认分页大小为 20', () => {
    expect(DEFAULT_CURSOR_LIMIT).toBe(20);
  });
});
