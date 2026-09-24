/**
 * GitHub 仓库 / Release 采集器（`SourceType.GITHUB_REPO`）。
 *
 * ── 端点与形状都是实测的 ────────────────────────────────────────────
 * 探针：`work/_agent04/probe-upstreams.json`（`GET /repos/{owner}/{repo}/releases`
 * 与 `GET /repos/{owner}/{repo}` 的真实响应）。
 * 关键字段：`id`(number) / `tag_name` / `name` / `html_url` / `published_at`
 * / `draft` / `prerelease` / `author.login` / `body`。
 *
 * ── `includeReleases` 两种语义 ──────────────────────────────────────
 * config 里只有这一个开关（Agent 03 的契约），因此：
 *   - `true`（默认）：采**Release**。这是「盯一个仓库」最常见的诉求
 *     —— `docs/05` 为它单独准备了 `ContentType.GITHUB_RELEASE`；
 *   - `false`：采**仓库本身**一条。用于「只想在精选里放这个项目」的场景。
 *
 * ⚠ 反过来做（两种都发）是错的：仓库本身的字段是可变的
 * （star 数、描述），每次都发会持续产生「新内容」，
 * 而内容其实没变 —— 那会直接冲垮 `docs/07` 的去重。
 *
 * ── `ContentType` 映射 ─────────────────────────────────────────────
 * Release → `GITHUB_RELEASE`，仓库 → `GITHUB_REPO`。`draft` 的 release
 * **跳过**：草稿是仓库维护者的未完成内容，采进来等于替别人提前发布。
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
import { normalizeLanguageTag } from '../field-limits';
import { canonicalizeUrl } from '../url/canonical';
import { readConfigBoolean, readConfigString } from './config-read';
import { getJson } from './http';
import { asArray, asIdString, asObject, asString, compactPayload, pickString } from './json';

/** GitHub API 基址。**硬编码**：管理员改不了，因此不是 SSRF 的「可配置 URL」。 */
export const GITHUB_API = 'https://api.github.com';

/**
 * 单次请求取多少个 release。GitHub 的 `per_page` 上限就是 100。
 *
 * 取满 100 而不是 30：多要的那些**不增加请求数**，但让「窗口随轮次推进」
 * 成为可能（每轮入库仍由 `GITHUB_RELEASES_PER_ROUND` 控制）。
 */
export const GITHUB_RELEASES_PER_PAGE = 100;

/** 每轮最多入库多少个 release。 */
export const GITHUB_RELEASES_PER_ROUND = 30;

export class GithubRepoCollectorAdapter implements CollectorAdapter {
  readonly type = SourceType.GITHUB_REPO;

  async fetch(
    source: CollectorSource,
    _cursor: CollectorCursor,
    context: CollectorContext,
  ): Promise<CollectorBatch> {
    // ⚠ 校验必须作用在**最终选定**的那个值上。曾经写成
    // `readConfigString(...) ?? normaliseRepo(source.externalId, ...)` ——
    // 于是只要 config.repo 有值，`normaliseRepo`（连同它的正则）就
    // 完全不会执行，`../../etc/passwd` 这样的值会直接进 URL 路径。
    // 这是测试抓出来的真缺陷：校验藏在 `??` 的右半边等于没有校验。
    const repo = normaliseRepo(
      readConfigString(source.config, 'repo') ?? source.externalId,
      source.slug,
    );
    if (repo === null) {
      throw sourceConfigInvalid(`GITHUB_REPO source ${source.slug} has no repository`);
    }

    const includeReleases = readConfigBoolean(source.config, 'includeReleases', true);
    const what = `GitHub source ${source.slug} (${repo})`;

    try {
      if (includeReleases) {
        const page = await this.fetchReleases(source.id, repo, what, context);
        // `complete` = 「上游这一页我读完了」。恰好取满一页说明可能还有更旧的
        // （GitHub 是分页的，我们只请求第一页）—— 如实报告。
        const mayHaveMore = page.items.length >= GITHUB_RELEASES_PER_PAGE;
        return {
          items: page.items,
          roundLimit: GITHUB_RELEASES_PER_ROUND,
          complete: !mayHaveMore,
          skippedCount: 0,
          warnings: mayHaveMore
            ? [
                `repository has at least ${GITHUB_RELEASES_PER_PAGE} releases; ` +
                  'only the newest page was read this round',
              ]
            : [],
        };
      }

      return {
        items: [await this.fetchRepo(source.id, repo, what, context)],
        roundLimit: null,
        complete: true,
        skippedCount: 0,
        warnings: [],
      };
    } catch (error) {
      throw toCollectorError(error, what);
    }
  }

  private headers(context: CollectorContext): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      'user-agent': 'signal-collector',
      'x-github-api-version': '2022-11-28',
      // GitHub 未配令牌时仍可匿名调用（有速率限制）—— 与 X 不同，
      // 这里**不**把「未配置」当失败：匿名可用的能力不该被自己的保守判断砍掉。
      ...(context.credentials.githubToken === null
        ? {}
        : { authorization: `Bearer ${context.credentials.githubToken}` }),
    };
  }

  private async fetchReleases(
    sourceId: string,
    repo: string,
    what: string,
    context: CollectorContext,
  ): Promise<{ items: CollectedItem[] }> {
    const body = await getJson(
      {
        url: `${GITHUB_API}/repos/${repo}/releases?per_page=${GITHUB_RELEASES_PER_PAGE}`,
        headers: this.headers(context),
        // release 的 `body` 里可能有大段 changelog；给 1MB 上限，
        // 比全局的 2MB 更省，同时不会截断正常 release 说明。
        maxBytes: 1_048_576,
        what,
      },
      context,
    );

    const items: CollectedItem[] = [];
    for (const raw of asArray(body)) {
      const release = asObject(raw);
      if (release === null) continue;
      // 草稿跳过：那是维护者尚未发布的版本，采进来等于替别人提前发布。
      if (release['draft'] === true) continue;

      const htmlUrl = asString(release['html_url']);
      if (htmlUrl === null) continue;
      const canonicalUrl = canonicalizeUrl(htmlUrl);
      if (canonicalUrl === null) continue;

      const tag = asString(release['tag_name']) ?? '';
      const releaseName = asString(release['name']);
      items.push({
        sourceId,
        externalId: asIdString(release['id']) ?? (tag === '' ? null : tag),
        originalUrl: htmlUrl,
        canonicalUrl,
        title: releaseName ?? (tag === '' ? `Release ${repo}` : `${repo} ${tag}`),
        body: asString(release['body']),
        language: null,
        publishedAt: releaseDate(release),
        author: pickString(release, 'author', 'login') ?? repo.split('/')[0] ?? null,
        type: ContentType.GITHUB_RELEASE,
        payload: compactPayload({
          repo,
          tagName: tag || null,
          prerelease: release['prerelease'] === true,
        }),
      });
    }
    return { items };
  }

  private async fetchRepo(
    sourceId: string,
    repo: string,
    what: string,
    context: CollectorContext,
  ): Promise<CollectedItem> {
    const body = await getJson(
      {
        url: `${GITHUB_API}/repos/${repo}`,
        headers: this.headers(context),
        // release 的 `body` 里可能有大段 changelog；给 1MB 上限，
        // 比全局的 2MB 更省，同时不会截断正常 release 说明。
        maxBytes: 1_048_576,
        what,
      },
      context,
    );

    const repository = asObject(body);
    const htmlUrl = asString(repository?.['html_url']) ?? `https://github.com/${repo}`;
    const canonicalUrl = canonicalizeUrl(htmlUrl);
    if (canonicalUrl === null) {
      throw sourceConfigInvalid(`${what}: repository URL is not usable`);
    }

    return {
      sourceId,
      externalId: asString(repository?.['full_name']) ?? repo,
      originalUrl: htmlUrl,
      canonicalUrl,
      title: asString(repository?.['full_name']) ?? repo,
      body: asString(repository?.['description']),
      // ⚠ `repo.language` 是**主编程语言名**（`JavaScript` / `Python` /
      // `Jupyter Notebook`），而 `raw_items.language` 是 BCP-47 标签、
      // 列宽 `Char(5)`。直接把前者写进后者必然写失败（列太长），
      // 而且语义就是错的。收敛成合规标签，取不到就留空交给 Pipeline 判定。
      language: normalizeLanguageTag(asString(repository?.['language'])),
      publishedAt: null,
      author: pickString(repository, 'owner', 'login') ?? repo.split('/')[0] ?? null,
      type: ContentType.GITHUB_REPO,
      payload: compactPayload({
        repo,
        stars:
          typeof repository?.['stargazers_count'] === 'number'
            ? repository['stargazers_count']
            : null,
        homepage: asString(repository?.['homepage']),
      }),
    };
  }
}

/**
 * `owner/name` 形状检查。
 *
 * 不做这一步的话，`repo` 里出现 `..` 或 `/` 会被拼进 URL 路径，
 * 让这个硬编码端点的实际请求目标变成别的东西（`/repos/../..` 之类）。
 * Agent 03 的 config 校验已经用同一个正则挡过一次，这里再挡一次的理由是
 * **本适配器也接受 `externalId` 作为来源**，而 externalId 不走那个校验。
 */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function normaliseRepo(raw: string | null, slug: string): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (!REPO_SLUG.test(trimmed)) {
    throw sourceConfigInvalid(`GITHUB_REPO source ${slug}: "${trimmed}" is not an owner/name repo`);
  }
  return trimmed;
}

/** `published_at` 优先，缺失时退回 `created_at`（GitHub 两者都可能为空）。 */
function releaseDate(release: Record<string, unknown>): Date | null {
  for (const key of ['published_at', 'created_at']) {
    const value = asString(release[key]);
    if (value === null) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}
