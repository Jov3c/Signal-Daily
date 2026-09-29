/**
 * `ReadingProgressRepository` 端口 —— 阅读进度的持久化契约。
 *
 * ⚠ 只写 `reading_progress`，对 `contents` 只**读**（可见性判定）。
 */

import type { ReadingResourceType } from './resource-type';

/** 注入 token。 */
export const READING_PROGRESS_REPOSITORY = 'READING_PROGRESS_REPOSITORY';

/** 注入 token：可注入时钟（`completedAt` 必须可断言）。 */
export const READING_PROGRESS_CLOCK = 'READING_PROGRESS_CLOCK';

export type ReadingProgressRow = {
  resourceType: ReadingResourceType;
  resourceId: string;
  /** 0–1，四位小数（与 `Decimal(5,4)` 的精度一致）。 */
  progress: number;
  lastPosition: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type UpsertProgressInput = {
  userId: bigint;
  resourceType: ReadingResourceType;
  resourceId: bigint;
  progress: number;
  lastPosition: string | null;
  /**
   * 首次跨过完成线时写入的时刻；为 `null` 表示本次**不设**
   *（已完成的保持原值 —— Prisma 的 `undefined` 语义就是「不改这一列」）。
   *
   * 由**服务层**算好再传进来（它是业务判断），仓储只负责写。
   *
   * ⚠ **这里刻意没有 `now`**：`updated_at` 由 Prisma 的 `@updatedAt` 自动维护，
   * 仓储拿它做不了任何事。§23 审查的 F9 指出第一版把它留在端口上，
   * 于是**真实现忽略它、替身却用它** —— 两套实现的 `updatedAt` 语义不同，
   * 而两边各自都「测得过」。端口里不该有没人真正使用的参数。
   */
  completedAt: Date | null;
};

export interface ReadingProgressRepository {
  /** 该资源是否对外可见（只有可见的才允许记进度）。 */
  isResourceVisible(resourceId: bigint): Promise<boolean>;

  /** 读一条（服务层要用它判断「是不是已完成过」）。 */
  find(input: {
    userId: bigint;
    resourceType: ReadingResourceType;
    resourceId: bigint;
  }): Promise<ReadingProgressRow | null>;

  /** 写入（按主键 upsert）。 */
  upsert(input: UpsertProgressInput): Promise<ReadingProgressRow>;
}
