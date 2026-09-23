/**
 * 前台公开 DTO — 跨 app 共享。
 *
 * 逐字对应开发包 `reference/contracts.ts`（Agent 00 负责其可执行版本）。
 * 这些类型同时被 API（Agent 10 Public API）与 Web（Agent 13）使用，
 * 因此必须在 contracts 中唯一定义。
 *
 * 范围说明：本文件只包含冻结参考中已列出的公开 DTO。
 * 模块内部的 request DTO、以及各模块自己的 read model，
 * 按 `docs/18` 留在模块目录内，由对应 Agent 负责，
 * 但必须复用此处的封套与枚举。
 */

import type { ContentType, SourceKind, SourceTier, SourceType } from '../enums';

/** 前台可见的来源信息。 */
export type PublicSource = {
  id: string;
  name: string;
  slug: string;
  type: SourceType;
  kind: SourceKind;
  tier: SourceTier;
  official: boolean;
};

/**
 * 内容页的证据摘要。
 * 前台必须始终能追溯来源（`docs/00`：任何公开内容必须可追溯到原始来源）。
 */
export type EvidenceSummary = {
  /** 独立来源数：V1 按不同 source_id 计算。 */
  independentSourceCount: number;
  primarySource: PublicSource | null;
  hasOfficialConfirmation: boolean;
};

export type PublicPerson = {
  id: string;
  name: string;
  slug: string;
  xHandle?: string | null;
  avatarUrl?: string | null;
};

export type PublicTopic = {
  id: string;
  name: string;
  slug: string;
};

/**
 * 前台内容详情。
 *
 * 注意：
 *   - `bodyOriginal` 永远不被 `bodyTranslated` 覆盖（docs/00）。
 *   - `originalUrl` 必须始终返回。
 *   - `bookmarked` 只在登录请求时存在，游客为 undefined。
 */
export type PublicContent = {
  id: string;
  type: ContentType;
  title: string;
  summary: string | null;
  bodyOriginal: string | null;
  bodyTranslated: string | null;
  language: string;
  originalUrl: string;
  imageUrl: string | null;
  publishedAt: string | null;
  source: PublicSource;
  author: PublicPerson | null;
  topics: PublicTopic[];
  recommendationReason: string | null;
  evidenceSummary: EvidenceSummary;
  bookmarked?: boolean;
};
