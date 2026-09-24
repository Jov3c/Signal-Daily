/**
 * Hacker News 采集器（`SourceType.HACKER_NEWS`）。
 *
 * ── 端点是两段式的，形状实测确认 ────────────────────────────────────
 * ```
 * GET /v0/{feed}stories.json   → number[]（500 个 id，已按排名排好）
 * GET /v0/item/{id}.json       → { id, by, time, title, url, score, descendants, type }
 * ```
 * （探针：`work/_agent04/probe-upstreams.json`）
 *
 * ── 为什么必须限制取多少个 item ─────────────────────────────────────
 * `/topstories.json` 固定返回 **500** 个 id。全取意味着一次采集要发
 * 500 个 HTTP 请求 —— collector 队列的并发是 5（`docs/13`），
 * 一个 HN 来源就能把整个采集系统堵死几分钟，其它来源全部饿死。
 *
 * 因此取前 `HN_MAX_ITEMS` 个 id（榜单本身已按热度排好，
 * 「前 N 个」就是「最热的 N 个」），并发上限 `HN_ITEM_CONCURRENCY`。
 *
 * ── `feed` 与 `minScore` 的分工 ────────────────────────────────────
 * `feed` 决定用哪个榜单端点；`minScore` 是**采集后**的过滤。
 * 注意榜单不同、`minScore` 的效果也不同：`new` 榜里的条目分数普遍很低
 * （刚发出来），配一个高 `minScore` 会把它过滤成空 —— 这是配置问题，
 * 不是 bug，但值得在管理后台的提示里说清楚（见 HANDOFF 给 Agent 12）。
 */

import { ContentType, SourceType } from '@signal/contracts';
import { HACKER_NEWS_FEEDS, type HackerNewsFeed } from '@signal/source-core';
import { toCollectorError } from '../errors';
import type { CollectorSource } from '../ports';
import type {
  CollectedItem,
  CollectorAdapter,
  CollectorBatch,
  CollectorContext,
  CollectorCursor,
} from '../types';
import { canonicalizeUrl } from '../url/canonical';
import { readConfigEnum, readConfigInteger } from './config-read';
import { getJson } from './http';
import { asIdString, asNumber, asObject, asString, compactPayload } from './json';

/** HN 官方 Firebase API。硬编码，管理员改不了。 */
export const HACKER_NEWS_API = 'https://hacker-news.firebaseio.com/v0';

/** 单轮最多取多少条。见文件头「为什么必须限制」。 */
export const HN_MAX_ITEMS = 30;

/** 取 item 的并发上限。取得太猛会被 Firebase 限流，取太慢会拖长整个任务。 */
export const HN_ITEM_CONCURRENCY = 5;

/**
 * `minScore` 的取值区间，与 Agent 03 的 config 校验（`0..10000`）保持一致。
 *
 * 采集端也收敛一次而不是信任库里的值：seed 数据与手工改库都绕过了
 * Admin API 的校验，而一个越界的 `minScore` 会让这个来源**永远采不到东西**
 * （所有条目都被过滤掉），症状只是「这个源一直是空的」。
 */
const MAX_MIN_SCORE = 10_000;

function clampMinScore(value: number): number {
  return Math.min(Math.max(value, 0), MAX_MIN_SCORE);
}

export class HackerNewsCollectorAdapter implements CollectorAdapter {
  readonly type = SourceType.HACKER_NEWS;

  async fetch(
    source: CollectorSource,
    // 刻意**不使用**游标（见 `selectIds` 的注释：id 增量会导致永久漏采）。
    _cursor: CollectorCursor,
    context: CollectorContext,
  ): Promise<CollectorBatch> {
    const feed = readConfigEnum<HackerNewsFeed>(source.config, 'feed', HACKER_NEWS_FEEDS, 'top');
    const minScore = clampMinScore(readConfigInteger(source.config, 'minScore', 0));
    const what = `Hacker News source ${source.slug} (${feed})`;

    try {
      const ids = await this.loadIds(feed, what, context);
      const selected = selectIds(ids, HN_MAX_ITEMS);
      const stories = await mapWithConcurrency(selected, HN_ITEM_CONCURRENCY, (id) =>
        this.loadStory(id, what, context),
      );

      const items: CollectedItem[] = [];
      let skippedCount = 0;
      /** 取回来但处理不了的（`item` 端点失败 / 被 flag / 删掉）。 */
      let unprocessed = 0;

      for (const story of stories) {
        if (story === null) {
          unprocessed += 1;
          continue;
        }
        const score = asNumber(story['score']) ?? 0;
        if (score < minScore) continue;

        const item = toCollectedItem(source.id, story, feed);
        if (item === null) {
          skippedCount += 1;
          continue;
        }
        items.push(item);
      }

      // ⚠ `complete` 的定义是「**这一轮要处理的东西都处理好了**」。
      //
      // 它曾经恒为 `true`（谎言），上一轮修成 `ids.length <= HN_MAX_ITEMS`
      // 之后又恒为 `false` —— 因为 `/topstories.json` 固定返回 500 条、
      // 而 `HN_MAX_ITEMS` 固定是 30。一个恒为 `false` 的字段同样没有信息量，
      // 还会让每一轮都打一条**管理员无法行动**的告警（没有任何设置能让它变 true）。
      //
      // 现在它表示可行动的语义：取回的这 30 条里有没有处理失败的。
      // 「只取前 30 条」是文件头写明的**设计**（全取 = 一次 500 个请求，
      // 会把 collector 队列的 5 个并发堵死），不是异常。
      return {
        items,
        roundLimit: null,
        complete: unprocessed === 0,
        skippedCount,
        warnings:
          unprocessed === 0
            ? []
            : [`${unprocessed} of the top ${selected.length} stories could not be read`],
      };
    } catch (error) {
      throw toCollectorError(error, what);
    }
  }

  private async loadIds(
    feed: HackerNewsFeed,
    what: string,
    context: CollectorContext,
  ): Promise<string[]> {
    const body = await getJson(
      {
        url: `${HACKER_NEWS_API}/${feed}stories.json`,
        headers: { accept: 'application/json' },
        // 500 个数字约 4KB，给 64KB 足够且能挡住异常响应。
        // 500 个数字约 4KB —— 给 64KB 足够，且能挡住异常响应。
        maxBytes: 65_536,
        what: `${what} story list`,
      },
      context,
    );
    return Array.isArray(body) ? body.map((id) => asIdString(id)).filter(isString) : [];
  }

  /** 取单个 item。**单条失败不抛**：一条坏数据不该让整个来源失败。 */
  private async loadStory(
    id: string,
    what: string,
    context: CollectorContext,
  ): Promise<Record<string, unknown> | null> {
    try {
      const body = await getJson(
        {
          url: `${HACKER_NEWS_API}/item/${id}.json`,
          headers: { accept: 'application/json' },
          maxBytes: 262_144,
          what: `${what} item ${id}`,
        },
        context,
      );
      return asObject(body);
    } catch {
      // 刻意吞掉：删掉的 item、被 flag 的 item、单次超时都是**常态**，
      // 让它们失败整个来源会让 HN 采集频繁整体失败。
      // 代价是这些 URL 不会出现在日志里 —— 因此这里不能顺手 debug 打印
      // （500 个 item 里坏几个很常见，逐条打印会淹掉真正的错误）。
      return null;
    }
  }
}

/**
 * 从榜单里选出要取的 id —— **只按榜单顺序取前 N 个，不按 id 做增量过滤**。
 *
 * ── ⚠ 这是一个 P1 缺陷的修复：曾经的 id 增量会造成永久漏采 ──────────
 * 原实现先取榜单前 N 个，再跳过 `id <= sinceExternalId` 的条目，
 * 注释还声称这样做「与榜单排序无关」。**那个声称是假的**：
 *
 * ```
 * 第 1 轮榜单 [100, 99, 98]  → 采到 100/99/98，游标 = 98
 * 第 2 轮榜单 [101, 97, 100, 99, 98]
 *         97 涨到了榜眼、**从来没有采过**，但 97 <= 98 → 被跳过
 *         此后 97 的 id 永远小于游标 → **永久不会被采集**
 * ```
 *
 * 「发布较早、后来才涨上首页」恰恰是 HN 上最典型的现象（一个故事从 new 榜
 * 爬到 front page）。而漏采没有任何信号：不计数、不进日志、`complete` 还是 true。
 *
 * 根因是把**两种不同的语义**混在一起：id 是「时间上的新旧」，
 * 榜单位置是「此刻的热度」。前者不能用来判断后者。
 *
 * 现在改成「取窗口 + 靠库去重」：每一轮都取榜单前 N 个，
 * 已经在库里的由 `docs/06` 的幂等键（source+externalId / canonical URL hash）
 * 挡掉。代价是每轮多做一次 `findExistingKeys` 查询 —— 换掉一个静默的数据缺口，
 * 这个代价是值的。
 */
function selectIds(ids: string[], limit: number): string[] {
  return ids.slice(0, limit);
}

/**
 * 一条 HN story → `CollectedItem`。
 *
 * `url` 可能为 null（Ask HN / Show HN 这类**自帖**没有外链，正文在 `text` 里），
 * 此时退回 HN 自己的讨论页 —— 那是这类条目唯一可追溯的原始地址。
 * 直接跳过是错的：那会让 Ask HN / Show HN 永远采不到，而它们恰恰是 HN 上
 * 最有价值的内容之一。
 */
function toCollectedItem(
  sourceId: string,
  story: Record<string, unknown>,
  feed: HackerNewsFeed,
): CollectedItem | null {
  const id = asIdString(story['id']);
  if (id === null) return null;

  const hnUrl = `https://news.ycombinator.com/item?id=${id}`;
  const outbound = asString(story['url']);
  const originalUrl = outbound ?? hnUrl;

  const canonicalUrl = canonicalizeUrl(originalUrl);
  if (canonicalUrl === null) return null;

  const title = asString(story['title']);
  const text = asString(story['text']);

  return {
    sourceId,
    externalId: id,
    originalUrl,
    canonicalUrl,
    title,
    body: text,
    language: null,
    publishedAt:
      asNumber(story['time']) === null ? null : new Date((asNumber(story['time']) ?? 0) * 1_000),
    author: asString(story['by']),
    type: ContentType.HN_STORY,
    payload: compactPayload({
      hnId: id,
      hnUrl,
      score: asNumber(story['score']),
      comments: asNumber(story['descendants']),
      feed,
      // 自帖（无外链）标记出来：前台应当直接展示正文而不是「阅读原文」。
      selfPost: outbound === null,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function isString(value: string | null): value is string {
  return value !== null;
}

/**
 * 有并发上限的 map，**保持输入顺序**（`Promise.all` 本身就是保序的，
 * 这里只是把「一批一批跑」写清楚）。
 */
async function mapWithConcurrency<T, R>(
  input: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < input.length; start += concurrency) {
    const batch = input.slice(start, start + concurrency);
    results.push(...(await Promise.all(batch.map((item) => task(item)))));
  }
  return results;
}
