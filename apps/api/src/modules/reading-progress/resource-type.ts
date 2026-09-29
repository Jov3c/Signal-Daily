/**
 * 阅读进度的资源类型。
 *
 * ── ⚠ 为什么这是本模块**自己定的**取值集合（并已提 CCR）──────────────
 * `prisma/schema.prisma` 里 `reading_progress.resource_type` 是
 * **`VarChar(30)`**，而 `docs/05` 的枚举清单里**没有**对应的枚举
 * （`docs/04` 也只写了 `PUT /reading-progress`，没给请求体形状）。
 *
 * 于是「允许哪些取值」没有契约可依。本模块的取值：
 *
 * ```text
 * CONTENT   一篇文章 / 一条内容（V1 唯一的取值）
 * ```
 *
 * 明确定义而不是「接受任意字符串」的理由：`resource_type` 参与**主键**
 * （`@@id([userId, resourceType, resourceId])`），任意字符串意味着
 * 调用方可以往库里灌入无界的垃圾键 —— 那些行永远没人读、也不会被清理。
 */
export const READING_RESOURCE_TYPES = ['CONTENT'] as const;

export type ReadingResourceType = (typeof READING_RESOURCE_TYPES)[number];

/** 该字符串是不是 V1 支持的资源类型。 */
export function isReadingResourceType(value: unknown): value is ReadingResourceType {
  return typeof value === 'string' && (READING_RESOURCE_TYPES as readonly string[]).includes(value);
}
