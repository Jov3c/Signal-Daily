/**
 * Hugging Face 采集器（`SourceType.HUGGINGFACE`）。
 *
 * ── ⚠ 本适配器的端点形状**未能在本机实测** ──────────────────────────
 * 本机对 `huggingface.co` 的 DNS 被污染（解析到 `69.63.176.15`，
 * 一个与 HF 无关的地址），连接直接超时。探针记录见
 * `work/_agent04/probe-upstreams.json` 的 `hf-model` 项。
 *
 * 因此这里采取的策略是：**按文档形状严格解析，形状对不上就如实失败**，
 * 而不是「尽量猜一个」。
 *
 * 为什么这个取舍很重要：一个宽松的解析器在形状变化时会返回 **0 条**，
 * 而「这个来源本来就没更新」在数据上长得一模一样 —— 后台会显示一切正常，
 * HF 动态永远是空的，没人知道是解析器坏了。
 * 相反，严格失败会把问题变成一条看得见的 `SOURCE_FETCH_FAILED`。
 *
 * 上线前必须由能访问 HF 的环境跑一次真实验证（见 HANDOFF 的
 * Known Limitations）。**这不是「已验证」，是「待验证」。**
 *
 * ── 采集什么 ────────────────────────────────────────────────────────
 * 盯一个具体的 model / dataset / space 时，「有新东西」= **有新 commit**。
 * 所以采的是 `/{model,dataset,space}s/{repoId}/commits/main`。
 *
 * 不去采 `/api/models?sort=trending` 这类榜单：那与「盯住某个仓库」是
 * 两种不同的来源语义，而 config 里只有 `repoType` + `repoId` 两个键
 * （Agent 03 的契约），表达不了榜单来源。硬做只会让语义含糊。
 */

import { ContentType, SourceType } from '@signal/contracts';
import { HUGGINGFACE_REPO_TYPES, type HuggingFaceRepoType } from '@signal/source-core';
import { sourceConfigInvalid, toCollectorError, fetchFailed } from '../errors';
import type { CollectorSource } from '../ports';
import type {
  CollectedItem,
  CollectorAdapter,
  CollectorBatch,
  CollectorContext,
  CollectorCursor,
} from '../types';
import { canonicalizeUrl } from '../url/canonical';
import { readConfigEnum, readConfigString } from './config-read';
import { getJson } from './http';
import { asArray, asObject, asString, compactPayload } from './json';

/** Hugging Face Hub API。硬编码，管理员改不了。 */
export const HUGGINGFACE_API = 'https://huggingface.co/api';

/** 站点根（拼人类可读的链接用）。 */
const HUGGINGFACE_SITE = 'https://huggingface.co';

/** 单轮最多取多少条 commit。 */
export const HF_MAX_COMMITS = 30;

/** `repoType` → URL 路径段。与 Agent 03 的 `source-tester.ts` 用同一张表。 */
const HF_SEGMENT: Readonly<Record<HuggingFaceRepoType, string>> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces',
};

export class HuggingFaceCollectorAdapter implements CollectorAdapter {
  readonly type = SourceType.HUGGINGFACE;

  async fetch(
    source: CollectorSource,
    _cursor: CollectorCursor,
    context: CollectorContext,
  ): Promise<CollectorBatch> {
    // ⚠ 与 GitHub 同源的一个缺陷：校验曾经挂在 `??` 的右半边，
    // 于是 config.repoId 有值时正则完全不会执行。测试抓出来的。
    const repoId = normaliseRepoId(
      readConfigString(source.config, 'repoId') ?? source.externalId,
      source.slug,
    );
    const repoType = readConfigEnum<HuggingFaceRepoType>(
      source.config,
      'repoType',
      HUGGINGFACE_REPO_TYPES,
      'model',
    );
    const segment = HF_SEGMENT[repoType];
    const what = `Hugging Face ${segment} ${repoId}`;

    try {
      const body = await getJson(
        {
          url: `${HUGGINGFACE_API}/${segment}/${repoId}/commits/main`,
          headers: { accept: 'application/json', 'user-agent': 'signal-collector' },
          what,
        },
        context,
      );

      const commits = asArray(body);
      if (commits.length === 0) {
        // 空数组是合法的（仓库刚建、只有一个 commit 且已被游标跳过）。
        // 但**不是数组**一定是形状变了 —— 那时必须失败，不能返回 0 条。
        if (!Array.isArray(body)) {
          throw fetchFailed(
            `${what}: expected a JSON array of commits, got ${describeShape(body)}. ` +
              'The Hugging Face API shape is unverified in this environment — see HANDOFF.',
          );
        }
        return { items: [], complete: true, skippedCount: 0, warnings: [] };
      }

      const items: CollectedItem[] = [];
      const withinWindow = commits.slice(0, HF_MAX_COMMITS);
      for (const raw of withinWindow) {
        const commit = asObject(raw);
        const commitId = asString(commit?.['id']);
        if (commit === null || commitId === null) {
          throw fetchFailed(
            `${what}: commit entry is missing a string "id" (got ${describeShape(raw)}). ` +
              'The Hugging Face API shape is unverified in this environment — see HANDOFF.',
          );
        }

        // 提交页是可追溯的原始地址；仓库首页做不到「这条内容对应哪次变更」。
        const originalUrl = `${HUGGINGFACE_SITE}/${segment}/${repoId}/commit/${commitId}`;
        const canonicalUrl = canonicalizeUrl(originalUrl);
        if (canonicalUrl === null) continue;

        const title = asString(commit['title']) ?? asString(commit['message']);
        items.push({
          sourceId: source.id,
          externalId: commitId,
          originalUrl,
          canonicalUrl,
          title: title ?? `${repoId} updated`,
          body: asString(commit['message']),
          language: null,
          publishedAt: commitDate(commit),
          author: firstAuthor(commit),
          type: ContentType.MODEL,
          payload: compactPayload({
            repoId,
            repoType,
            commitId,
            repoUrl: `${HUGGINGFACE_SITE}/${segment}/${repoId}`,
          }),
        });
      }

      return {
        items,
        complete: commits.length <= HF_MAX_COMMITS,
        skippedCount: 0,
        warnings:
          commits.length <= HF_MAX_COMMITS
            ? []
            : [
                `repository has at least ${commits.length} recent commits; ` +
                  `only the newest ${HF_MAX_COMMITS} were collected this round`,
              ],
      };
    } catch (error) {
      throw toCollectorError(error, what);
    }
  }
}

/** `owner/name` 形状检查（与 Agent 03 的 config 校验同一个正则）。 */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * 校验 `owner/name`。
 *
 * 与 Agent 03 的 `source-config.schema.ts` 用**同一个正则**：
 * HF 的 config 契约要求 `owner/name`，两边不一致会让「后台能存、
 * 采集器拒绝」这种最难受的故障出现。
 */
function normaliseRepoId(raw: string | null, slug: string): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!REPO_SLUG.test(trimmed)) {
    throw sourceConfigInvalid(
      `HUGGINGFACE source ${slug}: "${trimmed}" is not an owner/name repository id ` +
        '(the config contract requires owner/name, same as the Admin API validation)',
    );
  }
  return trimmed;
}

/**
 * commit 的时间。
 *
 * HF 的 commit 用 `date`（ISO 8601）。`createdAt` 作为兜底 ——
 * 两种键名在 HF 的不同端点上确实都出现过。
 */
function commitDate(commit: Record<string, unknown>): Date | null {
  for (const key of ['date', 'createdAt', 'created_at']) {
    const value = asString(commit[key]);
    if (value === null) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** commit 的作者。HF 的形状是 `authors: [{ user, ... }]`。 */
function firstAuthor(commit: Record<string, unknown>): string | null {
  for (const author of asArray(commit['authors'])) {
    const user = asString(asObject(author)?.['user']);
    if (user !== null) return user;
  }
  return asString(commit['author']);
}

/** 只用于错误信息，不泄漏响应内容。 */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}
