/**
 * 日报草稿编译器 —— `docs/10` 的 Draft Compiler 与多样性规则。
 *
 * **纯函数**：输入候选列表，输出版块结构 + 一份「哪些候选没进去、为什么」的说明。
 * 读库与写库留在 `publishing.service.ts`，因此这里的每一条规则都能被
 * 单独断言，不需要 MySQL。
 *
 * ── `docs/10` 的原文 ────────────────────────────────────────────────
 *
 * ```text
 * Draft Compiler
 * 候选必须：
 * - Content 已 APPROVED
 * - include_daily_candidate=true
 * - 在业务窗口内
 * - 未 REJECTED / ARCHIVED
 * AI 只能给 Lead、section、排序建议，写入仍是 DRAFT。
 *
 * 默认版块：FRONT_PAGE / AI / PRODUCT / DEVELOPMENT / TECH / X_VOICES / BRIEFS
 *
 * 多样性
 * AI 草稿建议限制：
 * - 单一公司不超过主要条目 25%
 * - 同 Event 默认 1 条 Primary
 * - supporting 作为延伸阅读
 * - X_VOICES 默认 5–10 条
 * - Lead 只有 1 条
 * 管理员可覆盖。
 * ```
 *
 * ── ⚠ 本模块**不做 AI 草稿**（V1 的设计取舍，已记入 HANDOFF）──────────
 * `docs/10` 说「AI 只能给 Lead、section、排序建议」，而
 * `AiTaskType.DAILY_DRAFT` 在 Agent 06 的 Prompt Registry 里**显式登记为
 * `null`**（`promptFor` 会抛 `UNSUPPORTED`）。本模块因此**先做规则版**：
 * 按分数、类型、关键词、来源属性做确定性排序与归类。
 *
 * 这样做的三个理由：
 *
 * 1. **没有 AI 也能出一份草稿** —— 否则整条日报链路卡在一次外部调用上，
 *    而 AI 不可用（未配 key / 预算耗尽 / 上游故障）是常态而不是异常；
 * 2. 规则版是**确定的**，同一份候选永远得到同一份草稿，
 *    这对「重跑幂等」是硬要求（`docs/07`：每阶段必须幂等）；
 * 3. AI 建议的落点是**同一个 DRAFT**（`docs/10` 的「写入仍是 DRAFT」），
 *    将来接上 AI 时它覆盖的是同一批数据，不需要改状态机。
 *
 * ── 「单一公司不超过主要条目 25%」怎么落地（⚠ 近似，必须说明）────────
 * schema 里**没有「公司」这个字段**。最接近的实体是 `Source`
 * （一家公司的官方 Blog / X 账号就是它的一个 Source）。
 * 因此本模块按 **Source** 近似「公司」，并在 HANDOFF 里显式标注这是近似。
 *
 * 另：「主要条目」按 `DailyDisplayStyle` 读作 `LEAD` + `MAJOR`
 *（`docs/05` 的四个取值是 LEAD / MAJOR / STANDARD / BRIEF，
 *  排除 BRIEF 之后「主要」对应的就是前两档）。
 */

import {
  ContentType,
  DailyDisplayStyle,
  DailySectionType,
  type SourceKind,
  type SourceTier,
} from '@signal/contracts';

/* ------------------------------------------------------------------ */
/* 输入 / 输出                                                         */
/* ------------------------------------------------------------------ */

/** 一个候选（已通过「APPROVED + includeDailyCandidate + 业务窗口」的筛选）。 */
export type DraftCandidate = {
  contentId: string;
  title: string;
  summary: string | null;
  /** 用于多样性规则（近似「公司」）。 */
  sourceId: string;
  sourceName: string;
  sourceKind: SourceKind;
  sourceTier: SourceTier;
  official: boolean;
  /** `contents.final_score`，可能为 `null`（还没被评分）。 */
  finalScore: number | null;
  /** ISO 时刻（`published_at` 缺失时由仓储用 `created_at` 兜底）。 */
  publishedAt: string;
  /** 所属事件。 */
  eventId: string | null;
  /** 是否是所属事件的主稿。 */
  isEventPrimary: boolean;
  contentType: ContentType;
};

/** 编译出的一个条目。 */
export type CompiledItem = {
  contentId: string;
  displayStyle: DailyDisplayStyle;
  sortOrder: number;
};

export type CompiledSection = {
  type: DailySectionType;
  title: string;
  sortOrder: number;
  items: CompiledItem[];
};

/** 候选没进草稿（或被降级）的原因。 */
export const DraftNoteReason = {
  NOT_EVENT_PRIMARY: 'NOT_EVENT_PRIMARY',
  DUPLICATE_EVENT: 'DUPLICATE_EVENT',
  DUPLICATE_CONTENT: 'DUPLICATE_CONTENT',
  X_VOICES_CAP: 'X_VOICES_CAP',
  SOURCE_DIVERSITY_DEMOTED: 'SOURCE_DIVERSITY_DEMOTED',
} as const;

export type DraftNoteReasonValue = (typeof DraftNoteReason)[keyof typeof DraftNoteReason];

/** 一条说明：某个候选发生了什么。 */
export type DraftNote = {
  contentId: string;
  reason: DraftNoteReasonValue;
  detail?: string;
};

export type CompiledDraft = {
  sections: CompiledSection[];
  /**
   * 「哪些候选没进去、为什么」。
   *
   * 为什么要返回它而不是静默丢弃：`docs/10` 的多样性规则是**建议性**的
   *（「管理员可覆盖」），管理员看到一篇该进的高分内容没进日报时，
   * 必须能回答「为什么」。没有这份说明，那只能靠猜。
   */
  notes: DraftNote[];
};

/* ------------------------------------------------------------------ */
/* 规则常量                                                            */
/* ------------------------------------------------------------------ */

/** `docs/10` 的七个默认版块，**顺序即 sortOrder**。 */
export const DEFAULT_SECTIONS: readonly { type: DailySectionType; title: string }[] = [
  { type: DailySectionType.FRONT_PAGE, title: '首页' },
  { type: DailySectionType.AI, title: 'AI' },
  { type: DailySectionType.PRODUCT, title: '产品' },
  { type: DailySectionType.DEVELOPMENT, title: '开发' },
  { type: DailySectionType.TECH, title: '科技' },
  { type: DailySectionType.X_VOICES, title: 'X 声音' },
  { type: DailySectionType.BRIEFS, title: '简讯' },
];

/**
 * `FRONT_PAGE` 的条目数。
 *
 * 取 1：`docs/10` 说「Lead 只有 1 条」，而 `FRONT_PAGE` 就是**头条区**。
 * 把头条内容同时塞进它的主题版块会让同一篇内容在一期里出现两次 ——
 * 而 `docs/10` 没有要求重复展示，所以我们不做。
 *
 * 取 1 还有一个直接好处：**自动草稿天然满足发布前的 `LEAD_REQUIRED`**，
 * 只要候选池非空。
 */
export const FRONT_PAGE_SIZE = 1;

/** `docs/10`：「X_VOICES 默认 5–10 条」。上限是硬约束，下限是期望值。 */
export const X_VOICES_MIN = 5;
export const X_VOICES_MAX = 10;

/** `docs/10`：「单一公司不超过主要条目 25%」。 */
export const MAJOR_SOURCE_SHARE = 0.25;

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 编译一份草稿。
 *
 * **确定性**：同一份输入（含顺序）必然得到同一份输出。
 * 比较分数时用 `finalScore` 降序、`publishedAt` 降序、`contentId` 降序
 * 三级决胜 —— 没有第三级的话，两条同分同秒的内容在两次运行里可能换位，
 * 而「重跑幂等」要求它们不能换。
 */
export function compileDraft(candidates: readonly DraftCandidate[]): CompiledDraft {
  const notes: DraftNote[] = [];

  // ── 1. 去重（同一个 contentId 只出现一次）─────────────────────────
  const byContentId = new Map<string, DraftCandidate>();
  for (const candidate of candidates) {
    if (byContentId.has(candidate.contentId)) {
      notes.push({
        contentId: candidate.contentId,
        reason: DraftNoteReason.DUPLICATE_CONTENT,
        detail: 'the same content appeared twice in the candidate list',
      });
      continue;
    }
    byContentId.set(candidate.contentId, candidate);
  }

  // ── 2. 同 Event 默认 1 条 Primary（docs/10）──────────────────────
  // 非主稿的**丢弃**（不是降级）：`docs/10` 说 supporting 作为延伸阅读，
  // 而延伸阅读是**内容页**的呈现（`docs/22` 的 Event 证据链），
  // 不是日报的条目 —— 日报是编辑挑选的结果，不是事件的全集。
  const seenEvents = new Set<string>();
  const survivors: DraftCandidate[] = [];
  for (const candidate of byContentId.values()) {
    if (candidate.eventId === null) {
      survivors.push(candidate);
      continue;
    }
    if (!candidate.isEventPrimary) {
      notes.push({
        contentId: candidate.contentId,
        reason: DraftNoteReason.NOT_EVENT_PRIMARY,
        detail: `event ${candidate.eventId} already has a primary item`,
      });
      continue;
    }
    if (seenEvents.has(candidate.eventId)) {
      notes.push({
        contentId: candidate.contentId,
        reason: DraftNoteReason.DUPLICATE_EVENT,
        detail: `event ${candidate.eventId} already contributed an item`,
      });
      continue;
    }
    seenEvents.add(candidate.eventId);
    survivors.push(candidate);
  }

  // ── 3. 拆分 X 与其他 ─────────────────────────────────────────────
  const sorted = [...survivors].sort(compareCandidates);
  const xPosts = sorted.filter((candidate) => candidate.contentType === ContentType.X_POST);
  const others = sorted.filter((candidate) => candidate.contentType !== ContentType.X_POST);

  // ── 4. X_VOICES 上限（docs/10：5–10 条）──────────────────────────
  const xKept = xPosts.slice(0, X_VOICES_MAX);
  for (const dropped of xPosts.slice(X_VOICES_MAX)) {
    notes.push({
      contentId: dropped.contentId,
      reason: DraftNoteReason.X_VOICES_CAP,
      detail: `X_VOICES keeps at most ${X_VOICES_MAX} items`,
    });
  }

  // ── 5. 归类 ──────────────────────────────────────────────────────
  // `FRONT_PAGE` 拿分数最高的那一条（头条），其余按主题归到各自版块。
  const buckets = new Map<DailySectionType, DraftCandidate[]>();
  const push = (type: DailySectionType, candidate: DraftCandidate): void => {
    const list = buckets.get(type);
    if (list === undefined) buckets.set(type, [candidate]);
    else list.push(candidate);
  };

  // `FRONT_PAGE` 是**唯一**能产出 `LEAD` 的版块（见 `displayStyleFor`），
  // 而 `LEAD` 是发布前校验的硬要求。因此头条的选取要保证「只要候选池非空，
  // 就一定有一条 LEAD」。
  let xPool = xKept;

  if (others.length > 0) {
    for (const candidate of others.slice(0, FRONT_PAGE_SIZE)) {
      push(DailySectionType.FRONT_PAGE, candidate);
    }
    for (const candidate of others.slice(FRONT_PAGE_SIZE)) {
      push(sectionForCandidate(candidate), candidate);
    }
  } else if (xPool.length > 0) {
    // ── ⚠ 头条兜底：非 X 候选为空时，用分数最高的 X 顶上 ────────────
    //
    // 没有这一条，「非 X 候选为空」的日子（例如只配了 X 白名单、
    // 或 RSS 当天没出东西）会让自动草稿**结构性**过不了 preflight ——
    // 每天都得有人工干预，而「自动草稿」这个设计本身就失效了。
    //
    // ⚠ 这是 §23 独立审查的 **P3-1** 找出来的。本模块原先在 HANDOFF 里写着
    // 「自动草稿天然满足 LEAD_REQUIRED，只要候选池非空」—— **那句话是错的**；
    // 正确条件是「**至少一条非 X 候选**」。审查用的只读探针实测：
    // 三条全 X 候选 → sections 只有 `X_VOICES`（styles 全是 MAJOR/STANDARD）
    // → `preflightEdition` 报 `LEAD_REQUIRED`。
    //
    // 顶上去的那条**同时从 X_VOICES 移除**：`docs/10` 没有要求同一篇内容
    // 在一期里出现两次，而本模块已确立「一条内容只出现一次」的不变式。
    const promoted = [...xPool].sort(compareCandidates)[0];
    if (promoted !== undefined) {
      push(DailySectionType.FRONT_PAGE, promoted);
      xPool = xPool.filter((candidate) => candidate.contentId !== promoted.contentId);
    }
  }

  for (const candidate of xPool) {
    push(DailySectionType.X_VOICES, candidate);
  }

  // ── 6. 每个版块内排序 + 分配展示样式 ─────────────────────────────
  const sections: CompiledSection[] = [];
  for (const definition of DEFAULT_SECTIONS) {
    const bucket = buckets.get(definition.type);
    if (bucket === undefined || bucket.length === 0) continue;

    const ordered = [...bucket].sort(compareCandidates);
    const items = ordered.map((candidate, index) => ({
      contentId: candidate.contentId,
      displayStyle: displayStyleFor(definition.type, index),
      sortOrder: index,
    }));

    sections.push({
      type: definition.type,
      title: definition.title,
      // sortOrder 用 `docs/10` 的**规范序号**，不是数组下标 ——
      // 这样「AI 永远排在 PRODUCT 前面」不依赖哪些版块恰好非空。
      sortOrder: DEFAULT_SECTIONS.findIndex((entry) => entry.type === definition.type),
      items,
    });
  }

  // ── 7. 来源多样性：降级（不是丢弃）───────────────────────────────
  const sourceByContentId = new Map(survivors.map((c) => [c.contentId, c.sourceId]));
  for (const note of applySourceDiversity(sections, sourceByContentId)) notes.push(note);

  return { sections, notes };
}

/* ------------------------------------------------------------------ */
/* 规则                                                                */
/* ------------------------------------------------------------------ */

/**
 * 候选排序：分数降序 → 发布时间降序 → contentId 降序。
 *
 * ⚠ 第三级（`contentId`）不是装饰：没有它，两条**同分同秒**的候选
 * 会依赖 `Array.prototype.sort` 的实现细节决定先后，而 V8 的排序虽然稳定，
 * 稳定性只保证「输入顺序相同则输出顺序相同」—— 而候选来自 SQL，
 * 没有 `ORDER BY` 覆盖到 contentId 时它自己的顺序也不保证。
 * 加上第三级之后，输出**只由内容本身决定**。
 *
 * `contentId` 按**数值**比较而不是字符串：两者都是确定性的，但
 * `'9' > '10'`（字符串）会让「id 更大 = 通常更新」这条直觉反过来，
 * 而排序规则一旦反直觉，下一个人改它时就容易改错。
 * 主键是 BIGINT，所以数值比较是安全的；非纯数字时退回字符串比较
 *（`contentId` 是 `BigIntId`，理论上永远是数字，这里只是不让它抛异常）。
 *
 * `finalScore` 为 `null`（还没评分）排最后：它没有依据排到前面，
 * 但也不该被丢掉（`docs/08`：低分不删除）。
 */
export function compareCandidates(a: DraftCandidate, b: DraftCandidate): number {
  const scoreA = a.finalScore ?? Number.NEGATIVE_INFINITY;
  const scoreB = b.finalScore ?? Number.NEGATIVE_INFINITY;
  if (scoreA !== scoreB) return scoreB - scoreA;

  if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;

  const numericA = /^\d+$/.test(a.contentId) ? BigInt(a.contentId) : null;
  const numericB = /^\d+$/.test(b.contentId) ? BigInt(b.contentId) : null;
  if (numericA !== null && numericB !== null) {
    if (numericA === numericB) return 0;
    return numericA < numericB ? 1 : -1;
  }

  if (a.contentId === b.contentId) return 0;
  return a.contentId < b.contentId ? 1 : -1;
}

/**
 * 按内容类型与关键词归类（确定性规则版的「section 建议」）。
 *
 * 顺序**重要**：先判最具体的（模型 / 产品 / 开发 / 硬件），
 * 特征都不命中才落到 `BRIEFS`。反过来写会让任何提到「发布」的
 * 内容都被归到 `PRODUCT`。
 *
 * ⚠ 中英双写而不是只写中文：`docs/00` 的目标读者看中文，
 * 但来源里大量是英文标题（`docs/05` 的 `contents.language` 可能是 `en`）。
 */
export function sectionForCandidate(candidate: DraftCandidate): DailySectionType {
  if (candidate.contentType === ContentType.X_POST) return DailySectionType.X_VOICES;
  // X 之外的短内容（`SHORT_POST`）没有正文可归类，直接进简讯。
  if (candidate.contentType === ContentType.SHORT_POST) return DailySectionType.BRIEFS;

  const text = `${candidate.title} ${candidate.summary ?? ''}`.toLowerCase();

  // 模型 / 训练 / 推理 —— AI 版块的核心。
  if (/(model|llm|gpt|claude|gemini|llama|qwen|推理|训练|模型|微调|fine-?tun)/.test(text)) {
    return DailySectionType.AI;
  }
  // 开发工具 / 开源 / 框架。
  if (/(github|release|sdk|api|framework|library|open-?source|开发者|开源|框架|编译)/.test(text)) {
    return DailySectionType.DEVELOPMENT;
  }
  // 硬件 / 基础设施。
  if (/(chip|gpu|cpu|datacenter|data cent|芯片|硬件|算力|数据中心|云)/.test(text)) {
    return DailySectionType.TECH;
  }
  // 产品 / 商业。
  if (/(product|pricing|launch|acquisi|funding|产品|发布|上线|定价|融资|收购)/.test(text)) {
    return DailySectionType.PRODUCT;
  }
  return DailySectionType.BRIEFS;
}

/**
 * 版块内的展示样式。
 *
 * ```text
 * FRONT_PAGE  [0] LEAD    其余 STANDARD
 * 其他版块     [0] MAJOR   [1..2] STANDARD   其余 BRIEF
 * ```
 *
 * `LEAD` 只可能在 `FRONT_PAGE[0]` 出现，因此「Lead 只有 1 条」（`docs/10`）
 * 由这个函数**结构性保证**，不依赖调用方自觉。
 */
export function displayStyleFor(sectionType: DailySectionType, index: number): DailyDisplayStyle {
  if (index === 0) {
    return sectionType === DailySectionType.FRONT_PAGE
      ? DailyDisplayStyle.LEAD
      : DailyDisplayStyle.MAJOR;
  }
  if (sectionType === DailySectionType.FRONT_PAGE) return DailyDisplayStyle.STANDARD;
  if (index <= 2) return DailyDisplayStyle.STANDARD;
  return DailyDisplayStyle.BRIEF;
}

/**
 * 来源多样性：单一来源的 `LEAD` + `MAJOR` 条目不超过 25%，超出者**降级为
 * `STANDARD`**（不是丢弃）。
 *
 * 为什么降级而不是丢弃：`docs/10` 把这一条列在「AI 草稿建议限制」下，
 * 并明确「管理员可覆盖」—— 它是**版位建议**，不是准入规则。
 * 丢弃会让一篇真实的高分内容从日报里消失，而降级只影响它的醒目程度。
 *
 * 为什么不降级 `LEAD`：`docs/10` 要求恰好 1 条 Lead，
 * 把它降下去会让草稿直接过不了发布前的 `LEAD_REQUIRED`。
 *
 * 上限用 `max(1, floor(majorCount * 0.25))`：主要条目少的时候
 * （例如只有 3 条）纯按比例会得到 0，那等于禁止任何来源拥有主要版位 ——
 * 显然不是这条规则的意思。
 */
export function applySourceDiversity(
  sections: CompiledSection[],
  sourceByContentId: ReadonlyMap<string, string>,
): DraftNote[] {
  const notes: DraftNote[] = [];

  // 收集所有 LEAD / MAJOR 条目（带它们所在的位置，便于就地改写）。
  const majorSlots: {
    section: number;
    item: number;
    sourceId: string;
    style: DailyDisplayStyle;
  }[] = [];
  sections.forEach((section, sectionIndex) => {
    section.items.forEach((item, itemIndex) => {
      if (
        item.displayStyle === DailyDisplayStyle.LEAD ||
        item.displayStyle === DailyDisplayStyle.MAJOR
      ) {
        majorSlots.push({
          section: sectionIndex,
          item: itemIndex,
          sourceId: sourceByContentId.get(item.contentId) ?? '',
          style: item.displayStyle,
        });
      }
    });
  });

  const cap = Math.max(1, Math.floor(majorSlots.length * MAJOR_SOURCE_SHARE));
  const used = new Map<string, number>();

  for (const slot of majorSlots) {
    // LEAD 永远不动（见函数头）。
    if (slot.style === DailyDisplayStyle.LEAD) {
      used.set(slot.sourceId, (used.get(slot.sourceId) ?? 0) + 1);
      continue;
    }

    const count = used.get(slot.sourceId) ?? 0;
    if (count >= cap) {
      const target = sections[slot.section]?.items[slot.item];
      if (target === undefined) continue;
      target.displayStyle = DailyDisplayStyle.STANDARD;
      notes.push({
        contentId: target.contentId,
        reason: DraftNoteReason.SOURCE_DIVERSITY_DEMOTED,
        detail: `source already holds ${String(count)} of ${String(cap)} major slots`,
      });
      continue;
    }
    used.set(slot.sourceId, count + 1);
  }

  return notes;
}
