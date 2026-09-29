/**
 * 审核后端服务层的守卫。
 *
 * 覆盖任务书点名的六项：**权限**（另见 HTTP 层测试）、**审核**、
 * **Evidence 操作**、**Primary 切换**、**高分通知**、**Source failure 通知**。
 *
 * 测试数据用中文（§23.4 第 4 问）：标题、来源名、备注都用真实形态。
 */

import { describe, expect, it } from 'vitest';
import {
  ContentPipelineStatus,
  EditorialReviewStatus,
  EvidenceType,
  PlatformErrorCode,
  SourceKind,
  SourceTier,
} from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import { ReviewService } from '../src/modules/admin-review/review.service';
import { EvidenceService, hashEvidenceUrl } from '../src/modules/admin-review/evidence.service';
import { NotificationService, NotificationType } from '../src/modules/admin-review/notification.service';
import { AuditEvent } from '../src/modules/admin-review/audit';
import { scoreBand } from '../src/modules/admin-review/scoring';
import { InMemoryAdminReviewRepository } from './support/admin-review-fakes';

const NOW = new Date('2026-09-29T02:00:00.000Z');
const ADMIN = '1';

function build() {
  const repository = new InMemoryAdminReviewRepository();
  const stream = createMemoryStream();
  const logger = createLogger({ service: 'api', destination: stream });
  return {
    repository,
    stream,
    reviews: new ReviewService(repository),
    evidence: new EvidenceService(repository, logger),
    notifications: new NotificationService(repository, logger),
  };
}

/** 一条待审内容（默认带审核行）。 */
function seedPending(
  repository: InMemoryAdminReviewRepository,
  overrides: Partial<Parameters<InMemoryAdminReviewRepository['seedContent']>[0]> = {},
): string {
  const contentId = overrides.contentId ?? '100';
  repository.seedContent({
    contentId,
    title: 'Anthropic 发布新的模型能力评测报告',
    finalScore: 88,
    publishedAt: '2026-09-29T01:00:00.000Z',
    recommendationReason: '官方一手发布，信息密度高。',
    source: {
      id: '7',
      name: 'Anthropic 官方博客',
      kind: SourceKind.OFFICIAL,
      tier: SourceTier.S,
      official: true,
    },
    ...overrides,
  });
  return contentId;
}

describe('分数档位（与 docs/08 一致）', () => {
  it('边界精确：85 / 70 / 55 都是下界含', () => {
    expect(scoreBand(85)).toBe('TOP_CANDIDATE');
    expect(scoreBand(84.99)).toBe('RECOMMENDED');
    expect(scoreBand(70)).toBe('RECOMMENDED');
    expect(scoreBand(69.99)).toBe('NORMAL');
    expect(scoreBand(55)).toBe('NORMAL');
    expect(scoreBand(54.99)).toBe('LOW');
  });
});

describe('审核队列（docs/09）', () => {
  it('默认按 finalScore DESC，未评分的排在最后', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100', finalScore: 70 });
    seedPending(repository, { contentId: '101', finalScore: 95 });
    seedPending(repository, { contentId: '102', finalScore: null });

    const page = await reviews.list({ page: 1, pageSize: 10 });

    expect(page.data.map((item) => item.contentId)).toEqual(['101', '100', '102']);
  });

  it('列表带 Source tier / official / 独立来源数（docs/09 的额外列）', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100', eventId: '900' });
    repository.seedEvent('900', '事件', '100');
    repository.seedEvidence({
      evidenceId: 'e1',
      eventId: '900',
      evidenceType: EvidenceType.PRIMARY_SOURCE,
      url: 'https://a.example.com/1',
      sourceId: '7',
      source: { id: '7', name: '官方', kind: SourceKind.OFFICIAL, tier: SourceTier.S, official: true },
    });
    repository.seedEvidence({
      evidenceId: 'e2',
      eventId: '900',
      evidenceType: EvidenceType.SUPPORTING_SOURCE,
      url: 'https://b.example.com/1',
      sourceId: '8',
      source: { id: '8', name: '媒体', kind: SourceKind.MEDIA, tier: SourceTier.B, official: false },
    });

    const page = await reviews.list({ page: 1, pageSize: 10 });

    expect(page.data[0]).toMatchObject({
      independentSourceCount: 2,
      hasOfficialConfirmation: true,
      scoreBand: 'TOP_CANDIDATE',
    });
    expect(page.data[0]!.source).toMatchObject({ tier: SourceTier.S, official: true });
  });

  it('**同 Source 的多条证据只算 1 个独立来源**（docs/06 口径）', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100', eventId: '900' });
    repository.seedEvent('900', '事件', '100');
    for (const [index, url] of ['https://a/1', 'https://a/2', 'https://a/3'].entries()) {
      repository.seedEvidence({
        evidenceId: `e${index}`,
        eventId: '900',
        evidenceType: EvidenceType.SUPPORTING_SOURCE,
        url,
        sourceId: '7',
      });
    }

    const page = await reviews.list({ page: 1, pageSize: 10 });
    expect(page.data[0]!.independentSourceCount).toBe(1);
  });

  it('分页 meta 正确', async () => {
    const { repository, reviews } = build();
    for (let index = 0; index < 5; index += 1) {
      seedPending(repository, { contentId: String(100 + index) });
    }

    const page = await reviews.list({ page: 2, pageSize: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.meta).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
  });
});

describe('审核详情（docs/09 的「必须同时看到」清单）', () => {
  it('逐项都在（原文/翻译、来源、AI 分数、事件、证据、独立来源、官方确认、相似内容）', async () => {
    const { repository, reviews } = build();
    seedPending(repository, {
      contentId: '100',
      eventId: '900',
      bodyOriginal: '<p>原文正文</p>',
      bodyTranslated: '<p>中文译文</p>',
      aiTopics: ['ai-models'],
    });
    repository.seedContent({ contentId: '101', title: '另一篇报道', eventId: '900' });
    repository.seedEvent('900', 'Anthropic 评测报告', '100');
    repository.seedEvidence({
      evidenceId: 'e1',
      eventId: '900',
      evidenceType: EvidenceType.PRIMARY_SOURCE,
      url: 'https://a.example.com/1',
      sourceId: '7',
      isPrimary: true,
      source: { id: '7', name: '官方', kind: SourceKind.OFFICIAL, tier: SourceTier.S, official: true },
    });
    repository.seedEvidence({
      evidenceId: 'e2',
      eventId: '900',
      evidenceType: EvidenceType.SUPPORTING_SOURCE,
      url: 'https://b.example.com/1',
      sourceId: '8',
      source: { id: '8', name: '媒体', kind: SourceKind.MEDIA, tier: SourceTier.B, official: false },
    });
    repository.seedEvidence({
      evidenceId: 'e3',
      eventId: '900',
      evidenceType: EvidenceType.RELATED_DISCUSSION,
      url: 'https://c.example.com/1',
      sourceId: '9',
    });

    const detail = await reviews.detail('100');

    expect(detail.content.bodyOriginal).toContain('原文正文');
    expect(detail.content.bodyTranslated).toContain('中文译文');
    expect(detail.source).toMatchObject({ kind: SourceKind.OFFICIAL, tier: SourceTier.S, official: true });
    expect(detail.aiScore.finalScore).toBe(88);
    expect(detail.aiScore.band).toBe('TOP_CANDIDATE');
    expect(detail.aiScore.recommendationReason).toContain('官方一手');
    expect(detail.aiScore.topics).toEqual(['ai-models']);
    expect(detail.event).toMatchObject({
      id: '900',
      canonicalTitle: 'Anthropic 评测报告',
      isPrimaryContent: true,
      independentSourceCount: 3,
      hasOfficialConfirmation: true,
    });
    expect(detail.event!.primaryEvidence?.evidenceId).toBe('e1');
    expect(detail.event!.supportingEvidence.map((e) => e.evidenceId)).toEqual(['e2']);
    expect(detail.event!.relatedDiscussion.map((e) => e.evidenceId)).toEqual(['e3']);
    // 相似内容 = 同一事件的其他内容
    expect(detail.similarContents.map((s) => s.contentId)).toEqual(['101']);
    expect(detail.review.status).toBe(EditorialReviewStatus.PENDING);
  });

  it('没有事件时 event 为 null（而不是伪造一个空事件）', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100', eventId: null });

    const detail = await reviews.detail('100');
    expect(detail.event).toBeNull();
    expect(detail.similarContents).toEqual([]);
  });

  it('内容不存在 → 404', async () => {
    const { reviews } = build();
    await expect(reviews.detail('999')).rejects.toMatchObject({
      code: PlatformErrorCode.NOT_FOUND,
      httpStatus: 404,
    });
  });

  it('**相似内容里的 similarity 是 null**（API 侧不重算相似度，也不谎报数字）', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100', eventId: '900' });
    repository.seedContent({ contentId: '101', eventId: '900' });
    repository.seedEvent('900', '事件', '100');

    const detail = await reviews.detail('100');
    expect(detail.similarContents[0]!.similarity).toBeNull();
  });
});

describe('审核决策（docs/09 的五个动作）', () => {
  it.each([
    ['APPROVE_FEATURED', EditorialReviewStatus.APPROVED, true, false],
    ['APPROVE_DAILY', EditorialReviewStatus.APPROVED, false, true],
    ['APPROVE_BOTH', EditorialReviewStatus.APPROVED, true, true],
    ['DEFER', EditorialReviewStatus.DEFERRED, false, false],
    ['REJECT', EditorialReviewStatus.REJECTED, false, false],
  ] as const)('%s → 审核状态 / 精选 / 日报候选', async (action, status, featured, daily) => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100' });

    const result = await reviews.decide('100', action, null, ADMIN, NOW);

    expect(result.reviewStatus).toBe(status);
    expect(result.publishFeatured).toBe(featured);
    expect(result.includeDailyCandidate).toBe(daily);
  });

  it('Approve 把内容推进到 APPROVED', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100' });

    const result = await reviews.decide('100', 'APPROVE_BOTH', null, ADMIN, NOW);
    expect(result.pipelineStatus).toBe(ContentPipelineStatus.APPROVED);
  });

  it('Reject 把内容推进到 REJECTED', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100' });

    const result = await reviews.decide('100', 'REJECT', null, ADMIN, NOW);
    expect(result.pipelineStatus).toBe(ContentPipelineStatus.REJECTED);
  });

  it('**Defer 不改内容状态**（它还留在候选池里，置 ARCHIVED 会让它消失）', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100' });

    const result = await reviews.decide('100', 'DEFER', null, ADMIN, NOW);
    expect(result.pipelineStatus).toBe(ContentPipelineStatus.REVIEW_PENDING);
  });

  it('记下 reviewedAt 与操作者', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100' });

    await reviews.decide('100', 'APPROVE_FEATURED', '看起来不错', ADMIN, NOW);

    expect(repository.decisions[0]).toMatchObject({
      reviewedByUserId: ADMIN,
      reviewedAt: NOW,
      adminNote: '看起来不错',
    });
  });

  it('内容/审核行不存在 → 404', async () => {
    const { reviews } = build();
    await expect(reviews.decide('999', 'APPROVE_BOTH', null, ADMIN, NOW)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});

describe('批量决策（docs/09：只允许 Defer / Reject）', () => {
  it('批量 Defer 生效', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100' });
    seedPending(repository, { contentId: '101' });

    const result = await reviews.bulk(['100', '101'], 'DEFER', null, ADMIN, NOW);

    expect(result.updated).toBe(2);
    expect(result.skipped).toEqual([]);
  });

  it('**不静默跳过**：不存在的 id 被逐条报出来', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100' });

    const result = await reviews.bulk(['100', '999'], 'REJECT', null, ADMIN, NOW);

    expect(result.updated).toBe(1);
    expect(result.skipped).toEqual([{ contentId: '999', reason: 'content or review not found' }]);
  });

  it('批量**不清空**精选/日报意图（两个布尔位保持 false，不覆盖单条的设置）', async () => {
    const { repository, reviews } = build();
    seedPending(repository, { contentId: '100' });

    await reviews.bulk(['100'], 'DEFER', null, ADMIN, NOW);

    expect(repository.decisions[0]).toMatchObject({
      publishFeatured: false,
      includeDailyCandidate: false,
    });
  });
});

describe('Evidence 人工操作（docs/09）', () => {
  function seedEventWithContent(repository: InMemoryAdminReviewRepository): void {
    seedPending(repository, { contentId: '100', eventId: '900' });
    repository.seedEvent('900', '事件', '100');
  }

  it('增加一个 Evidence URL', async () => {
    const { repository, evidence } = build();
    seedEventWithContent(repository);

    const result = await evidence.add(
      '900',
      { url: 'https://example.com/官方原文', evidenceType: EvidenceType.PRIMARY_SOURCE },
      ADMIN,
    );

    expect(result.evidence.url).toContain('官方原文');
    expect(result.evidence.evidenceType).toBe(EvidenceType.PRIMARY_SOURCE);
  });

  it('**同 URL 重复添加 → 409**（而不是把 P2002 抛给管理员）', async () => {
    const { repository, evidence } = build();
    seedEventWithContent(repository);
    const url = 'https://example.com/dup';

    await evidence.add('900', { url, evidenceType: EvidenceType.SUPPORTING_SOURCE }, ADMIN);

    await expect(
      evidence.add('900', { url, evidenceType: EvidenceType.SUPPORTING_SOURCE }, ADMIN),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('**URL scheme 白名单**：javascript: / data: 被拒', async () => {
    const { repository, evidence } = build();
    seedEventWithContent(repository);

    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://x/y']) {
      await expect(
        evidence.add('900', { url, evidenceType: EvidenceType.SUPPORTING_SOURCE }, ADMIN),
      ).rejects.toMatchObject({ code: PlatformErrorCode.VALIDATION_FAILED });
    }
  });

  it('相对 URL 被拒（证据必须是绝对地址，否则后台无法跳转）', async () => {
    const { repository, evidence } = build();
    seedEventWithContent(repository);

    await expect(
      evidence.add('900', { url: '/relative/path', evidenceType: EvidenceType.SUPPORTING_SOURCE }, ADMIN),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('修改 Evidence type', async () => {
    const { repository, evidence } = build();
    seedEventWithContent(repository);
    const created = await evidence.add(
      '900',
      { url: 'https://example.com/a', evidenceType: EvidenceType.SUPPORTING_SOURCE },
      ADMIN,
    );

    const updated = await evidence.update(
      '900',
      created.evidence.evidenceId,
      { evidenceType: EvidenceType.RELATED_DISCUSSION },
      ADMIN,
    );

    expect(updated.evidence.evidenceType).toBe(EvidenceType.RELATED_DISCUSSION);
  });

  it('删除 Evidence', async () => {
    const { repository, evidence } = build();
    seedEventWithContent(repository);
    const created = await evidence.add(
      '900',
      { url: 'https://example.com/a', evidenceType: EvidenceType.SUPPORTING_SOURCE },
      ADMIN,
    );

    await expect(evidence.remove('900', created.evidence.evidenceId, ADMIN)).resolves.toMatchObject(
      { deleted: true },
    );
    await expect(evidence.remove('900', created.evidence.evidenceId, ADMIN)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('**设置 Primary：任何时刻至多一个**', async () => {
    const { repository, evidence } = build();
    seedEventWithContent(repository);
    const a = await evidence.add(
      '900',
      { url: 'https://example.com/a', evidenceType: EvidenceType.PRIMARY_SOURCE },
      ADMIN,
    );
    const b = await evidence.add(
      '900',
      { url: 'https://example.com/b', evidenceType: EvidenceType.PRIMARY_SOURCE },
      ADMIN,
    );

    await evidence.setPrimary('900', a.evidence.evidenceId, ADMIN);
    expect(repository.primaryCount('900')).toBe(1);

    await evidence.setPrimary('900', b.evidence.evidenceId, ADMIN);
    // 关键：切换之后**仍然只有一个**（先清后设 + 事务）
    expect(repository.primaryCount('900')).toBe(1);
    expect(repository.evidences.get('900')!.find((e) => e.isPrimary)!.evidenceId).toBe(
      b.evidence.evidenceId,
    );
  });

  it('设置不存在的证据 → 404', async () => {
    const { repository, evidence } = build();
    seedEventWithContent(repository);

    await expect(evidence.setPrimary('900', 'nope', ADMIN)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('**每一次人工操作都写审计**（docs/09）', async () => {
    const { repository, evidence, stream } = build();
    seedEventWithContent(repository);
    const created = await evidence.add(
      '900',
      { url: 'https://example.com/a', evidenceType: EvidenceType.SUPPORTING_SOURCE },
      ADMIN,
    );
    await evidence.update('900', created.evidence.evidenceId, { title: '改标题' }, ADMIN);
    await evidence.setPrimary('900', created.evidence.evidenceId, ADMIN);
    await evidence.remove('900', created.evidence.evidenceId, ADMIN);

    const audits = stream.records().filter((record) => String(record.msg) === 'admin audit');
    expect(audits.map((record) => record.errorCode).sort()).toEqual(
      [
        AuditEvent.EVIDENCE_ADDED,
        AuditEvent.EVIDENCE_UPDATED,
        AuditEvent.EVIDENCE_PRIMARY_SET,
        AuditEvent.EVIDENCE_DELETED,
      ].sort(),
    );
    // 审计里必须能追到人
    expect(audits.every((record) => record.userId === ADMIN)).toBe(true);
  });

  it('hashEvidenceUrl 是 sha256 十六进制小写（对齐 Char(64)）', () => {
    const hash = hashEvidenceUrl('https://example.com/a');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('管理员通知（任务书的「高分通知 / Source failure 通知」）', () => {
  it('高分候选产生一条通知', async () => {
    const { repository, notifications } = build();
    seedPending(repository, { contentId: '100', finalScore: 92 });

    const result = await notifications.scan();

    expect(result.highScoreCreated).toBe(1);
    expect([...repository.notifications.values()][0]).toMatchObject({
      type: NotificationType.HIGH_SCORE_CONTENT,
      targetUrl: '/admin/review/100',
    });
  });

  it('低于 85 分不通知（docs/08 的一级候选阈值）', async () => {
    const { repository, notifications } = build();
    seedPending(repository, { contentId: '100', finalScore: 84.99 });

    expect((await notifications.scan()).highScoreCreated).toBe(0);
  });

  it('**已审过的内容不再通知**（管理员已经处理过它了）', async () => {
    const { repository, notifications } = build();
    seedPending(repository, {
      contentId: '100',
      finalScore: 92,
      reviewStatus: EditorialReviewStatus.APPROVED,
    });

    expect((await notifications.scan()).highScoreCreated).toBe(0);
  });

  it('**幂等**：重复扫描不会产生第二条通知', async () => {
    const { repository, notifications } = build();
    seedPending(repository, { contentId: '100', finalScore: 92 });

    const first = await notifications.scan();
    const second = await notifications.scan();

    expect(first.highScoreCreated).toBe(1);
    expect(second.highScoreCreated).toBe(0);
    expect(repository.notifications.size).toBe(1);
  });

  it('Source 失败产生一条通知', async () => {
    const { repository, notifications } = build();
    repository.failingSources.push({
      id: '7',
      name: '某官方博客',
      lastErrorCode: 'SOURCE_FETCH_FAILED',
      lastErrorAt: '2026-09-29T01:00:00.000Z',
    });

    const result = await notifications.scan();

    expect(result.sourceFailureCreated).toBe(1);
    expect([...repository.notifications.values()][0]!.targetUrl).toBe('/admin/sources/7');
  });

  it('Source 失败通知同样幂等', async () => {
    const { repository, notifications } = build();
    repository.failingSources.push({
      id: '7',
      name: '某官方博客',
      lastErrorCode: 'SOURCE_FETCH_FAILED',
      lastErrorAt: null,
    });

    await notifications.scan();
    expect((await notifications.scan()).sourceFailureCreated).toBe(0);
  });

  it('两类通知互不干扰（去重键按 type 分开）', async () => {
    const { repository, notifications } = build();
    seedPending(repository, { contentId: '100', finalScore: 92 });
    repository.failingSources.push({
      id: '7',
      name: '某官方博客',
      lastErrorCode: 'SOURCE_FETCH_FAILED',
      lastErrorAt: null,
    });

    const result = await notifications.scan();

    expect(result).toEqual({ highScoreCreated: 1, sourceFailureCreated: 1 });
  });

  it('通知产生时也写审计（actor 是 system）', async () => {
    const { repository, notifications, stream } = build();
    seedPending(repository, { contentId: '100', finalScore: 92 });

    await notifications.scan();

    const audit = stream
      .records()
      .find((record) => record.errorCode === AuditEvent.NOTIFICATION_RAISED);
    expect(audit).toMatchObject({ userId: 'system' });
  });
});

describe('Dashboard（按上海业务日）', () => {
  it('返回六项数字', async () => {
    const { repository, reviews } = build();
    repository.dashboard = {
      todayFetched: 42,
      highScorePending: 3,
      pendingReview: 12,
      failingSources: [
        { id: '7', name: '某来源', lastErrorCode: 'SOURCE_FETCH_FAILED', lastErrorAt: null },
      ],
      aiCostTodayUsd: 0.75,
      latestDailyEdition: { id: '1', businessDate: '2026-09-29', status: 'DRAFT' as never },
    };

    const stats = await reviews.dashboard(NOW);

    expect(stats).toMatchObject({
      todayFetched: 42,
      highScorePending: 3,
      pendingReview: 12,
      aiCostTodayUsd: 0.75,
    });
    expect(stats.failingSources).toHaveLength(1);
    expect(stats.latestDailyEdition?.businessDate).toBe('2026-09-29');
  });
});
