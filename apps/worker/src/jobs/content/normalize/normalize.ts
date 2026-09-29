/**
 * Normalize —— `RawItem`（外部原始抓取事实）→ `Content`（可编辑的标准内容实体）。
 *
 * `docs/07` 的流水线第一站，也是**唯一**做「清洗 + 提取 + 类型判定」的地方。
 *
 * ── 为什么这一步是纯函数 ────────────────────────────────────────────
 * 整条流水线里最容易出错的判断（HTML 清洗、正文提取、标题回退、类型推导）
 * 全都集中在这里，而它们**不依赖数据库、不依赖网络、不需要 AI**。
 * 做成纯函数意味着：可以用真实形态的输入直接测，不需要起 MySQL；
 * 而副作用（落库、状态推进）留给 service，那一层的测试可以用替身。
 *
 * ── 输入侧的两个约定（来自 Agent 04 的交接）──────────────────────────
 * 1. `bodyRaw` **可能是一整张网页**（MANUAL_URL），也可能已经是片段
 *    （RSS 的 `content:encoded`）—— 提取逻辑必须同时应付两种；
 * 2. `titleRaw` 是**纯文本**（采集端去过标签、解过实体），但**不保证干净**：
 *    Agent 04 的 `toPlainTitle` 明确保留三种残留（双重编码 / 未闭合标签 /
 *    零散 `<`）。所以这里仍然要过一遍清洗，而不是直接当标题用。
 */

import { ContentPipelineStatus, DomainErrorCode, type ContentType, type SourceType } from '@signal/contracts';
import { extractArticleBody } from '../html/extract';
import { htmlToPlainText } from '../html/plain-text';
import { hasSubstantiveContent, sanitizeArticleHtml } from '../html/sanitize';
import { deriveContentType } from './content-type';

/** `contents.title` 是 `VarChar(700)` —— MySQL 的 700 是**字符**不是字节。 */
export const CONTENT_TITLE_MAX_CHARS = 700;

/** `contents.original_url` 是 `VarChar(2048)`。 */
export const CONTENT_URL_MAX_CHARS = 2048;

/**
 * 语言未知时的落值。
 *
 * `contents.language` 是 `NOT NULL Char(5)`，所以必须有值。
 * 用 ISO 639-3 的 `und`（undetermined）而不是猜一个 `en`/`zh`：
 * **猜错比留空更糟** —— 语言会进前台筛选，一个错误的标签会让读者
 * 在「中文」里看到英文文章，而且没人会去查。
 *
 * Agent 04 明确交接：GitHub 来源的 `raw_items.language` 会是 `null`
 *（`repo.language` 是编程语言名，不是 BCP-47 标签），由 `LANGUAGE_DETECT` 补。
 */
export const CONTENT_LANGUAGE_FALLBACK = 'und';

/** 从正文首段回退生成标题时，最多取多少字符。 */
const TITLE_FALLBACK_MAX_CHARS = 200;

/** Normalize 的输入（`RawItem` + 它所属 Source 的必要属性）。 */
export type NormalizeInput = {
  rawItemId: string;
  sourceId: string;
  sourceType: SourceType;
  payload: Record<string, unknown> | null;
  externalId: string | null;
  originalUrl: string;
  titleRaw: string | null;
  bodyRaw: string | null;
  language: string | null;
  publishedAt: Date | null;
};

/** 可以写入 `contents` 的一组值。 */
export type NormalizedContent = {
  sourceId: string;
  rawItemId: string;
  type: ContentType;
  title: string;
  bodyOriginal: string | null;
  language: string;
  originalUrl: string;
  imageUrl: string | null;
  publishedAt: Date | null;
  pipelineStatus: ContentPipelineStatus;
  /** 正文命中的容器 —— 供统计与排查（不落库）。 */
  bodySource: 'article' | 'main' | 'body' | 'fragment' | 'none';
};

export type NormalizeResult =
  | { ok: true; content: NormalizedContent }
  | { ok: false; code: string; reason: string };

/** 截断到 N 个**字符**（不是字节）—— 对齐 `VarChar(700)` 的语义。 */
function truncateChars(value: string, max: number): string {
  // 用 Array.from 按码点切，避免把代理对（emoji）劈成孤立代理项。
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join('');
}

/**
 * 生成标题。
 *
 * 三级回退：
 * 1. `titleRaw`（采集端已经去过标签、解过实体）；
 * 2. 标题为空时，**从正文首段回退**（Hacker News 的 self post、
 *    X 的纯文本帖都可能没有独立标题）；
 * 3. 都没有 → `null`（由调用方判定为 `CONTENT_EMPTY`）。
 */
function deriveTitle(titleRaw: string | null, bodyPlainText: string | null): string | null {
  const cleanedTitle = sanitizeArticleHtml(titleRaw) ?? titleRaw ?? '';
  const plainTitle = htmlToPlainText(cleanedTitle)?.trim() ?? '';
  if (plainTitle !== '') return truncateChars(plainTitle, CONTENT_TITLE_MAX_CHARS);

  if (bodyPlainText === null) return null;
  const firstLine = bodyPlainText.split('\n').find((line) => line.trim() !== '') ?? '';
  const fallback = firstLine.trim();
  if (fallback === '') return null;
  return truncateChars(fallback, TITLE_FALLBACK_MAX_CHARS);
}

/**
 * 取正文里的第一张图片，作为列表页的缩略图。
 *
 * 只看**清洗之后**的 HTML：清洗已经把 `data:` 图片、非 http(s) scheme
 * 与不可信属性挡在外面，所以这里取到的 `src` 一定是安全的。
 * 取不到就 `null`（不猜、不从 payload 里翻一个来路不明的字段）。
 */
function deriveImageUrl(sanitizedBody: string | null): string | null {
  if (sanitizedBody === null) return null;
  const match = /<img\s[^>]*src="([^"]+)"/i.exec(sanitizedBody);
  const src = match?.[1]?.trim();
  return src === undefined || src === '' ? null : src;
}

/**
 * 把一条原始事实归一成可编辑的内容。
 *
 * **不做任何 I/O** —— 调用方负责读 RawItem / Source、写 Content、推进状态。
 */
export function normalizeRawItem(input: NormalizeInput): NormalizeResult {
  // 1) 正文：先提取区域（整页 → 文章），再清洗（docs/14）。
  const extracted =
    input.bodyRaw === null || input.bodyRaw.trim() === ''
      ? ({ html: '', container: 'none' } as const)
      : extractArticleBody(input.bodyRaw);

  const bodyOriginal = sanitizeArticleHtml(extracted.html);
  const bodyPlainText = htmlToPlainText(bodyOriginal);

  // 2) 标题：优先用来源给的，缺失时从正文回退。
  const title = deriveTitle(input.titleRaw, bodyPlainText);

  // 3) 两者皆空 → 这条事实没有可展示的内容，如实失败（不静默丢弃）。
  if (title === null && !hasSubstantiveContent(bodyOriginal)) {
    return {
      ok: false,
      code: DomainErrorCode.CONTENT_EMPTY,
      reason: 'cleaned title and body are both empty',
    };
  }

  // 4) 其余字段：能直接搬的直接搬，需要收敛的收敛。
  return {
    ok: true,
    content: {
      sourceId: input.sourceId,
      rawItemId: input.rawItemId,
      type: deriveContentType(input.sourceType, input.payload),
      // title 为 null 但正文有内容时，用正文首段兜底过了；
      // 走到这里若仍为 null（正文只有图片），给一个来自 URL 的占位标题。
      title: title ?? placeholderTitle(input.originalUrl),
      bodyOriginal,
      language: input.language ?? CONTENT_LANGUAGE_FALLBACK,
      originalUrl: truncateChars(input.originalUrl, CONTENT_URL_MAX_CHARS),
      imageUrl: deriveImageUrl(bodyOriginal),
      publishedAt: input.publishedAt,
      pipelineStatus: ContentPipelineStatus.INGESTED,
      bodySource: bodyOriginal === null ? 'none' : extracted.container,
    },
  };
}

/**
 * 纯图片内容的占位标题。
 *
 * `contents.title` 是 `NOT NULL`，而一条只有图片的 X 帖确实没有文字标题。
 * 用 URL 的最后一段而不是写死「无标题」：前者能让人认出是哪一条，
 * 后者会让后台出现一堆无法区分的同名条目。
 */
function placeholderTitle(originalUrl: string): string {
  const tail = originalUrl.split('/').filter((part) => part !== '').pop() ?? originalUrl;
  return truncateChars(tail, CONTENT_TITLE_MAX_CHARS);
}
