/**
 * 前台用到的响应类型。
 *
 * ── 两个来源，边界说清楚 ────────────────────────────────────────────
 * **凡是 `@signal/contracts` 里有的，一律从那里 re-export，绝不重定义** ——
 * 那是全系统唯一枚举来源（`docs/00`），在前端再抄一份就等于制造第二个真源。
 * 公开内容、来源、证据摘要、人物、主题都在里面（`contracts/src/dto/public.ts`）。
 *
 * 只有**没有**进契约的那几个，才在这里本地声明，并且每一条都注明出处与
 * 为什么没进契约。目前只有两个：
 *
 * | 类型                | 定义在                                        | 为什么在前端重声明 |
 * | ------------------- | --------------------------------------------- | ------------------ |
 * | `MeDto`             | `apps/api/src/modules/users/dto/me.dto.ts`     | 跨 app 应该进 contracts，但那是 Agent 00 的冻结区（Agent 02 已提 CCR-agent-02 请求提升，尚未裁决）。前端 import 不了 `apps/api`，只能镜像。 |
 * | `UserPreferences`   | `apps/api/src/modules/user-preferences/dto.ts` | 同上（Agent 09 的模块内 DTO）。取值本身**是**契约枚举（`UserTheme` / `ArticleFontSize`），所以只有容器形状是重复的。 |
 *
 * 这两处重复的代价被 `apps/web/test/contract-parity.spec.ts` 盯着：
 * 它从**源文件**里把字段名读出来与这里比对，字段改名时前端会红，
 * 而不是在运行时静默少一个字段。
 */

import type {
  ArticleFontSize,
  ContentType,
  DailyDisplayStyle,
  DailySectionType,
  EvidenceType,
  SourceKind,
  SourceTier,
  UserRole,
  UserTheme,
} from '@signal/contracts';

/* ------------------------------------------------------------------ */
/* 契约里已有的 —— 只转发，不重定义                                     */
/* ------------------------------------------------------------------ */

export type {
  PublicContent,
  PublicPerson,
  PublicSource,
  PublicTopic,
  EvidenceSummary,
} from '@signal/contracts';

export {
  ArticleFontSize,
  ContentPipelineStatus,
  ContentType,
  DailyDisplayStyle,
  DailyEditionStatus,
  DailySectionType,
  EvidenceType,
  SourceKind,
  SourceTier,
  SourceType,
  UserRole,
  UserTheme,
} from '@signal/contracts';

/* ------------------------------------------------------------------ */
/* 契约里没有的（见文件头）                                             */
/* ------------------------------------------------------------------ */

/** `GET /me`（`apps/api/src/modules/users/dto/me.dto.ts`）。不含任何凭据。 */
export type MeDto = {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: UserRole;
  createdAt: string;
};

/**
 * `GET /me/preferences`（`apps/api/src/modules/user-preferences/dto.ts`）。
 *
 * ⚠ 三个字段的**取值**是契约枚举，只有「这三个装在一个对象里」这件事是
 * 模块内约定。所以下面用契约枚举做类型，而不是字符串字面量。
 */
export type UserPreferences = {
  theme: UserTheme;
  articleFontSize: ArticleFontSize;
  defaultTranslation: boolean;
};

/* ------------------------------------------------------------------ */
/* 公开面的另外三组形状（同样是「本该在契约里」的模块内 DTO）            */
/* ------------------------------------------------------------------ */

/**
 * `GET /featured`（`apps/api/src/modules/featured/repository.ts` 的 `FeaturedRow`）。
 *
 * ⚠ **只声明前台真正要读的字段，而且刻意不声明 `content.pipelineStatus` /
 * `content.reviewStatus` / `content.publishFeatured`。**
 *
 * 那三个是编辑台的内部状态。**2026-10-01 起后端会过投影层，它们不再出现在
 * 公开响应里** —— 真源是 `apps/api/src/modules/featured/public-view.ts` 的
 * `PublicFeatured`，而这份镜像就是对着它写的（`contract-parity.spec.ts`
 * 也比的是那一份）。
 *
 * 在这之前 `/featured` 是**原样返回仓储的行**的，那三个字段确实能被 curl 到 ——
 * 当时把这件事记进了 `CONTRACT_CHANGE_REQUEST-agent-13.md` 第 2 项
 *（「日报有 `public-view.ts` 那层投影，精选没有」），现已补上。
 */
export type FeaturedRow = {
  contentId: string;
  customTitle: string | null;
  customSummary: string | null;
  sortWeight: number;
  publishedAt: string;
  active: boolean;
  content: {
    title: string;
    summary: string | null;
    originalUrl: string;
    imageUrl: string | null;
    publishedAt: string | null;
    sourceName: string;
  };
};

/** `GET /daily/:date`（`apps/api/src/modules/daily/public-view.ts`）。 */
export type PublicDailyItem = {
  contentId: string;
  displayStyle: DailyDisplayStyle;
  sortOrder: number;
  headline: string;
  excerpt: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
  type: ContentType;
  originalUrl: string;
  source: { name: string; slug: string; kind: SourceKind; tier: SourceTier; official: boolean };
};

export type PublicDailySection = {
  type: DailySectionType;
  title: string;
  sortOrder: number;
  items: PublicDailyItem[];
};

export type PublicDailyEdition = {
  businessDate: string;
  editionNo: number | null;
  editionNoLabel: string | null;
  headline: string | null;
  publishedAt: string | null;
  sections: PublicDailySection[];
};

/** `GET /daily/archive` 里的一行（`PublicDailyArchiveEntry`）。 */
export type PublicDailyArchiveEntry = {
  businessDate: string;
  editionNo: number | null;
  editionNoLabel: string | null;
  headline: string | null;
  publishedAt: string | null;
  itemCount: number;
};

/**
 * `GET /contents/:id/evidence` 里的一条。
 *
 * ⚠ 前台**只**用它做「来源/证据」入口那一小块；完整的证据链
 *（`urlHash` / `confidence` / 操作者）是后台的东西，`docs/14` 不授权搬过来。
 */
export type PublicEvidence = {
  id: string;
  evidenceType: EvidenceType;
  title: string | null;
  url: string;
  publishedAt: string | null;
  isPrimary: boolean;
  source: { name: string; slug: string; kind: SourceKind; tier: SourceTier; official: boolean };
};
