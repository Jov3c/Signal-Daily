/**
 * `DailyService` 的守卫 —— 覆盖任务书点名的八项「必测」里的六项。
 *
 * ```text
 * draft generation      -> 由 worker 的 PublishingService 覆盖（见 worker 侧测试）
 * 未审核 08:00 不发     -> 本文件「只有 SCHEDULED 能发布」
 * scheduled publish     -> 本文件
 * Lead required         -> 本文件（preflight 阻断）
 * REJECTED 阻断         -> 本文件
 * editionNo 发布时分配  -> 本文件
 * archive 只返回 PUBLISHED -> 本文件
 * approved-only Featured   -> featured-service.spec.ts
 * ```
 *
 * ⚠ 测试数据用**中文**与真实形态（§23.4 第 4 问）：标题、来源名、备注都是
 * 真实会出现的内容。Agent 01 的 FULLTEXT 事故（用 ASCII 探针测中文搜索、
 * 一直是绿的）是这里的直接教训。
 */

import { describe, expect, it } from 'vitest';
import {
  ContentPipelineStatus,
  DAILY_TARGET_PUBLISH_HOUR,
  DailyDisplayStyle,
  DailyEditionStatus,
  DailySectionType,
  isAppError,
} from '@signal/contracts';
import { businessTimeToUtc } from '@signal/config';
import { createLogger } from '@signal/logger';
import { createMemoryStream, type MemoryLogStream } from '@signal/test-utils';
import { DailyService } from '../src/modules/daily/service';
import { DAILY_TRANSITIONS, canTransition, isEditable } from '../src/modules/daily/state';
import { InMemoryDailyRepository, fixedClock } from './support/publishing-fakes';
import type { SectionInput } from '../src/modules/daily/repository';

/** 上海时间 2026-09-29 09:00（= UTC 01:00）—— 业务日就是 09-29。 */
const NOW = new Date('2026-09-29T01:00:00.000Z');
const TODAY = '2026-09-29';
const ADMIN = '42';

function build(repository = new InMemoryDailyRepository()) {
  const stream: MemoryLogStream = createMemoryStream();
  const logger = createLogger({ service: 'api', destination: stream });
  return {
    repository,
    stream,
    service: new DailyService(repository, fixedClock(NOW), logger),
  };
}

/** 一个能过预检的版块结构（一条 LEAD + 一条 STANDARD）。 */
function validSections(): SectionInput[] {
  return [
    {
      type: DailySectionType.FRONT_PAGE,
      title: '首页',
      sortOrder: 0,
      items: [
        {
          contentId: '100',
          displayStyle: DailyDisplayStyle.LEAD,
          sortOrder: 0,
          customHeadline: null,
          customExcerpt: null,
        },
      ],
    },
    {
      type: DailySectionType.AI,
      title: 'AI',
      sortOrder: 1,
      items: [
        {
          contentId: '101',
          displayStyle: DailyDisplayStyle.MAJOR,
          sortOrder: 0,
          customHeadline: '自定义标题',
          customExcerpt: null,
        },
      ],
    },
  ];
}

/** 铺好一条能发布的路径：期次 + 已审核内容 + 版块。 */
function seedSchedulable(repository: InMemoryDailyRepository): void {
  repository.seedContent('100', ContentPipelineStatus.APPROVED);
  repository.seedContent('101', ContentPipelineStatus.APPROVED);
  repository.seedEdition({ businessDate: TODAY, sections: validSections() });
}

/** 断言一个 AppError 的 code。 */
function expectAppError(error: unknown, code: string): void {
  expect(isAppError(error), `期望 AppError，实际是 ${String(error)}`).toBe(true);
  if (isAppError(error)) expect(error.code).toBe(code);
}

/* ------------------------------------------------------------------ */
/* 状态机                                                              */
/* ------------------------------------------------------------------ */

describe('日报状态机（docs/05 的 DailyEditionStatus）', () => {
  it('覆盖契约里的每一个状态，且不引入契约外的状态', () => {
    // `Object.keys` 与契约数组逐字对齐 —— 少一个状态是 `Record` 编译不过，
    // 多一个（或改名不改结构）只有运行期能发现。
    expect(Object.keys(DAILY_TRANSITIONS).sort()).toEqual(
      [
        DailyEditionStatus.CANCELLED,
        DailyEditionStatus.DRAFT,
        DailyEditionStatus.PUBLISHED,
        DailyEditionStatus.REVIEWING,
        DailyEditionStatus.SCHEDULED,
      ].sort(),
    );
  });

  it('PUBLISHED 是终态（docs/10：发布后只能改 typo 且要记 revision —— V1 不做）', () => {
    for (const target of Object.values(DailyEditionStatus)) {
      expect(canTransition(DailyEditionStatus.PUBLISHED, target)).toBe(false);
    }
  });

  it('CANCELLED 可以恢复成 DRAFT（取消不占号，误点不该永久毁掉当天）', () => {
    expect(canTransition(DailyEditionStatus.CANCELLED, DailyEditionStatus.DRAFT)).toBe(true);
  });

  it('排期后仍可编辑（docs/10 限制的是发布后，不是发布前）', () => {
    expect(isEditable(DailyEditionStatus.SCHEDULED)).toBe(true);
    expect(isEditable(DailyEditionStatus.PUBLISHED)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 排期                                                                */
/* ------------------------------------------------------------------ */

describe('排期', () => {
  it('DRAFT 可以排期，默认时刻是该业务日的上海 08:00', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY });

    const edition = await service.schedule(TODAY, ADMIN);

    expect(edition.status).toBe(DailyEditionStatus.SCHEDULED);
    // ⚠ 这条断言的**具体值**是关键：拼 `T08:00:00Z` 会得到 UTC 08:00，
    // 即上海 16:00，比目标晚 8 小时。用 businessTimeToUtc 才是上海 08:00。
    expect(edition.scheduledAt).toBe(
      businessTimeToUtc(TODAY, DAILY_TARGET_PUBLISH_HOUR).toISOString(),
    );
    expect(edition.scheduledAt).toBe('2026-09-29T00:00:00.000Z');
  });

  it('⚠ 排期**不接受**调用方指定时刻 —— `scheduledAt` 永远是契约的目标时刻', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY });

    // 服务层没有「传时刻」这个入口（签名里就没有），所以这里验的是
    // 「无论何时排期，落库的时刻都是同一个」。
    const edition = await service.schedule(TODAY, ADMIN);
    expect(edition.scheduledAt).toBe(
      businessTimeToUtc(TODAY, DAILY_TARGET_PUBLISH_HOUR).toISOString(),
    );
    // 这一条与 worker 的 08:00 那一班必须一致 ——
    // 两边都从契约常量派生，另有 posting-queue.spec 钉住 worker 侧。
    expect(edition.scheduledAt).toBe('2026-09-29T00:00:00.000Z');
  });

  it('已发布的一期不能再排期（409）', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.PUBLISHED });

    await expect(service.schedule(TODAY, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_INVALID_TRANSITION');
      return true;
    });
  });

  it('不存在的业务日 → 404', async () => {
    const { service } = build();
    await expect(service.schedule('2020-01-01', ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_EDITION_NOT_FOUND');
      return true;
    });
  });
});

/* ------------------------------------------------------------------ */
/* 取消                                                                */
/* ------------------------------------------------------------------ */

describe('取消', () => {
  it('DRAFT / REVIEWING / SCHEDULED 都能取消', async () => {
    for (const status of [
      DailyEditionStatus.DRAFT,
      DailyEditionStatus.REVIEWING,
      DailyEditionStatus.SCHEDULED,
    ]) {
      const { service, repository } = build();
      repository.seedEdition({ businessDate: TODAY, status });
      const edition = await service.cancel(TODAY, ADMIN);
      expect(edition.status, `${status} 应当能取消`).toBe(DailyEditionStatus.CANCELLED);
    }
  });

  it('已发布的一期不能取消（409）', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.PUBLISHED });
    await expect(service.cancel(TODAY, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_INVALID_TRANSITION');
      return true;
    });
  });
});

/* ------------------------------------------------------------------ */
/* 发布                                                                */
/* ------------------------------------------------------------------ */

describe('发布（docs/10：「只有 SCHEDULED 才发布」「未审核保持草稿」）', () => {
  it('DRAFT 不能发布 —— 这正是「未审核 08:00 不发」', async () => {
    const { service, repository } = build();
    seedSchedulable(repository); // 内容齐全、版块合法，但状态是 DRAFT

    await expect(service.publish(TODAY, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_INVALID_TRANSITION');
      if (isAppError(error)) {
        expect(error.details).toMatchObject({
          from: DailyEditionStatus.DRAFT,
          to: DailyEditionStatus.PUBLISHED,
        });
      }
      return true;
    });
  });

  it('REVIEWING 也不能发布（必须管理员显式排期）', async () => {
    const { service, repository } = build();
    seedSchedulable(repository);
    await service.replaceSections(TODAY, { headline: undefined, sections: validSections() }, ADMIN);

    await expect(service.publish(TODAY, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_INVALID_TRANSITION');
      return true;
    });
  });

  it('SCHEDULED 可以发布，并**在发布时**分配期号 NO.001', async () => {
    const { service, repository } = build();
    seedSchedulable(repository);
    await service.schedule(TODAY, ADMIN);

    const result = await service.publish(TODAY, ADMIN);

    expect(result.edition.status).toBe(DailyEditionStatus.PUBLISHED);
    expect(result.edition.editionNo).toBe(1);
    expect(result.editionNoLabel).toBe('NO.001');
    expect(result.edition.publishedAt).toBe(NOW.toISOString());
  });

  it('**取消的草稿不占号**（docs/10）：先取消一期，再发布的那一期仍是 NO.001', async () => {
    const { service, repository } = build();
    seedSchedulable(repository);
    await service.schedule(TODAY, ADMIN);
    await service.cancel(TODAY, ADMIN);

    // 恢复成 DRAFT 再排期发布 —— 取消不占号，所以期号仍是 1。
    repository.editions.get(TODAY)!.status = DailyEditionStatus.DRAFT;
    await service.schedule(TODAY, ADMIN);
    const result = await service.publish(TODAY, ADMIN);

    expect(result.edition.editionNo).toBe(1);
  });

  it('第二期拿到 NO.002（期号是「已发布期数 + 1」）', async () => {
    const { service, repository } = build();
    repository.seedEdition({
      businessDate: '2026-09-28',
      status: DailyEditionStatus.PUBLISHED,
      editionNo: 1,
    });
    seedSchedulable(repository);
    await service.schedule(TODAY, ADMIN);

    const result = await service.publish(TODAY, ADMIN);
    expect(result.edition.editionNo).toBe(2);
  });

  it('Lead required：没有 LEAD 时不发布，且**不占期号**', async () => {
    const { service, repository } = build();
    repository.seedContent('100', ContentPipelineStatus.APPROVED);
    repository.seedEdition({
      businessDate: TODAY,
      status: DailyEditionStatus.SCHEDULED,
      sections: [
        {
          type: DailySectionType.AI,
          title: 'AI',
          sortOrder: 1,
          items: [
            {
              contentId: '100',
              displayStyle: DailyDisplayStyle.STANDARD, // 没有 LEAD
              sortOrder: 0,
              customHeadline: null,
              customExcerpt: null,
            },
          ],
        },
      ],
    });

    await expect(service.publish(TODAY, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_PREFLIGHT_FAILED');
      if (isAppError(error)) {
        const details = error.details as { issues: { reason: string }[] };
        expect(details.issues.map((issue) => issue.reason)).toContain('LEAD_REQUIRED');
      }
      return true;
    });

    // ⚠ 关键：校验失败**绝不能占期号**。否则一次失败的发布会让 NO.001 空掉，
    // 而 docs/10 说期号只在「真正发布」时分配。
    expect(repository.markPublishedCalls).toBe(0);
    const edition = await service.detail(TODAY);
    expect(edition.edition.editionNo).toBeNull();
  });

  it('REJECTED 阻断：内容被撤下后不能发布，且不占期号', async () => {
    const { service, repository } = build();
    seedSchedulable(repository);
    await service.schedule(TODAY, ADMIN);

    // 排期之后内容被 Agent 07 撤下（真实会发生）
    repository.seedContent('101', ContentPipelineStatus.REJECTED);

    await expect(service.publish(TODAY, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_PREFLIGHT_FAILED');
      if (isAppError(error)) {
        const details = error.details as { issues: { reason: string }[] };
        expect(details.issues.map((issue) => issue.reason)).toContain('CONTENT_NOT_PUBLISHABLE');
      }
      return true;
    });
    expect(repository.markPublishedCalls).toBe(0);
  });

  it('⚠ 已经发布过的一期再点发布 → 409 DAILY_ALREADY_PUBLISHED（**不是**静默 200）', async () => {
    const { service, repository } = build();
    seedSchedulable(repository);
    await service.schedule(TODAY, ADMIN);
    await service.publish(TODAY, ADMIN);

    await expect(service.publish(TODAY, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_ALREADY_PUBLISHED');
      if (isAppError(error)) {
        // 错误里要带上「它是什么时候发的、期号多少、下一步该做什么」——
        // 否则管理员只会反复点发布。
        expect(error.details).toMatchObject({ businessDate: TODAY, editionNo: 1 });
        expect(String((error.details as { hint: string }).hint)).toMatch(/archive/);
      }
      return true;
    });

    // 期号没有被改（仍然是 1，不是 2）
    const current = await service.detail(TODAY);
    expect(current.edition.editionNo).toBe(1);
  });

  it('并发：读状态之后别人先发布了 → 409，且不重复占号', async () => {
    const { service, repository } = build();
    seedSchedulable(repository);
    await service.schedule(TODAY, ADMIN);

    repository.simulateConcurrentPublish = true;
    await expect(service.publish(TODAY, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_ALREADY_PUBLISHED');
      if (isAppError(error)) {
        expect(error.details).toMatchObject({ raced: true });
      }
      return true;
    });

    // 只尝试占号一次 —— 撞车之后不再重试
    expect(repository.markPublishedCalls).toBe(1);
  });

  it('审计：每一次发布都写下操作者（可追到人）', async () => {
    const { service, repository, stream } = build();
    seedSchedulable(repository);
    await service.schedule(TODAY, ADMIN);
    await service.publish(TODAY, ADMIN);

    const audits = stream
      .records()
      .filter((record) => record['errorCode'] === 'ADMIN_DAILY_PUBLISHED');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: ADMIN });
    expect((audits[0]?.['auditTarget'] as Record<string, string>)['businessDate']).toBe(TODAY);
  });
});

/* ------------------------------------------------------------------ */
/* 编辑                                                                */
/* ------------------------------------------------------------------ */

describe('编辑版块', () => {
  it('DRAFT 被保存后变成 REVIEWING（「有人动过它了」）', async () => {
    const { service, repository } = build();
    seedSchedulable(repository);

    const detail = await service.replaceSections(
      TODAY,
      { headline: '今日信号', sections: validSections() },
      ADMIN,
    );

    expect(detail.edition.status).toBe(DailyEditionStatus.REVIEWING);
    expect(detail.edition.headline).toBe('今日信号');
    expect(detail.sections).toHaveLength(2);
  });

  it('SCHEDULED 编辑后**仍是 SCHEDULED**（修错别字不该把已排的期踢回去）', async () => {
    const { service, repository } = build();
    seedSchedulable(repository);
    await service.schedule(TODAY, ADMIN);

    const detail = await service.replaceSections(
      TODAY,
      { headline: undefined, sections: validSections() },
      ADMIN,
    );
    expect(detail.edition.status).toBe(DailyEditionStatus.SCHEDULED);
  });

  it('PUBLISHED 不能再编辑（409，docs/10：不许静默重排整版）', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.PUBLISHED });

    await expect(
      service.replaceSections(TODAY, { headline: undefined, sections: [] }, ADMIN),
    ).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_INVALID_TRANSITION');
      return true;
    });
  });

  it('**只能引用已审核的内容**（docs/00：任何内容必须人工审核）', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY });
    repository.seedContent('100', ContentPipelineStatus.REVIEW_PENDING);
    repository.seedContent('101', ContentPipelineStatus.REJECTED);

    await expect(
      service.replaceSections(TODAY, { headline: undefined, sections: validSections() }, ADMIN),
    ).rejects.toSatisfy((error: unknown) => {
      // 用平台码 CONFLICT：这不是状态机转移问题，而是「引用了不该引用的东西」。
      expectAppError(error, 'CONFLICT');
      if (isAppError(error)) {
        const details = error.details as { problems: { contentId: string; reason: string }[] };
        expect(details.problems).toEqual(
          expect.arrayContaining([
            { contentId: '100', reason: 'REVIEW_PENDING' },
            { contentId: '101', reason: 'REJECTED' },
          ]),
        );
      }
      return true;
    });
  });

  it('引用不存在的内容也会被拒（而不是写进库再让外键炸）', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY });
    // 一个都不 seed —— 两条都不存在

    await expect(
      service.replaceSections(TODAY, { headline: undefined, sections: validSections() }, ADMIN),
    ).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'CONFLICT');
      if (isAppError(error)) {
        const details = error.details as { problems: { reason: string }[] };
        expect(details.problems.every((p) => p.reason === 'CONTENT_NOT_FOUND')).toBe(true);
      }
      return true;
    });
  });
});

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

describe('读取与惰性建期', () => {
  it('今天与过去：打开编辑台时按需补建当天期次（幂等）', async () => {
    const { service, repository } = build();

    const first = await service.detail(TODAY);
    expect(first.edition.businessDate).toBe(TODAY);
    expect(first.edition.status).toBe(DailyEditionStatus.DRAFT);

    // 再开一次不会建出第二行
    await service.detail(TODAY);
    expect(repository.editions.size).toBe(1);
  });

  it('未来的日期不补建 → 404（否则列表里会堆出一批空期次）', async () => {
    const { service } = build();
    await expect(service.detail('2026-10-05')).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_EDITION_NOT_FOUND');
      return true;
    });
  });

  it('公开读取：未发布的期次对外不存在（404，不是空日报）', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.DRAFT });

    await expect(service.publishedDetail(TODAY)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'DAILY_EDITION_NOT_FOUND');
      return true;
    });
  });

  it('**归档只返回 PUBLISHED**（docs/10：前台日历只展示 PUBLISHED）', async () => {
    const { service, repository } = build();
    repository.seedEdition({
      businessDate: '2026-09-27',
      status: DailyEditionStatus.PUBLISHED,
      editionNo: 1,
    });
    repository.seedEdition({ businessDate: '2026-09-28', status: DailyEditionStatus.DRAFT });
    repository.seedEdition({ businessDate: '2026-09-29', status: DailyEditionStatus.SCHEDULED });

    const archive = await service.archive({ from: '2026-09-01', to: '2026-10-01' });

    expect(archive.map((row) => row.businessDate)).toEqual(['2026-09-27']);
    expect(archive[0]?.status).toBe(DailyEditionStatus.PUBLISHED);
  });

  it('后台列表按业务日范围过滤', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: '2026-08-31' });
    repository.seedEdition({ businessDate: '2026-09-01' });
    repository.seedEdition({ businessDate: '2026-09-30' });
    repository.seedEdition({ businessDate: '2026-10-01' });

    const september = await service.listMonth({ from: '2026-09-01', to: '2026-10-01' });
    expect(september.map((row) => row.businessDate).sort()).toEqual(['2026-09-01', '2026-09-30']);
  });
});
