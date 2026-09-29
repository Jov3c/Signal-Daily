/**
 * Evidence Attach —— `docs/07` 的「Evidence Attach」与 `docs/22` 的证据链模型。
 *
 * ── 证据不是「另一篇重复文章」──────────────────────────────────────
 * `docs/22` 明确：「Evidence：用于支撑 Event，可只是一条 URL/官方声明，
 * 不一定需要成为完整 Content。」因此一条 Content 进入事件时，
 * 我们为它生成一条**证据**，回答的是「这个事件为什么可信」，
 * 而不是「又读了一遍同一篇文章」。
 *
 * ── 类型映射（`docs/07` 原文）──────────────────────────────────────
 * ```text
 * 官方原始发布：PRIMARY_SOURCE 或 OFFICIAL_CONFIRMATION
 * 高质量独立媒体：SUPPORTING_SOURCE
 * X 当事人确认：SOCIAL_CONFIRMATION
 * 讨论/分析：RELATED_DISCUSSION
 * ```
 * 映射**只看来源属性**（tier / kind / official），不看正文 ——
 * 与 `docs/08`「AI 不得凭语言风格伪造官方确认」同一条原则。
 *
 * ── 三条硬规则 ────────────────────────────────────────────────────
 * 1. **一个 Event 最多一个 `isPrimary = true`** —— `docs/03` 要求，
 *    而 DB 层**不强制**（Agent 01 的说明），必须靠事务；
 * 2. **同一 Event 内同 URL 只留一条** —— `EventEvidence` 有
 *    `@@unique([eventId, urlHash])`，由 DB 兜底；
 * 3. **同一 Source 的多条内容只算一个独立来源** ——
 *    `docs/06`：「同 Source 的 RSS + 页面重复抓取只能算 1 个独立来源」。
 */

import { EvidenceType, SourceKind, SourceTier } from '@signal/contracts';
import type { SourcePriorityInput } from '../cluster/priority';

/** 库中已存在的一条证据（规划时需要知道「已有哪些」）。 */
export type ExistingEvidence = {
  evidenceId: string;
  urlHash: string;
  evidenceType: EvidenceType;
  isPrimary: boolean;
  /**
   * 取证时的 `publishedAt`。
   *
   * ⚠ **必须带**：第一版没带它，于是「已有 Primary」在比较里只有一个
   * 无穷大的排序键，任何带日期的**新**官方内容都会把它顶掉 ——
   * 结果是 Primary 每来一条官方报道就翻一次，而 `docs/22` 要的是
   * 「官方**原文**」，也就是最早那一条。
   */
  publishedAt: Date | null;
};

/** 事件里的一条内容（生成证据的原料）。 */
export type EvidenceCandidate = {
  contentId: string;
  sourceId: string;
  source: SourcePriorityInput;
  title: string | null;
  url: string;
  urlHash: string;
  publishedAt: Date | null;
};

/** 待写入的一条证据。 */
export type EvidenceDraft = {
  contentId: string;
  sourceId: string;
  evidenceType: EvidenceType;
  title: string | null;
  url: string;
  urlHash: string;
  publishedAt: Date | null;
  /** 是否要把它设成该事件的 Primary Evidence。 */
  isPrimary: boolean;
};

export type EvidencePlan = {
  /** 需要新增的证据（已存在的 URL 不在其中）。 */
  toInsert: EvidenceDraft[];
  /**
   * 该事件的 Primary Evidence 应指向哪条（按 `urlHash`）。
   * `null` 表示事件里没有任何 `PRIMARY_SOURCE`，**不设 Primary**。
   *
   * ⚠ 它可能与 `toInsert` 无关 —— 新内容可能来自媒体（SUPPORTING_SOURCE），
   * 而 Primary 仍然是之前那条官方原文。
   */
  primaryUrlHash: string | null;
  /** 需要先把旧的 Primary 置 false（选中项与当前 Primary 不同）。 */
  reassignPrimary: boolean;
  /** 幂等诊断：有多少条因为 URL 已存在而被跳过。 */
  skippedExistingUrls: number;
  /** `distinct source_id` 的独立来源数（`docs/06` 的口径）。 */
  independentSourceCount: number;
};

/**
 * 内容 → 证据类型。
 *
 * | 来源 | 证据类型 |
 * | ---- | -------- |
 * | `official = true` 或 `tier = S` | `PRIMARY_SOURCE`（该事件还没有 Primary 时）/ `OFFICIAL_CONFIRMATION` |
 * | `kind = PERSON` | `SOCIAL_CONFIRMATION`（`docs/07` 的「X 当事人确认」） |
 * | `kind = DEVELOPER` | `SUPPORTING_SOURCE`（核心开发者 = 高质量独立来源） |
 * | `tier = A/B` 的媒体/社区/政府 | `SUPPORTING_SOURCE` |
 * | 其余（含 `tier = C`） | `RELATED_DISCUSSION` |
 *
 * ⚠ 「官方原始发布」为什么有两个可能的类型：`docs/07` 写的是
 * 「`PRIMARY_SOURCE` **或** `OFFICIAL_CONFIRMATION`」。
 * 区分方式是**它是不是该事件的第一条官方来源** ——
 * 第一条是「原始发布」（Primary），后续官方来源是「官方确认/补充」。
 * 这样 `docs/22` 的「Primary Evidence」才有唯一确定的语义。
 *
 * @param hasPrimaryAlready 该事件当前是否已有 Primary Evidence
 */
export function evidenceTypeFor(
  source: SourcePriorityInput,
  hasPrimaryAlready: boolean,
): EvidenceType {
  const isOfficial = source.official || source.tier === SourceTier.S;

  if (isOfficial) {
    return hasPrimaryAlready ? EvidenceType.OFFICIAL_CONFIRMATION : EvidenceType.PRIMARY_SOURCE;
  }
  if (source.kind === SourceKind.GOVERNMENT) {
    // 政府公告是直接事实来源，但没有 official 标记时按官方确认处理。
    return EvidenceType.OFFICIAL_CONFIRMATION;
  }
  if (source.kind === SourceKind.PERSON) return EvidenceType.SOCIAL_CONFIRMATION;
  if (source.kind === SourceKind.DEVELOPER) return EvidenceType.SUPPORTING_SOURCE;

  if (source.tier === SourceTier.A || source.tier === SourceTier.B) {
    return EvidenceType.SUPPORTING_SOURCE;
  }
  if (source.kind === SourceKind.MEDIA || source.kind === SourceKind.COMMUNITY) {
    return EvidenceType.SUPPORTING_SOURCE;
  }
  return EvidenceType.RELATED_DISCUSSION;
}

/**
 * `distinct source_id` 的独立来源数（`docs/06` 的口径）。
 *
 * ⚠ **同 Source 的多条内容只算 1** —— 这正是 `docs/06` 要防的
 * 「10 家媒体转载同一稿件 = 10 个独立来源」。
 * `sourceId` 为空（人工补的证据、或来源被删后 SetNull）的不计入 ——
 * 否则删掉 Source 反而会让独立来源数虚高。
 *
 * `docs/03`：该值**不冗余存储**，由调用方在需要时计算。
 */
export function countIndependentSources(candidates: readonly EvidenceCandidate[]): number {
  const distinct = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.sourceId !== '') distinct.add(candidate.sourceId);
  }
  return distinct.size;
}

/** 选出应该是 Primary 的那条证据。 */
export type PrimarySelection = {
  /** 选中的证据 URL hash（对应 `EventEvidence.urlHash`）。 */
  urlHash: string | null;
  reason: 'first-primary-source' | 'no-primary-source-available';
};

/**
 * 选 Primary Evidence。
 *
 * 规则：**在 `PRIMARY_SOURCE` 类型的证据里，选 `publishedAt` 最早的**
 *（并列取 `urlHash` 字典序最小 —— 只为确定性）。
 *
 * 为什么限定在 `PRIMARY_SOURCE` 里选：`docs/22` 说 Primary 是
 * 「官方原文」，把它让给一条 `RELATED_DISCUSSION`（讨论帖）会让
 * 前台的「来源：X · 官方一手」变成谎言。
 * 事件里没有官方来源时**不设 Primary**，而不是硬塞一条 ——
 * 「有 Primary」本身就是一个关于可信度的断言。
 */
export function selectPrimary(
  candidates: readonly EvidenceDraft[],
  existing: readonly ExistingEvidence[],
): PrimarySelection {
  /** 排序键：越小越优先当 Primary。 */
  type Entry = { urlHash: string; key: number; existing: boolean };

  const fresh: Entry[] = candidates
    .filter((candidate) => candidate.evidenceType === EvidenceType.PRIMARY_SOURCE)
    .map((candidate) => ({
      urlHash: candidate.urlHash,
      // 新证据日期未知 → 不能声称自己是「原文」，排到最后。
      key: candidate.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY,
      existing: false,
    }));

  const alreadyStored: Entry[] = existing
    .filter((item) => item.evidenceType === EvidenceType.PRIMARY_SOURCE)
    .map((item) => ({
      urlHash: item.urlHash,
      // ⚠ 已有证据日期未知 → 当作「已知最早」，**保持不动**。
      // 这是刻意的偏向：把 Primary 交给一条日期不明的既有证据，
      // 比每来一条带日期的官方报道就把 Primary 翻一次更稳 ——
      // 而 Primary 的语义是「官方原文」，本来就该是第一手的那条。
      key: item.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
      existing: true,
    }));

  // 已有证据排在前面：日期完全相同时（用严格 `<` 比较）先到的（既有的）胜出。
  const all = [...alreadyStored, ...fresh];
  if (all.length === 0) return { urlHash: null, reason: 'no-primary-source-available' };

  const best = all.reduce((earliest, item) =>
    item.key < earliest.key || (item.key === earliest.key && item.urlHash < earliest.urlHash)
      ? item
      : earliest,
  );

  return { urlHash: best.urlHash, reason: 'first-primary-source' };
}

/**
 * 规划一次证据挂接。
 *
 * 纯函数：输入「事件里已有的证据」+「事件里的内容」，输出「要写什么」。
 * 副作用（事务、Primary 切换）留给仓储层。
 */
export function planEvidenceAttach(input: {
  candidates: readonly EvidenceCandidate[];
  existing: readonly ExistingEvidence[];
}): EvidencePlan {
  const knownUrlHashes = new Set(input.existing.map((item) => item.urlHash));

  const toInsert: EvidenceDraft[] = [];
  let skippedExistingUrls = 0;
  // 逐条判定「是不是第一条官方来源」—— 用*本批次*的进度，
  // 这样同一次挂接里的两条官方内容不会都变成 PRIMARY_SOURCE。
  let primarySourceSeen = input.existing.some(
    (item) => item.evidenceType === EvidenceType.PRIMARY_SOURCE,
  );

  for (const candidate of input.candidates) {
    if (knownUrlHashes.has(candidate.urlHash)) {
      skippedExistingUrls += 1;
      continue;
    }
    knownUrlHashes.add(candidate.urlHash);

    const evidenceType = evidenceTypeFor(candidate.source, primarySourceSeen);
    if (evidenceType === EvidenceType.PRIMARY_SOURCE) primarySourceSeen = true;

    toInsert.push({
      contentId: candidate.contentId,
      sourceId: candidate.sourceId,
      evidenceType,
      title: candidate.title,
      url: candidate.url,
      urlHash: candidate.urlHash,
      publishedAt: candidate.publishedAt,
      isPrimary: false, // Primary 由 selectPrimary 统一决定
    });
  }

  const selection = selectPrimary(toInsert, input.existing);
  if (selection.urlHash !== null) {
    for (const draft of toInsert) {
      if (draft.urlHash === selection.urlHash) draft.isPrimary = true;
    }
  }

  // 需要切换的条件：选中了某条 Primary，而它**不是**当前那条。
  // 注意选中项可能是一条**已存在**的证据（新内容来自媒体时），
  // 所以调用方必须用 `primaryUrlHash` 而不是「草稿里的 isPrimary」去落库。
  const currentPrimary = input.existing.find((item) => item.isPrimary);
  const reassignPrimary =
    selection.urlHash !== null && currentPrimary?.urlHash !== selection.urlHash;

  return {
    toInsert,
    primaryUrlHash: selection.urlHash,
    reassignPrimary,
    skippedExistingUrls,
    independentSourceCount: countIndependentSources(input.candidates),
  };
}
