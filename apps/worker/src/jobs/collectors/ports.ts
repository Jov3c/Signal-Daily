/**
 * Collector 的持久化 / 外部依赖端口。
 *
 * 与 Agent 02/03 同一套做法：服务层只依赖端口，单元测试用内存替身
 * 完整验证行为（幂等、失败隔离、状态推进），不需要 MySQL 或 Redis；
 * 真实 SQL / 真实 BullMQ 语义再由集成测试在真库真 Redis 上跑一遍。
 *
 * ── 为什么 `CollectorSource` 比 Agent 03 的 `SourceRecord` 窄得多 ────
 * 这不是重复定义，是**刻意的窄接口**，而且它承担一条硬规则的执行：
 *
 * > `tasks/agent-04-collectors.md`：Source tier/kind/official
 * > **不复制到 Raw payload 作为事实源**。
 *
 * 那三个字段是「这个来源有多可信」的编辑配置，管理员随时可改
 * （`docs/22`：Tier 由管理员维护）。一旦把抓取当时的取值写进 RawItem，
 * 那条数据就带上了一份会过期的历史快照 —— 之后 Pipeline / Review
 * 到底该信 payload 还是信 `sources` 表，就成了说不清的事。
 *
 * 因此适配器**拿不到**这些字段：类型里根本没有，写不出来。
 * 这比「写注释提醒大家别写进去」可靠得多 —— 注释不会拦住任何一行代码，
 * 而这里少一个字段，任何试图访问 `source.tier` 的代码都编译不过。
 * 读取时经 `source_id` 现查（`docs/02`、`docs/22`）。
 */

import type { SourceType } from '@signal/contracts';
import type { CollectorCursor } from './types';

/* ------------------------------------------------------------------ */
/* Source                                                              */
/* ------------------------------------------------------------------ */

/**
 * 采集侧的 Source 读模型。
 *
 * 刻意**不含** `kind` / `tier` / `official` / `trustScore` / `priority` —— 见文件头。
 * 也不含 `lastFetchedAt` 等状态列：采集器不读自己的写结果。
 */
export type CollectorSource = {
  id: string;
  name: string;
  slug: string;
  type: SourceType;
  baseUrl: string | null;
  feedUrl: string | null;
  externalId: string | null;
  language: string | null;
  config: Record<string, unknown> | null;
  fetchIntervalSeconds: number;
  enabled: boolean;
};

/** 注入 token。 */
export const SOURCE_REPOSITORY = 'COLLECTOR_SOURCE_REPOSITORY';

/** 一次采集的结果，用于推进 Source 的调度状态。 */
export type FetchOutcome = {
  at: Date;
  /** 无论成功失败都推进 —— 否则失败的来源会被每一轮反复取出来。 */
  nextFetchAt: Date;
  /** 成功时传 null（会清掉 `last_error_code`）。 */
  errorCode: string | null;
};

export interface CollectorSourceRepository {
  findById(id: string): Promise<CollectorSource | null>;
  /**
   * 取到期来源。
   *
   * 过滤与排序**必须**来自 `@signal/source-core` 的
   * `buildDueSourcesWhere()` / `DUE_SOURCES_ORDER_BY` —— 那是与
   * Source Registry（Agent 03）共用的唯一一份规则。各写一份的结果是
   * 「后台显示已停用，worker 还在抓」。
   */
  findDueSources(now: Date, limit: number): Promise<CollectorSource[]>;
  /** 该来源已抓到的最新事实 → 增量游标。 */
  latestCursor(sourceId: string): Promise<CollectorCursor>;
  /** 记录本轮结果并推进 `next_fetch_at`。 */
  recordFetchOutcome(sourceId: string, outcome: FetchOutcome): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* RawItem                                                             */
/* ------------------------------------------------------------------ */

/** 待写入的一条 RawItem（哈希已在服务层算好）。 */
export type NewRawItem = {
  sourceId: string;
  externalId: string | null;
  originalUrl: string;
  canonicalUrl: string;
  canonicalUrlHash: string;
  titleRaw: string | null;
  bodyRaw: string | null;
  payload: Record<string, unknown>;
  language: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  contentHash: string;
  /** `RawItemStatus.FETCHED`。 */
  status: 'FETCHED';
};

/** 去重时用来查询的候选键。 */
export type ExistingKeysQuery = {
  sourceId: string;
  externalIds: string[];
  canonicalUrlHashes: string[];
};

export type ExistingKeys = {
  externalIds: Set<string>;
  canonicalUrlHashes: Set<string>;
};

/** 注入 token。 */
export const RAW_ITEM_REPOSITORY = 'COLLECTOR_RAW_ITEM_REPOSITORY';

export interface RawItemRepository {
  /**
   * 查这一批候选里**已经存在**的键（`docs/06` 幂等第 1、2 条）。
   *
   * 只查候选值而不是把该来源的全部历史拉进内存：一个高频来源
   * 几个月后可能有几万条 RawItem，全量拉取会让每次采集的内存随时间线性增长。
   */
  findExistingKeys(query: ExistingKeysQuery): Promise<ExistingKeys>;
  /** 批量插入，返回真正写入的条数。 */
  insertMany(items: NewRawItem[]): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* JobRun                                                              */
/* ------------------------------------------------------------------ */

export type JobRunInput = {
  /** 用契约的 `JobName` 取值（`docs/13`）。 */
  jobType: string;
  /** 用 `JobId.*` builder 生成的幂等键。 */
  jobKey: string | null;
  metadata: Record<string, unknown> | null;
};

/** 注入 token。 */
export const JOB_RUN_REPOSITORY = 'COLLECTOR_JOB_RUN_REPOSITORY';

export interface JobRunRepository {
  start(at: Date, input: JobRunInput): Promise<string | null>;
  finish(
    id: string | null,
    at: Date,
    outcome: {
      status: 'SUCCEEDED' | 'FAILED' | 'DEAD';
      errorCode: string | null;
      attempts: number;
    },
  ): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

/**
 * `collector.fetch-source` 的任务载荷。
 *
 * 形状**不是**我发明的：Agent 03 的 `source-enqueuer.ts` 已经在往
 * `collector` 队列里放这个对象，并提交了 CCR-agent-03 第 2 项请求固化。
 * 消费端必须逐字对齐，否则管理员点「立即抓取」会静默什么都不发生。
 *
 * ```jsonc
 * { "sourceId": "123", "trigger": "manual", "requestedAt": "2026-09-24T01:00:56.616Z" }
 * ```
 */
export type CollectorFetchSourcePayload = {
  /** BIGINT → string（`docs/02`）。 */
  sourceId: string;
  /** `manual` = 管理员 `fetch-now` 触发；`schedule` = 调度器到期触发。 */
  trigger: 'manual' | 'schedule';
  /** 入队时刻，ISO 8601 UTC。 */
  requestedAt: string;
};

export type EnqueuedFetch = {
  queue: string;
  jobName: string;
  jobId: string;
  window: string;
};

/** 注入 token。 */
export const SOURCE_FETCH_QUEUE = 'COLLECTOR_SOURCE_FETCH_QUEUE';

export interface SourceFetchQueue {
  enqueue(payload: CollectorFetchSourcePayload, at: Date): Promise<EnqueuedFetch>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Distributed lock                                                    */
/* ------------------------------------------------------------------ */

/** 注入 token。 */
export const SOURCE_LOCK = 'COLLECTOR_SOURCE_LOCK';

/**
 * `docs/06` 的「Redis lock `source-fetch:{sourceId}`」。
 *
 * 两处都要用到、且**必须是同一把锁**：
 *   - 调度器：一个来源在枚举到期时先占锁，避免两个 worker 实例同时把它入队；
 *   - 采集任务执行期间：占锁，避免「定时抓取」与「管理员手动抓取」
 *     对同一来源并发写 RawItem（并发会让「先查后写」的幂等判定失效）。
 *
 * 因此接口只有最小的两个动作，没有 `tryLock` / `renew` 之类的花样：
 * 语义越少，两处用错的可能就越小。
 */
export interface SourceLock {
  /** 拿到返回 token；已被占用返回 null（**不等待**）。 */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  /** 只释放自己持有的锁（token 比对），避免释放掉别人的。 */
  release(key: string, token: string): Promise<void>;
}

/** 锁 key 的唯一构造点（`docs/06` 的字面格式）。 */
export function sourceFetchLockKey(sourceId: string): string {
  return `source-fetch:${sourceId}`;
}
