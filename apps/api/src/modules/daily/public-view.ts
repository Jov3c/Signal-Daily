/**
 * 已发布日报的**对外投影**。
 *
 * ── 为什么要单独一层，而不是直接把编辑台的形状返回 ──────────────────
 * 编辑台的 `EditionDetail` 里带着一批**只对管理员有意义**的东西：
 *
 * ```text
 * editionId          库内主键（对外用 businessDate 定位就够了）
 * status             状态机取值（前台不该看到 DRAFT / REVIEWING 这些概念）
 * scheduledAt        排期时刻（内部运营信息）
 * pipelineStatus     内容审核状态（docs/14：不把后台 debug 信息搬给用户）
 * ```
 *
 * 直接复用会让「以后给编辑台加一个内部字段」变成「意外泄漏到前台」——
 * 而这类泄漏不会让任何测试变红。投影层让**新增字段默认不外泄**。
 * 这与 Agent 13 的任务书要求一致：「不得把后台完整 debug 信息直接搬给用户」。
 */

import type {
  ContentType,
  DailyDisplayStyle,
  DailySectionType,
  SourceKind,
  SourceTier,
} from '@signal/contracts';
import { formatEditionNo } from './preflight';
import type { EditionDetail, EditionRow } from './repository';

/** 前台一条日报内容。 */
export type PublicDailyItem = {
  /** 供前台跳 `GET /contents/:id`（`docs/04`）。 */
  contentId: string;
  displayStyle: DailyDisplayStyle;
  sortOrder: number;
  /** 编辑自定义标题，没有就用内容自己的标题。 */
  headline: string;
  excerpt: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
  type: ContentType;
  originalUrl: string;
  source: {
    name: string;
    slug: string;
    kind: SourceKind;
    tier: SourceTier;
    official: boolean;
  };
};

export type PublicDailySection = {
  type: DailySectionType;
  title: string;
  sortOrder: number;
  items: PublicDailyItem[];
};

export type PublicDailyEdition = {
  businessDate: string;
  editionNo: number | null;
  /** `NO.001`。 */
  editionNoLabel: string | null;
  headline: string | null;
  publishedAt: string | null;
  sections: PublicDailySection[];
};

/** 归档列表里的一行（不含版块，只够画出日历）。 */
export type PublicDailyArchiveEntry = {
  businessDate: string;
  editionNo: number | null;
  editionNoLabel: string | null;
  headline: string | null;
  publishedAt: string | null;
  itemCount: number;
};

/**
 * 把编辑台的详情投影成前台形状。
 *
 * ⚠ `content === null` 的条目（内容行已被删除）**直接丢掉**。
 * 外键本该让它不可能发生，但真发生时不丢掉的话，前台会拿到一个
 * `originalUrl: undefined` 的条目并渲染出一个**点不动的链接** ——
 * 比少一条更难排查。
 */
export function toPublicEdition(detail: EditionDetail): PublicDailyEdition {
  return {
    businessDate: detail.edition.businessDate,
    editionNo: detail.edition.editionNo,
    editionNoLabel:
      detail.edition.editionNo === null ? null : formatEditionNo(detail.edition.editionNo),
    headline: detail.edition.headline,
    publishedAt: detail.edition.publishedAt,
    sections: detail.sections.map((section) => ({
      type: section.type,
      title: section.title,
      sortOrder: section.sortOrder,
      items: section.items.flatMap((item): PublicDailyItem[] => {
        if (item.content === null) return [];
        return [
          {
            contentId: item.contentId,
            displayStyle: item.displayStyle,
            sortOrder: item.sortOrder,
            headline: item.customHeadline ?? item.content.title,
            excerpt: item.customExcerpt ?? item.content.summary,
            imageUrl: item.content.imageUrl,
            publishedAt: item.content.publishedAt,
            type: item.content.type,
            originalUrl: item.content.originalUrl,
            source: {
              name: item.content.source.name,
              slug: item.content.source.slug,
              kind: item.content.source.kind,
              tier: item.content.source.tier,
              official: item.content.source.official,
            },
          },
        ];
      }),
    })),
  };
}

/** 归档条目。 */
export function toArchiveEntry(edition: EditionRow, itemCount: number): PublicDailyArchiveEntry {
  return {
    businessDate: edition.businessDate,
    editionNo: edition.editionNo,
    editionNoLabel: edition.editionNo === null ? null : formatEditionNo(edition.editionNo),
    headline: edition.headline,
    publishedAt: edition.publishedAt,
    itemCount,
  };
}
