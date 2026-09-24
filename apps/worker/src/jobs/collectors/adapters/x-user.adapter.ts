/**
 * X（Twitter）白名单账号采集器（`SourceType.X_USER`）。
 *
 * ── `docs/06` / `docs/00` 的强规则 ──────────────────────────────────
 * > 默认规则：保留原创 Post；可选 Quote Post；默认排除 Reply；默认排除纯 Repost。
 * > 只处理 Source Registry 中 `type=X_USER AND enabled=true`。
 * > **不要实现「用户订阅 X 账号」**（规则 §13）。
 *
 * 「只处理 enabled=true」在**调度器**那一层落实（`buildDueSourcesWhere`
 * 只取 enabled），本适配器只负责「抓一个账号的帖子并过滤」。
 *
 * ── 为什么必须自己再过滤一遍 ────────────────────────────────────────
 * X API v2 的 `exclude` 参数只接受 `retweets` / `replies` 两个值 ——
 * **没有**排除 quote 的选项。而且 `exclude` 是「请求侧」的，
 * 一旦上游行为变化（或将来换成别的取值组合），返回里就会混进不该有的东西。
 * 因此拿到数据后按 `referenced_tweets` 再判一遍：
 * 请求侧排除是**性能优化**，响应侧过滤才是**正确性保证**。
 *
 * ── ⚠ 令牌路径未做端到端验证 ───────────────────────────────────────
 * 本机 `api.x.com` 不可达，且 `X_API_BEARER_TOKEN` 未配置
 * （见 `work/_agent04/probe-upstreams.json` 的 `x-user` 项）。
 * 已验证的是「未配置时如实失败、且**完全不发请求**」，以及
 * 用真实现 + stub fetch 跑通的解析与过滤逻辑。
 * 真实令牌下的端到端表现需人工确认（见 HANDOFF）。
 */

import { ContentType, SourceType } from '@signal/contracts';
import { credentialsMissing, sourceConfigInvalid, toCollectorError } from '../errors';
import type { CollectorSource } from '../ports';
import type {
  CollectedItem,
  CollectorAdapter,
  CollectorBatch,
  CollectorContext,
  CollectorCursor,
} from '../types';
import { normalizeLanguageTag } from '../field-limits';
import { canonicalizeUrl } from '../url/canonical';
import { readConfigBoolean, readConfigString } from './config-read';
import { getJson } from './http';
import { asArray, asIdString, asNumber, asObject, asString, compactPayload } from './json';

/** X API v2。硬编码，管理员改不了。 */
export const X_API = 'https://api.x.com/2';

/** 单轮最多取多少条。X 的 `max_results` 允许范围是 5–100。 */
export const X_FETCH_MAX_RESULTS = 50;

/** `referenced_tweets[].type` 的三个取值。 */
type ReferenceType = 'retweeted' | 'quoted' | 'replied_to';

export class XUserCollectorAdapter implements CollectorAdapter {
  readonly type = SourceType.X_USER;

  async fetch(
    source: CollectorSource,
    cursor: CollectorCursor,
    context: CollectorContext,
  ): Promise<CollectorBatch> {
    // ⚠ 未配置令牌时**先抛，再出网** —— 绝不能发一个不带凭据的请求
    // 去撞 X 的风控，也不能返回「成功但 0 条」让后台以为一切正常。
    if (context.credentials.xApiBearerToken === null) {
      throw credentialsMissing(
        `X_USER source ${source.slug}: X_API_BEARER_TOKEN is not configured, ` +
          'so this account cannot be collected',
      );
    }

    const handle = readConfigString(source.config, 'handle') ?? source.externalId;
    if (handle === null) {
      throw sourceConfigInvalid(`X_USER source ${source.slug} has no config.handle`);
    }

    const includeQuotes = readConfigBoolean(source.config, 'includeQuotes', true);
    const includeReplies = readConfigBoolean(source.config, 'includeReplies', false);
    const includeReposts = readConfigBoolean(source.config, 'includeReposts', false);
    const what = `X source ${source.slug} (@${handle})`;

    try {
      const userId = await this.resolveUserId(handle, what, context);
      const tweets = await this.loadTweets(
        userId,
        cursor,
        includeReplies,
        includeReposts,
        what,
        context,
      );

      const items: CollectedItem[] = [];
      let skippedCount = 0;

      for (const raw of tweets) {
        const tweet = asObject(raw);
        if (tweet === null) continue;

        const kind = classify(tweet);
        if (kind === 'retweeted' && !includeReposts) continue;
        if (kind === 'replied_to' && !includeReplies) continue;
        if (kind === 'quoted' && !includeQuotes) continue;

        const item = toCollectedItem(source.id, handle, tweet, kind);
        if (item === null) {
          skippedCount += 1;
          continue;
        }
        items.push(item);
      }

      return { items, complete: true, skippedCount, warnings: [] };
    } catch (error) {
      throw toCollectorError(error, what);
    }
  }

  /**
   * handle → 数字 user id。
   *
   * `/users/:id/tweets` 需要数字 id，而 registry 里存的是 handle
   * （`docs/04` 的例子 `externalId: "karpathy"`）。多一次请求是必要的 ——
   * 硬编码 id 会让管理员改 handle 之后静默抓到**别人的**时间线。
   */
  private async resolveUserId(
    handle: string,
    what: string,
    context: CollectorContext,
  ): Promise<string> {
    const body = await getJson(
      {
        url: `${X_API}/users/by/username/${encodeURIComponent(handle)}`,
        headers: this.headers(context),
        maxBytes: 262_144,
        what: `${what} user lookup`,
      },
      context,
    );

    const id = asIdString(asObject(asObject(body)?.['data'])?.['id']);
    if (id === null) {
      throw sourceConfigInvalid(
        `${what}: X returned no user id for this handle (account may not exist or be suspended)`,
      );
    }
    return id;
  }

  private async loadTweets(
    userId: string,
    cursor: CollectorCursor,
    includeReplies: boolean,
    includeReposts: boolean,
    what: string,
    context: CollectorContext,
  ): Promise<unknown[]> {
    const params = new URLSearchParams({
      max_results: String(X_FETCH_MAX_RESULTS),
      'tweet.fields': 'created_at,lang,public_metrics,referenced_tweets,conversation_id',
    });

    // `exclude` 是性能优化，不是正确性保证 —— 正确性由响应侧过滤兜底（见文件头）。
    const exclude: string[] = [];
    if (!includeReplies) exclude.push('replies');
    if (!includeReposts) exclude.push('retweets');
    if (exclude.length > 0) params.set('exclude', exclude.join(','));

    // 增量：X 的 `since_id` 只返回比它更新的推文。
    // 只在游标看着像雪花 id 时才用 —— 一个非数字的 externalId
    // （比如管理员手工改过库）发出去会被 X 拒成 400。
    if (cursor.sinceExternalId !== null && /^\d+$/.test(cursor.sinceExternalId)) {
      params.set('since_id', cursor.sinceExternalId);
    }

    const body = await getJson(
      {
        url: `${X_API}/users/${userId}/tweets?${params.toString()}`,
        headers: this.headers(context),
        what,
      },
      context,
    );

    // `data` 缺失是**合法**的：X 对一个没有新推文的账号返回
    // `{ meta: {...} }` 而没有 `data` 字段（不是空数组）。
    // 把它当错误会让「这个账号今天没发推」变成一条采集失败。
    const data = asObject(body)?.['data'];
    return data === undefined || data === null ? [] : asArray(data);
  }

  private headers(context: CollectorContext): Record<string, string> {
    return {
      accept: 'application/json',
      'user-agent': 'signal-collector',
      // 令牌在 `fetch()` 入口已保证非 null（未配置时先抛错、根本不出网），
      // 所以不需要 `?? ''` —— 一个永远不成立的兜底会掩盖真实的断言。
      authorization: `Bearer ${context.credentials.xApiBearerToken ?? ''}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 分类与映射                                                           */
/* ------------------------------------------------------------------ */

/**
 * 判断一条推文属于哪一类。
 *
 * X 用 `referenced_tweets: [{ type, id }]` 表达引用关系，
 * 取值是 `retweeted` / `quoted` / `replied_to`。
 * 一条推文理论上只会有一种引用关系，但**不假设**这一点：
 * 三种都判、按 `retweet` → `reply` → `quote` 的优先级返回，
 * 这样即使上游给出组合（或未来新增类型），行为也是确定的、可测的。
 */
export function classify(tweet: Record<string, unknown>): ReferenceType | 'original' {
  const types = new Set(
    asArray(tweet['referenced_tweets'])
      .map((ref) => asString(asObject(ref)?.['type']))
      .filter((type): type is string => type !== null),
  );

  if (types.has('retweeted')) return 'retweeted';
  if (types.has('replied_to')) return 'replied_to';
  if (types.has('quoted')) return 'quoted';
  return 'original';
}

/**
 * 一条推文 → `CollectedItem`。
 *
 * `originalUrl` 用 `https://x.com/{handle}/status/{id}` 而不是 API 的
 * `https://api.x.com/2/tweets/{id}`：前者是用户能打开的原帖地址
 * （`docs/00`：前台必须能「跳转原 X」），后者是 API 表示。
 */
function toCollectedItem(
  sourceId: string,
  handle: string,
  tweet: Record<string, unknown>,
  kind: ReferenceType | 'original',
): CollectedItem | null {
  const id = asIdString(tweet['id']);
  if (id === null) return null;

  const authorHandle = asString(asObject(tweet['author'])?.['username']) ?? handle;
  const originalUrl = `https://x.com/${authorHandle}/status/${id}`;

  // 仍然走一遍归一化，保住「canonicalUrl 一定经过 canonicalizeUrl」这个不变式 ——
  // 否则将来有人照这个适配器写新适配器时，会以为「直接赋值也行」。
  const canonicalUrl = canonicalizeUrl(originalUrl);
  if (canonicalUrl === null) return null;

  const metrics = asObject(tweet['public_metrics']);
  const quotedId = asArray(tweet['referenced_tweets'])
    .map((ref) => asObject(ref))
    .find((ref) => asString(ref?.['type']) === 'quoted')?.['id'];

  return {
    sourceId,
    externalId: id,
    originalUrl,
    canonicalUrl,
    title: null,
    body: asString(tweet['text']),
    // ⚠ 必须过一遍收敛：`raw_items.language` 是 BCP-47 标签、列宽 `Char(5)`，
    // 而上游的 `lang` 可能更长（`zh-Hant` 等）→ 真库报「column too long」
    // → **整批 0 条入库**，症状只是「这个来源一直是空的」。
    // GitHub 那条路径已经接了同一个函数，X 这条曾经漏掉（且零测试覆盖）。
    language: normalizeLanguageTag(asString(tweet['lang'])),
    publishedAt: parseTweetDate(tweet['created_at']),
    author: authorHandle,
    type: ContentType.X_POST,
    payload: compactPayload({
      tweetId: id,
      // ⚠ 键名是 `postKind` 而**不是** `kind`：`kind` 与 Source 的
      // `SourceKind` 撞名，而「Source 元数据不得进 payload」的守卫
      // 曾经是键名黑名单 —— 于是每一条推文都在落库前被拦下，
      // `SourceType.X_USER` **整体不可用**（0 条入库）。
      // 现在守卫是按类型的白名单（见 `payload-keys.ts`），
      // 但这个更清晰的名字一并保留：同一个词表示两件事本身就是隐患。
      postKind: kind,
      conversationId: asString(tweet['conversation_id']),
      quotedTweetId: asIdString(quotedId),
      likeCount: asNumber(metrics?.['like_count']),
      replyCount: asNumber(metrics?.['reply_count']),
      repostCount: asNumber(metrics?.['retweet_count']),
      quoteCount: asNumber(metrics?.['quote_count']),
    }),
  };
}

function parseTweetDate(value: unknown): Date | null {
  const raw = asString(value);
  if (raw === null) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}
