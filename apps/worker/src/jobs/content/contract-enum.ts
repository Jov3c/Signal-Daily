/**
 * 契约枚举 ↔ Prisma 枚举的双向桥接。
 *
 * 问题与 `apps/api/src/common/prisma/prisma-enums.ts`、Agent 06 的
 * `jobs/ai/contract-enum.ts` 完全一样：Prisma 生成的枚举与契约枚举
 * **值相同但类型不兼容**，直接赋值必然 TS2322。
 *
 * ⚠ **这是本仓库的第 4 份同类桥接**（api / collectors / ai / 本模块），
 * 已与其它重复一起记入 CCR，建议 Agent 14 提到共享包。
 * 各写一份的代价不是风格问题：`ContentType` 新增取值时，
 * **只要有一份忘了改，那条路径就会在运行期抛错**，而 `tsc` 只能保证
 * 各自的表对自己是穷尽的。
 *
 * 写法用**显式映射表**而不是 `as`：表是穷尽的
 *（`Record<契约枚举, Prisma枚举>` 缺键即编译错），而 `as` 会静默放过。
 */

import {
  ContentPipelineStatus as PrismaContentPipelineStatus,
  type EvidenceType as PrismaEvidenceType,
  ContentType as PrismaContentType,
  RawItemStatus as PrismaRawItemStatus,
  type SourceType as PrismaSourceType,
} from '@prisma/client';
import {
  ContentPipelineStatus,
  ContentType,
  EvidenceType,
  RawItemStatus,
  SourceType,
} from '@signal/contracts';

/* ------------------------------------------------------------------ */
/* 写入方向：契约 → Prisma                                             */
/* ------------------------------------------------------------------ */

const CONTENT_TYPE_TO_PRISMA: Readonly<Record<ContentType, PrismaContentType>> = {
  [ContentType.ARTICLE]: PrismaContentType.ARTICLE,
  [ContentType.X_POST]: PrismaContentType.X_POST,
  [ContentType.GITHUB_REPO]: PrismaContentType.GITHUB_REPO,
  [ContentType.GITHUB_RELEASE]: PrismaContentType.GITHUB_RELEASE,
  [ContentType.HN_STORY]: PrismaContentType.HN_STORY,
  [ContentType.MODEL]: PrismaContentType.MODEL,
  [ContentType.SHORT_POST]: PrismaContentType.SHORT_POST,
};

const PIPELINE_STATUS_TO_PRISMA: Readonly<Record<ContentPipelineStatus, PrismaContentPipelineStatus>> = {
  [ContentPipelineStatus.INGESTED]: PrismaContentPipelineStatus.INGESTED,
  [ContentPipelineStatus.ANALYZING]: PrismaContentPipelineStatus.ANALYZING,
  [ContentPipelineStatus.REVIEW_PENDING]: PrismaContentPipelineStatus.REVIEW_PENDING,
  [ContentPipelineStatus.APPROVED]: PrismaContentPipelineStatus.APPROVED,
  [ContentPipelineStatus.REJECTED]: PrismaContentPipelineStatus.REJECTED,
  [ContentPipelineStatus.ARCHIVED]: PrismaContentPipelineStatus.ARCHIVED,
};

const RAW_ITEM_STATUS_TO_PRISMA: Readonly<Record<RawItemStatus, PrismaRawItemStatus>> = {
  [RawItemStatus.FETCHED]: PrismaRawItemStatus.FETCHED,
  [RawItemStatus.NORMALIZED]: PrismaRawItemStatus.NORMALIZED,
  [RawItemStatus.DUPLICATE]: PrismaRawItemStatus.DUPLICATE,
  [RawItemStatus.READY_FOR_ANALYSIS]: PrismaRawItemStatus.READY_FOR_ANALYSIS,
  [RawItemStatus.FAILED]: PrismaRawItemStatus.FAILED,
};

export function toPrismaContentType(value: ContentType): PrismaContentType {
  return CONTENT_TYPE_TO_PRISMA[value];
}

export function toPrismaPipelineStatus(
  value: ContentPipelineStatus,
): PrismaContentPipelineStatus {
  return PIPELINE_STATUS_TO_PRISMA[value];
}

export function toPrismaRawItemStatus(value: RawItemStatus): PrismaRawItemStatus {
  return RAW_ITEM_STATUS_TO_PRISMA[value];
}

/* ------------------------------------------------------------------ */
/* 读取方向：Prisma → 契约                                             */
/* ------------------------------------------------------------------ */

/**
 * 白名单收敛。
 *
 * 查表而不是 `as`：库里真出现契约没有的值（手工改过库、或版本不一致）时
 * 这里会**立刻抛错**，而不是把一个未知的 SourceType 带进类型推导 ——
 * 那会让 `deriveContentType` 落进一个没人预期的分支。
 */
export function toContractSourceType(value: PrismaSourceType): SourceType {
  if ((Object.values(SourceType) as string[]).includes(value)) return value as SourceType;
  throw new Error(`Unexpected SourceType value from database: ${String(value)}`);
}

export function toContractRawItemStatus(value: PrismaRawItemStatus): RawItemStatus {
  if ((Object.values(RawItemStatus) as string[]).includes(value)) return value as RawItemStatus;
  throw new Error(`Unexpected RawItemStatus value from database: ${String(value)}`);
}

/**
 * 白名单收敛（通用版）—— 与 Agent 02 的 `common/prisma/prisma-enums.ts`
 * 里的同名函数是同一件事的又一份实现（已记入 CCR）。
 *
 * 用于读库时把「契约里没有的值」挡在边界外，而不是让它带着一个
 * 非法的 tier/kind 一路走进主来源排序 —— 那会静默给出一个错误的优先级。
 */
export function toContractEnum<T extends string>(
  allowed: readonly T[],
  value: string,
  label: string,
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${label} value from database: ${value}`);
}

/**
 * Prisma `EvidenceType` → 契约 `EvidenceType`。
 *
 * 与 `toContractSourceType` 同一取舍：查表而不是 `as`，
 * 库里出现契约没有的值时立刻抛错，而不是把一个未知的证据类型
 * 带进「有没有官方确认」这类判断里。
 */
export function toContractEvidenceType(value: PrismaEvidenceType): EvidenceType {
  if ((Object.values(EvidenceType) as string[]).includes(value)) return value as EvidenceType;
  throw new Error(`Unexpected EvidenceType value from database: ${String(value)}`);
}
