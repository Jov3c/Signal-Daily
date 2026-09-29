/**
 * Near Dedup 的相似度计算。
 *
 * ── 中文是这里的核心难点 ────────────────────────────────────────────
 * Signal 的正文是中文（`docs/12` 的检索列就叫 `body_translated`），
 * 而**中文没有空格**：按空白切词会得到「一整篇文章」作为一个 token，
 * 于任何两篇中文文章要么完全相同、要么相似度为 0。
 *
 * 本模块用 **字符二元组（bigram shingle）**：
 *
 * ```text
 * 「推理成本下降」 → {推理, 理成, 成本, 本下, 下降}
 * ```
 *
 * 这是中文近似判重的常规做法，且**不需要分词器**（词表、模型都是额外的
 * 依赖与维护成本，而 V1 明确不上向量库）。拉丁文则按单词切（`AI` / `GPT-4`
 * 这类术语按词比对才有意义），两种 shingle 混在同一个集合里。
 *
 * ── 为什么是 Jaccard 而不是余弦 ─────────────────────────────────────
 * Jaccard（交集/并集）对「一篇长文包含一篇短文」这种包含关系不敏感
 *（会被判成不相似），而余弦更宽容。这里的用途是**找出「同一件事的不同报道」**，
 * 两篇的长度差通常不大，Jaccard 更简单、可解释、无需向量化。
 * 阈值取 0.6 —— 见 `DEFAULT_SIMILARITY_THRESHOLD` 的说明。
 *
 * ── 成本边界（这是 V1 的已知限制）──────────────────────────────────
 * 计算是 O(候选数 × shingle 数)。因此调用方**必须**限定候选窗口
 *（时间窗 + 条数上限），不能拿全库来比。见 `NEAR_DUP_CANDIDATE_WINDOW_DAYS`。
 * 真正的规模化方案是 MinHash/LSH 或向量检索 —— V1 明确不做
 *（`docs/07`：「V1 不因为 Evidence 引入向量数据库」），已记入 HANDOFF。
 */

/**
 * 默认相似度阈值。
 *
 * ── 这个数字是**实测**出来的，不是拍的 ──────────────────────────────
 * 第一版我拍了 0.6（「挺像的才算」的直觉），然后用真实中文语料一测：
 *
 * ```text
 * 同一事件、不同措辞的两篇中文报道   Jaccard ≈ 0.45   ← 0.6 会把它漏掉
 * 两篇毫不相关的中文报道             Jaccard < 0.2
 * ```
 *
 * 0.6 会让**绝大多数真正该被找出来的近似重复直接漏网** ——
 * 而漏报正是近似判重最不该犯的错。
 *
 * 取 **0.35**：离实测的「同一事件 0.45」留 0.10 余量，
 * 离「无关 < 0.2」留 0.15 余量，两侧都不贴边。
 *
 * ── ⚠ 这是启发式，别把它当精确科学 ────────────────────────────────
 * 固定阈值 + 中文 bigram 的 Jaccard 是一个**粗筛**：
 *
 * - 文章越长，「同一事件不同措辞」的重叠越低（各自独有细节多），
 *   这个阈值在长文上会偏严；
 * - 极短文本（一条 X 帖）的 shingle 集合很小，偶然重合的概率偏高，
 *   这个阈值在短文上会偏松。
 *
 * 之所以可以接受：**Near Dedup 只产出候选，不做任何删除或标记**，
 * 最终「它们是不是同一个事件」由 Event Cluster（S4）决定。
 * 粗筛漏一点、松一点，代价是 S4 多做几次比较；
 * 而在这里做不可逆的判断（删内容 / 标重复），代价是丢证据。
 *
 * 上真实数据后应当按 precision/recall 重新校准 —— 已记入 HANDOFF。
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.35;

/**
 * 候选窗口（天）。
 *
 * 只和最近 N 天内的内容比「是不是同一件事」——
 * 同一事件的报道几乎都在几天内出现，而拿全库比既慢又没意义
 *（半年前的一篇相似文章不代表同一个事件）。
 */
export const NEAR_DUP_CANDIDATE_WINDOW_DAYS = 7;

/**
 * 单个文本最多取多少个 shingle。
 *
 * 超长正文会产生数千个 bigram，而边际信息量递减。
 * 取前 N 个（**按出现顺序**，不是随机采样 —— 保持确定性，
 * 同一篇文章每次算出同一个指纹）。
 */
export const MAX_SHINGLES_PER_DOCUMENT = 2_000;

/** 一个文档的相似度指纹。 */
export type SimilarityFingerprint = {
  shingles: ReadonlySet<string>;
  /** shingle 总数（用于诊断「是不是文章太短，指纹不可靠」）。 */
  size: number;
};

/** CJK 统一表意文字（含扩展 A）与常见中日韩标点。 */
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

/** 拉丁单词（含数字、连字符、下划线，覆盖 `GPT-4` / `gpt_4` 这类术语）。 */
const LATIN_WORD = /[a-z0-9][a-z0-9_-]*/g;

/**
 * 把一个字符归一化成「比较用」的形态。
 *
 * - 全角转半角（中文正文里全角标点、全角字母很常见，不归一化会让
 *   「ＡＩ」与「AI」算成两个不同的 token）；
 * - 大小写统一（`AI` 与 `ai` 是同一个词）；
 * - 去掉变音符号之类不做处理 —— 中文场景用不到，且会引入额外依赖。
 */
function normalizeChar(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  // 全角 ASCII（U+FF01–U+FF5E）→ 半角
  if (code >= 0xff01 && code <= 0xff5e) {
    return String.fromCodePoint(code - 0xfee0).toLowerCase();
  }
  // 全角空格
  if (code === 0x3000) return ' ';
  return char.toLowerCase();
}

/**
 * 计算文本的相似度指纹。
 *
 * 规则：
 * - **CJK 字符**：按字符二元组（相邻两字）—— 中文没有空格，这是唯一的切分方式；
 * - **拉丁词**：按词；
 * - 标点、空白、emoji 一律作为分隔符（不参与比较）。
 *
 * ⚠ 极短文本（少于 2 个 CJK 字且没有拉丁词）会得到空指纹 ——
 * 调用方应当把空指纹当作「无法比较」而不是「与谁都相似度为 0」。
 * 把「无法比较」和「不相似」混为一谈，会让短标题的条目被误判。
 */
export function fingerprint(text: string | null): SimilarityFingerprint {
  const shingles = new Set<string>();
  if (text === null || text === '') return { shingles, size: 0 };

  const normalized = Array.from(text, normalizeChar).join('');

  // 1) 拉丁词
  for (const match of normalized.matchAll(LATIN_WORD)) {
    shingles.add(`w:${match[0]}`);
    if (shingles.size >= MAX_SHINGLES_PER_DOCUMENT) return { shingles, size: shingles.size };
  }

  // 2) CJK 二元组：只对**连续的** CJK 串取 bigram
  //    （跨越标点的两字不是词，`模型。推理` 不该产生 `型推`）
  let run: string[] = [];
  const flushRun = (): void => {
    for (let index = 0; index + 1 < run.length; index += 1) {
      shingles.add(`c:${run[index]}${run[index + 1]}`);
      if (shingles.size >= MAX_SHINGLES_PER_DOCUMENT) return;
    }
    run = [];
  };

  for (const char of normalized) {
    if (CJK.test(char)) {
      run.push(char);
      continue;
    }
    flushRun();
    run = [];
    if (shingles.size >= MAX_SHINGLES_PER_DOCUMENT) break;
  }
  flushRun();

  return { shingles, size: shingles.size };
}

/**
 * Jaccard 相似度。
 *
 * @returns 0–1；**任一方指纹为空时返回 `null`**（表示「无法比较」，
 *          而不是「不相似」—— 见 `fingerprint` 的说明）
 */
export function jaccard(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number | null {
  if (a.size === 0 || b.size === 0) return null;

  // 遍历较小的那个集合，减少查找次数。
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const item of small) {
    if (large.has(item)) intersection += 1;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? null : intersection / union;
}

/** 一个候选文档（比较用）。 */
export type SimilarityCandidate = {
  contentId: string;
  sourceId: string;
  /** 用于比较的文本（标题 + 正文的纯文本）。 */
  text: string | null;
};

/** 判定结果。 */
export type NearDuplicateMatch = {
  contentId: string;
  sourceId: string;
  /** Jaccard 相似度 0–1。 */
  score: number;
  /** 是否来自同一个 Source（同源近似重复的意义与跨源不同）。 */
  sameSource: boolean;
};

export type NearDuplicateVerdict = {
  /** 超过阈值且**来自不同 Source** 的匹配，按相似度降序。 */
  crossSourceMatches: NearDuplicateMatch[];
  /** 超过阈值且来自同一 Source 的匹配（通常是同源的重复发布）。 */
  sameSourceMatches: NearDuplicateMatch[];
  /** 参与比较的候选数（指纹非空、且不是自己）。 */
  comparedCount: number;
};

/**
 * 找出与 `probe` 近似的内容。
 *
 * 结果**按来源是否相同分两组**：跨源相似意味着「同一个事件被不同媒体报道」，
 * 那是 `docs/22` 里**有价值**的独立来源；同源相似多半是重复发布。
 * 把两者混在一起会让「独立来源数」失去意义。
 *
 * ⚠ 本函数**不做任何删除或标记** —— 同一事件的多来源报道是
 * Evidence 的基础（`docs/22`），不是要被消掉的噪声。
 * Event Cluster（S4）才是决定「它们属于同一个事件」的地方。
 */
export function findNearDuplicates(
  probe: { contentId: string; sourceId: string; text: string | null },
  candidates: readonly SimilarityCandidate[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): NearDuplicateVerdict {
  const probeFingerprint = fingerprint(probe.text);

  const crossSourceMatches: NearDuplicateMatch[] = [];
  const sameSourceMatches: NearDuplicateMatch[] = [];
  let comparedCount = 0;

  for (const candidate of candidates) {
    if (candidate.contentId === probe.contentId) continue;

    const score = jaccard(probeFingerprint.shingles, fingerprint(candidate.text).shingles);
    // `null` = 任一方指纹为空 = 无法比较。**不当作 0**，也不计入 comparedCount。
    if (score === null) continue;

    comparedCount += 1;
    if (score < threshold) continue;

    const match: NearDuplicateMatch = {
      contentId: candidate.contentId,
      sourceId: candidate.sourceId,
      score: Math.round(score * 1_000) / 1_000,
      sameSource: candidate.sourceId === probe.sourceId,
    };
    (match.sameSource ? sameSourceMatches : crossSourceMatches).push(match);
  }

  const byScoreDesc = (a: NearDuplicateMatch, b: NearDuplicateMatch): number => b.score - a.score;
  return {
    crossSourceMatches: crossSourceMatches.sort(byScoreDesc),
    sameSourceMatches: sameSourceMatches.sort(byScoreDesc),
    comparedCount,
  };
}
