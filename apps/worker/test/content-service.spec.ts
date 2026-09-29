/**
 * `ContentService` 的守卫 —— Normalize 阶段的编排行为。
 *
 * 重点覆盖三件容易静默出错的事：
 * 1. **幂等**：`content.normalize` 会因为重试、或归一化规则升版本而重复入队，
 *    第二次执行必须是干净的空操作（而不是报错、也不是建出第二条 Content）；
 * 2. **数据失败 ≠ 任务失败**：「清洗完什么都没有」是数据结论，
 *    要记成 `raw_items.status = FAILED` 而不是抛异常让 BullMQ 白重试三次；
 * 3. **事务原子性**：建 Content 失败时 RawItem 状态不得被改动。
 */

import { describe, expect, it } from 'vitest';
import { ContentPipelineStatus, DomainErrorCode, RawItemStatus, SourceType } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream } from '@signal/test-utils';
import { ContentService } from '../src/jobs/content/content.service';
import {
  FakeContentClock,
  InMemoryContentRepository,
  RecordingContentEnqueuer,
} from './support/content-fakes';

function buildService(clockAt?: string) {
  const repository = new InMemoryContentRepository();
  const enqueuer = new RecordingContentEnqueuer();
  const clock = new FakeContentClock(clockAt === undefined ? undefined : new Date(clockAt));
  const stream = createMemoryStream();
  const service = new ContentService(
    repository,
    createLogger({ service: 'worker', destination: stream }),
    enqueuer,
    clock,
  );
  return { service, repository, enqueuer, clock, stream };
}

describe('正常路径', () => {
  it('RawItem → Content，并把 RawItem 推进到 NORMALIZED', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42' });

    const outcome = await service.normalize('42');

    expect(outcome.status).toBe('NORMALIZED');
    if (outcome.status !== 'NORMALIZED') throw new Error('unreachable');
    expect(outcome.alreadyExisted).toBe(false);
    expect(outcome.content.title).toBe('Anthropic 发布新的评测报告');
    expect(repository.statusOf('42')).toBe(RawItemStatus.NORMALIZED);
    expect(repository.contentCount()).toBe(1);
  });

  it('落库的 Content 带 INGESTED 状态与推导出的类型', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42', sourceType: SourceType.X_USER, payload: {} });

    const outcome = await service.normalize('42');
    if (outcome.status !== 'NORMALIZED') throw new Error('unreachable');

    const row = repository.contentById(outcome.contentId);
    expect(row?.pipelineStatus).toBe(ContentPipelineStatus.INGESTED);
    expect(row?.type).toBe('X_POST');
    expect(row?.bodyOriginal).toContain('推理成本');
  });

  it('正文与标题都进了库（不是只写一半）', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42' });

    const outcome = await service.normalize('42');
    if (outcome.status !== 'NORMALIZED') throw new Error('unreachable');

    const row = repository.contentById(outcome.contentId);
    expect(row?.title).toBeTruthy();
    expect(row?.bodyOriginal).toBeTruthy();
    expect(row?.originalUrl).toBe('https://example.com/posts/1');
  });
});

describe('幂等（重试安全）', () => {
  it('同一条 RawItem 归一化两次不会建出第二条 Content', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42' });

    const first = await service.normalize('42');
    const second = await service.normalize('42');

    expect(repository.contentCount()).toBe(1);
    if (first.status !== 'NORMALIZED' || second.status !== 'NORMALIZED') {
      throw new Error('unreachable');
    }
    expect(second.alreadyExisted).toBe(true);
    expect(second.contentId).toBe(first.contentId);
  });

  it('幂等命中时不重复写库', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42' });

    await service.normalize('42');
    const writesAfterFirst = repository.writes.length;
    await service.normalize('42');

    expect(repository.writes.length).toBe(writesAfterFirst);
  });

  it('幂等路径不抛错（重试是正常路径，不是异常）', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42' });
    await service.normalize('42');

    await expect(service.normalize('42')).resolves.toMatchObject({ status: 'NORMALIZED' });
  });
});

describe('数据失败 vs 任务失败', () => {
  it('既无标题也无正文 → 标 RawItem FAILED，**不抛异常**', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42', titleRaw: null, bodyRaw: null });

    const outcome = await service.normalize('42');

    expect(outcome.status).toBe('FAILED');
    if (outcome.status !== 'FAILED') throw new Error('unreachable');
    expect(outcome.code).toBe(DomainErrorCode.CONTENT_EMPTY);
    expect(repository.statusOf('42')).toBe(RawItemStatus.FAILED);
    // 不该建出 Content
    expect(repository.contentCount()).toBe(0);
  });

  it('清洗后只剩空壳（script/iframe）同样标 FAILED', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({
      rawItemId: '42',
      titleRaw: null,
      bodyRaw: '<script>a()</script><iframe></iframe>',
    });

    const outcome = await service.normalize('42');
    expect(outcome.status).toBe('FAILED');
    expect(repository.statusOf('42')).toBe(RawItemStatus.FAILED);
  });

  it('失败会写一条可见的 warn 日志（带 errorCode）', async () => {
    const { service, repository, stream } = buildService();
    repository.seedRawItem({ rawItemId: '42', titleRaw: null, bodyRaw: null });

    await service.normalize('42');

    const record = stream
      .records()
      .find((entry) => String(entry.msg).includes('cannot be normalized'));
    expect(record).toMatchObject({ errorCode: DomainErrorCode.CONTENT_EMPTY, rawItemId: '42' });
  });

  it('成功会写一条 info 日志（带 contentId 与正文长度）', async () => {
    const { service, repository, stream } = buildService();
    repository.seedRawItem({ rawItemId: '42' });

    await service.normalize('42');

    const record = stream.records().find((entry) => String(entry.msg) === 'content normalized');
    expect(record).toBeDefined();
    expect(record).toMatchObject({ rawItemId: '42', contentType: 'ARTICLE' });
    expect(typeof record?.bodyChars).toBe('number');
  });
});

describe('RawItem 不存在 → 抛不可重试的错误', () => {
  it('不存在的 id 抛 CONTENT_RAW_ITEM_NOT_FOUND', async () => {
    const { service } = buildService();

    await expect(service.normalize('999')).rejects.toMatchObject({
      code: DomainErrorCode.CONTENT_RAW_ITEM_NOT_FOUND,
    });
  });

  it('抛的是 AppError 子类（能被平台统一处理）', async () => {
    const { service } = buildService();
    await expect(service.normalize('999')).rejects.toThrow(/RawItem not found/);
  });

  it('不存在的 id 不写任何东西', async () => {
    const { service, repository } = buildService();
    await service.normalize('999').catch(() => undefined);
    expect(repository.writes).toHaveLength(0);
  });
});

describe('事务原子性', () => {
  it('建 Content 失败时，RawItem 状态**不得**被推进（不留半截状态）', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42' });
    repository.failCreate = new Error('写库时数据库连接断了');

    await expect(service.normalize('42')).rejects.toThrow('写库时数据库连接断了');

    // 关键：状态仍是 FETCHED，所以调度器下一轮会重新捞起它 —— 这是正确的可重试语义
    expect(repository.statusOf('42')).toBe(RawItemStatus.FETCHED);
    expect(repository.contentCount()).toBe(0);
  });
});

describe('流水线串联（normalize → dedup）', () => {
  it('归一化成功后**入队下一阶段**（否则流水线会静默停在第一站）', async () => {
    const { service, repository, enqueuer } = buildService();
    repository.seedRawItem({ rawItemId: '42' });

    const outcome = await service.normalize('42');

    if (outcome.status !== 'NORMALIZED') throw new Error('unreachable');
    expect(enqueuer.deduped).toEqual([outcome.contentId]);
  });

  it('幂等命中**也**入队下一阶段（补上「Content 建好但入队失败」的那次）', async () => {
    const { service, repository, enqueuer } = buildService();
    repository.seedRawItem({ rawItemId: '42' });

    await service.normalize('42');
    enqueuer.deduped.length = 0; // 清掉第一次
    await service.normalize('42'); // 幂等命中

    expect(enqueuer.deduped).toHaveLength(1);
  });

  it('判为精确重复时**不入队**（没有 Content 可分析）', async () => {
    const { service, repository, enqueuer } = buildService();
    repository.seedRawItem({ rawItemId: '42', contentHash: 'a'.repeat(64) });
    repository.seedRawItem({ rawItemId: '43', contentHash: 'a'.repeat(64) });

    await service.normalize('42');
    enqueuer.deduped.length = 0;
    const second = await service.normalize('43');

    expect(second.status).toBe('DUPLICATE');
    expect(enqueuer.deduped).toHaveLength(0);
  });

  it('数据失败（CONTENT_EMPTY）时也不入队', async () => {
    const { service, repository, enqueuer } = buildService();
    repository.seedRawItem({ rawItemId: '42', titleRaw: null, bodyRaw: null });

    await service.normalize('42');

    expect(enqueuer.deduped).toHaveLength(0);
  });

  it('**入队失败会抛出去**（不静默断链）—— 重试是安全的，因为 normalize 幂等', async () => {
    const { service, repository, enqueuer } = buildService();
    repository.seedRawItem({ rawItemId: '42' });
    enqueuer.failDedup = new Error('Redis 挂了');

    await expect(service.normalize('42')).rejects.toThrow('Redis 挂了');

    // Content 已经建好了（这是对的），重试时走幂等命中并把链条补上
    expect(repository.contentCount()).toBe(1);
    enqueuer.failDedup = null;
    await expect(service.normalize('42')).resolves.toMatchObject({ status: 'NORMALIZED' });
    expect(enqueuer.deduped).toHaveLength(1);
  });
});

describe('近似判重（Near Dedup，S3）', () => {
  const SAME_A = 'Anthropic 发布了新的模型能力评测报告，指出推理成本在 2026 年下降了约 40%。';
  const SAME_B = 'Anthropic 发布最新模型能力评测报告，报告指出推理成本在 2026 年下降约 40%。';
  const OTHER = '某开源项目宣布停止维护，作者说明原因是维护成本过高。';

  /** 直接往替身里塞一条已存在的 Content（跳过 normalize）。 */
  async function seedContent(
    repository: InMemoryContentRepository,
    rawItemId: string,
    sourceId: string,
    body: string,
  ): Promise<string> {
    repository.seedRawItem({ rawItemId, sourceId, bodyRaw: `<p>${body}</p>` });
    const persisted = await repository.createContentAndAdvance({
      sourceId,
      rawItemId,
      type: 'ARTICLE' as never,
      title: body,
      bodyOriginal: `<p>${body}</p>`,
      language: 'zh',
      originalUrl: `https://example.com/${rawItemId}`,
      imageUrl: null,
      publishedAt: null,
      pipelineStatus: 'INGESTED' as never,
    });
    return persisted.contentId;
  }

  it('跨源近似 → 进 crossSourceMatches', async () => {
    const { service, repository } = buildService();
    await seedContent(repository, '42', '7', SAME_A);
    const probeId = await seedContent(repository, '43', '9', SAME_B);

    const verdict = await service.findNearDuplicates(probeId);

    expect(verdict).not.toBeNull();
    expect(verdict!.crossSourceMatches.length).toBeGreaterThanOrEqual(1);
  });

  it('不相关的内容不产生匹配', async () => {
    const { service, repository } = buildService();
    await seedContent(repository, '42', '7', SAME_A);
    const probeId = await seedContent(repository, '43', '9', OTHER);

    const verdict = await service.findNearDuplicates(probeId);

    expect(verdict!.crossSourceMatches).toHaveLength(0);
    expect(verdict!.sameSourceMatches).toHaveLength(0);
  });

  it('Content 不存在 → 返回 null（不是抛错）', async () => {
    const { service } = buildService();
    await expect(service.findNearDuplicates('999')).resolves.toBeNull();
  });

  it('候选窗口之外的不参与比较（时钟推进 8 天后就找不到旧的了）', async () => {
    const { service, repository, clock } = buildService();
    await seedContent(repository, '42', '7', SAME_A);
    const probeId = await seedContent(repository, '43', '9', SAME_B);

    clock.set(new Date(Date.now() + 8 * 24 * 3600 * 1000));
    const verdict = await service.findNearDuplicates(probeId);

    expect(verdict!.crossSourceMatches).toHaveLength(0);
  });

  it('**不做任何写入** —— 判重只产出候选（多来源是资产，不是噪声）', async () => {
    const { service, repository } = buildService();
    await seedContent(repository, '42', '7', SAME_A);
    const probeId = await seedContent(repository, '43', '9', SAME_B);
    const writesBefore = repository.writes.length;

    await service.findNearDuplicates(probeId);

    expect(repository.writes.length).toBe(writesBefore);
  });
});

describe('事件聚合（Event Cluster，S4）', () => {
  const SAME_A = 'Anthropic 发布了新的模型能力评测报告，指出推理成本在 2026 年下降了约 40%。';
  const SAME_B = 'Anthropic 发布最新模型能力评测报告，报告指出推理成本在 2026 年下降约 40%。';
  const OTHER = '某开源项目宣布停止维护，作者说明原因是维护成本过高。';

  async function seed(
    repository: InMemoryContentRepository,
    rawItemId: string,
    sourceId: string,
    body: string,
  ): Promise<string> {
    repository.seedRawItem({ rawItemId, sourceId, bodyRaw: `<p>${body}</p>` });
    const persisted = await repository.createContentAndAdvance({
      sourceId,
      rawItemId,
      type: 'ARTICLE' as never,
      title: body,
      bodyOriginal: `<p>${body}</p>`,
      language: 'zh',
      originalUrl: `https://example.com/${rawItemId}`,
      imageUrl: null,
      publishedAt: null,
      pipelineStatus: 'INGESTED' as never,
    });
    return persisted.contentId;
  }

  it('第一篇内容 → 新建事件', async () => {
    const { service, repository } = buildService();
    const id = await seed(repository, '42', '7', SAME_A);

    const outcome = await service.clusterContent(id);

    expect(outcome).toMatchObject({ action: 'create' });
    expect(repository.events.size).toBe(1);
  });

  it('同一事件的另一篇报道 → 加入已有事件', async () => {
    const { service, repository } = buildService();
    const a = await seed(repository, '42', '7', SAME_A);
    const b = await seed(repository, '43', '9', SAME_B);

    await service.clusterContent(a);
    const outcome = await service.clusterContent(b);

    expect(outcome).toMatchObject({ action: 'join' });
    expect(repository.events.size).toBe(1);
  });

  it('不相关的内容 → 各自新建事件', async () => {
    const { service, repository } = buildService();
    const a = await seed(repository, '42', '7', SAME_A);
    const b = await seed(repository, '43', '9', OTHER);

    await service.clusterContent(a);
    await service.clusterContent(b);

    expect(repository.events.size).toBe(2);
  });

  it('**幂等**：同一条内容聚合两次不会建出第二个事件', async () => {
    const { service, repository } = buildService();
    const id = await seed(repository, '42', '7', SAME_A);

    const first = await service.clusterContent(id);
    const second = await service.clusterContent(id);

    expect(repository.events.size).toBe(1);
    expect(second).toMatchObject({ action: 'join' });
    if (first?.action !== 'create' || second?.action !== 'join') throw new Error('unreachable');
    expect(second.eventId).toBe(first.eventId);
  });

  it('**主来源会重算**：官方随后加入时，主稿换成官方那篇', async () => {
    const { service, repository } = buildService();
    // 媒体先报（tier=C，第 5 档）
    repository.setSourcePriority('7', { tier: 'C' as never, kind: 'MEDIA' as never, official: false });
    // 官方随后发公告（official=true，第 1 档）
    repository.setSourcePriority('8', { tier: 'S' as never, kind: 'OFFICIAL' as never, official: true });

    const media = await seed(repository, '42', '7', SAME_A);
    const official = await seed(repository, '43', '8', SAME_B);

    await service.clusterContent(media);
    const outcome = await service.clusterContent(official);

    // 官方那篇成为主稿 —— 否则前台会一直引用二手报道
    expect(outcome).toMatchObject({ action: 'join', primaryContentId: official });
  });

  it('Content 不存在 → 返回 null（不抛错）', async () => {
    const { service } = buildService();
    await expect(service.clusterContent('999')).resolves.toBeNull();
  });

  it('聚合写事件表 + 证据，并把内容的 pipelineStatus 推进到 ANALYZING', async () => {
    const { service, repository } = buildService();
    const id = await seed(repository, '42', '7', SAME_A);
    repository.writes.length = 0;

    await service.clusterContent(id);

    const tables = new Set(repository.writes.map((w) => w.table));
    // events / event_contents：事件与归属
    // contents：把 pipelineStatus 推到 ANALYZING（S6 的状态机，归本模块）
    expect([...tables].sort()).toEqual(['contents', 'event_contents', 'events']);
    expect(repository.statusOfContent(id)).toBe(ContentPipelineStatus.ANALYZING);
  });
});

describe('Evidence Attach（S5）', () => {
  const SAME_A = 'Anthropic 发布了新的模型能力评测报告，指出推理成本在 2026 年下降了约 40%。';
  const SAME_B = 'Anthropic 发布最新模型能力评测报告，报告指出推理成本在 2026 年下降约 40%。';

  async function seed(
    repository: InMemoryContentRepository,
    rawItemId: string,
    sourceId: string,
    body: string,
  ): Promise<string> {
    repository.seedRawItem({ rawItemId, sourceId, bodyRaw: `<p>${body}</p>` });
    const persisted = await repository.createContentAndAdvance({
      sourceId,
      rawItemId,
      type: 'ARTICLE' as never,
      title: body,
      bodyOriginal: `<p>${body}</p>`,
      language: 'zh',
      originalUrl: `https://example.com/${sourceId}/${rawItemId}`,
      imageUrl: null,
      publishedAt: null,
      pipelineStatus: 'INGESTED' as never,
    });
    return persisted.contentId;
  }

  it('聚类后自动生成证据，且**恰好一个 Primary**', async () => {
    const { service, repository } = buildService();
    repository.setSourcePriority('7', { tier: 'S' as never, kind: 'OFFICIAL' as never, official: true });
    const id = await seed(repository, '42', '7', SAME_A);

    const outcome = await service.clusterContent(id);

    expect(outcome?.evidence?.inserted).toBe(1);
    expect(repository.primaryEvidenceCount(outcome!.eventId)).toBe(1);
  });

  it('**同 Source 的多条内容只算一个独立来源**', async () => {
    const { service, repository } = buildService();
    repository.setSourcePriority('7', { tier: 'B' as never, kind: 'MEDIA' as never, official: false });
    const a = await seed(repository, '42', '7', SAME_A);
    const b = await seed(repository, '43', '7', SAME_B);

    await service.clusterContent(a);
    const second = await service.clusterContent(b);

    // 证据两条，但独立来源仍然是 1（docs/06 的核心口径）
    expect(second?.evidence?.independentSourceCount).toBe(1);
    expect(repository.primaryEvidenceCount(second!.eventId)).toBeLessThanOrEqual(1);
  });

  it('不同来源各算一个独立来源', async () => {
    const { service, repository } = buildService();
    repository.setSourcePriority('7', { tier: 'B' as never, kind: 'MEDIA' as never, official: false });
    repository.setSourcePriority('8', { tier: 'B' as never, kind: 'MEDIA' as never, official: false });
    const a = await seed(repository, '42', '7', SAME_A);
    const b = await seed(repository, '43', '8', SAME_B);

    await service.clusterContent(a);
    const second = await service.clusterContent(b);

    expect(second?.evidence?.independentSourceCount).toBe(2);
  });

  it('**重复聚合不会重复插证据**（幂等）', async () => {
    const { service, repository } = buildService();
    // 用官方来源，这样事件里有 PRIMARY_SOURCE，能顺带验 Primary 的唯一性。
    repository.setSourcePriority('7', { tier: 'S' as never, kind: 'OFFICIAL' as never, official: true });
    const id = await seed(repository, '42', '7', SAME_A);

    const first = await service.clusterContent(id);
    await service.clusterContent(id);

    expect(repository.evidence.get(first!.eventId)!).toHaveLength(1);
    // 不变式：**任何时刻最多一个 Primary**
    expect(repository.primaryEvidenceCount(first!.eventId)).toBe(1);
  });

  it('**非官方来源的事件不设 Primary**（「有 Primary」本身就是可信度断言）', async () => {
    const { service, repository } = buildService();
    repository.setSourcePriority('7', { tier: 'C' as never, kind: 'MEDIA' as never, official: false });
    const id = await seed(repository, '42', '7', SAME_A);

    const outcome = await service.clusterContent(id);

    expect(outcome?.evidence?.primaryUrlHash).toBeNull();
    expect(repository.primaryEvidenceCount(outcome!.eventId)).toBe(0);
  });

  it('官方加入后成为 Primary（原先只有媒体时 Primary 可能为空）', async () => {
    const { service, repository } = buildService();
    repository.setSourcePriority('7', { tier: 'B' as never, kind: 'MEDIA' as never, official: false });
    repository.setSourcePriority('8', { tier: 'S' as never, kind: 'OFFICIAL' as never, official: true });

    const media = await seed(repository, '42', '7', SAME_A);
    const official = await seed(repository, '43', '8', SAME_B);

    const first = await service.clusterContent(media);
    // 只有媒体时没有 PRIMARY_SOURCE → 不设 Primary
    expect(first?.evidence?.primaryUrlHash).toBeNull();

    const second = await service.clusterContent(official);
    expect(second?.evidence?.primaryUrlHash).not.toBeNull();
    expect(repository.primaryEvidenceCount(second!.eventId)).toBe(1);
  });

  it('同 URL 的重复内容只留一条证据', async () => {
    const { service, repository } = buildService();
    const a = await seed(repository, '42', '7', SAME_A);
    const b = await seed(repository, '43', '9', SAME_B);
    // 把第二条的 URL 改成与第一条相同
    repository.contents.get(b)!.data.originalUrl = repository.contents.get(a)!.data.originalUrl;

    const first = await service.clusterContent(a);
    await service.clusterContent(b);

    expect(repository.evidence.get(first!.eventId)!).toHaveLength(1);
  });
});

describe('AI 衔接 + Review Queue（S6）', () => {
  const BODY = '某公司发布技术报告，指出推理成本下降约 40%。';

  async function seed(
    repository: InMemoryContentRepository,
    rawItemId: string,
    sourceId: string,
  ): Promise<string> {
    repository.seedRawItem({ rawItemId, sourceId, bodyRaw: `<p>${BODY} ${rawItemId}</p>` });
    const persisted = await repository.createContentAndAdvance({
      sourceId,
      rawItemId,
      type: 'ARTICLE' as never,
      title: BODY,
      bodyOriginal: `<p>${BODY}</p>`,
      language: 'zh',
      originalUrl: `https://example.com/${rawItemId}`,
      imageUrl: null,
      publishedAt: null,
      pipelineStatus: 'INGESTED' as never,
    });
    return persisted.contentId;
  }

  it('聚类后把内容交给 AI：状态 ANALYZING + 两个 AI 作业入队', async () => {
    const { service, repository, enqueuer } = buildService();
    const id = await seed(repository, '42', '7');

    await service.clusterContent(id);

    expect(repository.statusOfContent(id)).toBe(ContentPipelineStatus.ANALYZING);
    expect(enqueuer.aiTranslation).toEqual([id]);
    expect(enqueuer.aiScoring).toEqual([id]);
  });

  it('**先改状态再入队**（反过来会让内容永远卡在待分析）', async () => {
    const { service, repository, enqueuer } = buildService();
    const id = await seed(repository, '42', '7');

    // 入队时读到的状态必须是 ANALYZING
    let statusAtEnqueue: string | undefined;
    const original = enqueuer.enqueueAiTranslation.bind(enqueuer);
    enqueuer.enqueueAiTranslation = async (contentId: string) => {
      statusAtEnqueue = repository.statusOfContent(contentId);
      await original(contentId);
    };

    await service.clusterContent(id);

    expect(statusAtEnqueue).toBe(ContentPipelineStatus.ANALYZING);
  });

  it('收尾扫描：AiRun 都不在途 → 进 REVIEW_PENDING + 建审核行', async () => {
    const { service, repository } = buildService();
    const id = await seed(repository, '42', '7');
    await service.clusterContent(id);

    repository.setAiRuns(id, ['SUCCEEDED', 'SUCCEEDED']);
    repository.setTopic('ai-models', '11');
    repository.analyzedTopics.set(id, ['ai-models']);

    const finalized = await service.sweepForReview();

    expect(finalized).toBe(1);
    expect(repository.statusOfContent(id)).toBe(ContentPipelineStatus.REVIEW_PENDING);
    expect(repository.reviews.has(id)).toBe(true);
    expect(repository.contentTopics.get(id)).toEqual([{ topicId: '11', confidence: 1 }]);
  });

  it('**AiRun 还在途时不收尾**（否则会在 AI 写完之前就放行）', async () => {
    const { service, repository } = buildService();
    const id = await seed(repository, '42', '7');
    await service.clusterContent(id);

    repository.setAiRuns(id, ['SUCCEEDED', 'RUNNING']);

    expect(await service.sweepForReview()).toBe(0);
    expect(repository.statusOfContent(id)).toBe(ContentPipelineStatus.ANALYZING);
  });

  it('**失败的 AiRun 也算跑完**（翻译失败不该让内容永远进不了审核队列）', async () => {
    const { service, repository } = buildService();
    const id = await seed(repository, '42', '7');
    await service.clusterContent(id);

    repository.setAiRuns(id, ['FAILED', 'SUCCEEDED']);

    expect(await service.sweepForReview()).toBe(1);
    expect(repository.statusOfContent(id)).toBe(ContentPipelineStatus.REVIEW_PENDING);
  });

  it('一条 AiRun 都没有时不收尾（AI 还没被消费）', async () => {
    const { service, repository } = buildService();
    const id = await seed(repository, '42', '7');
    await service.clusterContent(id);

    expect(await service.sweepForReview()).toBe(0);
  });

  it('**重复收尾是幂等的**（不会建出第二个审核行）', async () => {
    const { service, repository } = buildService();
    const id = await seed(repository, '42', '7');
    await service.clusterContent(id);
    repository.setAiRuns(id, ['SUCCEEDED', 'SUCCEEDED']);

    expect(await service.sweepForReview()).toBe(1);
    expect(await service.sweepForReview()).toBe(0); // 已有审核行 → 不再收尾
    expect(repository.contentTopics.get(id)).toHaveLength(0);
  });

  it('模型没给主题时不报错（只是没有 ContentTopic）', async () => {
    const { service, repository } = buildService();
    const id = await seed(repository, '42', '7');
    await service.clusterContent(id);
    repository.setAiRuns(id, ['SUCCEEDED']);

    expect(await service.sweepForReview()).toBe(1);
    expect(repository.contentTopics.get(id)).toEqual([]);
  });

  it('模型给了一个库里不存在的主题 slug → 静默跳过（不建悬空关联）', async () => {
    const { service, repository } = buildService();
    const id = await seed(repository, '42', '7');
    await service.clusterContent(id);
    repository.setAiRuns(id, ['SUCCEEDED']);
    repository.analyzedTopics.set(id, ['not-a-real-topic']);

    expect(await service.sweepForReview()).toBe(1);
    expect(repository.contentTopics.get(id)).toEqual([]);
  });
});

describe('写入范围', () => {
  it('Pipeline 的 Normalize 只写 contents 与 raw_items', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42' });
    await service.normalize('42');

    expect(repository.writtenTables().sort()).toEqual(['contents', 'raw_items']);
  });

  it('不写 events / event_evidence（那是 S4/S5 的事）', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42' });
    await service.normalize('42');

    expect(repository.writtenTables()).not.toContain('events');
    expect(repository.writtenTables()).not.toContain('event_evidence');
  });
});

describe('Exact Dedup（`docs/06` 幂等键 ③）', () => {
  const HASH = 'a'.repeat(64);

  it('同一份内容从别的来源出现 → 不建 Content，把 RawItem 标成 DUPLICATE', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42', contentHash: HASH, sourceId: '7' });
    repository.seedRawItem({ rawItemId: '43', contentHash: HASH, sourceId: '9' });

    const first = await service.normalize('42');
    const second = await service.normalize('43');

    expect(first.status).toBe('NORMALIZED');
    expect(second.status).toBe('DUPLICATE');
    // 关键：库里只有一条 Content
    expect(repository.contentCount()).toBe(1);
    expect(repository.statusOf('43')).toBe(RawItemStatus.DUPLICATE);
  });

  it('重复的那条给出正本 id 与「是否同源」', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42', contentHash: HASH, sourceId: '7' });
    repository.seedRawItem({ rawItemId: '43', contentHash: HASH, sourceId: '9' });

    const first = await service.normalize('42');
    const second = await service.normalize('43');

    if (first.status !== 'NORMALIZED' || second.status !== 'DUPLICATE') {
      throw new Error('unreachable');
    }
    expect(second.canonicalContentId).toBe(first.contentId);
    expect(second.sameSource).toBe(false); // 42 来自 source 7、43 来自 source 9
  });

  it('同源重复也照样判出来（sameSource = true）', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42', contentHash: HASH, sourceId: '7' });
    repository.seedRawItem({ rawItemId: '43', contentHash: HASH, sourceId: '7' });

    await service.normalize('42');
    const second = await service.normalize('43');

    if (second.status !== 'DUPLICATE') throw new Error('unreachable');
    expect(second.sameSource).toBe(true);
  });

  it('**正本是先入库的那条**（后到的被标重复）', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42', contentHash: HASH });
    repository.seedRawItem({ rawItemId: '43', contentHash: HASH });

    const first = await service.normalize('42');
    const second = await service.normalize('43');

    if (first.status !== 'NORMALIZED' || second.status !== 'DUPLICATE') {
      throw new Error('unreachable');
    }
    expect(repository.statusOf('42')).toBe(RawItemStatus.NORMALIZED);
    expect(repository.statusOf('43')).toBe(RawItemStatus.DUPLICATE);
  });

  it('hash 不同 → 不是重复', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42', contentHash: 'a'.repeat(64) });
    repository.seedRawItem({ rawItemId: '43', contentHash: 'b'.repeat(64) });

    await service.normalize('42');
    const second = await service.normalize('43');

    expect(second.status).toBe('NORMALIZED');
    expect(repository.contentCount()).toBe(2);
  });

  it('**没有 hash 时不判重**（不退回「标题相同就算」）', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42', contentHash: null });
    repository.seedRawItem({ rawItemId: '43', contentHash: null });

    await service.normalize('42');
    const second = await service.normalize('43');

    // 两条标题正文完全一样，但没有 hash → 不判重，各自建 Content
    expect(second.status).toBe('NORMALIZED');
    expect(repository.contentCount()).toBe(2);
  });

  it('不会把自己判成自己的重复', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42', contentHash: HASH });

    await service.normalize('42');
    // 幂等命中（不是判重路径）
    const second = await service.normalize('42');
    expect(second.status).toBe('NORMALIZED');
  });

  it('判重发生在**落库之前**（没有多余的 Content 行）', async () => {
    const { service, repository } = buildService();
    repository.seedRawItem({ rawItemId: '42', contentHash: HASH });
    repository.seedRawItem({ rawItemId: '43', contentHash: HASH });

    await service.normalize('42');
    const writesBefore = repository.writes.filter((w) => w.table === 'contents').length;
    await service.normalize('43');
    const writesAfter = repository.writes.filter((w) => w.table === 'contents').length;

    expect(writesAfter).toBe(writesBefore); // 没有新增 contents 写入
  });

  it('判重会写一条带正本 id 的 info 日志', async () => {
    const { service, repository, stream } = buildService();
    repository.seedRawItem({ rawItemId: '42', contentHash: HASH });
    repository.seedRawItem({ rawItemId: '43', contentHash: HASH });

    await service.normalize('42');
    await service.normalize('43');

    const record = stream
      .records()
      .find((entry) => String(entry.msg).includes('exact duplicate'));
    expect(record).toBeDefined();
    expect(record).toMatchObject({ rawItemId: '43' });
  });
});
