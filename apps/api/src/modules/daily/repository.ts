/**
 * `DailyRepository` 端口 —— 日报**编辑与读取**的持久化契约。
 *
 * ⚠ 边界（很重要，别越界）：
 *
 * ```text
 * 本端口（apps/api）        编辑与读取：建期次、改版块、排期、发布落库、公开读
 * publishing 模块（worker） 草稿生成：读候选、编译版块（`publishing.daily-draft`）
 * ```
 *
 * 因此这里**没有** `findCandidates` —— 候选选择与草稿编译是 worker 侧
 * publishing 模块的事（`docs/13` 把 `publishing.daily-draft` 定在 worker）。
 * 本端口只写 `daily_editions` / `daily_sections` / `daily_items`，
 * 对 `contents` 只**读**（内容状态归 Agent 05/07）。
 *
 * 端口化的理由与 Agent 02/03/07 一致：单元测试用内存替身验服务层行为，
 * 真实 SQL 语义由 `daily-db.integration.spec.ts` 在真库上跑一遍。
 */

import type {
  ContentPipelineStatus,
  ContentType,
  DailyDisplayStyle,
  DailyEditionStatus,
  DailySectionType,
  SourceKind,
  SourceTier,
} from '@signal/contracts';
import type { EditionSnapshot } from './preflight';

/** 注入 token。 */
export const DAILY_REPOSITORY = 'DAILY_REPOSITORY';

/** 一期日报的期级字段。 */
export type EditionRow = {
  editionId: string;
  /** 上海业务日 `YYYY-MM-DD`。 */
  businessDate: string;
  editionNo: number | null;
  status: DailyEditionStatus;
  headline: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
};

/** 条目里带出的内容预览（编辑台与前台都要看这些）。 */
export type DailyItemContent = {
  title: string;
  summary: string | null;
  originalUrl: string;
  imageUrl: string | null;
  publishedAt: string | null;
  type: ContentType;
  pipelineStatus: ContentPipelineStatus;
  source: {
    name: string;
    slug: string;
    kind: SourceKind;
    tier: SourceTier;
    official: boolean;
  };
};

/** 一个条目。`content` 为 `null` 表示内容行已被删除（外键本该挡住，但别信任它）。 */
export type DailyItemRow = {
  contentId: string;
  displayStyle: DailyDisplayStyle;
  sortOrder: number;
  customHeadline: string | null;
  customExcerpt: string | null;
  content: DailyItemContent | null;
};

export type DailySectionRow = {
  sectionId: string;
  type: DailySectionType;
  title: string;
  sortOrder: number;
  items: DailyItemRow[];
};

/** 一期的完整内容。 */
export type EditionDetail = {
  edition: EditionRow;
  sections: DailySectionRow[];
};

/** 写入用的版块/条目（服务层校验、截断之后的形状）。 */
export type SectionInput = {
  type: DailySectionType;
  title: string;
  sortOrder: number;
  items: {
    contentId: string;
    displayStyle: DailyDisplayStyle;
    sortOrder: number;
    customHeadline: string | null;
    customExcerpt: string | null;
  }[];
};

export interface DailyRepository {
  /** 按业务日找一期。 */
  findByBusinessDate(businessDate: string): Promise<EditionRow | null>;

  /**
   * **确保某一期的空草稿存在**（已存在则原样返回，**不覆盖任何内容**）。
   *
   * `docs/10` 的 00:10 由 worker 的调度负责创建；这里是**惰性补建**：
   * 管理员在 00:10 之前（或在一个全新的部署上）打开编辑台时，
   * 如果只返回 404，他除了等调度没有任何办法 —— 而那是一个
   * 无法解释也无法自助解决的死路。
   *
   * 幂等靠 `daily_editions.business_date` 的唯一约束 + 撞车后读回，
   * **不是**先查后写（那之间有并发窗口）。
   */
  ensureDraft(businessDate: string): Promise<EditionRow>;

  /** 读一期的完整内容（含版块与条目）。 */
  detail(editionId: string): Promise<EditionDetail | null>;

  /**
   * 用一组版块/条目**整体替换**某一期的内容。
   *
   * 整体替换而不是逐条 diff：编辑台的交互是「拖完再保存」，
   * 整体替换让「保存」是一次原子的形状变更，不会出现半截顺序。
   * 实现必须是**单事务**（先删旧版块、再建新的）。
   */
  replaceSections(editionId: string, sections: readonly SectionInput[]): Promise<void>;

  /** 改期级字段。`undefined` = 不改。 */
  updateEdition(
    editionId: string,
    patch: {
      headline?: string | null;
      status?: DailyEditionStatus;
      scheduledAt?: Date | null;
      publishedAt?: Date | null;
    },
  ): Promise<EditionRow | null>;

  /** 已发布期数（期号分配用：`NO.001` 起，取消的草稿不占号）。 */
  countPublished(): Promise<number>;

  /**
   * **占用期号**：仅当该期还不是 `PUBLISHED` 时写入。
   *
   * 返回 `null` 表示「别人已经先发布了这一期」——
   * 调用方据此转为「已发布，无需重复发」而不是报错（幂等）。
   */
  markPublished(
    editionId: string,
    input: { editionNo: number; publishedAt: Date },
  ): Promise<EditionRow | null>;

  /** 读一期用于发布前校验的快照（`preflight.ts` 的输入）。 */
  snapshot(editionId: string): Promise<EditionSnapshot | null>;

  /**
   * 按月列出期次（后台列表）。
   *
   * `from`（含）/ `to`（不含）都是业务日字符串。
   */
  listByDateRange(input: {
    from: string;
    to: string;
    status?: DailyEditionStatus;
  }): Promise<EditionRow[]>;

  /**
   * 归档：**只返回 PUBLISHED**（`docs/10`：前台日历只展示 PUBLISHED）。
   */
  listArchive(input: { from: string; to: string }): Promise<EditionRow[]>;

  /** 按业务日读一期，**未发布返回 `null`**（对外不存在的语义）。 */
  findPublishedDetail(businessDate: string): Promise<EditionDetail | null>;

  /**
   * 批量读内容状态 —— 编辑台保存前的准入校验。
   *
   * 为什么必须有这道校验：编辑台是**自由输入 contentId** 的，
   * 没有它就可以把一条 `REVIEW_PENDING`（甚至 `REJECTED`）的内容
   * 直接塞进日报，从而绕过 `docs/00` 的「**任何内容必须人工审核**」。
   * 草稿编译器只挑 APPROVED 的候选，但**手工编辑是另一条路径**，
   * 必须自己再挡一次。
   *
   * @returns contentId → `pipelineStatus`；**不存在的 id 不在返回值里**
   *          （用「查不到」表达「不存在」，而不是造一个 `MISSING` 状态值 ——
   *           那样会把「库里没有这一行」和「库里有但状态是 X」混成一个类型）。
   */
  findContentStatuses(contentIds: readonly string[]): Promise<Map<string, ContentPipelineStatus>>;
}
