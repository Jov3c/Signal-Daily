/**
 * 主来源优先级 —— `docs/07` 的「主来源优先级」与 `docs/22` 的「Primary Source 规则」。
 *
 * ```text
 * 1. 官方直接发布
 * 2. 当事人 / 原作者
 * 3. 核心开发者
 * 4. 高质量媒体
 * 5. 普通二手媒体
 * ```
 *
 * ── 输入是**来源属性**，不是正文 ────────────────────────────────────
 * 判断只看库里那四个受管理员维护的字段
 *（`Source.tier` / `kind` / `official`），**完全不看正文写了什么**。
 * 这与 `docs/08`「AI 不得凭语言风格伪造官方确认」是同一条原则：
 * 可信度来自「谁说的」，不是「说得像不像」。
 *
 * ── 为什么必须是**全序**而不是几档并列 ──────────────────────────────
 * 「谁是主来源」必须**唯一且确定**：同一个事件被聚合两次要得到同一个主来源，
 * 否则 `Event.primaryContentId` 会随处理顺序漂移，而它决定了前台
 * 「这个事件的主稿是哪一篇」。所以这里给出的是 1–5 的**全序**，
 * 且最终用 `contentId` 做平局的确定性决胜。
 */

import { SourceKind, SourceTier } from '@signal/contracts';

/** 主来源档位（1 最优先）。 */
export const PRIMARY_SOURCE_RANKS = [1, 2, 3, 4, 5] as const;
export type PrimarySourceRank = (typeof PRIMARY_SOURCE_RANKS)[number];

/** 判断优先级所需的来源属性。 */
export type SourcePriorityInput = {
  tier: SourceTier;
  kind: SourceKind;
  official: boolean;
};

/**
 * 计算主来源档位。
 *
 * 规则（**顺序敏感**：先命中先返回）：
 *
 * | 档 | 条件 | 对应 `docs/07` 的哪一条 |
 * | -- | ---- | ------------------------ |
 * | 1 | `official = true` 或 `tier = S` | 官方直接发布 |
 * | 2 | `kind = PERSON` | 当事人 / 原作者 |
 * | 3 | `kind = DEVELOPER` | 核心开发者 |
 * | 4 | `tier = B` 或 `kind = MEDIA` / `COMMUNITY` | 高质量媒体 |
 * | 5 | 其余（含 `tier = C`） | 普通二手媒体 |
 *
 * ⚠ `official = true` 与 `tier = S` 放在同一档是刻意的：`docs/22` 说
 * 「S：官方 / 原作者 / 直接事实来源」—— 管理员把 tier 标成 S 与把
 * official 打开表达的是同一件事，**让它们落在不同档位会产生
 * 「同样官方却分出高下」这种没人能解释的排序**。
 *
 * ⚠ `GOVERNMENT` 归入第 1 档：政府公告是典型的「直接事实来源」
 *（`docs/22` 的 S 档定义里就包含它）。
 */
export function primarySourceRank(source: SourcePriorityInput): PrimarySourceRank {
  if (source.official || source.tier === SourceTier.S) return 1;
  if (source.kind === SourceKind.PERSON) return 2;
  if (source.kind === SourceKind.DEVELOPER) return 3;
  if (source.kind === SourceKind.GOVERNMENT) return 1;
  if (source.tier === SourceTier.B) return 4;
  if (source.kind === SourceKind.MEDIA || source.kind === SourceKind.COMMUNITY) return 4;
  return 5;
}

/** 一个参与「谁是主来源」比较的候选 Content。 */
export type PrimaryCandidate = {
  contentId: string;
  source: SourcePriorityInput;
  /** 该内容进入事件的时间 —— 平局时**先到的**胜出。 */
  createdAt: Date;
};

/**
 * 从一组候选里选出主来源（`Event.primaryContentId`）。
 *
 * 排序键（依次比较）：
 * 1. **档位**（1 最优先）；
 * 2. **更早进入事件**的优先 —— 同一档位下，先报道的通常是原始出处；
 * 3. **`contentId` 数值最小**的优先 —— 纯粹为了让结果**确定**，
 *    避免「同一批数据两次选出不同主来源」。
 *
 * @returns 主来源的 `contentId`；候选为空时 `null`
 */
export function pickPrimaryContent(candidates: readonly PrimaryCandidate[]): string | null {
  if (candidates.length === 0) return null;

  let best: PrimaryCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null || isBetterPrimary(candidate, best)) best = candidate;
  }
  return best === null ? null : best.contentId;
}

function isBetterPrimary(a: PrimaryCandidate, b: PrimaryCandidate): boolean {
  const rankA = primarySourceRank(a.source);
  const rankB = primarySourceRank(b.source);
  if (rankA !== rankB) return rankA < rankB;

  const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff < 0;

  return compareIds(a.contentId, b.contentId) < 0;
}

/**
 * 按**数值**比较两个十进制 id（字典序下 `'10' < '9'` 是错的）。
 *
 * 与 `dedup/exact.ts` 的同名逻辑一样：解析不出来时退回字符串比较，
 * 只为**确定性**，不声称符合数值直觉。
 */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    if (left === right) return 0;
    return left < right ? -1 : 1;
  } catch {
    return a < b ? -1 : 1;
  }
}
