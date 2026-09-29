/**
 * Exact Dedup —— `docs/06` 的三条幂等键里的第 ③ 条（`content_hash`）。
 *
 * ── 三条幂等键的分工（`docs/06`）────────────────────────────────────
 * | # | 键 | 谁负责 | 抓什么 |
 * | - | -- | ------ | ------ |
 * | ① | `(source_id, external_id)` | 采集端（落库前拦截） | 同一个来源重复抓同一条 |
 * | ② | `canonical_url_hash` | 采集端（落库前拦截） | 同一篇文章换了 URL 参数/短链 |
 * | ③ | `content_hash` | **本模块** | 同一份内容从**不同来源**出现（转载、镜像） |
 *
 * 采集端对 ③ **只计算、不拦截**（Agent 04 的交接第 ② 条）：
 * 同一篇文章换了标题、或正文被上游修订，都应作为新事实入库 ——
 * 「它们算不算同一篇」是 Pipeline 的判断。
 *
 * ── 为什么用「原始 content_hash」而不是自算一个「归一化 hash」────────
 * `docs/06` 的措辞是「normalized content hash」，但**采集端算的那个
 * `RawItem.contentHash` 是对原始 title + body 求的**（`contentHashOf(fitted.title, item.body)`）。
 * 我没有另算一个归一化 hash 来「更符合文档字面」，理由有三条：
 *
 * 1. **没有地方存它** —— `contents` 表没有 hash 列，而加列属 Agent 01（§10）。
 *    每次判重都自算一遍意味着要**扫描候选内容并逐个重算**，成本随库增长；
 * 2. **`raw_items.content_hash` 已经有索引**（Agent 01 建的 `@@index([contentHash])`），
 *    用它判重是一次索引查询；
 * 3. **语义上它恰好是 Exact 的正确判据** —— ①②已经挡掉了「同源重抓」与
 *    「同 URL 换参数」，「字节完全相同地从不同来源出现」正是精确重复的定义。
 *    至于「换了个标题/排版但其实是同一篇」，那是 **Near Dedup**（S3）的职责，
 *    不是 Exact 的 —— 把两件事混在一起会让 Exact 变得又慢又不准。
 *
 * ⚠ 已记入 HANDOFF：若将来要做「同一篇内容的多种转载归并」，
 * 那属于 Near Dedup；若确实需要持久化归一化 hash，走 CCR 加列。
 *
 * ── 为什么在 Content 落库**之前**判 ────────────────────────────────
 * `docs/07` 的流程图把 Exact Dedup 画在 Normalize 之后，字面上也可以理解成
 * 「先建 Content，再判重、再标记/归档」。我选择**在落库之前判**：
 *
 * - 先建再归档会在库里留下一条永远不该被展示的 Content
 *   （而 `contents` 上**没有**「我是一条重复」的列，也没有指向正本的指针）；
 * - 判重所需的一切（`contentHash`）在 Normalize 完成后就已经有了，
 *   不需要先落库才能判。
 *
 * 结果是：**同一份内容在库里恰好一行**，被判定为重复的那条只留下
 * `raw_items.status = DUPLICATE`（原始事实仍然可追溯，符合 `docs/00`
 * 「系统内部可保存原文用于处理」）。
 */

/** 一个用于比较的候选（库里已经存在的 Content）。 */
export type DedupCandidate = {
  contentId: string;
  rawItemId: string;
  contentHash: string | null;
  sourceId: string;
  createdAt: Date;
};

/** 待判定的对象。 */
export type DedupProbe = {
  rawItemId: string;
  contentHash: string | null;
};

export type ExactDuplicateVerdict =
  | { duplicate: false; reason: 'no-hash' | 'no-candidate' }
  | {
      duplicate: true;
      reason: 'same-content-hash';
      /** 正本（最早入库的那一条）。 */
      canonicalContentId: string;
      canonicalRawItemId: string;
      /** 与正本是否来自同一个 Source —— 用于统计「同源/跨源重复」。 */
      sameSource: boolean;
    };

/**
 * 判定 `probe` 是不是某条已存在 Content 的精确重复。
 *
 * 规则：
 * - 双方都必须有非空 `contentHash`（没有就没法判「精确」，**不猜**）；
 * - hash 必须完全相同；
 * - **不能与自己比较**（`rawItemId` 相同的一律跳过）；
 * - 正本取 **`createdAt` 最早**的那条；时间相同则取 `rawItemId` 最小的 ——
 *   用 BIGINT 数值比较而不是字典序（`'10' < '9'` 是字典序陷阱）。
 */
export function pickExactDuplicate(
  probe: DedupProbe,
  candidates: readonly DedupCandidate[],
  probeSourceId: string,
): ExactDuplicateVerdict {
  const hash = probe.contentHash;
  if (hash === null || hash === '') return { duplicate: false, reason: 'no-hash' };

  const matches = candidates.filter(
    (candidate) =>
      candidate.rawItemId !== probe.rawItemId &&
      candidate.contentHash !== null &&
      candidate.contentHash === hash,
  );
  if (matches.length === 0) return { duplicate: false, reason: 'no-candidate' };

  const canonical = matches.reduce((earliest, candidate) =>
    isEarlier(candidate, earliest) ? candidate : earliest,
  );

  return {
    duplicate: true,
    reason: 'same-content-hash',
    canonicalContentId: canonical.contentId,
    canonicalRawItemId: canonical.rawItemId,
    sameSource: canonical.sourceId === probeSourceId,
  };
}

/** `a` 是否比 `b` 更早（正本优先）。 */
function isEarlier(a: DedupCandidate, b: DedupCandidate): boolean {
  const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff < 0;
  return compareBigIntStrings(a.rawItemId, b.rawItemId) < 0;
}

/**
 * 按**数值**比较两个十进制 id 字符串（字典序下 `'10' < '9'` 是错的）。
 *
 * ⚠ 这只是**平局的决胜规则**，不是「脏 id 排除规则」：
 * `isEarlier()` 先比 `createdAt`，**只有时间完全相同**才会走到这里。
 * 所以一条 id 畸形的记录**仍然可能成为正本**（当它入库最早时）——
 * 这是刻意的：id 解不解析得出来，不影响「谁先入库」这个事实。
 *
 * 这里只保证一件事：**时间相同时比较结果是确定的**，不会因为
 * 「BigInt 解析失败就退回字典序」而给出一个看似确定、实则与数值序相反的答案。
 */
function compareBigIntStrings(a: string, b: string): number {
  if (a === b) return 0;
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    if (left === right) return 0;
    return left < right ? -1 : 1;
  } catch {
    // 至少一方不是十进制数字串：无法做数值比较。
    // 退回字符串比较只是为了**确定性**（同一对输入永远给出同一个结论），
    // 不声称它符合数值直觉。
    return a < b ? -1 : 1;
  }
}
