/**
 * 管理员手工指定的单个 URL（`SourceType.MANUAL_URL`）。
 *
 * ── 这是唯一一个「地址由管理员随便填」的适配器 ───────────────────────
 * RSS 的地址是 feed、GitHub/HN/HF 的地址是硬编码厂商端点，
 * 只有 MANUAL_URL 让管理员指向任意网站。因此它是 SSRF 的主战场：
 * `@signal/source-core` 的 `safeFetchText` 在这里不是可选项。
 *
 * 写入侧（Agent 03 的 `buildSourceConfig`）已经在存库时校验过一次地址，
 * 但**这里必须再校验一次**：① 数据可能是 seed 直接写库的（绕过 API）；
 * ② 域名可以事后改 DNS（TOCTOU）；③ 重定向只有抓取时才知道去哪。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────
 * 同一个 URL 反复抓会得到同一个 `canonicalUrl`，因此被去重挡掉 ——
 * 这正是想要的行为：手工来源的语义是「盯住这个页面」，
 * 不是「每次抓都产生一条新内容」。
 */

import { ContentType, SourceType } from '@signal/contracts';
import { sourceConfigInvalid, toCollectorError } from '../errors';
import type { CollectorSource } from '../ports';
import type {
  CollectedItem,
  CollectorAdapter,
  CollectorBatch,
  CollectorContext,
  CollectorCursor,
} from '../types';
import { canonicalizeUrl } from '../url/canonical';
import { readConfigString } from './config-read';
import { getText } from './http';
import { extractHtmlTitle } from '../text/markup';

/** 正文最多留多少字符。整页 HTML 可能远大于此，而 Pipeline 只需要正文。 */
export const MANUAL_URL_BODY_LIMIT = 200_000;

export class ManualUrlCollectorAdapter implements CollectorAdapter {
  readonly type = SourceType.MANUAL_URL;

  async fetch(
    source: CollectorSource,
    _cursor: CollectorCursor,
    context: CollectorContext,
  ): Promise<CollectorBatch> {
    const url = readConfigString(source.config, 'url');
    if (url === null) {
      throw sourceConfigInvalid(`MANUAL_URL source ${source.slug} has no config.url`);
    }

    const what = `MANUAL_URL source ${source.slug}`;
    try {
      const result = await getText(
        {
          url,
          headers: {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'user-agent': 'signal-collector',
          },
          what,
        },
        context,
      );

      // 去重与展示都用**响应的最终地址**：管理员填的短链 / 会跳转的地址
      // 与真实页面不是同一个 URL，用填的那个会让同一页面重复入库。
      const canonicalUrl = canonicalizeUrl(result.finalUrl) ?? canonicalizeUrl(url);
      if (canonicalUrl === null) {
        throw sourceConfigInvalid(`${what}: resolved URL is not a usable http(s) address`);
      }

      const item: CollectedItem = {
        sourceId: source.id,
        // 手工来源没有「上游 id」，去重完全靠 URL —— 这是刻意的，
        // 见文件头「幂等」。
        externalId: null,
        originalUrl: result.finalUrl,
        canonicalUrl,
        title: extractHtmlTitle(result.body),
        // ⚠ 整页正文原文，**未清洗**。docs/14 的清洗在 Pipeline（Agent 05）。
        body: result.body.slice(0, MANUAL_URL_BODY_LIMIT),
        // 语言交给 Pipeline 的 LANGUAGE_DETECT：从 HTML 里猜 lang 属性
        // 经常猜错（不少站点直接写 lang="en" 而内容是中文），
        // 与其把错的写进库，不如留空让 AI 判。
        language: null,
        publishedAt: null,
        author: null,
        type: ContentType.ARTICLE,
        payload: {
          contentType: result.contentType,
          httpStatus: result.status,
          truncated: result.truncated,
        },
      };

      return { items: [item], complete: true, skippedCount: 0, warnings: [] };
    } catch (error) {
      throw toCollectorError(error, what);
    }
  }
}
