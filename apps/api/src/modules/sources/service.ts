/**
 * SourcesService —— Source Registry 的业务逻辑。
 *
 * ── 本模块的边界（规则 §6 / §12 / §13）────────────────────────────────
 *   - `type=X_USER` 就是 X 动态的**后台白名单实体**，与用户订阅无关。
 *     这里**没有、也不允许出现** follow / subscribe / 订阅 Feed 之类的概念。
 *   - 不实现采集本身（Agent 04）、不实现审核（Agent 07）、
 *     不实现公开读接口（Agent 10）。本模块只负责「来源这份清单」。
 *
 * ── 为什么 PATCH 也要跑一遍完整 config 校验 ──────────────────────────
 * 校验的对象是**合并之后的有效状态**，而不是请求体。
 * 只校验请求体的话，`PATCH {type:'RSS'}` 能把一个 X 来源改成一个
 * config 里还留着 `handle` 的 RSS 来源 —— 那是一个谁也读不懂的来源。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AppError, DomainErrorCode } from '@signal/contracts';
import { SOURCE_CLOCK, type SourceClock } from './clock';
import type { CreateSourceDto, SourceListQueryDto, UpdateSourceDto } from './dto/source.dto';
import { toSourceDto, type SourceDto } from './dto/source.dto';
import {
  SOURCE_REPOSITORY,
  isUniqueViolation,
  type SourceRecord,
  type SourceRepository,
  type UpdateSourceInput,
} from './repository';
import {
  SOURCE_FETCH_ENQUEUER,
  type EnqueuedSourceFetch,
  type SourceFetchEnqueuer,
} from './source-enqueuer';
import { SOURCE_TESTER, type SourceTestResult, type SourceTester } from './source-tester';
import { buildSourceConfig } from './source-config.schema';
import { computeNextFetchAt } from './scheduling';

export type SourceListResultDto = {
  items: SourceDto[];
  total: number;
};

@Injectable()
export class SourcesService {
  // ⚠ 显式 @Inject：不要依赖 emitDecoratorMetadata（见 di-wiring.spec.ts）。
  constructor(
    @Inject(SOURCE_REPOSITORY) private readonly sources: SourceRepository,
    @Inject(SOURCE_TESTER) private readonly tester: SourceTester,
    @Inject(SOURCE_FETCH_ENQUEUER) private readonly enqueuer: SourceFetchEnqueuer,
    @Inject(SOURCE_CLOCK) private readonly clock: SourceClock,
  ) {}

  async list(query: SourceListQueryDto): Promise<SourceListResultDto> {
    const result = await this.sources.list({
      page: query.page,
      pageSize: query.pageSize,
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.tier === undefined ? {} : { tier: query.tier }),
      ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
      ...(query.q === undefined ? {} : { q: query.q }),
    });

    return { items: result.items.map(toSourceDto), total: result.total };
  }

  async get(id: string): Promise<SourceDto> {
    return toSourceDto(await this.requireSource(id));
  }

  async create(input: CreateSourceDto): Promise<SourceDto> {
    const normalized = buildSourceConfig({
      type: input.type,
      config: input.config,
      externalId: input.externalId,
      feedUrl: input.feedUrl,
      baseUrl: input.baseUrl,
      previousConfig: null,
    });

    // 先查一次给出友好的 409；并发下仍可能撞上唯一约束，那时由 P2002 兜底。
    await this.assertSlugAvailable(input.slug);

    try {
      const created = await this.sources.create({
        name: input.name,
        slug: input.slug,
        type: input.type,
        kind: input.kind,
        tier: input.tier,
        official: input.official,
        baseUrl: normalized.baseUrl,
        feedUrl: normalized.feedUrl,
        externalId: normalized.externalId,
        language: input.language,
        priority: input.priority,
        trustScore: input.trustScore,
        fetchIntervalSeconds: input.fetchIntervalSeconds,
        enabled: input.enabled,
        config: normalized.config,
        // 新建即到期：`docs/06`「后台新增账号后自动进入下一调度周期」。
        // 即使此刻 `enabled=false` 也照写 —— 它只表示「一旦启用就立刻抓」。
        nextFetchAt: this.clock.now(),
      });
      return toSourceDto(created);
    } catch (error) {
      throw this.translateWriteError(error);
    }
  }

  async update(id: string, patch: UpdateSourceDto): Promise<SourceDto> {
    const existing = await this.requireSource(id);

    // 合并出「改完之后的有效状态」，再对它校验 —— 而不是只校验请求体。
    const effective = {
      type: patch.type ?? existing.type,
      externalId: patch.externalId === undefined ? existing.externalId : patch.externalId,
      feedUrl: patch.feedUrl === undefined ? existing.feedUrl : patch.feedUrl,
      baseUrl: patch.baseUrl === undefined ? existing.baseUrl : patch.baseUrl,
      config: patch.config === undefined ? existing.config : patch.config,
    };

    const normalized = buildSourceConfig({
      type: effective.type,
      config: effective.config,
      externalId: effective.externalId,
      feedUrl: effective.feedUrl,
      baseUrl: effective.baseUrl,
      // 让 seed / seedNote 这类「来源标记」能从已有 config 继承下来 ——
      // 否则一次只改 handle 的 PATCH 会把它们静默抹掉（独立审查 P3-2）。
      previousConfig: existing.config,
    });

    // 只有调用方显式给了 config（或者换了 type，旧 config 必然不再匹配）
    // 时才回写 config —— 否则一次 `PATCH {tier}` 会把库里那份
    // 管理员没动过的 JSON 悄悄重写一遍。
    const rewriteConfig = patch.config !== undefined || effective.type !== existing.type;

    if (patch.slug !== undefined && patch.slug !== existing.slug) {
      await this.assertSlugAvailable(patch.slug);
    }

    const update: UpdateSourceInput = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.slug !== undefined) update.slug = patch.slug;
    if (patch.type !== undefined) update.type = patch.type;
    if (patch.kind !== undefined) update.kind = patch.kind;
    if (patch.tier !== undefined) update.tier = patch.tier;
    if (patch.official !== undefined) update.official = patch.official;
    if (patch.language !== undefined) update.language = patch.language;
    if (patch.priority !== undefined) update.priority = patch.priority;
    if (patch.trustScore !== undefined) update.trustScore = patch.trustScore;
    if (patch.fetchIntervalSeconds !== undefined) {
      update.fetchIntervalSeconds = patch.fetchIntervalSeconds;
    }
    if (patch.enabled !== undefined) {
      update.enabled = patch.enabled;
      // ★ 「停用 → 启用」这个**状态跃迁**必须推进 nextFetchAt，
      //   与 `POST /:id/enable` 是同一套语义。
      //
      //   独立审查 P2-1 实测过不一致的后果：一个 7 天间隔的来源被抓过一次后
      //   `next_fetch_at = +7d`，管理员停用、再用编辑表单（走 PATCH）启用，
      //   界面显示「已启用」，但调度器 7 天内不会碰它 ——
      //   正是 `scheduling.ts` 文件头要防的那类「后台显示已启用，worker 不抓」。
      if (patch.enabled && !existing.enabled) update.nextFetchAt = this.clock.now();
    }

    // 归一化后的三个列值总是参与更新：它们可能因为 config 里的别名
    // （`config.feedUrl` / `config.repo`）而被提升到列上。
    update.baseUrl = normalized.baseUrl;
    update.feedUrl = normalized.feedUrl;
    update.externalId = normalized.externalId;
    if (rewriteConfig) update.config = normalized.config;

    try {
      return toSourceDto(await this.sources.update(id, update));
    } catch (error) {
      throw this.translateWriteError(error);
    }
  }

  /**
   * 启用。**幂等**：对已启用的来源重复调用不报错，也**不重置** `nextFetchAt`。
   *
   * 「停用 → 启用」这个**状态跃迁**才把 `nextFetchAt` 设为 now
   * （`docs/06`：新增账号后自动进入下一调度周期；停用后停止产生新抓取任务）。
   * 若每次调用都重置，管理员反复点启用就等于反复插队，会让正常来源饿死。
   */
  async enable(id: string): Promise<SourceDto> {
    const existing = await this.requireSource(id);
    if (existing.enabled) return toSourceDto(existing);
    return toSourceDto(await this.sources.setEnabled(id, true, this.clock.now()));
  }

  /** 停用。**幂等**。停用之后 `findDueSources` 不会再返回它（有专门测试）。 */
  async disable(id: string): Promise<SourceDto> {
    const existing = await this.requireSource(id);
    if (!existing.enabled) return toSourceDto(existing);
    return toSourceDto(await this.sources.setEnabled(id, false, null));
  }

  /** 探测一次。失败是**结论**（`ok:false`），不是 HTTP 错误。 */
  async test(id: string): Promise<SourceTestResult> {
    return this.tester.test(await this.requireSource(id));
  }

  /** 立刻入队一次采集。 */
  async fetchNow(id: string): Promise<EnqueuedSourceFetch> {
    const source = await this.requireSource(id);
    return this.enqueuer.enqueueFetchNow(source.id, this.clock.now());
  }

  /**
   * 计算某来源下一次该抓的时刻。
   *
   * 目前只有测试与文档使用：真正推进 `nextFetchAt` 的是 Collector
   * （Agent 04，抓完之后调用），但规则必须是同一份，所以走 `computeNextFetchAt`。
   */
  nextFetchAtFor(source: SourceRecord, from: Date): Date {
    return computeNextFetchAt(source.fetchIntervalSeconds, from);
  }

  private async requireSource(id: string): Promise<SourceRecord> {
    const source = await this.sources.findById(id);
    if (source === null) {
      throw new AppError({
        code: DomainErrorCode.SOURCE_NOT_FOUND,
        httpStatus: 404,
        safeMessage: 'Source not found',
      });
    }
    return source;
  }

  private async assertSlugAvailable(slug: string): Promise<void> {
    const existing = await this.sources.findBySlug(slug);
    if (existing !== null) throw duplicateSlugError();
  }

  /**
   * 把 Prisma 的唯一约束冲突翻译成 409。
   *
   * 为什么需要：`assertSlugAvailable` 是「先查后写」，两个并发请求可以
   * 同时查到「没有」，然后一个成功、另一个撞上唯一约束。
   * 那种情况下用户该看到的是 409，而不是 500。
   */
  private translateWriteError(error: unknown): unknown {
    if (isUniqueViolation(error)) return duplicateSlugError();
    return error;
  }
}

function duplicateSlugError(): AppError {
  return new AppError({
    code: DomainErrorCode.SOURCE_DUPLICATE_SLUG,
    httpStatus: 409,
    safeMessage: 'A source with this slug already exists',
  });
}
