/**
 * Source Registry 的请求校验与响应 DTO。
 *
 * 校验方式与 Auth 模块一致：**手写**而不是 class-validator。
 * 理由：`PATCH` 语义要求区分「字段没给」与「字段给了 null」，
 * 而 `config` 是一个按 `type` 变化的自由结构 —— 两者都不适合用
 * 声明式装饰器表达。手写还能把**所有**错误一次收齐再返回，
 * 而不是遇到第一个就退出。
 *
 * 与 `source-config.schema.ts` 的分工：
 *   - 本文件管**通用字段**（name / slug / type / kind / tier / 数值范围 …）
 *     → 失败是 `VALIDATION_FAILED`；
 *   - 那边管**按类型变化的 `config`** → 失败是 `SOURCE_CONFIG_INVALID`。
 * 分开是为了让管理员一眼看出「是表单项填错了」还是「这个类型的配置不对」。
 */

import {
  MAX_PAGE_SIZE,
  SOURCE_KINDS,
  SOURCE_TIERS,
  SOURCE_TYPES,
  SourceTier,
  type SourceKind,
  type SourceType,
} from '@signal/contracts';
import type { SourceRecord } from '../repository';
import {
  DEFAULT_FETCH_INTERVAL_SECONDS,
  isValidFetchInterval,
  MAX_FETCH_INTERVAL_SECONDS,
  MIN_FETCH_INTERVAL_SECONDS,
} from '../scheduling';

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

export const MAX_NAME_LENGTH = 255;
/** `sources.slug` 是 `VarChar(255)`。 */
export const MAX_SLUG_LENGTH = 255;
/** `sources.base_url` / `feed_url` 是 `VarChar(2048)`。 */
export const MAX_URL_LENGTH = 2048;
/** `sources.external_id` 是 `VarChar(255)`。 */
export const MAX_EXTERNAL_ID_LENGTH = 255;
/** `sources.language` 是 `Char(5)`。 */
export const MAX_LANGUAGE_LENGTH = 5;
/** `sources.last_error_code` 是 `VarChar(120)`。 */
export const MAX_ERROR_CODE_LENGTH = 120;

/**
 * `priority` 的取值范围。
 *
 * 列类型是 `TINYINT`（有符号，上限 127），但产品语义是「编辑权重」，
 * 因此收敛到 0–100 这个一眼能懂的量纲。库里的 seed 数据是 80–95，落在区间内。
 */
export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 100;

/**
 * `trustScore` 的取值范围。
 *
 * 列是 `DECIMAL(4,1)`，因此**只能有一位小数** —— 超出会在写入时被静默舍入，
 * 那种「存进去和读出来不一样」的行为必须在入口挡住。
 */
export const MIN_TRUST_SCORE = 0;
export const MAX_TRUST_SCORE = 10;

/** slug 只允许小写字母、数字与连字符，且不以连字符开头/结尾。 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 语言标签：`zh` / `en-US` 这类；列宽只有 5，过长的写法（`zh-Hans`）本就不该进来。 */
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,4})?$/;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/* ------------------------------------------------------------------ */
/* Response                                                            */
/* ------------------------------------------------------------------ */

/** Admin Source 视图。时间一律 ISO 8601 UTC 字符串，`id` 一律 string。 */
export type SourceDto = {
  id: string;
  name: string;
  slug: string;
  type: SourceType;
  kind: SourceKind;
  tier: SourceTier;
  official: boolean;
  baseUrl: string | null;
  feedUrl: string | null;
  externalId: string | null;
  language: string | null;
  priority: number;
  trustScore: number;
  fetchIntervalSeconds: number;
  enabled: boolean;
  config: Record<string, unknown> | null;
  lastFetchedAt: string | null;
  nextFetchAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toSourceDto(record: SourceRecord): SourceDto {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    type: record.type,
    kind: record.kind,
    tier: record.tier,
    official: record.official,
    baseUrl: record.baseUrl,
    feedUrl: record.feedUrl,
    externalId: record.externalId,
    language: record.language,
    priority: record.priority,
    trustScore: record.trustScore,
    fetchIntervalSeconds: record.fetchIntervalSeconds,
    enabled: record.enabled,
    config: record.config,
    lastFetchedAt: iso(record.lastFetchedAt),
    nextFetchAt: iso(record.nextFetchAt),
    lastSuccessAt: iso(record.lastSuccessAt),
    lastErrorAt: iso(record.lastErrorAt),
    lastErrorCode: record.lastErrorCode,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

/** 控制字符会进日志与响应头，任何字符串字段都不接受。 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function readStringField(
  raw: unknown,
  label: string,
  maxLength: number,
  errors: string[],
): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    errors.push(`${label} must be a string or null`);
    return undefined;
  }
  const value = raw.trim();
  if (value === '' || value.length > maxLength) {
    errors.push(`${label} must be a non-empty string of at most ${maxLength} characters`);
    return undefined;
  }
  if (hasControlCharacter(value)) {
    errors.push(`${label} must not contain control characters`);
    return undefined;
  }
  return value;
}

function readBooleanField(raw: unknown, label: string, errors: string[]): boolean | undefined {
  if (typeof raw !== 'boolean') {
    errors.push(`${label} must be a boolean`);
    return undefined;
  }
  return raw;
}

function readIntegerField(
  raw: unknown,
  label: string,
  min: number,
  max: number,
  errors: string[],
): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    errors.push(`${label} must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return raw;
}

function readEnumField<T extends string>(
  raw: unknown,
  label: string,
  allowed: readonly T[],
  errors: string[],
): T | undefined {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    errors.push(`${label} must be one of: ${allowed.join(', ')}`);
    return undefined;
  }
  return raw as T;
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

/** 新建 Source 的**已校验**输入。URL 的 SSRF 校验发生在 config 构建阶段。 */
export type CreateSourceDto = {
  name: string;
  slug: string;
  type: SourceType;
  kind: SourceKind;
  tier: SourceTier;
  official: boolean;
  baseUrl: string | null;
  feedUrl: string | null;
  externalId: string | null;
  language: string | null;
  priority: number;
  trustScore: number;
  fetchIntervalSeconds: number;
  enabled: boolean;
  /** 原样透传，由 `buildSourceConfig` 按 type 校验。 */
  config: unknown;
};

export function parseCreateSourceBody(body: unknown): ParseResult<CreateSourceDto> {
  const record = asRecord(body);
  if (record === null) return { ok: false, errors: ['body must be a JSON object'] };

  const errors: string[] = [];

  const name = readStringField(record.name, 'name', MAX_NAME_LENGTH, errors);
  const slug = readStringField(record.slug, 'slug', MAX_SLUG_LENGTH, errors);
  if (typeof slug === 'string' && !SLUG_PATTERN.test(slug)) {
    errors.push('slug must be lowercase letters, digits and hyphens (e.g. "x-karpathy")');
  }

  const type = readEnumField(record.type, 'type', SOURCE_TYPES, errors);
  const kind = readEnumField(record.kind, 'kind', SOURCE_KINDS, errors);
  const tier =
    record.tier === undefined ? undefined : readEnumField(record.tier, 'tier', SOURCE_TIERS, errors);

  const official =
    record.official === undefined ? false : readBooleanField(record.official, 'official', errors);

  const baseUrl =
    record.baseUrl === undefined
      ? null
      : readStringField(record.baseUrl, 'baseUrl', MAX_URL_LENGTH, errors);
  const feedUrl =
    record.feedUrl === undefined
      ? null
      : readStringField(record.feedUrl, 'feedUrl', MAX_URL_LENGTH, errors);
  const externalId =
    record.externalId === undefined
      ? null
      : readStringField(record.externalId, 'externalId', MAX_EXTERNAL_ID_LENGTH, errors);
  const language =
    record.language === undefined
      ? null
      : readStringField(record.language, 'language', MAX_LANGUAGE_LENGTH, errors);

  if (typeof language === 'string' && !LANGUAGE_PATTERN.test(language)) {
    errors.push('language must look like "en" or "en-US"');
  }

  const priority =
    record.priority === undefined
      ? 50
      : readIntegerField(record.priority, 'priority', MIN_PRIORITY, MAX_PRIORITY, errors);

  const trustScore =
    record.trustScore === undefined ? 7 : readTrustScore(record.trustScore, errors);

  const fetchIntervalSeconds =
    record.fetchIntervalSeconds === undefined
      ? DEFAULT_FETCH_INTERVAL_SECONDS
      : readFetchInterval(record.fetchIntervalSeconds, errors);

  const enabled =
    record.enabled === undefined ? true : readBooleanField(record.enabled, 'enabled', errors);

  // 逐个点名缺失的必填项：一次把问题说清，而不是遇到第一个就返回。
  if (typeof name !== 'string') errors.push('name is required');
  if (typeof slug !== 'string') errors.push('slug is required');
  if (type === undefined) errors.push('type is required');
  if (kind === undefined) errors.push('kind is required');

  if (
    errors.length > 0 ||
    typeof name !== 'string' ||
    typeof slug !== 'string' ||
    type === undefined ||
    kind === undefined ||
    tier === null ||
    official === undefined ||
    priority === undefined ||
    trustScore === undefined ||
    fetchIntervalSeconds === undefined ||
    enabled === undefined ||
    baseUrl === undefined ||
    feedUrl === undefined ||
    externalId === undefined ||
    language === undefined
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      name,
      slug,
      type,
      kind,
      // 未指定时的默认值与 `prisma/schema.prisma` 的 `@default(B)` 保持一致。
      tier: tier ?? SourceTier.B,
      official,
      baseUrl,
      feedUrl,
      externalId,
      language,
      priority,
      trustScore,
      fetchIntervalSeconds,
      enabled,
      config: hasOwn(record, 'config') ? record.config : undefined,
    },
  };
}

/** `DECIMAL(4,1)` 只能有一位小数 —— 超出的精度会被库静默舍入。 */
function readTrustScore(raw: unknown, errors: string[]): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push('trustScore must be a number');
    return undefined;
  }
  if (raw < MIN_TRUST_SCORE || raw > MAX_TRUST_SCORE) {
    errors.push(`trustScore must be between ${MIN_TRUST_SCORE} and ${MAX_TRUST_SCORE}`);
    return undefined;
  }
  if (Math.round(raw * 10) !== raw * 10) {
    errors.push('trustScore supports at most one decimal place');
    return undefined;
  }
  return raw;
}

function readFetchInterval(raw: unknown, errors: string[]): number | undefined {
  if (typeof raw !== 'number' || !isValidFetchInterval(raw)) {
    errors.push(
      `fetchIntervalSeconds must be an integer between ${MIN_FETCH_INTERVAL_SECONDS} and ${MAX_FETCH_INTERVAL_SECONDS}`,
    );
    return undefined;
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

/**
 * 局部更新。**只包含请求里真正出现的字段** —— 缺失即不改动。
 *
 * `null` 是有意义的值（清空 `feedUrl` / `baseUrl` / `config`），
 * 因此这里用「键是否存在」而不是「值是否为 undefined」来表达意图。
 */
export type UpdateSourceDto = Partial<CreateSourceDto>;

export function parseUpdateSourceBody(body: unknown): ParseResult<UpdateSourceDto> {
  const record = asRecord(body);
  if (record === null) return { ok: false, errors: ['body must be a JSON object'] };

  const errors: string[] = [];
  const patch: UpdateSourceDto = {};

  if (hasOwn(record, 'name')) {
    const name = readStringField(record.name, 'name', MAX_NAME_LENGTH, errors);
    if (typeof name === 'string') patch.name = name;
  }
  if (hasOwn(record, 'slug')) {
    const slug = readStringField(record.slug, 'slug', MAX_SLUG_LENGTH, errors);
    if (typeof slug === 'string') {
      if (SLUG_PATTERN.test(slug)) patch.slug = slug;
      else errors.push('slug must be lowercase letters, digits and hyphens');
    }
  }
  if (hasOwn(record, 'type')) {
    const type = readEnumField(record.type, 'type', SOURCE_TYPES, errors);
    if (type !== undefined) patch.type = type;
  }
  if (hasOwn(record, 'kind')) {
    const kind = readEnumField(record.kind, 'kind', SOURCE_KINDS, errors);
    if (kind !== undefined) patch.kind = kind;
  }
  if (hasOwn(record, 'tier')) {
    const tier = readEnumField(record.tier, 'tier', SOURCE_TIERS, errors);
    if (tier !== undefined) patch.tier = tier;
  }
  if (hasOwn(record, 'official')) {
    const official = readBooleanField(record.official, 'official', errors);
    if (official !== undefined) patch.official = official;
  }
  if (hasOwn(record, 'enabled')) {
    const enabled = readBooleanField(record.enabled, 'enabled', errors);
    if (enabled !== undefined) patch.enabled = enabled;
  }
  if (hasOwn(record, 'baseUrl')) {
    const value = readStringField(record.baseUrl, 'baseUrl', MAX_URL_LENGTH, errors);
    if (value !== undefined) patch.baseUrl = value;
  }
  if (hasOwn(record, 'feedUrl')) {
    const value = readStringField(record.feedUrl, 'feedUrl', MAX_URL_LENGTH, errors);
    if (value !== undefined) patch.feedUrl = value;
  }
  if (hasOwn(record, 'externalId')) {
    const value = readStringField(record.externalId, 'externalId', MAX_EXTERNAL_ID_LENGTH, errors);
    if (value !== undefined) patch.externalId = value;
  }
  if (hasOwn(record, 'language')) {
    const value = readStringField(record.language, 'language', MAX_LANGUAGE_LENGTH, errors);
    if (value !== undefined) {
      if (value !== null && !LANGUAGE_PATTERN.test(value)) {
        errors.push('language must look like "en" or "en-US"');
      } else {
        patch.language = value;
      }
    }
  }
  if (hasOwn(record, 'priority')) {
    const value = readIntegerField(record.priority, 'priority', MIN_PRIORITY, MAX_PRIORITY, errors);
    if (value !== undefined) patch.priority = value;
  }
  if (hasOwn(record, 'trustScore')) {
    const value = readTrustScore(record.trustScore, errors);
    if (value !== undefined) patch.trustScore = value;
  }
  if (hasOwn(record, 'fetchIntervalSeconds')) {
    const value = readFetchInterval(record.fetchIntervalSeconds, errors);
    if (value !== undefined) patch.fetchIntervalSeconds = value;
  }
  if (hasOwn(record, 'config')) {
    patch.config = record.config;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: patch };
}

/* ------------------------------------------------------------------ */
/* List query                                                          */
/* ------------------------------------------------------------------ */

export type SourceListQueryDto = {
  page: number;
  pageSize: number;
  type?: SourceType;
  kind?: SourceKind;
  tier?: SourceTier;
  enabled?: boolean;
  q?: string;
};

/** Admin 列表查询参数。非法值直接报错而不是静默用默认值 —— 那会让分页悄悄错位。 */
export function parseSourceListQuery(query: unknown): ParseResult<SourceListQueryDto> {
  const record = asRecord(query) ?? {};
  const errors: string[] = [];

  const page = readQueryInteger(record.page, 'page', 1, 1_000_000, 1, errors);
  const pageSize = readQueryInteger(record.pageSize, 'pageSize', 1, MAX_PAGE_SIZE, 20, errors);

  const result: SourceListQueryDto = {
    page: page ?? 1,
    pageSize: pageSize ?? 20,
  };

  const type = readQueryEnum(record.type, 'type', SOURCE_TYPES, errors);
  if (type !== undefined) result.type = type;
  const kind = readQueryEnum(record.kind, 'kind', SOURCE_KINDS, errors);
  if (kind !== undefined) result.kind = kind;
  const tier = readQueryEnum(record.tier, 'tier', SOURCE_TIERS, errors);
  if (tier !== undefined) result.tier = tier;

  if (record.enabled !== undefined) {
    if (record.enabled === 'true') result.enabled = true;
    else if (record.enabled === 'false') result.enabled = false;
    else errors.push('enabled must be "true" or "false"');
  }

  if (record.q !== undefined) {
    if (typeof record.q !== 'string' || record.q.length > MAX_NAME_LENGTH) {
      errors.push(`q must be a string of at most ${MAX_NAME_LENGTH} characters`);
    } else if (record.q.trim() !== '') {
      result.q = record.q.trim();
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: result };
}

function readQueryInteger(
  raw: unknown,
  label: string,
  min: number,
  max: number,
  fallback: number,
  errors: string[],
): number | undefined {
  if (raw === undefined) return fallback;
  // query string 里一切都是字符串，因此这里接受数字串。
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${label} must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return value;
}

function readQueryEnum<T extends string>(
  raw: unknown,
  label: string,
  allowed: readonly T[],
  errors: string[],
): T | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    errors.push(`${label} must be one of: ${allowed.join(', ')}`);
    return undefined;
  }
  return raw as T;
}
