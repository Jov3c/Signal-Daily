/**
 * `BookmarkRepository` 的 Prisma 实现。
 *
 * ⚠ 只写 `bookmarks`。它**读** `contents` / `sources`（卡片预览）但**从不写** ——
 * 内容状态归 Agent 05/07。
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  ContentPipelineStatus,
  type ContentType,
  type SourceKind,
  type SourceTier,
  type SourceType,
} from '@signal/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { BookmarkRepository, BookmarkRow } from './repository';

/** 内容预览的字段（收藏页画卡片用）。 */
const CONTENT_SELECT = {
  id: true,
  type: true,
  title: true,
  summary: true,
  originalUrl: true,
  imageUrl: true,
  publishedAt: true,
  language: true,
  source: {
    select: {
      id: true,
      name: true,
      slug: true,
      type: true,
      kind: true,
      tier: true,
      official: true,
    },
  },
} as const;

const BOOKMARK_SELECT = {
  contentId: true,
  createdAt: true,
  content: { select: CONTENT_SELECT },
} as const;

type BookmarkPrismaRow = {
  contentId: bigint;
  createdAt: Date;
  content: {
    id: bigint;
    type: string;
    title: string;
    summary: string | null;
    originalUrl: string;
    imageUrl: string | null;
    publishedAt: Date | null;
    language: string;
    source: {
      id: bigint;
      name: string;
      slug: string;
      type: string;
      kind: string;
      tier: string;
      official: boolean;
    };
  } | null;
};

/**
 * 游标编码。
 *
 * ⚠ 用**复合游标** `{createdAtMillis}-{contentId}` 而不是只拿 `contentId`：
 * 列表按 `createdAt DESC` 排序，而 `createdAt` 是**毫秒精度**、并不唯一
 * （用户一次性收藏多条时可能撞在同一毫秒）。只拿一个不参与排序的字段当游标，
 * 会让翻页在边界上**漏掉或重复**若干行 —— 而且只在特定数据下出现。
 * 两个键一起构成全序，翻页才是确定的。
 */
export function encodeBookmarkCursor(createdAt: Date, contentId: bigint): string {
  return `${String(createdAt.getTime())}-${String(contentId)}`;
}

/** 解析游标；非法返回 `null`（调用方转 400）。 */
export function decodeBookmarkCursor(
  cursor: string,
): { createdAtMs: number; contentId: bigint } | null {
  const match = /^(\d{1,20})-(\d{1,20})$/.exec(cursor);
  if (match === null) return null;
  const createdAtMs = Number(match[1]);
  if (!Number.isSafeInteger(createdAtMs)) return null;
  return { createdAtMs, contentId: BigInt(match[2] as string) };
}

@Injectable()
export class PrismaBookmarkRepository implements BookmarkRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async isContentVisible(contentId: bigint): Promise<boolean> {
    const row = await this.prisma.content.findFirst({
      where: {
        id: contentId,
        // `docs/12`：Public API 不得返回 REJECTED / internal candidate。
        pipelineStatus: ContentPipelineStatus.APPROVED,
      },
      select: { id: true },
    });
    return row !== null;
  }

  async add(input: { userId: bigint; contentId: bigint; now: Date }): Promise<BookmarkRow | null> {
    if (!(await this.isContentVisible(input.contentId))) return null;

    // ⚠ **幂等靠主键，不靠先查后写**：`@@id([userId, contentId])` 撞车时
    // `createMany({skipDuplicates})` 直接跳过，`createdAt` 保持最初那次的值。
    // 「先查再插」之间有并发窗口，两条并发请求会有一条抛 P2002 变成 500。
    await this.prisma.bookmark.createMany({
      data: [{ userId: input.userId, contentId: input.contentId, createdAt: input.now }],
      skipDuplicates: true,
    });

    return this.find({ userId: input.userId, contentId: input.contentId });
  }

  async remove(input: { userId: bigint; contentId: bigint }): Promise<void> {
    // `deleteMany` 而不是 `delete`：删不存在的行时 `delete` 抛 P2025，
    // 而取消收藏的目标是「它不在我的收藏里」—— 本来就不在也是达成。
    await this.prisma.bookmark.deleteMany({
      where: { userId: input.userId, contentId: input.contentId },
    });
  }

  async find(input: { userId: bigint; contentId: bigint }): Promise<BookmarkRow | null> {
    const row = await this.prisma.bookmark.findUnique({
      where: { userId_contentId: { userId: input.userId, contentId: input.contentId } },
      select: BOOKMARK_SELECT,
    });
    return row === null ? null : toRow(row as BookmarkPrismaRow);
  }

  async list(input: {
    userId: bigint;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: BookmarkRow[]; nextCursor: string | null }> {
    const decoded = input.cursor === undefined ? null : decodeBookmarkCursor(input.cursor);
    if (input.cursor !== undefined && decoded === null) {
      // 走到这里说明 dto 没挡住 —— 但别静默退化成「第一页」。
      throw new Error(`Non-decodable bookmark cursor: ${input.cursor}`);
    }

    const where: Record<string, unknown> = {
      userId: input.userId,
      // `docs/12`：Public API 不得返回 REJECTED / internal candidate。
      // 收藏行本身**保留**（内容恢复可见后会重新出现），只是不在列表里显示。
      content: { pipelineStatus: ContentPipelineStatus.APPROVED },
    };
    if (decoded !== null) {
      const boundary = new Date(decoded.createdAtMs);
      where['OR'] = [
        { createdAt: { lt: boundary } },
        { createdAt: boundary, contentId: { lt: decoded.contentId } },
      ];
    }

    const rows = await this.prisma.bookmark.findMany({
      where,
      select: BOOKMARK_SELECT,
      // 全序：`createdAt` 倒序 + `contentId` 倒序（决胜键，见游标注释）
      orderBy: [{ createdAt: 'desc' }, { contentId: 'desc' }],
      take: input.limit + 1,
    });

    // 多取一条判断「还有没有下一页」—— cursor 分页的常规做法。
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);

    return {
      rows: page.map((row) => toRow(row as BookmarkPrismaRow)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeBookmarkCursor(
              (last as BookmarkPrismaRow).createdAt,
              (last as BookmarkPrismaRow).contentId,
            )
          : null,
    };
  }
}

/** Prisma 行 → 端口形状。 */
function toRow(row: BookmarkPrismaRow): BookmarkRow {
  return {
    contentId: String(row.contentId),
    createdAt: row.createdAt.toISOString(),
    content:
      row.content === null
        ? null
        : {
            id: String(row.content.id),
            type: row.content.type as ContentType,
            title: row.content.title,
            summary: row.content.summary,
            originalUrl: row.content.originalUrl,
            imageUrl: row.content.imageUrl,
            publishedAt:
              row.content.publishedAt === null ? null : row.content.publishedAt.toISOString(),
            language: row.content.language,
            source: {
              id: String(row.content.source.id),
              name: row.content.source.name,
              slug: row.content.source.slug,
              type: row.content.source.type as SourceType,
              kind: row.content.source.kind as SourceKind,
              tier: row.content.source.tier as SourceTier,
              official: row.content.source.official,
            },
          },
  };
}
