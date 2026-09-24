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

import { toBigIntId } from '../../common/prisma/bigint-id';
import type { SourceKind, SourceTier, SourceType } from '@signal/contracts';

/** 注入 token。 */
export const SOURCE_REPOSITORY = 'SOURCE_REPOSITORY';

/**
 * 能被**驱动安全绑定**的 BIGINT 上界（有符号 64 位最大值）。
 *
 * ⚠ 为什么不是 `BIGINT UNSIGNED` 的上限 —— 这一条独立审查实测出来的：
 * Prisma 把 JS `bigint` 按**有符号** 64 位绑定，`sources.id` 虽然是
 * `BIGINT UNSIGNED`，但任何超过 `2^63-1` 的值（**包括合法的无符号上限
 * `18446744073709551615` 本身**）都会让驱动抛
 * `PrismaClientUnknownRequestError`：
 *
 * ```
 * 99999999999999999999  -> THROW PrismaClientUnknownRequestError
 * 18446744073709551615  -> THROW PrismaClientUnknownRequestError   ← 连合法上限都炸
 * ```
 * （复现脚本：`work/_agent03/repro-bigint-bound.mjs`）
 *
 * 后果是：`GET /admin/sources/18446744073709551615` 会返回 **500 而不是 404**，
 * 污染 5xx 告警。`common/prisma/bigint-id.ts` 的 `toBigIntId()` 只校验
 * 「20 位以内的十进制数字」，没有上界 —— 那个文件属于 Agent 02，
 * 我不越界修改，因此在本模块边界上再收一次。
 *
 * 超界的 id 一律当作「**不存在**」（→ 404），而不是「非法输入」（→ 400）：
 * 对调用方而言这两者没有区别，而 404 不会产生 5xx 噪声。
 *
 * 已提交给契约 Owner：见 `handoffs/CONTRACT_CHANGE_REQUEST-agent-03.md`。
 */
export const MAX_BINDABLE_ID = 9_223_372_036_854_775_807n;

/**
 * 服务层的 id（string）→ 库里的 `bigint`；不可绑定的值返回 `null`。
 *
 * **本模块内一律用这个，不要直接用 `toBigIntId()`。**
 */
export function toSourceId(raw: string): bigint | null {
  const id = toBigIntId(raw);
  if (id === null) return null;
  return id > MAX_BINDABLE_ID ? null : id;
}

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
 * ⚠ 关于 `config: null`：类型上允许，但**服务层永远不会传 null** ——
 * DTO 层会以 400 明确拒绝它（独立审查 P3-1）。
 *
 * 原先的注释写着「`null` 表示清空 config」，而实现并不清空，
 * 而是把 `null` 喂给 `buildSourceConfig` 当成「空对象 → 全部走默认值」，
 * 于是「清空」被执行成了「静默重置成默认值」。注释与实现不符本身就是缺陷，
 * 因此两处一起改：行为改为拒绝，注释改为如实描述。
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
