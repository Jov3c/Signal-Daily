/**
 * `PublicReadService` —— 公开读（`docs/04` 的 Public 段）。
 *
 * ── 本模块负责哪些路由 ──────────────────────────────────────────────
 *
 * ```text
 * GET /today                    今日视图          ← 本模块
 * GET /contents/:id             内容详情 + 证据口径 ← 本模块
 * GET /contents/:id/evidence    公开证据链        ← 本模块
 * GET /x?cursor=&category=&personId=  X 动态      ← 本模块
 * GET /people        /people/:slug                ← 本模块
 * GET /topics        /topics/:slug                ← 本模块
 * GET /sources/:slug                              ← 本模块
 * GET /search?q=                FULLTEXT 搜索     ← `modules/search`（Agent 10 的另一半）
 *
 * GET /featured · /daily/:date · /daily/archive   ← **Agent 08 已实现**，
 *   本模块**不重做**（`imports: [FeaturedModule, DailyModule]` 即可复用）。
 * ```
 *
 * ── 缓存的用法（`docs/12`）──────────────────────────────────────────
 * 「读缓存 → 未命中则查库 → 回填」三步，键与 TTL 见 `cache.ts`。
 * ⚠ 缓存**只缓存成功的查询结果**：查不到（404）不缓存 ——
 * 否则一次误请求会把「不存在」记住，而内容可能随后被创建。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AppError, PlatformErrorCode } from '@signal/contracts';
import { businessDateOf, businessDayRangeUtc } from '@signal/config';
import {
  CONTENT_CACHE_TTL_SECONDS,
  METADATA_CACHE_TTL_SECONDS,
  PUBLIC_CACHE,
  cacheKeys,
  type PublicCache,
} from './cache';
import { PUBLIC_READ_REPOSITORY, type PublicReadRepository } from './repository';
import { toPublicReadId } from './bigint-id';

/** 注入 token：可注入时钟（「今日」的边界必须可断言）。 */
export const PUBLIC_READ_CLOCK = 'PUBLIC_READ_CLOCK';

export interface PublicReadClock {
  now(): Date;
}

/** `/today` 的返回形状（`docs/04` 只写了「Today editorial view」）。 */
export type TodayView = {
  businessDate: string;
  /** 当日高分内容（`minScore` 以上），按分数倒序。 */
  featured: Awaited<ReturnType<PublicReadRepository['listByWindow']>>;
  /** 当日最新内容，按发布时间倒序。 */
  latest: Awaited<ReturnType<PublicReadRepository['listByWindow']>>;
};

/** `/today` 的规模（`docs/04` 没有给 —— 本模块取值）。 */
export const TODAY_FEATURED_LIMIT = 10;
export const TODAY_LATEST_LIMIT = 20;
/** 「高分」的门槛：与 `docs/08` 的「推荐」档一致（>= 70）。 */
export const TODAY_FEATURED_MIN_SCORE = 70;

@Injectable()
export class PublicReadService {
  constructor(
    @Inject(PUBLIC_READ_REPOSITORY) private readonly repository: PublicReadRepository,
    @Inject(PUBLIC_CACHE) private readonly cache: PublicCache,
    @Inject(PUBLIC_READ_CLOCK) private readonly clock: PublicReadClock,
  ) {}

  /* ---------------------------------------------------------------- */
  /* 今日                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 今日视图。
   *
   * ⚠ `docs/04` 只写了 `GET /today`（「Today editorial view」），**没有给形状** ——
   * 下面的形状是本模块定义并提了 CCR 的。
   *
   * 窗口用**上海业务日**（`businessDayRangeUtc`），不是 UTC 日 ——
   * 否则上海用户每天早上 8 点会看到「昨天」的今日。
   */
  async today(): Promise<TodayView> {
    const businessDate = businessDateOf(this.clock.now());
    const cached = await this.cache.get<TodayView>(cacheKeys.today());
    if (cached !== null) return cached;

    const { startUtc, endUtc } = businessDayRangeUtc(businessDate);
    const [featured, latest] = await Promise.all([
      this.repository.listByWindow({
        startUtc,
        endUtc,
        limit: TODAY_FEATURED_LIMIT,
        // 当日**高分** —— 按 finalScore。
        sort: 'score',
        minScore: TODAY_FEATURED_MIN_SCORE,
      }),
      this.repository.listByWindow({
        startUtc,
        endUtc,
        limit: TODAY_LATEST_LIMIT,
        // ⚠ 当日**最新** —— 按发布时间。此前这里没传 `sort`（那时它写死按分数），
        // 于是「最新」实际按分数排，与 `TodayView.latest` 的文档矛盾。
        sort: 'latest',
      }),
    ]);

    const view: TodayView = { businessDate, featured, latest };
    await this.cache.set(cacheKeys.today(), view, CONTENT_CACHE_TTL_SECONDS);
    return view;
  }

  /* ---------------------------------------------------------------- */
  /* 内容与证据                                                        */
  /* ---------------------------------------------------------------- */

  async content(rawId: string) {
    const contentId = toPublicReadId(rawId);
    if (contentId === null) throw notVisible(rawId);

    const key = cacheKeys.content(rawId);
    const cached =
      await this.cache.get<Awaited<ReturnType<PublicReadRepository['findContent']>>>(key);
    if (cached !== null) return cached;

    const row = await this.repository.findContent(contentId);
    // ⚠ 「不存在」与「存在但未审核」都 404 且**不缓存** ——
    // 后者若被缓存，管理员刚审核通过的内容会在 TTL 内仍然 404。
    if (row === null) throw notVisible(rawId);

    await this.cache.set(key, row, CONTENT_CACHE_TTL_SECONDS);
    return row;
  }

  /**
   * 公开证据链。
   *
   * ⚠ **按内容 id 取，而不是按事件 id** —— `docs/04` 的路由是
   * `/contents/:id/evidence`。内容 → 它所属的事件 → 该事件的证据链。
   *
   * 内容没有事件、或事件没有证据时返回**空数组**（不是 404）：
   * 「这篇内容没有证据链」是一个正常状态，不是错误。
   */
  async contentEvidence(rawId: string) {
    const contentId = toPublicReadId(rawId);
    if (contentId === null) throw notVisible(rawId);

    // 先确认内容**可见** —— 否则这个接口会变成一个「某 id 是否存在」的探测器，
    // 而且会泄漏不可见内容的证据链。
    const content = await this.repository.findContent(contentId);
    if (content === null) throw notVisible(rawId);

    const eventId = await this.repository.findContentEventId(contentId);
    if (eventId === null) return { contentId: String(contentId), eventId: null, evidence: [] };

    const key = cacheKeys.evidence(String(eventId));
    const cached =
      await this.cache.get<Awaited<ReturnType<PublicReadRepository['findEventEvidence']>>>(key);
    if (cached !== null) {
      return { contentId: String(contentId), eventId: String(eventId), evidence: cached };
    }

    const evidence = (await this.repository.findEventEvidence(eventId)) ?? [];
    await this.cache.set(key, evidence, CONTENT_CACHE_TTL_SECONDS);
    return { contentId: String(contentId), eventId: String(eventId), evidence };
  }

  /* ---------------------------------------------------------------- */
  /* X 动态                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * X 动态。
   *
   * ⚠ `docs/04`：「只返回 `Source.type = X_USER` 且 `enabled = true` 的
   * X Content」，「**不存在**用户 follow/subscription 参数」。
   * 因此本方法**只有** `category`（人物分类）与 `personId` 两个筛选维度，
   * 它们都作用于**后台维护的元数据**，与「当前用户」无关。
   */
  async x(input: { limit: number; cursor?: string; category?: string; personId?: string }) {
    const personId = input.personId === undefined ? undefined : toPublicReadId(input.personId);
    if (input.personId !== undefined && personId === null) {
      throw new AppError({
        code: PlatformErrorCode.VALIDATION_FAILED,
        httpStatus: 400,
        safeMessage: 'Invalid personId',
        details: { fields: ['personId: must be a decimal string'] },
      });
    }

    const category = input.category ?? '';
    const cursorKey = input.cursor ?? '';
    const key = cacheKeys.x(`${category}|${input.personId ?? ''}`, cursorKey);

    const cached = await this.cache.get<Awaited<ReturnType<PublicReadRepository['listX']>>>(key);
    if (cached !== null) return cached;

    const result = await this.repository.listX({
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(personId === null || personId === undefined ? {} : { personId }),
    });

    // ⚠ X 流用**元数据 TTL**（300 秒）：它是按时间倒序的列表，
    // 5 分钟的陈旧对读者无感，而它是最热的键（首页 Tab）。
    await this.cache.set(key, result, METADATA_CACHE_TTL_SECONDS);
    return result;
  }

  /* ---------------------------------------------------------------- */
  /* 人物 / 主题 / 来源                                                 */
  /* ---------------------------------------------------------------- */

  async people() {
    const key = cacheKeys.people();
    const cached =
      await this.cache.get<Awaited<ReturnType<PublicReadRepository['listPeople']>>>(key);
    if (cached !== null) return cached;

    const rows = await this.repository.listPeople();
    await this.cache.set(key, rows, METADATA_CACHE_TTL_SECONDS);
    return rows;
  }

  async person(slug: string, limit: number) {
    const person = await this.repository.findPersonBySlug(slug);
    if (person === null) throw notFound('Person', slug);

    const contents = await this.repository.listPersonContents({
      personId: BigInt(person.id),
      limit: limit,
    });
    return { ...person, contents };
  }

  async topics() {
    const key = cacheKeys.topics();
    const cached =
      await this.cache.get<Awaited<ReturnType<PublicReadRepository['listTopics']>>>(key);
    if (cached !== null) return cached;

    const rows = await this.repository.listTopics();
    await this.cache.set(key, rows, METADATA_CACHE_TTL_SECONDS);
    return rows;
  }

  async topic(slug: string, limit: number) {
    const topic = await this.repository.findTopicBySlug(slug);
    if (topic === null) throw notFound('Topic', slug);

    const contents = await this.repository.listTopicContents({
      topicId: BigInt(topic.id),
      limit: limit,
    });
    return { ...topic, contents };
  }

  async source(slug: string, limit: number) {
    const source = await this.repository.findSourceBySlug(slug);
    if (source === null) throw notFound('Source', slug);

    const contents = await this.repository.listSourceContents({
      sourceId: BigInt(source.id),
      limit: limit,
    });
    return { ...source, contents };
  }
}

/** 不可见 = 不存在 **或** 未审核（`docs/12` + 不要构成存在性探测器）。 */
function notVisible(contentId: string): AppError {
  return new AppError({
    code: 'CONTENT_NOT_VISIBLE',
    httpStatus: 404,
    safeMessage: 'Content not found',
    details: { contentId },
  });
}

function notFound(what: string, slug: string): AppError {
  return new AppError({
    code: PlatformErrorCode.NOT_FOUND,
    httpStatus: 404,
    safeMessage: `${what} not found`,
    details: { slug },
  });
}
