/**
 * RSS / Atom / RSS 1.0 采集器。
 *
 * ── 这个适配器覆盖的三种格式 ────────────────────────────────────────
 * `docs/00` 把「RSS / Atom」和「AI / 科技官方 Blog」分开列，但技术上
 * 官方 Blog 用的就是 RSS 或 Atom（实测：GitHub Blog 是 RSS 2.0，
 * Simon Willison 是 Atom 1.0），所以是同一个适配器。
 *
 * ── feed 的权威地址在列上，不在 config 里 ───────────────────────────
 * `sources.feed_url` 是权威位置（`docs/03` 就是这么建的表，Agent 03 的
 * config 校验也明确「`feedUrl` 只作为输入别名被接受、然后提升到列里，
 * 绝不会同时留在 config」）。所以这里读 `feedUrl ?? baseUrl` ——
 * 与 Agent 03 的 `test` 端点探的是**同一个**地址，两边不会分叉。
 */

import { ContentType, SourceType } from '@signal/contracts';
import { DEFAULT_RSS_MAX_ITEMS, MAX_RSS_MAX_ITEMS, MIN_RSS_MAX_ITEMS } from '@signal/source-core';
import { sourceConfigInvalid, toCollectorError } from '../errors';
import { parseFeed, type FeedEntry, type ParsedFeed } from '../feed/parse-feed';
import type { CollectorSource } from '../ports';
import type {
  CollectedItem,
  CollectorAdapter,
  CollectorBatch,
  CollectorContext,
  CollectorCursor,
} from '../types';
import { canonicalizeUrl, resolveItemUrl } from '../url/canonical';
import { getText } from './http';

/**
 * 单轮最多**读取**多少条（不是入库多少 —— 入库由 `roundLimit` 控制）。
 *
 * 取 `MAX_RSS_MAX_ITEMS`（= Agent 03 的 config 契约里 `maxItems` 的上限 500）：
 * 一份列了几千条的 feed 不值得整份解析，而 500 条的解析代价可以忽略。
 */
export const RSS_HARD_CEILING = MAX_RSS_MAX_ITEMS;

export class RssCollectorAdapter implements CollectorAdapter {
  readonly type = SourceType.RSS;

  async fetch(
    source: CollectorSource,
    // 刻意**不使用**游标：RSS 的窗口是 feed 顺序，与 `publishedAt` 无关 ——
    // 拿时间做增量过滤会让被 `maxItems` 截断掉的旧条目永久失去被采集的机会。
    _cursor: CollectorCursor,
    context: CollectorContext,
  ): Promise<CollectorBatch> {
    const feedUrl = source.feedUrl ?? source.baseUrl;
    if (feedUrl === null) {
      throw sourceConfigInvalid(`RSS source ${source.slug} has neither feedUrl nor baseUrl`);
    }

    const what = `RSS source ${source.slug}`;
    const feed = await this.loadFeed(feedUrl, what, context);

    const maxItems = readMaxItems(source.config);
    const items: CollectedItem[] = [];
    let skippedCount = 0;

    // ⚠ **这里不按 maxItems 截断** —— 上限交给 service 在去重之后施加，
    // 否则窗口永远停在最新的 N 条、更旧的条目永久采不到（见 types.ts 的
    // `roundLimit` 说明）。这里只用一个**硬上限**挡住病态 feed
    // （例如一份列了 10 万条的 feed）：解析 500 条的代价可以忽略，
    // 因为它已经在内存里了。
    for (const entry of feed.entries.slice(0, RSS_HARD_CEILING)) {
      const item = toCollectedItem(source.id, entry, feed);
      if (item === null) {
        // 既没有 link 也没有可用的 guid —— 追溯不到原始来源。
        // `docs/00`：「任何公开内容必须可追溯到原始来源」，所以跳过而不是编一个。
        skippedCount += 1;
        continue;
      }
      items.push(item);
    }

    // `complete` 的含义是「**上游这一次能给的，我都读进来了**」。
    // 真正的截断发生在 service 的去重之后（`roundLimit`），
    // 那里会记一条可行动的日志（还有多少条留到下一轮）。
    const hitHardCeiling = feed.entries.length > RSS_HARD_CEILING;
    return {
      items,
      roundLimit: maxItems,
      complete: !hitHardCeiling,
      skippedCount,
      warnings: hitHardCeiling
        ? [
            ...feed.warnings,
            `feed offered ${feed.entries.length} entries; only the newest ` +
              `${RSS_HARD_CEILING} were read this round`,
          ]
        : feed.warnings,
    };
  }

  /** 取回并解析 feed。所有底层错误在这里收敛成 `CollectorError`。 */
  private async loadFeed(
    feedUrl: string,
    what: string,
    context: CollectorContext,
  ): Promise<ParsedFeed & { finalUrl: string }> {
    try {
      const result = await getText(
        {
          url: feedUrl,
          headers: {
            accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            'user-agent': 'signal-collector',
          },
          what,
        },
        context,
      );

      // 体积被截断说明 feed 大到超过上限，此时解析出来的一定是残片。
      // 与其产出一个「少了一半条目」的批次（而且看起来完全成功），
      // 不如如实失败 —— 管理员该做的是调大上限或换个源，
      // 而不是拿到一份静默不完整的数据。
      if (result.truncated) {
        throw new Error(
          `feed exceeded the ${context.maxBytes} byte limit and was truncated; ` +
            'parsing a partial document would silently drop entries',
        );
      }

      return { ...parseFeed(result.body), finalUrl: result.finalUrl };
    } catch (error) {
      throw toCollectorError(error, what);
    }
  }
}

/**
 * `maxItems` 的读取。
 *
 * 兜底值取 `@signal/source-core` 的 `DEFAULT_RSS_MAX_ITEMS`，**不在这里另定一个数**：
 * Agent 03 的 config 校验已经用它作为默认值，两边必须一致。
 * 越界值收敛到边界而不是报错 —— 采集端不该因为一个越界值停止工作，
 * 而写入侧（Admin API）已经保证进不了越界值。
 */
function readMaxItems(config: Record<string, unknown> | null): number {
  const raw = config?.['maxItems'];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return DEFAULT_RSS_MAX_ITEMS;
  return Math.min(Math.max(raw, MIN_RSS_MAX_ITEMS), MAX_RSS_MAX_ITEMS);
}

/**
 * 一条 feed 条目 → `CollectedItem`。返回 null 表示无法追溯到原始来源。
 *
 * 链接的解析基准用**响应的最终地址**（`finalUrl`）而不是配置里的 feed 地址：
 * feed 经常 301 到 CDN 或新域名，用旧地址做基准会把相对链接拼到错的主机上，
 * 结果是一堆 404 的 `originalUrl` —— 而前台要拿它做「阅读原文」。
 */
function toCollectedItem(
  sourceId: string,
  entry: FeedEntry,
  feed: ParsedFeed & { finalUrl: string },
): CollectedItem | null {
  // ⚠ 回退到 guid 时**不**按 feed 地址做相对解析（第二个参数传 null）：
  // 不透明的 guid（`<guid>abc123</guid>`）会被相对解析成
  // `https://feed-host/abc123` —— 一个凭空造出来的 404 链接。
  // `docs/00` 要求「任何公开内容必须可追溯到原始来源」，
  // 与其产出一个假的 originalUrl，不如跳过这一条并计数。
  const url = resolveItemUrl(entry.link, feed.finalUrl) ?? resolveItemUrl(entry.id, null);
  if (url === null) return null;

  const canonicalUrl = canonicalizeUrl(url);
  if (canonicalUrl === null) return null;

  return {
    sourceId,
    externalId: entry.id,
    originalUrl: url.toString(),
    canonicalUrl,
    title: entry.title,
    // 正文优先用 `content:encoded` / Atom 的 `content`，取不到退回摘要。
    // ⚠ 原文**未清洗**（可能含 HTML），清洗是 Pipeline 的职责（docs/14）。
    body: entry.body ?? entry.summary,
    language: feed.language,
    publishedAt: entry.publishedAt,
    author: entry.author,
    type: ContentType.ARTICLE,
    // 只有源侧事实。**不含** kind / tier / official —— 见 ports.ts 文件头。
    payload: { feedFormat: feed.format },
  };
}
