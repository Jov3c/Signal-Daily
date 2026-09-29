/**
 * `PublishingRepository` 端口 —— worker 侧日报生成的持久化契约。
 *
 * ⚠ 边界（与 `apps/api/src/modules/daily/repository.ts` 的分工）：
 *
 * ```text
 * 本端口（worker）      草稿生成：读候选、整体替换版块、发布落库
 * api 的 daily 端口      编辑动作：按需建期次、改版块、排期、公开读
 * ```
 *
 * 两个端口都写 `daily_editions` / `daily_sections` / `daily_items`，
 * 但**写的动作不重叠**：worker 只写「机器生成的草稿」与「发布」，
 * api 只写「人改的版块」与「排期/取消」。这样同一行不会被两边同时改。
 *
 * ⚠ `replaceSections` 在两个 app 里各有一份 SQL 实现，
 * 与 `preflight.ts` 同一性质（跨 app 不能 import）。
 * 与 preflight 不同的是：**这里不需要逐字同步** —— 两边的写入语义本来就不同
 *（worker 是整份重算，api 是管理员提交的整份结构），
 * 而 DB 的唯一约束是两边共同的守门人。
 */

import type { DailyEditionStatus } from '@signal/contracts';
import type { DraftCandidate } from './draft-compiler';
import type { EditionSnapshot } from './preflight';

/** 注入 token。 */
export const PUBLISHING_REPOSITORY = 'PUBLISHING_REPOSITORY';

/** 一期日报的期级字段（worker 需要的子集）。 */
export type PublishingEditionRow = {
  editionId: string;
  /** 上海业务日 `YYYY-MM-DD`。 */
  businessDate: string;
  editionNo: number | null;
  status: DailyEditionStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
};

/** 写入用的版块/条目。 */
export type PublishingSectionInput = {
  type: string;
  title: string;
  sortOrder: number;
  items: {
    contentId: string;
    displayStyle: string;
    sortOrder: number;
  }[];
};

export interface PublishingRepository {
  /** 按业务日找一期。 */
  findEdition(businessDate: string): Promise<PublishingEditionRow | null>;

  /**
   * 确保空草稿存在（`docs/10` 的 00:10）。
   *
   * 幂等：撞上 `business_date` 唯一约束就把它读回来（**不是**先查后写）。
   */
  ensureDraft(businessDate: string): Promise<PublishingEditionRow>;

  /**
   * **整体替换**某一期的版块与条目（草稿生成用）。
   *
   * ⚠ 调用方必须先确认这一期仍是 `DRAFT` —— 那条守卫在
   * `publishing.service.ts` 里，因为它是业务判断（「有人动过就不要覆盖」），
   * 不是持久化细节。仓储这边只负责「这次替换是原子的」。
   */
  replaceSections(editionId: string, sections: readonly PublishingSectionInput[]): Promise<void>;

  /**
   * 日报候选（`docs/10` 的候选口径）。
   *
   * 四条同时满足：`APPROVED`、`review.includeDailyCandidate`、
   * 在业务窗口内、`review.status = APPROVED`（未 REJECTED / ARCHIVED）。
   */
  findCandidates(input: { startUtc: Date; endUtc: Date; limit: number }): Promise<DraftCandidate[]>;

  /** 读一期用于发布前校验的快照。 */
  snapshot(editionId: string): Promise<EditionSnapshot | null>;

  /** 已发布期数（期号分配用）。 */
  countPublished(): Promise<number>;

  /**
   * 占用期号并置为 `PUBLISHED`。
   *
   * 返回 `null` = 「已经发布过了」（幂等，不是错误）。
   * 内部用带 WHERE 的条件更新保证原子性，并唯一约束 + 重试处理期号撞车 ——
   * 理由见 `apps/api` 侧同名方法的注释（两处实现同一手法）。
   */
  markPublished(
    editionId: string,
    input: { editionNo: number; publishedAt: Date },
  ): Promise<PublishingEditionRow | null>;
}
