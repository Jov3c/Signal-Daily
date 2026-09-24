/**
 * `RawItemRepository` 的 Prisma 实现。
 *
 * ── 幂等怎么做（`docs/06` 的三条幂等键）────────────────────────────
 * ```
 * 1. source + externalId
 * 2. canonical URL hash
 * 3. normalized content hash
 * ```
 *
 * ⚠ **`raw_items` 上没有对应的唯一约束。**
 * Agent 01 建的是普通索引 `@@index([sourceId, externalId])` /
 * `@@index([canonicalUrlHash])` / `@@index([contentHash])`，
 * 没有 `@@unique`。所以幂等只能靠「先查后写」，而「先查后写」在并发下
 * 会双写 —— 这正是为什么**采集任务必须独占 `source-fetch:{sourceId}` 锁**
 * （`docs/06` 的 Redis lock，见 `source-lock.ts`）。
 *
 * 换句话说：这里的正确性依赖那把锁。**不要**在没有锁的情况下调用本仓储。
 * 加唯一约束属于改 `prisma/schema.prisma`（Agent 01 独占，规则 §10
 * 「任何 Agent 不得创建 Migration」），因此已作为已知限制记录在 HANDOFF。
 *
 * 第 3 条（content hash）刻意**不做**拦截：同一篇文章换了标题、
 * 或正文被上游修订，都应该作为新事实入库 —— `docs/07` 的
 * Near Dedup 由 Pipeline（Agent 05）判定，采集端越权判断会把
 * 有用信息提前丢掉。这里只把 `content_hash` 算好存下来给它用。
 */

import { Inject, Injectable } from '@nestjs/common';
import { RawItemStatus } from '@signal/contracts';
import type { Prisma } from '@prisma/client';
import { toBindableId } from './bigint-id';
import type { ExistingKeys, ExistingKeysQuery, NewRawItem, RawItemRepository } from './ports';
import { toJsonValue } from './json-value';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaRawItemRepository implements RawItemRepository {
  // ⚠ 显式 `@Inject`：**不要**依赖 emitDecoratorMetadata。
  // `PrismaService` 只作为类型使用时，eslint 的 `consistent-type-imports`
  // 会要求写成 `import type` —— 而那样 tsc 产出的 `design:paramtypes`
  // 会退化成 `[Function]`，Nest 在**编译产物**里就解析不到依赖。
  // 这个缺陷在单元测试与集成测试里**全都看不见**（它们不实例化本模块），
  // 只有从 dist 起一个真实 Nest 上下文才会暴露。
  // 见 Agent 02 的 `apps/api/test/di-wiring.spec.ts` 与
  // `work/_agent04/probe-dist-collectors.mjs`。
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findExistingKeys(query: ExistingKeysQuery): Promise<ExistingKeys> {
    const externalIds = new Set<string>();
    const canonicalUrlHashes = new Set<string>();

    const sourceId = toBindableId(query.sourceId);
    if (sourceId === null) return { externalIds, canonicalUrlHashes };

    // 只查这一批的候选值，不拉全量历史：
    // 一个高频来源几个月后有几万条 RawItem，全量拉取会让每次采集的内存
    // 随时间线性增长，最终在某个夜里 OOM。
    const conditions: object[] = [];
    if (query.externalIds.length > 0) {
      conditions.push({ externalId: { in: query.externalIds } });
    }
    if (query.canonicalUrlHashes.length > 0) {
      conditions.push({ canonicalUrlHash: { in: query.canonicalUrlHashes } });
    }
    if (conditions.length === 0) return { externalIds, canonicalUrlHashes };

    const rows = await this.prisma.rawItem.findMany({
      where: { sourceId, OR: conditions },
      select: { externalId: true, canonicalUrlHash: true },
    });

    for (const row of rows) {
      if (row.externalId !== null) externalIds.add(row.externalId);
      canonicalUrlHashes.add(row.canonicalUrlHash);
    }
    return { externalIds, canonicalUrlHashes };
  }

  async insertMany(items: NewRawItem[]): Promise<number> {
    if (items.length === 0) return 0;

    const data = [];
    for (const item of items) {
      const sourceId = toBindableId(item.sourceId);
      // 超界/畸形的 sourceId 已经在选源时被挡掉，走到这里说明状态不一致 ——
      // 宁可少写也不要写出一条 sourceId 错误的记录。
      if (sourceId === null) continue;

      data.push({
        sourceId,
        externalId: item.externalId,
        originalUrl: item.originalUrl,
        canonicalUrl: item.canonicalUrl,
        canonicalUrlHash: item.canonicalUrlHash,
        titleRaw: item.titleRaw,
        bodyRaw: item.bodyRaw,
        payload: toJsonValue(item.payload) as Prisma.InputJsonValue,
        language: item.language,
        publishedAt: item.publishedAt,
        fetchedAt: item.fetchedAt,
        contentHash: item.contentHash,
        status: RawItemStatus.FETCHED,
      });
    }

    if (data.length === 0) return 0;

    const result = await this.prisma.rawItem.createMany({ data });
    return result.count;
  }
}
