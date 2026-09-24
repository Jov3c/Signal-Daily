/**
 * 外部输入 → 数据库列的收敛。
 *
 * ── 为什么必须有这一层（两个真缺陷的修复）──────────────────────────
 *
 * **① 一条坏条目会让整批失败、连正常条目一起丢。**
 * `raw_items` 的 `createMany` 是**单条多行 INSERT，全有或全无**。
 * 实测：3 条里只要有 1 条 `external_id` 超过 `VarChar(512)`，
 * 那一批**全部**不落库 —— 而且这个来源此后每一轮都失败（坏条目每轮都在）。
 * 症状只是「这个来源一直是空的」，与「这个源本来就没更新」无法区分。
 *
 * **② 「语言」有两个完全不同的含义。**
 * GitHub 的 `repo.language` 是**主编程语言名**（`JavaScript` 10 字符、
 * `Python` 6、`Jupyter Notebook` 16），而 `raw_items.language` 是
 * **BCP-47 语言标签**（`Char(5)`：`zh` / `en-US`）。
 * 把前者写进后者既语义错误、也必然写失败 —— 而
 * `GITHUB_REPO` + `includeReleases=false`（`docs/06` 支持的形态）
 * 会 100% 走到这条路径。
 *
 * 因此：**长度收敛与语义收敛都必须在写库之前完成**，
 * 而不是指望上游给出合规的值。上游是第三方，它不知道我们的列宽。
 *
 * ── 两种处理方式，选择依据是「截断后还有没有意义」──────────────────
 *   - **可截断**：`externalId`（是个 id，截断后仍是稳定标识）、
 *     标题（截断后仍是标题）；
 *   - **不可截断，只能丢弃并计数**：URL。截断一个 URL 会得到一个
 *     404 链接，而 `docs/00` 要求「任何公开内容必须可追溯到原始来源」——
 *     编一个假链接比丢掉这条更糟。
 */

/** `raw_items.external_id` 是 `VarChar(512)`（按**字符**计）。 */
export const EXTERNAL_ID_MAX_CHARS = 512;

/** `raw_items.original_url` / `canonical_url` 是 `VarChar(2048)`。 */
export const URL_MAX_CHARS = 2048;

/**
 * `raw_items.title_raw` 是 `Text`：**65535 字节**（不是字符）。
 *
 * ⚠ 必须按字节算：一个中文字是 3 字节、一个 emoji 是 4 字节，
 * 按字符算会在中文内容上超出 3~4 倍。留 1KB 余量。
 */
export const TITLE_MAX_BYTES = 64_000;

/** 语言标签：BCP-47 的形状，且不超过列宽 5。 */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/;
export const LANGUAGE_MAX_CHARS = 5;

/** 按 UTF-8 **字节**截断，且不切断字符。 */
export function clampToBytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;

  // 二分找到「编码后不超过上限」的最长前缀，避免逐字符重编码。
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, mid)).length <= maxBytes) low = mid;
    else high = mid - 1;
  }

  // ⚠ 二分可能正好切在一个**代理对中间**：`TextEncoder` 会把孤立的代理项
  // 编码成 `U+FFFD`（3 字节而不是 4），于是二分「以为」这个前缀没超限。
  // 结果是标题末尾留下半个 emoji（写库后变成 `\uFFFD`）。
  // 去掉结尾的孤立代理项即可 —— 只可能多切一个字。
  const last = value.charCodeAt(low - 1);
  if (low > 0 && last >= 0xd800 && last <= 0xdbff) low -= 1;

  return value.slice(0, low);
}

/** 按字符数截断（用于 `VarChar` 列，MySQL 的 VARCHAR 按字符计）。 */
export function clampToChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

/**
 * 语言标签收敛。
 *
 * 三件事：去空白、只接受 BCP-47 形状、长度不超过列宽。
 * 取不到合规值就返回 `null` —— 让 Pipeline 的 `LANGUAGE_DETECT` 去补，
 * 而不是把一个「JavaScript」这样的**编程语言名**写进语言列。
 */
export function normalizeLanguageTag(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > LANGUAGE_MAX_CHARS) return null;
  return LANGUAGE_TAG.test(trimmed) ? trimmed : null;
}

/** 一条条目的字段收敛结果。 */
export type FittedItem = {
  externalId: string | null;
  originalUrl: string;
  canonicalUrl: string;
  title: string | null;
  /** 因为 URL 不可用（过长 / 非绝对地址）而被丢弃。 */
  dropped: boolean;
  /** 被截断的字段名（非空表示这条数据不是原样入库的）。 */
  truncated: string[];
};

/** URL 是否可以安全入库。 */
export function isStorableUrl(value: string): boolean {
  return value.length > 0 && value.length <= URL_MAX_CHARS && /^https?:\/\//.test(value);
}

/**
 * 把一条 `CollectedItem` 的字段收敛到列宽以内。
 *
 * `canonicalUrlHash` 由**收敛后**的 `canonicalUrl` 计算 —— 顺序很重要：
 * 先算 hash 再截断 URL 会让「hash 对应的 URL」与「库里的 URL」不是同一个，
 * 于是去重在边界上失效（两个不同的长 URL 截断后相同、但 hash 不同）。
 * 这个顺序由 `collector.service.ts` 保证。
 */
export function fitItemToColumns(item: {
  externalId: string | null;
  originalUrl: string;
  canonicalUrl: string;
  title: string | null;
}): FittedItem {
  const truncated: string[] = [];

  if (!isStorableUrl(item.canonicalUrl) || !isStorableUrl(item.originalUrl)) {
    return {
      externalId: null,
      originalUrl: '',
      canonicalUrl: '',
      title: null,
      dropped: true,
      truncated,
    };
  }

  const externalId =
    item.externalId === null ? null : clampToChars(item.externalId, EXTERNAL_ID_MAX_CHARS);
  if (externalId !== item.externalId) truncated.push('externalId');

  const title = item.title === null ? null : clampToBytes(item.title, TITLE_MAX_BYTES);
  if (title !== item.title) truncated.push('title');

  return {
    externalId,
    originalUrl: item.originalUrl,
    canonicalUrl: item.canonicalUrl,
    title,
    dropped: false,
    truncated,
  };
}
