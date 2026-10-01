/**
 * 精选项的**对外投影**。
 *
 * ── 为什么要单独一层（照 `daily/public-view.ts` 的同一条理由）──────────
 * 仓储的 `FeaturedRow.content` 里带着三个**只对编辑台有意义**的字段：
 *
 * ```text
 * pipelineStatus    内容流水线状态（INGESTED / ANALYZING / REVIEW_PENDING / …）
 * reviewStatus      人工审核结论
 * publishFeatured   后台的「上精选」开关
 * ```
 *
 * 而 `GET /featured` 此前是**原样返回仓储的行** —— 也就是说这三个字段
 * **确实出现在公开响应里**：任何人不登录、一条 `curl` 就能看到某条内容的
 * 内部审核状态。
 *
 * ⚠ 这不是「以后可能会泄漏」，是**当时就在泄漏**。前端 `apps/web/lib/types.ts`
 * 里早就写着这件事（它刻意不声明那三个字段），并把它记进了
 * `CONTRACT_CHANGE_REQUEST-agent-13.md` 第 2 项：「日报有 `public-view.ts`
 * 那层投影，**精选没有**」。2026-10-01 补上。
 *
 * ── 投影层真正的价值不是「删掉这三个字段」────────────────────────────
 * 是**新增字段默认不外泄**。直接复用仓储形状的话，「以后给编辑台加一个内部字段」
 * 就自动变成「意外泄漏到前台」—— 而这类泄漏不会让任何测试变红。
 * 白名单投影让那件事必须**显式**发生。
 *
 * ⚠ 刻意用**白名单**（逐个列出要暴露的字段），而不是「展开整个对象再 delete
 * 内部字段」。黑名单要在每次新增内部字段时记得去删 —— 忘一次就泄漏一次，
 * 而且没有任何东西会提醒你。白名单的失败方向是安全的：忘了加 → 前台少一个字段
 *（看得见、有测试兜），而不是多一个内部状态（看不见）。
 */

import type { FeaturedRow } from './repository';

/** 前台一条精选（= 前端 `apps/web/lib/types.ts` 的 `FeaturedRow` 镜像的那一份）。 */
export type PublicFeatured = {
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

/**
 * `FeaturedRow` → `PublicFeatured`。
 *
 * ⚠ **逐个字段写出来是刻意的** —— 不要改成展开运算符（`{ ...row }`），
 * 那等于把白名单又变回黑名单，这个文件存在的理由就没了。
 */
export function toPublicFeatured(row: FeaturedRow): PublicFeatured {
  return {
    contentId: row.contentId,
    customTitle: row.customTitle,
    customSummary: row.customSummary,
    sortWeight: row.sortWeight,
    publishedAt: row.publishedAt,
    active: row.active,
    content: {
      title: row.content.title,
      summary: row.content.summary,
      originalUrl: row.content.originalUrl,
      imageUrl: row.content.imageUrl,
      publishedAt: row.content.publishedAt,
      sourceName: row.content.sourceName,
    },
  };
}
