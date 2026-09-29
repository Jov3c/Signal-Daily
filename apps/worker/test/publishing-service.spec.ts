/**
 * `PublishingService` 的守卫 —— 草稿生成与定时发布。
 *
 * 覆盖任务书点名的两项：
 *
 * ```text
 * draft generation      -> 本文件「草稿生成」
 * 未审核 08:00 不发      -> 本文件「定时发布」（NOT_SCHEDULED 分支）
 * ```
 *
 * ⚠ 这一组里最重要的是**三条安全性质**（见 `publishing.service.ts` 文件头）：
 * 只写 DRAFT、整份重算、没有候选时不替换。它们每一条都对应一个
 * 「凌晨没人看着的时候把管理员的活儿冲掉了」的真实事故。
 */

import { describe, expect, it } from 'vitest';
import { DailyDisplayStyle, DailyEditionStatus, DailySectionType } from '@signal/contracts';
import { businessTimeToUtc } from '@signal/config';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import {
  PublishingService,
  candidateWindow,
  dailyAdminUrl,
} from '../src/jobs/publishing/publishing.service';
import { PublishingNotificationType } from '../src/jobs/publishing/notifier';
import {
  InMemoryPublishingRepository,
  RecordingNotifier,
  makeCandidate,
} from './support/publishing-fakes';

/** 上海时间 2026-09-29 08:00（= UTC 00:00）—— 正是目标发布时刻。 */
const PUBLISH_MOMENT = new Date('2026-09-29T00:00:00.000Z');
const TODAY = '2026-09-29';

function build() {
  const repository = new InMemoryPublishingRepository();
  const notifier = new RecordingNotifier();
  const stream = createMemoryStream();
  const logger = createLogger({ service: 'worker', destination: stream });
  return {
    repository,
    notifier,
    stream,
    service: new PublishingService(repository, notifier, { now: () => PUBLISH_MOMENT }, logger),
  };
}

/* ------------------------------------------------------------------ */
/* 00:10                                                              */
/* ------------------------------------------------------------------ */

describe('initDraft（docs/10 的 00:10）', () => {
  it('建出空 DRAFT，且**不碰任何内容**', async () => {
    const { service, repository } = build();
    const result = await service.initDraft(TODAY);

    expect(result.created).toBe(true);
    expect(result.status).toBe(DailyEditionStatus.DRAFT);
    // 关键：一条 replaceSections 都不该发生 —— 00:10 只建期次
    expect(repository.replaceCalls).toHaveLength(0);
    expect(repository.editions.get(TODAY)?.sections).toEqual([]);
  });

  it('幂等：已存在时原样返回，`created: false`', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.REVIEWING });

    const result = await service.initDraft(TODAY);
    expect(result.created).toBe(false);
    expect(result.status).toBe(DailyEditionStatus.REVIEWING);
  });
});

/* ------------------------------------------------------------------ */
/* 草稿生成                                                            */
/* ------------------------------------------------------------------ */

describe('generateDraft（docs/10 的 05:30 / 07:00）', () => {
  it('DRAFT 会被整份重算，产出七个默认版块里的非空项', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.DRAFT });
    repository.candidates = [
      makeCandidate({ contentId: '1', title: '高分模型发布', finalScore: 95 }),
      makeCandidate({ contentId: '2', title: '新一代 GPU 芯片', finalScore: 80 }),
      makeCandidate({ contentId: '3', title: '一则简讯', finalScore: 60 }),
    ];

    const result = await service.generateDraft(TODAY);

    expect(result.generated).toBe(true);
    expect(result.sectionCount).toBeGreaterThan(0);
    expect(result.itemCount).toBe(3);
    expect(repository.replaceCalls).toHaveLength(1);
  });

  it('⚠ **安全性质 1：非 DRAFT 一律不碰**（这是「05:30 的自动草稿不覆盖管理员 06:00 的编辑」的唯一保证）', async () => {
    for (const status of [
      DailyEditionStatus.REVIEWING,
      DailyEditionStatus.SCHEDULED,
      DailyEditionStatus.PUBLISHED,
      DailyEditionStatus.CANCELLED,
    ]) {
      const { service, repository } = build();
      repository.seedEdition({ businessDate: TODAY, status });
      repository.candidates = [makeCandidate({ contentId: '1' })];

      const result = await service.generateDraft(TODAY);

      expect(result.generated, `${status} 不该被覆盖`).toBe(false);
      expect(result.skippedReason).toBe('NOT_DRAFT');
      expect(repository.replaceCalls, `${status} 不该被覆盖`).toHaveLength(0);
    }
  });

  it('⚠ **安全性质 3：没有候选时不替换**（一次上游故障不该清空已有草稿）', async () => {
    const { service, repository } = build();
    repository.seedEdition({
      businessDate: TODAY,
      status: DailyEditionStatus.DRAFT,
      sections: [
        {
          type: DailySectionType.FRONT_PAGE,
          title: '首页',
          sortOrder: 0,
          items: [{ contentId: '1', displayStyle: DailyDisplayStyle.LEAD, sortOrder: 0 }],
        },
      ],
    });
    repository.candidates = [];

    const result = await service.generateDraft(TODAY);

    expect(result.generated).toBe(false);
    expect(result.skippedReason).toBe('NO_CANDIDATES');
    expect(repository.replaceCalls).toHaveLength(0);
    // 已有草稿原样保留
    expect(repository.editions.get(TODAY)?.sections).toHaveLength(1);
  });

  it('期次不存在时补建，而不是失败（00:10 那一趟可能因为停机没跑）', async () => {
    const { service, repository } = build();
    repository.candidates = [makeCandidate({ contentId: '1', title: '模型发布' })];

    const result = await service.generateDraft(TODAY);

    expect(result.generated).toBe(true);
    expect(repository.editions.has(TODAY)).toBe(true);
  });

  it('07:00 的「刷新」就是再跑一次生成 —— 同一天的两次生成不会互相打架', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.DRAFT });

    repository.candidates = [makeCandidate({ contentId: '1', title: '模型发布', finalScore: 90 })];
    await service.generateDraft(TODAY);

    // 07:00 之前又来了一篇
    repository.candidates = [
      ...repository.candidates,
      makeCandidate({ contentId: '2', title: '另一条模型消息', finalScore: 95 }),
    ];
    const refreshed = await service.generateDraft(TODAY);

    expect(refreshed.itemCount).toBe(2);
    // 新来的那条分数最高，成了头条
    const frontPage = repository.editions
      .get(TODAY)
      ?.sections.find((s) => s.type === DailySectionType.FRONT_PAGE);
    expect(frontPage?.items.map((i) => i.contentId)).toEqual(['2']);
  });

  it('候选没进草稿时返回原因（管理员要能回答「为什么这篇没进」）', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.DRAFT });
    repository.candidates = [
      makeCandidate({ contentId: '1', eventId: 'e1', isEventPrimary: true, finalScore: 90 }),
      makeCandidate({ contentId: '2', eventId: 'e1', isEventPrimary: false, finalScore: 95 }),
    ];

    const result = await service.generateDraft(TODAY);
    expect(result.notes.map((note) => note.reason)).toContain('NOT_EVENT_PRIMARY');
  });
});

/* ------------------------------------------------------------------ */
/* 候选窗口                                                            */
/* ------------------------------------------------------------------ */

describe('候选窗口（docs/10 只写了「业务窗口内」，取值由本模块决定）', () => {
  it('窗口是**该业务日 08:00 之前的 24 小时**（上海时间）', () => {
    const { startUtc, endUtc } = candidateWindow(TODAY);

    // 结束于上海 2026-09-29 08:00 = UTC 2026-09-29 00:00
    expect(endUtc.toISOString()).toBe(businessTimeToUtc(TODAY, 8).toISOString());
    expect(endUtc.toISOString()).toBe('2026-09-29T00:00:00.000Z');
    // 起始 = 结束 − 24h
    expect(endUtc.getTime() - startUtc.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(startUtc.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });

  it('窗口**按业务日固定**，不随「这一趟几点跑」变化（否则 07:00 的刷新会刷掉 05:30 选中的）', () => {
    const first = candidateWindow(TODAY);
    const second = candidateWindow(TODAY);
    expect(second).toEqual(first);
  });

  it('窗口真的在过滤：窗口外的候选不会进草稿', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.DRAFT });
    repository.candidates = [
      // 窗口内（昨天 12:00 上海）
      makeCandidate({
        contentId: '1',
        title: '窗口内的模型消息',
        publishedAt: '2026-09-28T04:00:00.000Z',
      }),
      // 窗口外（太早：前天 23:00 上海）
      makeCandidate({
        contentId: '2',
        title: '窗口外的旧消息',
        publishedAt: '2026-09-27T15:00:00.000Z',
      }),
      // 边界：正好等于 endUtc —— 半开区间，不含
      makeCandidate({
        contentId: '3',
        title: '边界上的消息',
        publishedAt: '2026-09-29T00:00:00.000Z',
      }),
    ];

    const result = await service.generateDraft(TODAY);
    const included = repository.editions
      .get(TODAY)
      ?.sections.flatMap((s) => s.items.map((i) => i.contentId));

    expect(included).toEqual(['1']);
    expect(result.itemCount).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 定时发布                                                            */
/* ------------------------------------------------------------------ */

describe('publishIfScheduled（docs/10 的 08:00）', () => {
  it('**未审核 08:00 不发**：DRAFT 到点只提醒、不发布', async () => {
    const { service, repository, notifier } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.DRAFT });

    const outcome = await service.publishIfScheduled(TODAY);

    expect(outcome.published).toBe(false);
    expect(outcome.reason).toBe('NOT_SCHEDULED');
    expect(repository.markPublishedCalls).toBe(0);
    // 而且要告诉管理员（否则「今天没出报」是静默的）
    expect(notifier.countOf(PublishingNotificationType.DAILY_NOT_PUBLISHED)).toBe(1);
    expect(notifier.calls[0]?.targetUrl).toBe(dailyAdminUrl(TODAY));
  });

  it('REVIEWING 同样不发（审核中 ≠ 已排期）', async () => {
    const { service, repository } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.REVIEWING });

    const outcome = await service.publishIfScheduled(TODAY);
    expect(outcome.reason).toBe('NOT_SCHEDULED');
  });

  it('⚠ CANCELLED 不发，**而且不发提醒**（取消是管理员的主动决定，提醒是噪音）', async () => {
    const { service, repository, notifier } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.CANCELLED });

    const outcome = await service.publishIfScheduled(TODAY);

    expect(outcome.published).toBe(false);
    // 与 NOT_SCHEDULED 分开：「本该有报纸但没出」和「本来就没有报纸」是两件事
    expect(outcome.reason).toBe('CANCELLED');
    expect(notifier.calls).toHaveLength(0);
  });

  it('对照：DRAFT 不发**但会提醒**（这才是「今天漏了一件事」）', async () => {
    const { service, repository, notifier } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.DRAFT });

    const outcome = await service.publishIfScheduled(TODAY);

    expect(outcome.reason).toBe('NOT_SCHEDULED');
    expect(notifier.countOf(PublishingNotificationType.DAILY_NOT_PUBLISHED)).toBe(1);
  });

  it('没有期次 → NO_EDITION（不报错、不建期次）', async () => {
    const { service } = build();
    const outcome = await service.publishIfScheduled(TODAY);
    expect(outcome.reason).toBe('NO_EDITION');
  });

  it('SCHEDULED 且预检通过 → 发布并分配期号', async () => {
    const { service, repository } = build();
    repository.seedEdition({
      businessDate: TODAY,
      status: DailyEditionStatus.SCHEDULED,
      sections: [
        {
          type: DailySectionType.FRONT_PAGE,
          title: '首页',
          sortOrder: 0,
          items: [{ contentId: '1', displayStyle: DailyDisplayStyle.LEAD, sortOrder: 0 }],
        },
      ],
    });

    const outcome = await service.publishIfScheduled(TODAY);

    expect(outcome.published).toBe(true);
    expect(outcome.reason).toBe('PUBLISHED');
    expect(outcome.editionNo).toBe(1);
    expect(repository.editions.get(TODAY)?.status).toBe(DailyEditionStatus.PUBLISHED);
    expect(repository.editions.get(TODAY)?.publishedAt).toBe(PUBLISH_MOMENT.toISOString());
  });

  it('第二期拿到期号 2（期号是「已发布期数 + 1」）', async () => {
    const { service, repository } = build();
    repository.seedEdition({
      businessDate: '2026-09-28',
      status: DailyEditionStatus.PUBLISHED,
      editionNo: 1,
    });
    repository.seedEdition({
      businessDate: TODAY,
      status: DailyEditionStatus.SCHEDULED,
      sections: [
        {
          type: DailySectionType.FRONT_PAGE,
          title: '首页',
          sortOrder: 0,
          items: [{ contentId: '1', displayStyle: DailyDisplayStyle.LEAD, sortOrder: 0 }],
        },
      ],
    });

    const outcome = await service.publishIfScheduled(TODAY);
    expect(outcome.editionNo).toBe(2);
  });

  it('预检失败 → 不发布、不占期号，并通知管理员「为什么」', async () => {
    const { service, repository, notifier } = build();
    repository.seedEdition({
      businessDate: TODAY,
      status: DailyEditionStatus.SCHEDULED,
      sections: [
        {
          type: DailySectionType.AI,
          title: 'AI',
          sortOrder: 1,
          // 没有 LEAD
          items: [{ contentId: '1', displayStyle: DailyDisplayStyle.STANDARD, sortOrder: 0 }],
        },
      ],
    });

    const outcome = await service.publishIfScheduled(TODAY);

    expect(outcome.published).toBe(false);
    expect(outcome.reason).toBe('PREFLIGHT_FAILED');
    expect(outcome.issues.map((issue) => issue.reason)).toContain('LEAD_REQUIRED');
    expect(repository.markPublishedCalls).toBe(0);
    expect(notifier.countOf(PublishingNotificationType.DAILY_PREFLIGHT_BLOCKED)).toBe(1);
  });

  it('幂等：已经发布过再跑一次 → ALREADY_PUBLISHED，不重复占号', async () => {
    const { service, repository } = build();
    repository.seedEdition({
      businessDate: TODAY,
      status: DailyEditionStatus.PUBLISHED,
      editionNo: 7,
    });

    const outcome = await service.publishIfScheduled(TODAY);

    expect(outcome.published).toBe(false);
    expect(outcome.reason).toBe('ALREADY_PUBLISHED');
    expect(outcome.editionNo).toBe(7);
    expect(repository.markPublishedCalls).toBe(0);
  });

  it('并发（读之后别人先发了）→ ALREADY_PUBLISHED，不报错', async () => {
    const { service, repository } = build();
    repository.seedEdition({
      businessDate: TODAY,
      status: DailyEditionStatus.SCHEDULED,
      sections: [
        {
          type: DailySectionType.FRONT_PAGE,
          title: '首页',
          sortOrder: 0,
          items: [{ contentId: '1', displayStyle: DailyDisplayStyle.LEAD, sortOrder: 0 }],
        },
      ],
    });
    repository.simulateConcurrentPublish = true;

    const outcome = await service.publishIfScheduled(TODAY);
    expect(outcome.reason).toBe('ALREADY_PUBLISHED');
    expect(repository.markPublishedCalls).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 07:30 提醒                                                          */
/* ------------------------------------------------------------------ */

describe('remindIfNotReviewing（docs/10 的 07:30）', () => {
  it('仍是 DRAFT → 提醒', async () => {
    const { service, repository, notifier } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.DRAFT });

    const outcome = await service.remindIfNotReviewing(TODAY);

    expect(outcome.reason).toBe('NOTIFIED');
    expect(notifier.countOf(PublishingNotificationType.DAILY_REVIEW_PENDING)).toBe(1);
  });

  it('幂等：同一天再跑不会重复写通知', async () => {
    const { service, repository, notifier } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.DRAFT });

    await service.remindIfNotReviewing(TODAY);
    const second = await service.remindIfNotReviewing(TODAY);

    expect(second.reason).toBe('ALREADY_NOTIFIED');
    expect(notifier.countOf(PublishingNotificationType.DAILY_REVIEW_PENDING)).toBe(1);
  });

  it('已经 REVIEWING / SCHEDULED / PUBLISHED → 不打扰', async () => {
    for (const status of [
      DailyEditionStatus.REVIEWING,
      DailyEditionStatus.SCHEDULED,
      DailyEditionStatus.PUBLISHED,
    ]) {
      const { service, repository, notifier } = build();
      repository.seedEdition({ businessDate: TODAY, status });
      const outcome = await service.remindIfNotReviewing(TODAY);
      expect(outcome.reason, `${status}`).toBe('ALREADY_REVIEWING');
      expect(notifier.calls).toHaveLength(0);
    }
  });

  it('已取消 → 不再提醒（管理员已经明确决定了）', async () => {
    const { service, repository, notifier } = build();
    repository.seedEdition({ businessDate: TODAY, status: DailyEditionStatus.CANCELLED });

    const outcome = await service.remindIfNotReviewing(TODAY);
    expect(outcome.reason).toBe('CANCELLED');
    expect(notifier.calls).toHaveLength(0);
  });

  it('没有期次 → NO_EDITION（不因此建期次）', async () => {
    const { service, repository } = build();
    const outcome = await service.remindIfNotReviewing(TODAY);
    expect(outcome.reason).toBe('NO_EDITION');
    expect(repository.editions.size).toBe(0);
  });
});
