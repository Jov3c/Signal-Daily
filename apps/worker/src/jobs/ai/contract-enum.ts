/**
 * `@signal/contracts` 枚举 → Prisma 枚举的桥接。
 *
 * 问题与 `apps/api/src/common/prisma/prisma-enums.ts` 完全一样，
 * 只是方向相反：Prisma 生成的枚举与契约枚举**值相同但类型不兼容**，
 * 直接赋值必然 TS2322。
 *
 * ⚠ 为什么 worker 侧要自己写一份而不是复用 api 的：
 * `apps/api/src/**` 不在 worker 的 tsconfig 项目引用里，
 * 跨 app import 会直接把 worker 的构建拖进 api 的依赖图
 * （`docs/02` 只允许跨 app 共享 `packages/*`）。
 * 已按 §7 记录到 HANDOFF，建议 Agent 14 评估把这类桥接提到
 * 一个共享包（与 Agent 04 提取 `packages/source-core` 同一思路）。
 *
 * 写法上用**显式映射表**而不是 `as`：
 * 表是穷尽的（`Record<契约枚举, Prisma枚举>` 缺键即编译错），
 * 而 `as` 会在契约新增枚举值时静默放过。
 */

import {
  AiRunStatus as PrismaAiRunStatus,
  AiTaskType as PrismaAiTaskType,
  EvidenceType as PrismaEvidenceType,
} from '@prisma/client';
import { AiRunStatus, AiTaskType, EvidenceType } from '@signal/contracts';

const AI_TASK_TYPE_TO_PRISMA: Readonly<Record<AiTaskType, PrismaAiTaskType>> = {
  [AiTaskType.LANGUAGE_DETECT]: PrismaAiTaskType.LANGUAGE_DETECT,
  [AiTaskType.TRANSLATE]: PrismaAiTaskType.TRANSLATE,
  [AiTaskType.CLASSIFY]: PrismaAiTaskType.CLASSIFY,
  [AiTaskType.SCORE]: PrismaAiTaskType.SCORE,
  [AiTaskType.DEDUP_VERIFY]: PrismaAiTaskType.DEDUP_VERIFY,
  [AiTaskType.EVENT_CLUSTER]: PrismaAiTaskType.EVENT_CLUSTER,
  [AiTaskType.DAILY_DRAFT]: PrismaAiTaskType.DAILY_DRAFT,
};

const AI_RUN_STATUS_TO_PRISMA: Readonly<Record<AiRunStatus, PrismaAiRunStatus>> = {
  [AiRunStatus.QUEUED]: PrismaAiRunStatus.QUEUED,
  [AiRunStatus.RUNNING]: PrismaAiRunStatus.RUNNING,
  [AiRunStatus.SUCCEEDED]: PrismaAiRunStatus.SUCCEEDED,
  [AiRunStatus.FAILED]: PrismaAiRunStatus.FAILED,
  [AiRunStatus.SKIPPED]: PrismaAiRunStatus.SKIPPED,
};

/** 契约 `EvidenceType` → Prisma `EvidenceType`（读取证据时用）。 */
const PRISMA_TO_EVIDENCE_TYPE: Readonly<Record<PrismaEvidenceType, EvidenceType>> = {
  [PrismaEvidenceType.PRIMARY_SOURCE]: EvidenceType.PRIMARY_SOURCE,
  [PrismaEvidenceType.OFFICIAL_CONFIRMATION]: EvidenceType.OFFICIAL_CONFIRMATION,
  [PrismaEvidenceType.SUPPORTING_SOURCE]: EvidenceType.SUPPORTING_SOURCE,
  [PrismaEvidenceType.SOCIAL_CONFIRMATION]: EvidenceType.SOCIAL_CONFIRMATION,
  [PrismaEvidenceType.RELATED_DISCUSSION]: EvidenceType.RELATED_DISCUSSION,
};

export function toPrismaAiTaskType(value: AiTaskType): PrismaAiTaskType {
  return AI_TASK_TYPE_TO_PRISMA[value];
}

export function toPrismaAiRunStatus(value: AiRunStatus): PrismaAiRunStatus {
  return AI_RUN_STATUS_TO_PRISMA[value];
}

/**
 * Prisma `EvidenceType` → 契约 `EvidenceType`。
 *
 * 查表而不是 `as`：库里真出现契约没有的值（例如手工改过库）时，
 * 这里会**立刻抛错**，而不是把一个非法值带进 credibility 判断。
 */
export function toContractEvidenceType(value: PrismaEvidenceType): EvidenceType {
  const found = PRISMA_TO_EVIDENCE_TYPE[value];
  if (found === undefined) {
    throw new Error(`Unexpected EvidenceType value from database: ${String(value)}`);
  }
  return found;
}
