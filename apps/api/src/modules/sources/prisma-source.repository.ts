/**
 * `SourceRepository` 的 Prisma 实现。
 *
 * 本文件承担两件**只在边界做一次**的事：
 *
 *  1. **类型收敛**：Prisma 生成一套枚举、`@signal/contracts` 另有一套，
 *     值相同但类型互不兼容。用 `toContractEnum()` 做运行期校验的收敛 ——
 *     库里若出现了契约外的值，在这里当场炸掉，而不是带着一个非法 tier
 *     一路走到前台展示。（这也是 Agent 02 留下的公共约定。）
 *  2. **类型翻译**：`BIGINT` → string、`DECIMAL` → number、`Json?` → 普通对象。
 *     这三样都不允许漏到服务层：`docs/02` 要求 API 的 id 是 string，
 *     而 `Prisma.Decimal` 直接 JSON 序列化会变成一个 `{s,e,d}` 对象。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SOURCE_KINDS, SOURCE_TIERS, SOURCE_TYPES } from '@signal/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toIdString } from '../../common/prisma/bigint-id';
import { toContractEnum } from '../../common/prisma/prisma-enums';
import { DUE_SOURCES_ORDER_BY, buildDueSourcesWhere } from './scheduling';
import {
  toSourceId,
  type CreateSourceInput,
  type SourceListQuery,
  type SourceListResult,
  type SourceRecord,
  type SourceRepository,
  type UpdateSourceInput,
} from './repository';

/** Prisma 返回的 Source 行（只声明我们用到的部分）。 */
type SourceRow = {
  id: bigint;
  name: string;
  slug: string;
  type: string;
  kind: string;
  tier: string;
  official: boolean;
  baseUrl: string | null;
  feedUrl: string | null;
  externalId: string | null;
  language: string | null;
  priority: number;
  trustScore: Prisma.Decimal | number;
  fetchIntervalSeconds: number;
  enabled: boolean;
  config: Prisma.JsonValue | null;
  lastFetchedAt: Date | null;
  nextFetchAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * `Json?` 列 → 普通对象。
 *
 * 只接受普通对象；数组 / 标量在 schema 上不可能（写入路径都经过
 * `buildSourceConfig`），但真出现了也返回 null 而不是把它当成 config 用 ——
 * 那会让下游拿到一个形状完全不对的东西。
 */
function toConfigRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** `Json?` 列的可写值。SQL NULL 必须用 `Prisma.DbNull` 表达。 */
function toDbJson(value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

/** 行 → 读模型。所有跨类型转换集中在这里。 */
function toRecord(row: SourceRow): SourceRecord {
  return {
    id: toIdString(row.id),
    name: row.name,
    slug: row.slug,
    type: toContractEnum(SOURCE_TYPES, row.type, 'SourceType'),
    kind: toContractEnum(SOURCE_KINDS, row.kind, 'SourceKind'),
    tier: toContractEnum(SOURCE_TIERS, row.tier, 'SourceTier'),
    official: row.official,
    baseUrl: row.baseUrl,
    feedUrl: row.feedUrl,
    externalId: row.externalId,
    language: row.language,
    priority: row.priority,
    // DECIMAL(4,1) 取出来是 Prisma.Decimal；不转的话 JSON 里会变成 {s,e,d}。
    trustScore: Number(row.trustScore),
    fetchIntervalSeconds: row.fetchIntervalSeconds,
    enabled: row.enabled,
    config: toConfigRecord(row.config),
    lastFetchedAt: row.lastFetchedAt,
    nextFetchAt: row.nextFetchAt,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorAt: row.lastErrorAt,
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 把服务层的 id（string）转成库里的 bigint。
 *
 * 用本模块的 `toSourceId`（带**驱动可绑定上界**校验），不是公共的 `toBigIntId` ——
 * 后者只判「是不是 20 位以内的数字」，超过 `2^63-1` 的值会让 Prisma 抛
 * `PrismaClientUnknownRequestError`，把本该 404 的请求变成 500。
 */
function requireBigIntId(rawId: string): bigint {
  const id = toSourceId(rawId);
  if (id === null) {
    // 服务层总是先 findById（畸形 id 在那一层就变成 404），
    // 走到这里说明是编程错误，不是用户输入问题。
    throw new Error(`Invalid source id reached the repository: ${rawId}`);
  }
  return id;
}

@Injectable()
export class PrismaSourceRepository implements SourceRepository {
  // ⚠ 显式 @Inject：不要依赖 emitDecoratorMetadata（见 di-wiring.spec.ts）。
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateSourceInput): Promise<SourceRecord> {
    const row = await this.prisma.source.create({
      data: {
        name: input.name,
        slug: input.slug,
        type: input.type,
        kind: input.kind,
        tier: input.tier,
        official: input.official,
        baseUrl: input.baseUrl,
        feedUrl: input.feedUrl,
        externalId: input.externalId,
        language: input.language,
        priority: input.priority,
        trustScore: input.trustScore,
        fetchIntervalSeconds: input.fetchIntervalSeconds,
        enabled: input.enabled,
        // Prisma 的 enum 输入类型是它自己那套；值域与契约逐字一致
        // （有 `schema-contract.spec.ts` 守卫），这里在写入方向做一次断言式的收敛。
        config: toDbJson(input.config) ?? Prisma.DbNull,
        nextFetchAt: input.nextFetchAt,
      },
    });
    return toRecord(row as unknown as SourceRow);
  }

  async findById(id: string): Promise<SourceRecord | null> {
    // 畸形 **或超出驱动可绑定范围** 的 id 一律当作「不存在」，让上层走 404 ——
    // 而不是让 BigInt()/Prisma 抛异常变成 500。
    const bigIntId = toSourceId(id);
    if (bigIntId === null) return null;

    const row = await this.prisma.source.findUnique({ where: { id: bigIntId } });
    return row === null ? null : toRecord(row as unknown as SourceRow);
  }

  async findBySlug(slug: string): Promise<SourceRecord | null> {
    const row = await this.prisma.source.findUnique({ where: { slug } });
    return row === null ? null : toRecord(row as unknown as SourceRow);
  }

  async list(query: SourceListQuery): Promise<SourceListResult> {
    const where: Prisma.SourceWhereInput = {};
    if (query.type !== undefined) where.type = query.type;
    if (query.kind !== undefined) where.kind = query.kind;
    if (query.tier !== undefined) where.tier = query.tier;
    if (query.enabled !== undefined) where.enabled = query.enabled;
    if (query.q !== undefined && query.q !== '') {
      where.OR = [{ name: { contains: query.q } }, { slug: { contains: query.q } }];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.source.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.source.count({ where }),
    ]);

    return {
      items: rows.map((row) => toRecord(row as unknown as SourceRow)),
      total,
    };
  }

  async update(id: string, patch: UpdateSourceInput): Promise<SourceRecord> {
    const data: Prisma.SourceUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.slug !== undefined) data.slug = patch.slug;
    if (patch.type !== undefined) data.type = patch.type;
    if (patch.kind !== undefined) data.kind = patch.kind;
    if (patch.tier !== undefined) data.tier = patch.tier;
    if (patch.official !== undefined) data.official = patch.official;
    if (patch.baseUrl !== undefined) data.baseUrl = patch.baseUrl;
    if (patch.feedUrl !== undefined) data.feedUrl = patch.feedUrl;
    if (patch.externalId !== undefined) data.externalId = patch.externalId;
    if (patch.language !== undefined) data.language = patch.language;
    if (patch.priority !== undefined) data.priority = patch.priority;
    if (patch.trustScore !== undefined) data.trustScore = patch.trustScore;
    if (patch.fetchIntervalSeconds !== undefined) {
      data.fetchIntervalSeconds = patch.fetchIntervalSeconds;
    }
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.nextFetchAt !== undefined) data.nextFetchAt = patch.nextFetchAt;
    const config = toDbJson(patch.config);
    if (config !== undefined) data.config = config;

    const row = await this.prisma.source.update({ where: { id: requireBigIntId(id) }, data });
    return toRecord(row as unknown as SourceRow);
  }

  async setEnabled(id: string, enabled: boolean, nextFetchAt: Date | null): Promise<SourceRecord> {
    const row = await this.prisma.source.update({
      where: { id: requireBigIntId(id) },
      data: { enabled, ...(nextFetchAt === null ? {} : { nextFetchAt }) },
    });
    return toRecord(row as unknown as SourceRow);
  }

  async findDueSources(now: Date, limit: number): Promise<SourceRecord[]> {
    const rows = await this.prisma.source.findMany({
      // 过滤与排序都来自 scheduling.ts —— 与 Agent 04 的 Scheduler 同一套规则。
      where: buildDueSourcesWhere(now) as Prisma.SourceWhereInput,
      orderBy: [...DUE_SOURCES_ORDER_BY] as Prisma.SourceOrderByWithRelationInput[],
      take: limit,
    });
    return rows.map((row) => toRecord(row as unknown as SourceRow));
  }
}
