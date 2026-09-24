/**
 * `CollectorSourceRepository` 的 Prisma 实现。
 *
 * ── 两条必须遵守的规则（都来自上游 HANDOFF，踩过就有真实后果）──────
 *
 * **① 绝不使用 SQL 的 `NOW()`。**
 * 本机 MySQL 的 `time_zone = SYSTEM = Asia/Shanghai`，而 `next_fetch_at`
 * 存的是 **UTC**（Prisma 按 UTC 读写 `DateTime`）。实测
 * `NOW(3)` 与 `UTC_TIMESTAMP(3)` 相差 8 小时 —— 用 `NOW()` 会让来源
 * **提前 8 小时**到期，静默、无报错、后台完全看不出来。
 * 本文件因此只绑定 JS 的 `Date`，不写任何原生 SQL（见 Agent 03 HANDOFF）。
 *
 * **② 到期查询必须走 `@signal/source-core` 的规则对象。**
 * `buildDueSourcesWhere()` 里的 `OR nextFetchAt IS NULL` 不是可选项：
 * Agent 01 的 seed 建的 8 个来源 `next_fetch_at` 全是 NULL，
 * 照 `docs/06` 的字面写（只判 `<= now`）它们**永远不会被采集**。
 * 排序同理（`DUE_SOURCES_ORDER_BY`）—— 各写一份的结果是
 * 「后台显示已停用，worker 还在抓」这类线上极难排查的不一致。
 */

import { Inject, Injectable } from '@nestjs/common';
import type { SourceType as PrismaSourceType } from '@prisma/client';
import { SOURCE_TYPES, type SourceType } from '@signal/contracts';
import { DUE_SOURCES_ORDER_BY, buildDueSourcesWhere } from '@signal/source-core';
import { toContractEnum } from './contract-enum';
import { toBindableId } from './bigint-id';
import type { CollectorSource, CollectorSourceRepository, FetchOutcome } from './ports';
import { PrismaService } from './prisma.service';
import type { CollectorCursor } from './types';

@Injectable()
export class PrismaCollectorSourceRepository implements CollectorSourceRepository {
  // ⚠ 显式 `@Inject`：**不要**依赖 emitDecoratorMetadata。
  // `PrismaService` 只作为类型使用时，eslint 的 `consistent-type-imports`
  // 会要求写成 `import type` —— 而那样 tsc 产出的 `design:paramtypes`
  // 会退化成 `[Function]`，Nest 在**编译产物**里就解析不到依赖。
  // 这个缺陷在单元测试与集成测试里**全都看不见**（它们不实例化本模块），
  // 只有从 dist 起一个真实 Nest 上下文才会暴露。
  // 见 Agent 02 的 `apps/api/test/di-wiring.spec.ts` 与
  // `work/_agent04/probe-dist-collectors.mjs`。
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<CollectorSource | null> {
    const sourceId = toBindableId(id);
    // 超出可绑定范围的 id 当作「不存在」而不是抛错：这与 Agent 03 的
    // `toSourceId()` 取舍一致（超界 id 一律 404/跳过，不产生 5xx 噪声）。
    if (sourceId === null) return null;

    const row = await this.prisma.source.findUnique({
      where: { id: sourceId },
      select: SOURCE_SELECT,
    });
    return row === null ? null : toCollectorSource(row);
  }

  async findDueSources(now: Date, limit: number): Promise<CollectorSource[]> {
    const rows = await this.prisma.source.findMany({
      where: buildDueSourcesWhere(now),
      orderBy: [...DUE_SOURCES_ORDER_BY],
      take: limit,
      select: SOURCE_SELECT,
    });
    return rows.map(toCollectorSource);
  }

  /**
   * 该来源已抓到的最新事实 → 增量游标。
   *
   * 排序用 `publishedAt` 优先、`id` 兜底：`publishedAt` 可空，
   * 而 `id` 是自增的（BIGINT UNSIGNED），所以「id 最大」等价于
   * 「最近写入」，是一个永远可用的稳定兜底。
   *
   * ⚠ 这里的 `publishedAt` 是**上游发布时刻**，不是抓取时刻。
   * 有的源会把文章时间写成未来（时区错误），于是那个值的来源就是游标 ——
   * 但这不会丢内容：游标只用于「跳过比它更旧的条目」，
   * 一个过大的未来时间会让该源一段时间内采不到新内容。
   * 因此这里额外限制「只用**不晚于现在太多**的发布时间做游标」。
   */
  async latestCursor(sourceId: string): Promise<CollectorCursor> {
    const id = toBindableId(sourceId);
    if (id === null) return { sincePublishedAt: null, sinceExternalId: null };

    const rows = await this.prisma.rawItem.findMany({
      where: { sourceId: id },
      orderBy: [{ id: 'desc' }],
      take: 20,
      select: { externalId: true, publishedAt: true },
    });
    if (rows.length === 0) return { sincePublishedAt: null, sinceExternalId: null };

    const horizon = Date.now() + 24 * 60 * 60 * 1000;
    let sincePublishedAt: Date | null = null;
    for (const row of rows) {
      const published = row.publishedAt;
      if (published === null || published.getTime() > horizon) continue;
      if (sincePublishedAt === null || published.getTime() > sincePublishedAt.getTime()) {
        sincePublishedAt = published;
      }
    }

    // `sinceExternalId` 只服务**上游支持真正增量语义**的适配器，目前只有 X 的
    // `since_id`（雪花 id 单调递增）。因此这里取**数值最大**的那个，而不是
    // 「最近写入那一行」的 externalId —— 两者在窗口顺序 ≠ id 顺序时不一致，
    // 旧实现取到更小的值会让 X 每轮重复拉取已见过的推文（去重兜住，
    // 但要占用 `max_results` 的窗口）。
    //
    // ⚠ HN 曾经也用它做增量，那是一个 P1 缺陷：榜单顺序与 id 顺序无关，
    // 「发布较早、后来涨上榜单」的条目会被永久跳过。现在 HN 不再使用游标。
    //
    // 非纯数字的 externalId（RSS 的 guid 等）不参与，返回 null。
    let sinceExternalId: string | null = null;
    let sinceExternalIdValue = -1n;
    for (const row of rows) {
      const value = row.externalId;
      if (value === null || !/^\d{1,20}$/.test(value)) continue;
      const numeric = BigInt(value);
      if (numeric > sinceExternalIdValue) {
        sinceExternalIdValue = numeric;
        sinceExternalId = value;
      }
    }

    return { sincePublishedAt, sinceExternalId };
  }

  async recordFetchOutcome(sourceId: string, outcome: FetchOutcome): Promise<void> {
    const id = toBindableId(sourceId);
    if (id === null) return;

    const succeeded = outcome.errorCode === null;
    await this.prisma.source.update({
      where: { id },
      data: {
        lastFetchedAt: outcome.at,
        // 无论成功失败都推进：否则一个一直失败的来源会被每一轮
        // 反复取出来（`enabled && nextFetchAt <= now` 恒成立），
        // 把队列额度全吃掉。
        nextFetchAt: outcome.nextFetchAt,
        ...(succeeded
          ? { lastSuccessAt: outcome.at, lastErrorCode: null }
          : { lastErrorAt: outcome.at, lastErrorCode: outcome.errorCode }),
      },
    });
  }
}

/**
 * 采集侧只取这些列。
 *
 * ⚠ **刻意不含** `kind` / `tier` / `official` / `trust_score` / `priority` ——
 * 见 `ports.ts` 文件头：那些是会变的编辑配置，不允许进 RawItem payload，
 * 而「查询时就不取」让这件事在类型与运行时两层都成立。
 */
const SOURCE_SELECT = {
  id: true,
  name: true,
  slug: true,
  type: true,
  baseUrl: true,
  feedUrl: true,
  externalId: true,
  language: true,
  config: true,
  fetchIntervalSeconds: true,
  enabled: true,
} as const;

type SourceRow = {
  id: bigint;
  name: string;
  slug: string;
  type: PrismaSourceType;
  baseUrl: string | null;
  feedUrl: string | null;
  externalId: string | null;
  language: string | null;
  config: unknown;
  fetchIntervalSeconds: number;
  enabled: boolean;
};

function toCollectorSource(row: SourceRow): CollectorSource {
  return {
    // BIGINT → string（`docs/02`）：`id` 绝不以 number 形式离开仓储。
    id: String(row.id),
    name: row.name,
    slug: row.slug,
    type: toContractEnum<SourceType>(SOURCE_TYPES, row.type, 'SourceType'),
    baseUrl: row.baseUrl,
    feedUrl: row.feedUrl,
    externalId: row.externalId,
    language: row.language,
    config: asJsonObject(row.config),
    fetchIntervalSeconds: row.fetchIntervalSeconds,
    enabled: row.enabled,
  };
}

/**
 * `sources.config` 是 `Json?`，取出来是 `unknown`。
 *
 * 非对象（数组 / 标量 / null）一律当作「没有配置」——
 * 适配器会用兜底值，而不是在一个数组上读 `.handle` 得到 undefined。
 */
function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
