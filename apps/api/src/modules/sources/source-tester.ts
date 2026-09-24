/**
 * `POST /admin/sources/:id/test` 的实现 —— 真的去探一次。
 *
 * ── 设计取舍：这是一个**诊断结果**端点，不是错误端点 ────────────────
 * 「目标站点连不上」是这次探测的**结论**，不是请求本身出错。所以：
 *   - 2xx 之外的响应、超时、DNS 失败 → HTTP **200** + `{ok: false, message}`；
 *   - 只有「这个 Source 根本不该被探测」（地址非法、config 缺字段）
 *     才抛 400。
 * 这样 Admin UI（Agent 12）可以直接把 `message` 显示在按钮旁边，
 * 而不会在浏览器控制台里堆满红色 4xx/5xx，也不会污染 5xx 告警。
 *
 * ── 测试性 ───────────────────────────────────────────────────────
 * 所有出网调用都走 `safeFetchText`，它的 `fetch` / DNS / 时钟都可注入，
 * 因此**真实解析逻辑（URL 校验、响应判定、状态码分支）跑的是真代码**，
 * 只把网络那一层换成替身 —— 避免出现「测试全绿但真代码从没跑过」
 * （Agent 01 的 FULLTEXT 就是这么被骗过去的）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { SourceType } from '@signal/contracts';
import { serializeError, type Logger } from '@signal/logger';
import { APP_LOGGER } from '../../common/logger/app-logger';
import { SourceFetchError, UrlSafetyError, type DnsLookup, safeFetchText } from './url-safety';
import type { SourceRecord } from './repository';
import { SOURCE_CONFIG, type SourceConfig } from './source.config';
import {
  HACKER_NEWS_FEEDS,
  type HackerNewsFeed,
  type HuggingFaceRepoType,
} from './source-config.schema';

/** 注入 token。 */
export const SOURCE_TESTER = 'SOURCE_TESTER';

/** 探测用的可注入依赖（测试用）。 */
export const SOURCE_TESTER_DEPS = 'SOURCE_TESTER_DEPS';

export type SourceTesterDeps = {
  fetchImpl?: typeof fetch;
  lookup?: DnsLookup;
  now?: () => number;
};

/**
 * 探测响应体的读取上限。
 *
 * 取 `SOURCE_FETCH_MAX_BYTES` 与 256 KiB 的**较小值**：探测只需要判断
 * 「这是不是一个 feed」，不需要把那篇 2 MiB 的正文下载下来。
 * 管理员点一次 Test 就对目标站点产生一次真实请求，控制代价是应该的。
 */
export const TEST_MAX_BYTES = 262_144;

export type SourceTestResult = {
  ok: boolean;
  type: SourceType;
  /** 探测目标的安全展示形式（**已去查询串与凭据**）。 */
  target: string | null;
  latencyMs: number;
  /** 人类可读的结论。不含任何凭据，可直接回显给管理员。 */
  message: string;
};

export interface SourceTester {
  test(source: SourceRecord): Promise<SourceTestResult>;
}

/** 固定厂商端点（非管理员可控，因此不参与 SSRF 的「可配置 URL」判定）。 */
const GITHUB_API = 'https://api.github.com';
const HUGGINGFACE_API = 'https://huggingface.co/api';
const HACKER_NEWS_API = 'https://hacker-news.firebaseio.com/v0';
const X_API = 'https://api.x.com/2';

const HF_SEGMENT: Readonly<Record<HuggingFaceRepoType, string>> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces',
};

/** 从 `config` 里读一个字符串，读不到就用兜底值。 */
function configString(
  config: Record<string, unknown> | null,
  key: string,
  fallback: string,
): string {
  const value = config?.[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * 正文看起来是不是 RSS / Atom。
 *
 * 只看前 4 KiB：feed 的根元素一定在最前面，而把 2 MiB 正文全转小写
 * 只为找 `<rss` 是浪费。很多站点的 `content-type` 是错的（用 text/html
 * 发 feed），所以不能只信 header。
 */
export function looksLikeFeed(body: string, contentType: string | null): boolean {
  const header = (contentType ?? '').toLowerCase();
  if (header.includes('rss') || header.includes('atom')) return true;

  const head = body.slice(0, 4_096).toLowerCase();
  return (
    head.includes('<rss') ||
    head.includes('<feed') ||
    head.includes('<rdf:rdf') ||
    // 有些源会先来一段注释/空白的 XML 声明。
    (head.includes('<?xml') && (header.includes('xml') || head.includes('<channel')))
  );
}

@Injectable()
export class HttpSourceTester implements SourceTester {
  // ⚠ 显式 @Inject：不要依赖 emitDecoratorMetadata（见 di-wiring.spec.ts）。
  constructor(
    @Inject(SOURCE_CONFIG) private readonly config: SourceConfig,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    @Inject(SOURCE_TESTER_DEPS) private readonly deps: SourceTesterDeps,
  ) {}

  async test(source: SourceRecord): Promise<SourceTestResult> {
    const startedAt = this.now();

    let target: string;
    try {
      target = this.resolveTarget(source);
    } catch (error) {
      // 配置本身有问题（例如 X 未配 token）→ 直接如实报告，不发请求。
      return this.failure(source.type, null, startedAt, messageOf(error));
    }

    try {
      const probe = this.probe(source, target);
      const result = await safeFetchText(
        target,
        {
          method: probe.method,
          headers: probe.headers,
          timeoutMs: this.config.fetchTimeoutMs,
          maxBytes: Math.min(this.config.fetchMaxBytes, TEST_MAX_BYTES),
        },
        { ...this.deps },
      );

      if (result.status < 200 || result.status >= 300) {
        return this.failure(
          source.type,
          result.displayUrl,
          startedAt,
          `Target responded with HTTP ${result.status}`,
        );
      }

      const verdict = probe.verdict?.(result.body, result.contentType) ?? null;
      if (verdict !== null) {
        return this.failure(source.type, result.displayUrl, startedAt, verdict);
      }

      return {
        ok: true,
        type: source.type,
        target: result.displayUrl,
        latencyMs: this.now() - startedAt,
        message: probe.successMessage,
      };
    } catch (error) {
      // 只把「我们知道怎么解释」的两类错误变成诊断结论；
      // 其余异常照常冒泡 —— 那才是真的程序缺陷，不该被伪装成「源不可用」。
      if (error instanceof UrlSafetyError || error instanceof SourceFetchError) {
        return this.failure(source.type, null, startedAt, messageOf(error));
      }
      this.logger.error(
        { sourceId: source.id, err: serializeError(error) },
        'source test failed unexpectedly',
      );
      throw error;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private failure(
    type: SourceType,
    target: string | null,
    startedAt: number,
    message: string,
  ): SourceTestResult {
    return { ok: false, type, target, latencyMs: this.now() - startedAt, message };
  }

  /**
   * 解析出这次要探测的 URL。
   *
   * 抛出的错误会被上层转成 `ok:false` 的结论（例如「X 未配置令牌」），
   * **不是** HTTP 错误 —— 管理员需要知道的是「测不了」，不是「你请求错了」。
   */
  private resolveTarget(source: SourceRecord): string {
    switch (source.type) {
      case SourceType.RSS: {
        const url = source.feedUrl ?? source.baseUrl;
        if (url === null) throw new Error('RSS source has neither feedUrl nor baseUrl');
        return url;
      }
      case SourceType.MANUAL_URL: {
        const url = configString(source.config, 'url', '');
        if (url === '') throw new Error('MANUAL_URL source has no config.url');
        return url;
      }
      case SourceType.X_USER: {
        if (this.config.xApiBearerToken === null) {
          throw new Error(
            'X API bearer token is not configured (X_API_BEARER_TOKEN); cannot verify this account',
          );
        }
        const handle = configString(source.config, 'handle', source.externalId ?? '');
        if (handle === '') throw new Error('X_USER source has no handle');
        return `${X_API}/users/by/username/${encodeURIComponent(handle)}`;
      }
      case SourceType.GITHUB_REPO: {
        const repo = source.externalId ?? configString(source.config, 'repo', '');
        if (repo === '') throw new Error('GITHUB_REPO source has no repository');
        return `${GITHUB_API}/repos/${repo}`;
      }
      case SourceType.HUGGINGFACE: {
        const repoId = source.externalId ?? configString(source.config, 'repoId', '');
        if (repoId === '') throw new Error('HUGGINGFACE source has no repository');
        const repoType = configString(source.config, 'repoType', 'model') as HuggingFaceRepoType;
        const segment = HF_SEGMENT[repoType] ?? HF_SEGMENT.model;
        return `${HUGGINGFACE_API}/${segment}/${repoId}`;
      }
      case SourceType.HACKER_NEWS: {
        const feed = configString(source.config, 'feed', 'top') as HackerNewsFeed;
        const known = (HACKER_NEWS_FEEDS as readonly string[]).includes(feed);
        // HN 没有「按来源」的端点：所有榜单都来自同一个官方 API。
        // 因此探测的是「官方 API 是否可达」，榜单取值只影响后续采集。
        if (!known) throw new Error(`Unknown Hacker News feed: ${feed}`);
        return `${HACKER_NEWS_API}/maxitem.json`;
      }
      default: {
        const exhaustive: never = source.type;
        throw new Error(`Unsupported SourceType: ${String(exhaustive)}`);
      }
    }
  }

  /** 每类来源的请求方式与「响应是否算成功」的判定。 */
  private probe(
    source: SourceRecord,
    _target: string,
  ): {
    method: 'GET' | 'HEAD';
    headers: Record<string, string>;
    successMessage: string;
    verdict?: (body: string, contentType: string | null) => string | null;
  } {
    switch (source.type) {
      case SourceType.RSS:
        return {
          method: 'GET',
          headers: {
            accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
          },
          successMessage: 'Feed responded and looks like RSS/Atom',
          verdict: (body, contentType) =>
            looksLikeFeed(body, contentType)
              ? null
              : 'Target responded but does not look like an RSS/Atom feed',
        };

      case SourceType.MANUAL_URL:
        return {
          // 用 HEAD 不成立：不少站点不支持 HEAD，会误报失败。
          method: 'GET',
          headers: { accept: 'text/html,application/xhtml+xml,application/json;q=0.8' },
          successMessage: 'URL is reachable',
        };

      case SourceType.X_USER:
        return {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.config.xApiBearerToken ?? ''}`,
          },
          successMessage: 'X account exists and is visible to this API token',
        };

      case SourceType.GITHUB_REPO:
        return {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'signal-app',
            'x-github-api-version': '2022-11-28',
            ...(this.config.githubToken === null
              ? {}
              : { authorization: `Bearer ${this.config.githubToken}` }),
          },
          successMessage: 'Repository is reachable',
        };

      case SourceType.HUGGINGFACE:
        return {
          method: 'GET',
          headers: { accept: 'application/json' },
          successMessage: 'Repository is reachable',
        };

      case SourceType.HACKER_NEWS:
        return {
          method: 'GET',
          headers: { accept: 'application/json' },
          successMessage: 'Hacker News API is reachable',
        };

      default: {
        const exhaustive: never = source.type;
        throw new Error(`Unsupported SourceType: ${String(exhaustive)}`);
      }
    }
  }
}

/**
 * 把错误收敛成一句可回显的话。
 *
 * `UrlSafetyError.safeMessage` 与 `SourceFetchError.message` 都是我们自己写的
 * 固定文案，**不含 URL**；而 `Error`（配置缺失）的文案同样是固定的。
 * 真正的底层异常文本一律不转发（可能含地址）。
 */
function messageOf(error: unknown): string {
  if (error instanceof UrlSafetyError) return error.safeMessage;
  if (error instanceof SourceFetchError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Source could not be verified';
}
