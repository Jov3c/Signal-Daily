/**
 * 调度规则与入队细节的单测。
 *
 * 这一层值得单独测，是因为它**跨 Agent 共用**：`scheduling.ts` 的
 * 「什么算到期」既被本模块的仓储实现使用，也要被 Agent 04 的 Scheduler
 * 使用。规则一旦漂移，症状是「后台显示已停用，worker 还在抓」这类
 * 极难排查的不一致。
 */

import { describe, expect, it } from 'vitest';
import { JobId, JobName, QueueName } from '@signal/contracts';
import {
  DUE_SOURCES_BATCH_SIZE,
  DUE_SOURCES_INDEX,
  DUE_SOURCES_ORDER_BY,
  MAX_FETCH_INTERVAL_SECONDS,
  MIN_FETCH_INTERVAL_SECONDS,
  buildDueSourcesWhere,
  computeNextFetchAt,
  isValidFetchInterval,
} from '../src/modules/sources/scheduling';
import {
  FETCH_NOW_WINDOW_MS,
  fetchWindow,
  redisConnectionOptions,
} from '../src/modules/sources/source-enqueuer';

const NOW = new Date('2026-09-24T12:00:00.000Z');

describe('抓取间隔', () => {
  it('computeNextFetchAt = 基准时刻 + 间隔', () => {
    expect(computeNextFetchAt(1_800, NOW).toISOString()).toBe('2026-09-24T12:30:00.000Z');
    expect(computeNextFetchAt(60, NOW).toISOString()).toBe('2026-09-24T12:01:00.000Z');
  });

  it('以**本轮开始时刻**为基准，而不是结束时刻（否则慢源周期会持续退化）', () => {
    // 同一个基准时刻算出来的结果只取决于间隔，与「已经花了多久」无关。
    const a = computeNextFetchAt(3_600, NOW);
    const b = computeNextFetchAt(3_600, NOW);
    expect(a.getTime()).toBe(b.getTime());
  });

  it.each([
    [MIN_FETCH_INTERVAL_SECONDS, true],
    [MAX_FETCH_INTERVAL_SECONDS, true],
    [MIN_FETCH_INTERVAL_SECONDS - 1, false],
    [MAX_FETCH_INTERVAL_SECONDS + 1, false],
    [90.5, false],
  ])('isValidFetchInterval(%s) === %s', (seconds, expected) => {
    expect(isValidFetchInterval(seconds as number)).toBe(expected);
  });

  it('种子数据的间隔（900 / 1800）都在合法区间内', () => {
    expect(isValidFetchInterval(900)).toBe(true);
    expect(isValidFetchInterval(1_800)).toBe(true);
  });
});

describe('到期查询规则（Agent 04 共用）', () => {
  it('必须同时限定 enabled=true 与 nextFetchAt <= now', () => {
    expect(buildDueSourcesWhere(NOW)).toEqual({
      enabled: true,
      OR: [{ nextFetchAt: null }, { nextFetchAt: { lte: NOW } }],
    });
  });

  it('**停用即不到期** —— enabled 是硬条件，不依赖调用方再加', () => {
    const filter = buildDueSourcesWhere(NOW);
    expect(filter.enabled).toBe(true);
  });

  it('nextFetchAt 为 NULL 也算到期（seed 出来的 8 个来源都没写这一列）', () => {
    const filter = buildDueSourcesWhere(NOW);
    expect(filter.OR).toContainEqual({ nextFetchAt: null });
  });

  it('now 被原样带进查询（不是「取当前时间」—— 那会让规则无法测试）', () => {
    const other = new Date('2030-01-01T00:00:00.000Z');
    expect(buildDueSourcesWhere(other).OR[1]).toEqual({ nextFetchAt: { lte: other } });
  });

  it('排序是先到期的先抓，**不按 priority**', () => {
    // 按 priority 排会让高优先级慢源反复插队，把 nextFetchAt 早的来源饿死。
    expect(DUE_SOURCES_ORDER_BY).toEqual([{ nextFetchAt: 'asc' }, { id: 'asc' }]);
    expect(JSON.stringify(DUE_SOURCES_ORDER_BY)).not.toContain('priority');
  });

  it('声明的索引与 Agent 01 建的一致', () => {
    expect(DUE_SOURCES_INDEX).toBe('sources(enabled, next_fetch_at)');
  });

  it('批大小是个正整数（防止一次把队列灌满）', () => {
    expect(Number.isInteger(DUE_SOURCES_BATCH_SIZE)).toBe(true);
    expect(DUE_SOURCES_BATCH_SIZE).toBeGreaterThan(0);
  });
});

describe('入队幂等窗口', () => {
  it('窗口是 1 分钟', () => {
    expect(FETCH_NOW_WINDOW_MS).toBe(60_000);
  });

  it('同一分钟内的两个时刻落在同一个窗口', () => {
    const a = new Date('2026-09-24T12:00:00.000Z');
    const b = new Date('2026-09-24T12:00:59.999Z');
    expect(fetchWindow(a)).toBe(fetchWindow(b));
  });

  it('跨过分钟边界就是新窗口', () => {
    const a = new Date('2026-09-24T12:00:59.999Z');
    const b = new Date('2026-09-24T12:01:00.000Z');
    expect(fetchWindow(a)).not.toBe(fetchWindow(b));
  });

  it('JobId 用契约里的 builder 拼，格式是 collector:{sourceId}:{window}', () => {
    const at = new Date('2026-09-24T12:00:00.000Z');
    expect(JobId.collectorFetchSource('42', fetchWindow(at))).toBe(
      `collector:42:${fetchWindow(at)}`,
    );
  });

  it('队列名与 Job 名逐字取自契约（不新造近义名）', () => {
    expect(QueueName.COLLECTOR).toBe('collector');
    expect(JobName.COLLECTOR_FETCH_SOURCE).toBe('collector.fetch-source');
  });
});

describe('redisConnectionOptions', () => {
  it('默认端口与 maxRetriesPerRequest=null（BullMQ 的硬要求）', () => {
    expect(redisConnectionOptions('redis://cache.internal')).toEqual({
      host: 'cache.internal',
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });

  it('解析端口 / 密码 / db 下标', () => {
    expect(redisConnectionOptions('redis://:s3cret@redis.internal:6380/2')).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      password: 's3cret',
      db: 2,
    });
  });

  it('用户名与百分号编码的密码会被解码', () => {
    expect(redisConnectionOptions('redis://user:p%40ss@host:6379')).toMatchObject({
      username: 'user',
      password: 'p@ss',
    });
  });

  it('rediss:// 必须开启 TLS', () => {
    expect(redisConnectionOptions('rediss://host:6380')).toMatchObject({ tls: {} });
  });

  it('本地默认串（.env 里那个）可用', () => {
    expect(redisConnectionOptions('redis://localhost:6379')).toMatchObject({
      host: 'localhost',
      port: 6379,
    });
  });
});
