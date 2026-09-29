/**
 * `FeaturedRepository` 端口 —— 精选的持久化契约。
 *
 * 端口化的理由与 Agent 02/03/07 一致：单元测试用内存替身验服务层行为，
 * 真实 SQL 语义由 `featured-db.integration.spec.ts` 在真库上跑一遍。
 */

import type { ContentPipelineStatus } from '@signal/contracts';

/** 注入 token。 */
export const FEATURED_REPOSITORY = 'FEATURED_REPOSITORY';

/** 精选项（含它引用的内容快照）。 */
export type FeaturedRow = {
  contentId: string;
  customTitle: string | null;
  customSummary: string | null;
  sortWeight: number;
  publishedAt: string;
  active: boolean;
  content: {
    title: string;
    summary: string | null;
    originalUrl: string;
    imageUrl: string | null;
    publishedAt: string | null;
    pipelineStatus: ContentPipelineStatus;
    reviewStatus: string | null;
    publishFeatured: boolean;
    sourceName: string;
  };
};

export type CreateFeaturedInput = {
  contentId: string;
  customTitle: string | null;
  customSummary: string | null;
  sortWeight: number;
  publishedAt: Date;
};

/**
 * 可编辑的字段。
 *
 * ⚠ **刻意不含** `originalUrl` / `publishedAt` / `sourceId` —— `docs/10`：
 * 「禁止改：原始来源、originalUrl、原发布时间」。想改也传不进来。
 * `undefined` = 不改；`null` = 清空。
 */
export type FeaturedEdits = {
  customTitle?: string | null;
  customSummary?: string | null;
  sortWeight?: number;
  active?: boolean;
};

export type UpdateFeaturedInput = FeaturedEdits & { contentId: string };

/** 注入 token：可注入时钟。 */
export const FEATURED_CLOCK = 'FEATURED_CLOCK';

export interface FeaturedRepository {
  /** 读一条内容的最小校验信息（判断能不能进精选）。 */
  findContentGate(contentId: string): Promise<{
    contentId: string;
    pipelineStatus: ContentPipelineStatus;
    reviewStatus: string | null;
    publishFeatured: boolean;
  } | null>;

  /** 该内容是否已经是精选。 */
  findFeatured(contentId: string): Promise<FeaturedRow | null>;

  /**
   * 建精选项。
   *
   * `content_id` 有唯一约束 —— 重复创建返回 `null`（调用方转 409），
   * **不靠先查后写**（那之间有并发窗口）。
   */
  create(input: CreateFeaturedInput): Promise<FeaturedRow | null>;

  /** 改自定义标题/摘要/权重/上下架。返回 `null` 表示不存在。 */
  update(input: UpdateFeaturedInput): Promise<FeaturedRow | null>;

  /** 列表。`publicOnly` 时只返回 `active` 且内容仍是 APPROVED 的。 */
  list(input: {
    publicOnly: boolean;
    topicSlug?: string;
    contentType?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: FeaturedRow[]; nextCursor: string | null }>;
}
