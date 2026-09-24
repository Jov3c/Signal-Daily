/**
 * `SourceRepository` 端口 —— Source Registry 的持久化契约。
 *
 * 端口化的理由与 Auth 模块一致：单元测试可以用内存替身完整验证
 * 服务层行为（分页、slug 冲突、启停语义），不需要 MySQL；
 * 真实 SQL 语义再由 `sources-db-semantics.integration.spec.ts` 在真库上跑一遍。
 *
 * ⚠ 注意 Prisma 枚举（`@prisma/client`）与契约枚举（`@signal/contracts`）
 * 是两套互不兼容的 nominal 类型。**本端口一律使用契约枚举**，
 * 由 `prisma-source.repository.ts` 在边界用 `toContractEnum()` 做带校验的收敛。
 */

import type { SourceKind, SourceTier, SourceType } from '@signal/contracts';

/** 注入 token。 */
export const SOURCE_REPOSITORY = 'SOURCE_REPOSITORY';

/**
 * 一条 Source 的读模型。
 *
 * `id` 是 **string**（BIGINT → string，`docs/02`）；`trustScore` 是 **number**
 * （库里是 `DECIMAL(4,1)`，取出来是 `Prisma.Decimal`，必须在仓储边界转掉，
 * 不能让 Decimal 对象漏到服务层与 JSON 响应里）。
 */
export type SourceRecord = {
  id: string;
  name: string;
  slug: string;
  type: SourceType;
  kind: SourceKind;
  tier: SourceTier;
  official: boolean;
  baseUrl: string | null;
  feedUrl: string | null;
  externalId: string | null;
  language: string | null;
  priority: number;
  trustScore: number;
  fetchIntervalSeconds: number;
  enabled: boolean;
  config: Record<string, unknown> | null;
  lastFetchedAt: Date | null;
  nextFetchAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** 新建。所有可空列都显式给值，避免「没传」与「传了 null」混淆。 */
export type CreateSourceInput = {
  name: string;
  slug: string;
  type: SourceType;
  kind: SourceKind;
  tier: SourceTier;
  official: boolean;
  baseUrl: string | null;
  feedUrl: string | null;
  externalId: string | null;
  language: string | null;
  priority: number;
  trustScore: number;
  fetchIntervalSeconds: number;
  enabled: boolean;
  config: Record<string, unknown> | null;
  /** 新建时的首次抓取时间。设为 `now` 让新来源立刻进入下一轮调度（`docs/06`）。 */
  nextFetchAt: Date | null;
};

/**
 * 局部更新。未出现的键 = 不改动。
 *
 * `config: null` 是**有意义的**（清空 config），因此不能靠 `undefined` 表达
 * 「清空」—— 这正是这里用 `| null` 而不是可选键的原因。
 */
export type UpdateSourceInput = {
  name?: string;
  slug?: string;
  type?: SourceType;
  kind?: SourceKind;
  tier?: SourceTier;
  official?: boolean;
  baseUrl?: string | null;
  feedUrl?: string | null;
  externalId?: string | null;
  language?: string | null;
  priority?: number;
  trustScore?: number;
  fetchIntervalSeconds?: number;
  enabled?: boolean;
  config?: Record<string, unknown> | null;
  nextFetchAt?: Date | null;
};

/** Admin 列表查询（`docs/02`：Admin 表格用 page/pageSize）。 */
export type SourceListQuery = {
  page: number;
  pageSize: number;
  type?: SourceType;
  kind?: SourceKind;
  tier?: SourceTier;
  enabled?: boolean;
  /** 关键词，匹配 name / slug（`docs/09` 的 Sources 页面搜索框）。 */
  q?: string;
};

export type SourceListResult = {
  items: SourceRecord[];
  total: number;
};

export interface SourceRepository {
  create(input: CreateSourceInput): Promise<SourceRecord>;
  findById(id: string): Promise<SourceRecord | null>;
  findBySlug(slug: string): Promise<SourceRecord | null>;
  list(query: SourceListQuery): Promise<SourceListResult>;
  /** 按 id 局部更新。记录不存在时抛 Prisma 的 P2025。 */
  update(id: string, patch: UpdateSourceInput): Promise<SourceRecord>;
  /** 幂等地设置启停状态，并按需推进 `nextFetchAt`。 */
  setEnabled(id: string, enabled: boolean, nextFetchAt: Date | null): Promise<SourceRecord>;
  /**
   * 取到期来源 —— Collector（Agent 04）的调度输入。
   *
   * 过滤与排序**必须**来自 `scheduling.ts`（`buildDueSourcesWhere` /
   * `DUE_SOURCES_ORDER_BY`），不要在实现里另写一份。
   */
  findDueSources(now: Date, limit: number): Promise<SourceRecord[]>;
}

/** 唯一的 slug 冲突错误（Prisma P2002）。 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
