/**
 * `FeaturedRepository` 的 Prisma 实现。
 *
 * ⚠ 本文件只写 `featured_items`。它**从不写** `contents` / `editorial_reviews`
 *（那是 Agent 05/07 的），也不碰 `daily_*`（那在本模块的兄弟目录）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ContentPipelineStatus } from '@signal/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toReviewId } from '../admin-review/bigint-id';
import type {
  CreateFeaturedInput,
  FeaturedRepository,
  FeaturedRow,
  UpdateFeaturedInput,
} from './repository';

const FEATURED_SELECT = {
  contentId: true,
  customTitle: true,
  customSummary: true,
  sortWeight: true,
  publishedAt: true,
  active: true,
  content: {
    select: {
      title: true,
      summary: true,
      originalUrl: true,
      imageUrl: true,
      publishedAt: true,
      pipelineStatus: true,
      review: { select: { status: true, publishFeatured: true } },
      source: { select: { name: true } },
    },
  },
} as const;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

@Injectable()
export class PrismaFeaturedRepository implements FeaturedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findContentGate(contentId: string) {
    const id = toReviewId(contentId);
    if (id === null) return null;

    const row = await this.prisma.content.findUnique({
      where: { id },
      select: {
        id: true,
        pipelineStatus: true,
        review: { select: { status: true, publishFeatured: true } },
      },
    });
    if (row === null) return null;

    return {
      contentId: String(row.id),
      pipelineStatus: row.pipelineStatus as ContentPipelineStatus,
      reviewStatus: row.review === null ? null : String(row.review.status),
      publishFeatured: row.review?.publishFeatured ?? false,
    };
  }

  async findFeatured(contentId: string): Promise<FeaturedRow | null> {
    const id = toReviewId(contentId);
    if (id === null) return null;

    const row = await this.prisma.featuredItem.findUnique({
      where: { contentId: id },
      select: FEATURED_SELECT,
    });
    return row === null ? null : toRow(row);
  }

  async create(input: CreateFeaturedInput): Promise<FeaturedRow | null> {
    const contentId = toReviewId(input.contentId);
    if (contentId === null) return null;

    try {
      const row = await this.prisma.featuredItem.create({
        data: {
          contentId,
          customTitle: input.customTitle,
          customSummary: input.customSummary,
          sortWeight: input.sortWeight,
          publishedAt: input.publishedAt,
          active: true,
        },
        select: FEATURED_SELECT,
      });
      return toRow(row);
    } catch (error) {
      // `featured_items.content_id` 唯一约束 → 已经是精选了。
      // **不靠先查后写**：那之间有并发窗口，两条请求会同时通过检查。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }
      throw error;
    }
  }

  async update(input: UpdateFeaturedInput): Promise<FeaturedRow | null> {
    const contentId = toReviewId(input.contentId);
    if (contentId === null) return null;

    const affected = await this.prisma.featuredItem.updateMany({
      where: { contentId },
      data: {
        ...(input.customTitle === undefined ? {} : { customTitle: input.customTitle }),
        ...(input.customSummary === undefined ? {} : { customSummary: input.customSummary }),
        ...(input.sortWeight === undefined ? {} : { sortWeight: input.sortWeight }),
        ...(input.active === undefined ? {} : { active: input.active }),
      },
    });
    if (affected.count === 0) return null;

    return this.findFeatured(input.contentId);
  }

  async list(input: {
    publicOnly: boolean;
    topicSlug?: string;
    contentType?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: FeaturedRow[]; nextCursor: string | null }> {
    const cursorId = input.cursor === undefined ? null : toReviewId(input.cursor);

    const where: Prisma.FeaturedItemWhereInput = {
      ...(input.publicOnly
        ? {
            active: true,
            // ⚠ 内容后来被撤下时精选项不会自动消失，前台必须自己过滤 ——
            // 否则会把已撤下的内容继续展示。
            content: { pipelineStatus: ContentPipelineStatus.APPROVED },
          }
        : {}),
      ...(input.contentType === undefined ? {} : { content: { type: input.contentType as never } }),
      ...(input.topicSlug === undefined
        ? {}
        : { content: { topics: { some: { topic: { slug: input.topicSlug } } } } }),
    };

    const rows = await this.prisma.featuredItem.findMany({
      where,
      select: FEATURED_SELECT,
      // 权重高的在前；同权重按发布时间倒序（`docs/10` 的「实时编辑流」语义）。
      orderBy: [{ sortWeight: 'desc' }, { publishedAt: 'desc' }, { contentId: 'desc' }],
      take: input.limit + 1,
      ...(cursorId === null ? {} : { cursor: { contentId: cursorId }, skip: 1 }),
    });

    // 多取一条用来判断「还有没有下一页」—— cursor 分页的常规做法。
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);

    return {
      rows: page.map(toRow),
      nextCursor: hasMore && last !== undefined ? String(last.contentId) : null,
    };
  }
}

/** Prisma 行 → 端口形状。 */
function toRow(row: {
  contentId: bigint;
  customTitle: string | null;
  customSummary: string | null;
  sortWeight: number;
  publishedAt: Date;
  active: boolean;
  content: {
    title: string;
    summary: string | null;
    originalUrl: string;
    imageUrl: string | null;
    publishedAt: Date | null;
    pipelineStatus: string;
    review: { status: string; publishFeatured: boolean } | null;
    source: { name: string };
  };
}): FeaturedRow {
  return {
    contentId: String(row.contentId),
    customTitle: row.customTitle,
    customSummary: row.customSummary,
    sortWeight: row.sortWeight,
    publishedAt: row.publishedAt.toISOString(),
    active: row.active,
    content: {
      title: row.content.title,
      summary: row.content.summary,
      originalUrl: row.content.originalUrl,
      imageUrl: row.content.imageUrl,
      publishedAt: iso(row.content.publishedAt),
      pipelineStatus: row.content.pipelineStatus as ContentPipelineStatus,
      reviewStatus: row.content.review === null ? null : String(row.content.review.status),
      publishFeatured: row.content.review?.publishFeatured ?? false,
      sourceName: row.content.source.name,
    },
  };
}
