/**
 * 类型化 config 校验 —— `tasks/agent-03-sources.md` 的「type-specific config validation」。
 *
 * ── 为什么 `config` 需要一个专门的校验层 ─────────────────────────────
 * `Source.type` 决定「怎么抓」，不同 Adapter 需要的参数完全不同：
 * X 要 handle 与「是否收录转发」，RSS 要条目上限，HN 要榜单类型。
 * 而 `sources.config` 在库里是一个 `Json?` 列 —— 数据库帮不上任何忙。
 * 如果这里不校验，管理员在后台把 `includeQuotes` 敲成 `includQuotes`，
 * 保存会成功、采集行为却静默变了，且没有任何地方会报错。
 *
 * 所以本层的规则是**严格的白名单**：该类型未声明的键一律拒绝。
 *
 * ── 两个刻意的例外（设计取舍，已记入 HANDOFF）────────────────────────
 * 1. `seed` / `seedNote` 在所有类型上都放行。它们是 Agent 01 seed 写入的
 *    **来源标记**（`{seed: true, seedNote: '...'}`），不是业务配置。
 *    若不放行，管理员在 Admin UI（Agent 12）里回传一次完整 config
 *    就会被拒 —— 那是个纯粹的集成摩擦，不是安全收益。
 * 2. URL 类字段分两步判：**先判「有没有给」，再判「能不能用」**。
 *    缺字段 → `SOURCE_CONFIG_INVALID`；给了但指向内网 →
 *    `SOURCE_URL_NOT_ALLOWED`。两件事对管理员的意义不同，
 *    合并成一个错误码会让「地址格式不对」和「忘了填」分不开。
 */

import { AppError, DomainErrorCode, SourceType } from '@signal/contracts';
import { assertSafeSourceUrl } from './url-safety';

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/** X handle：15 字符以内，字母数字下划线。 */
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** `owner/name` 形状（GitHub repo、Hugging Face repo）。 */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** RSS 单次最多取多少条。 */
export const MIN_RSS_MAX_ITEMS = 1;
export const MAX_RSS_MAX_ITEMS = 500;
export const DEFAULT_RSS_MAX_ITEMS = 50;

/** HN 支持的内置榜单。 */
export const HACKER_NEWS_FEEDS = ['top', 'new', 'best', 'ask', 'show', 'job'] as const;
export type HackerNewsFeed = (typeof HACKER_NEWS_FEEDS)[number];

/** Hugging Face 的资源类型。 */
export const HUGGINGFACE_REPO_TYPES = ['model', 'dataset', 'space'] as const;
export type HuggingFaceRepoType = (typeof HUGGINGFACE_REPO_TYPES)[number];

/** 所有类型都允许的透传键（Agent 01 的 seed 标记）。 */
const PASSTHROUGH_KEYS: readonly string[] = ['seed', 'seedNote'];

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

/** 校验输入。URL 类字段已经过 SSRF 语法校验（在 DTO 层做）。 */
export type SourceConfigInput = {
  type: SourceType;
  /** 请求里原样传来的 config（未知结构）。 */
  config: unknown;
  externalId: string | null;
  feedUrl: string | null;
  baseUrl: string | null;
  /**
   * 库里**已有**的 config（新建时为 null）。
   *
   * 唯一用途是让 `seed` / `seedNote` 这类「来源标记」能被继承 ——
   * 见 `copyPassthrough()`。
   */
  previousConfig: Record<string, unknown> | null;
};

/**
 * 校验结果。
 *
 * `config === null` 表示「不写 config」（全部字段都是默认值时不留空壳对象）。
 * 三个列字段是**归一化后**的值 —— 调用方必须写这三个，而不是原始输入。
 */
export type ValidatedSourceConfig = {
  config: Record<string, unknown>;
  externalId: string | null;
  feedUrl: string | null;
  baseUrl: string | null;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** 抛出统一的 config 校验失败。`fields` 只含字段名与原因，不含输入值。 */
function invalidConfig(type: SourceType, fields: string[]): AppError {
  return new AppError({
    code: DomainErrorCode.SOURCE_CONFIG_INVALID,
    httpStatus: 400,
    safeMessage: `Source config is invalid for type ${type}`,
    details: { fields },
  });
}

function asConfigRecord(type: SourceType, raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidConfig(type, ['config must be a JSON object']);
  }
  return raw as Record<string, unknown>;
}

/** 拒绝该类型未声明的键。 */
function rejectUnknownKeys(
  type: SourceType,
  raw: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allow = new Set([...allowed, ...PASSTHROUGH_KEYS]);
  const unknown = Object.keys(raw).filter((key) => !allow.has(key));
  if (unknown.length > 0) {
    throw invalidConfig(
      type,
      unknown.map((key) => `config.${key} is not a supported key for ${type}`),
    );
  }
}

function readBoolean(
  type: SourceType,
  raw: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalidConfig(type, [`config.${key} must be a boolean`]);
  return value;
}

function readInteger(
  type: SourceType,
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidConfig(type, [`config.${key} must be an integer between ${min} and ${max}`]);
  }
  return value;
}

function readString(
  type: SourceType,
  raw: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw invalidConfig(type, [
      `config.${key} must be a non-empty string of at most ${maxLength} characters`,
    ]);
  }
  return value.trim();
}

function readEnum<T extends string>(
  type: SourceType,
  raw: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw invalidConfig(type, [`config.${key} must be one of: ${values.join(', ')}`]);
  }
  return value as T;
}

/**
 * 写入 config 时**把该类型的全部已声明键都显式写出来**（含默认值）。
 *
 * 早期版本用的是「只在偏离默认值时才写」（稀疏存储）。改成全量快照的理由：
 * 稀疏存储下，管理员 `PATCH {tier}` 这种不碰 config 的编辑，会因为
 * config 只由已存在的稀疏对象推出，导致 `includeQuotes` 这类**没写在库里的键
 * 在概念上退回到代码默认值** —— 而 Collector（Agent 04）读的正是这份 JSON。
 * 一旦两边的默认值假设不一致，采集行为就会静默变化，且没有任何地方报错。
 *
 * 全量快照让「管理员看到的」与「库里存的」与「采集器读到的」三者一致。
 */

/**
 * 保留 `seed` / `seedNote` 标记。
 *
 * ⚠ 取值顺序是「请求体优先，其次从**已有 config** 继承」。
 * 只从请求体取是错的（独立审查 P3-2 实测）：管理员在 Admin UI 里只改一个
 * `handle`，表单往往只回传业务字段，于是 seed 标记被静默抹掉 ——
 * 而它是区分「seed 演示数据」与「真实数据」的**唯一**标记，
 * `docs/00` 又要求这些演示源上线前人工核验。丢了就再也分不出来。
 */
function copyPassthrough(
  raw: Record<string, unknown>,
  target: Record<string, unknown>,
  previous: Record<string, unknown> | null,
): void {
  for (const key of PASSTHROUGH_KEYS) {
    const value = raw[key] ?? previous?.[key];
    if (value !== undefined) target[key] = value;
  }
}

/** 两个来源给了同一个字段但值不同 —— 这是配置冲突，不能悄悄选一个。 */
function requireConsistent(
  type: SourceType,
  label: string,
  first: string | null,
  second: string | null,
): string | null {
  if (first !== null && second !== null && first !== second) {
    throw invalidConfig(type, [`${label} is given twice with different values`]);
  }
  return first ?? second;
}

/**
 * 「给了就必须是合法且公网的地址」。
 *
 * 缺失由调用方判；失败会抛 `UrlSafetyError`（`SOURCE_URL_NOT_ALLOWED`），
 * **刻意不折成 config 错误** —— 见文件头「两个刻意的例外」第 2 条。
 */
function readOptionalUrl(value: string | null): string | null {
  if (value === null) return null;
  return assertSafeSourceUrl(value).toString();
}

/* ------------------------------------------------------------------ */
/* Per-type validation                                                 */
/* ------------------------------------------------------------------ */

export function buildSourceConfig(input: SourceConfigInput): ValidatedSourceConfig {
  const raw = asConfigRecord(input.type, input.config);
  const shared = {
    externalId: input.externalId,
    feedUrl: input.feedUrl,
    baseUrl: readOptionalUrl(input.baseUrl),
    previous: input.previousConfig,
  };

  switch (input.type) {
    case SourceType.RSS:
      return validateRss(raw, shared);
    case SourceType.X_USER:
      return validateXUser(raw, shared);
    case SourceType.GITHUB_REPO:
      return validateGithubRepo(raw, shared);
    case SourceType.HACKER_NEWS:
      return validateHackerNews(raw, shared);
    case SourceType.HUGGINGFACE:
      return validateHuggingFace(raw, shared);
    case SourceType.MANUAL_URL:
      return validateManualUrl(raw, shared);
    default: {
      // 新增了 SourceType 而忘了在这里处理 —— 宁可当场炸，也不要静默放行。
      const exhaustive: never = input.type;
      throw invalidConfig(exhaustive, ['unsupported SourceType']);
    }
  }
}

type SharedInput = {
  externalId: string | null;
  feedUrl: string | null;
  baseUrl: string | null;
  previous: Record<string, unknown> | null;
};

/**
 * RSS / Atom。
 *
 * feed URL 的**权威位置是 `sources.feed_url` 列**（`docs/03` 就是这么建的），
 * 因此 `config.feedUrl` 只作为输入别名被接受、然后**提升到列里**，
 * 绝不会同时留在 config —— 两个事实源迟早会不一致。
 */
function validateRss(raw: Record<string, unknown>, shared: SharedInput): ValidatedSourceConfig {
  const type = SourceType.RSS;
  rejectUnknownKeys(type, raw, ['feedUrl', 'maxItems']);

  const fromConfig = readString(type, raw, 'feedUrl', 2048) ?? null;
  const feedUrl = readOptionalUrl(requireConsistent(type, 'feedUrl', shared.feedUrl, fromConfig));

  if (feedUrl === null && shared.baseUrl === null) {
    throw invalidConfig(type, ['RSS source requires feedUrl or baseUrl']);
  }

  const config: Record<string, unknown> = {};
  config.maxItems = readInteger(
    type,
    raw,
    'maxItems',
    MIN_RSS_MAX_ITEMS,
    MAX_RSS_MAX_ITEMS,
    DEFAULT_RSS_MAX_ITEMS,
  );
  copyPassthrough(raw, config, shared.previous);

  return { config, externalId: shared.externalId, feedUrl, baseUrl: shared.baseUrl };
}

/**
 * X 白名单账号。
 *
 * `type=X_USER` 就是 `docs/06` 的「X 动态白名单实体」。**不存在用户订阅**：
 * 这里没有、也不允许出现任何 follow / subscribe 语义，
 * 它只是管理员维护的一份账号清单。
 *
 * 默认值取自 `docs/06`：「保留原创 Post、可选 Quote Post、
 * 默认排除 Reply、默认排除纯 Repost」。
 */
function validateXUser(raw: Record<string, unknown>, shared: SharedInput): ValidatedSourceConfig {
  const type = SourceType.X_USER;
  rejectUnknownKeys(type, raw, ['handle', 'includeQuotes', 'includeReplies', 'includeReposts']);

  const handle = readString(type, raw, 'handle', 15);
  if (handle === undefined) {
    throw invalidConfig(type, ['X_USER source requires config.handle']);
  }
  if (!X_HANDLE.test(handle)) {
    throw invalidConfig(type, ['config.handle must be 1-15 characters of A-Z a-z 0-9 _']);
  }

  // externalId 与 handle 是同一件事的两种写法（docs/04 的示例两者相同）。
  // 给了但对不上，一定是哪里错了 —— 当场报错，不要挑一个用。
  if (shared.externalId !== null && shared.externalId.toLowerCase() !== handle.toLowerCase()) {
    throw invalidConfig(type, ['externalId must match config.handle for X_USER sources']);
  }

  const config: Record<string, unknown> = { handle };
  config.includeQuotes = readBoolean(type, raw, 'includeQuotes', true);
  config.includeReplies = readBoolean(type, raw, 'includeReplies', false);
  config.includeReposts = readBoolean(type, raw, 'includeReposts', false);
  copyPassthrough(raw, config, shared.previous);

  return {
    config,
    // 归一化成 handle，让 `external_id` 恒等于账号名（大小写以管理员输入为准）。
    externalId: handle,
    feedUrl: null,
    baseUrl: shared.baseUrl,
  };
}

/** GitHub 仓库 / Release。 */
function validateGithubRepo(
  raw: Record<string, unknown>,
  shared: SharedInput,
): ValidatedSourceConfig {
  const type = SourceType.GITHUB_REPO;
  rejectUnknownKeys(type, raw, ['repo', 'includeReleases']);

  const fromConfig = readString(type, raw, 'repo', 201) ?? null;
  const repo = requireConsistent(type, 'repo', shared.externalId, fromConfig);
  if (repo === null) {
    throw invalidConfig(type, ['GITHUB_REPO source requires config.repo or externalId']);
  }
  if (!REPO_SLUG.test(repo)) {
    throw invalidConfig(type, ['repository must look like owner/name']);
  }

  const config: Record<string, unknown> = {};
  config.includeReleases = readBoolean(type, raw, 'includeReleases', true);
  copyPassthrough(raw, config, shared.previous);

  return { config, externalId: repo, feedUrl: null, baseUrl: shared.baseUrl };
}

/** Hacker News 内置榜单。没有需要 SSRF 校验的外部 URL —— 端点由适配器固定。 */
function validateHackerNews(
  raw: Record<string, unknown>,
  shared: SharedInput,
): ValidatedSourceConfig {
  const type = SourceType.HACKER_NEWS;
  rejectUnknownKeys(type, raw, ['feed', 'minScore']);

  const config: Record<string, unknown> = {};
  config.feed = readEnum(type, raw, 'feed', HACKER_NEWS_FEEDS, 'top');
  config.minScore = readInteger(type, raw, 'minScore', 0, 10_000, 0);
  copyPassthrough(raw, config, shared.previous);

  return { config, externalId: shared.externalId, feedUrl: null, baseUrl: shared.baseUrl };
}

/** Hugging Face 模型 / 数据集 / Space。 */
function validateHuggingFace(
  raw: Record<string, unknown>,
  shared: SharedInput,
): ValidatedSourceConfig {
  const type = SourceType.HUGGINGFACE;
  rejectUnknownKeys(type, raw, ['repoType', 'repoId']);

  const fromConfig = readString(type, raw, 'repoId', 201) ?? null;
  const repoId = requireConsistent(type, 'repoId', shared.externalId, fromConfig);
  if (repoId === null) {
    throw invalidConfig(type, ['HUGGINGFACE source requires config.repoId or externalId']);
  }
  if (!REPO_SLUG.test(repoId)) {
    throw invalidConfig(type, ['repoId must look like owner/name']);
  }

  const config: Record<string, unknown> = {};
  config.repoType = readEnum(type, raw, 'repoType', HUGGINGFACE_REPO_TYPES, 'model');
  copyPassthrough(raw, config, shared.previous);

  return { config, externalId: repoId, feedUrl: null, baseUrl: shared.baseUrl };
}

/** 管理员手工指定的单个 URL。抓取目标就在 config 里，且必须有。 */
function validateManualUrl(raw: Record<string, unknown>, shared: SharedInput): ValidatedSourceConfig {
  const type = SourceType.MANUAL_URL;
  rejectUnknownKeys(type, raw, ['url', 'note']);

  const url = readString(type, raw, 'url', 2048);
  if (url === undefined) {
    throw invalidConfig(type, ['MANUAL_URL source requires config.url']);
  }
  // 先判「有没有」再判「能不能用」：缺失是 config 问题，私网地址是安全问题。
  const safeUrl = assertSafeSourceUrl(url).toString();

  const config: Record<string, unknown> = { url: safeUrl };
  const note = readString(type, raw, 'note', 500);
  if (note !== undefined) config.note = note;
  copyPassthrough(raw, config, shared.previous);

  return {
    config,
    externalId: shared.externalId,
    feedUrl: null,
    baseUrl: shared.baseUrl,
  };
}

