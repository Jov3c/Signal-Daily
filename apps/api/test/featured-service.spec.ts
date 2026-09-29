/**
 * `FeaturedService` 的守卫 —— 覆盖任务书的「**approved-only Featured**」。
 *
 * `docs/10`：
 *
 * > 精选是实时编辑流。Content APPROVED 且勾选 Featured 后创建 FeaturedItem。
 * > 允许：自定义展示标题 / 自定义摘要 / 调整权重 / 下架。
 * > 禁止改：原始来源、originalUrl、原发布时间。
 *
 * 最后那条「禁止改」在实现上是**接口形状**（`UpdateFeaturedInput` 里根本没有
 * 那些键）+ **请求校验**（传了就 400，不是静默忽略）两层。
 * 本文件把两层都钉住。
 */

import { describe, expect, it } from 'vitest';
import { ContentPipelineStatus, isAppError } from '@signal/contracts';
import { createLogger } from '@signal/logger';
import { createMemoryStream, type MemoryLogStream } from '@signal/test-utils';
import { FeaturedService } from '../src/modules/featured/service';
import {
  MAX_FEATURED_LIMIT,
  parseCreateFeaturedBody,
  parseFeaturedListQuery,
  parseUpdateFeaturedBody,
} from '../src/modules/featured/dto';
import { MAX_CUSTOM_TITLE_LENGTH, clampChars } from '../src/modules/featured/limits';
import { InMemoryFeaturedRepository, fixedClock } from './support/publishing-fakes';

const NOW = new Date('2026-09-29T02:00:00.000Z');
const ADMIN = '42';

function build(repository = new InMemoryFeaturedRepository()) {
  const stream: MemoryLogStream = createMemoryStream();
  const logger = createLogger({ service: 'api', destination: stream });
  return {
    repository,
    stream,
    service: new FeaturedService(repository, fixedClock(NOW), logger),
  };
}

function expectAppError(error: unknown, code: string): void {
  expect(isAppError(error), `期望 AppError，实际是 ${String(error)}`).toBe(true);
  if (isAppError(error)) expect(error.code).toBe(code);
}

describe('approved-only：两道门都要过（docs/10）', () => {
  it('已 APPROVED 且勾选了 Featured 才能进', async () => {
    const { service, repository } = build();
    repository.seedGate({
      contentId: '100',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishFeatured: true,
    });

    const created = await service.create('100', {}, ADMIN);
    expect(created.contentId).toBe('100');
    expect(created.active).toBe(true);
    expect(created.publishedAt).toBe(NOW.toISOString());
  });

  it('未 APPROVED（还在 REVIEW_PENDING）→ FEATURED_NOT_ELIGIBLE', async () => {
    const { service, repository } = build();
    repository.seedGate({
      contentId: '100',
      pipelineStatus: ContentPipelineStatus.REVIEW_PENDING,
      publishFeatured: true,
    });

    await expect(service.create('100', {}, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'FEATURED_NOT_ELIGIBLE');
      if (isAppError(error)) {
        expect(error.details).toMatchObject({ reason: 'NOT_APPROVED' });
      }
      return true;
    });
  });

  it('已 APPROVED 但**没有勾选** Featured → FEATURED_NOT_ELIGIBLE', async () => {
    const { service, repository } = build();
    repository.seedGate({
      contentId: '100',
      pipelineStatus: ContentPipelineStatus.APPROVED,
      publishFeatured: false, // 管理员只选了「加入日报」
    });

    await expect(service.create('100', {}, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'FEATURED_NOT_ELIGIBLE');
      if (isAppError(error)) {
        expect(error.details).toMatchObject({ reason: 'FEATURED_NOT_CHECKED' });
      }
      return true;
    });
  });

  it('内容不存在 → FEATURED_NOT_FOUND（不是 NOT_ELIGIBLE）', async () => {
    const { service } = build();
    await expect(service.create('999', {}, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'FEATURED_NOT_FOUND');
      return true;
    });
  });

  it('重复加入 → FEATURED_ALREADY_EXISTS（靠唯一约束，不是先查后写）', async () => {
    const { service, repository } = build();
    repository.seedGate({ contentId: '100' });
    await service.create('100', {}, ADMIN);

    await expect(service.create('100', {}, ADMIN)).rejects.toSatisfy((error: unknown) => {
      expectAppError(error, 'FEATURED_ALREADY_EXISTS');
      return true;
    });
  });
});

describe('允许改的四项 / 禁止改的三项', () => {
  it('能改自定义标题、摘要、权重、上下架', async () => {
    const { service, repository } = build();
    repository.seedGate({ contentId: '100' });
    await service.create('100', {}, ADMIN);

    const updated = await service.update(
      '100',
      {
        customTitle: '我们自己的标题',
        customSummary: '编辑写的一段摘要。',
        sortWeight: 90,
        active: false,
      },
      ADMIN,
    );

    expect(updated).toMatchObject({
      customTitle: '我们自己的标题',
      customSummary: '编辑写的一段摘要。',
      sortWeight: 90,
      active: false,
    });
  });

  it('**禁止改** originalUrl / publishedAt / sourceId —— 传了就 400，不是静默忽略', () => {
    for (const key of ['originalUrl', 'publishedAt', 'sourceId', 'source']) {
      expect(
        () =>
          parseUpdateFeaturedBody({ customTitle: 'x', [key]: 'y' }, (errors) => {
            throw new Error(errors.join('|'));
          }),
        `${key} 必须被拒绝`,
      ).toThrow(/not editable here/);
    }
  });

  it('一个可编辑字段都没给 → 400（不假装成功）', () => {
    expect(() =>
      parseUpdateFeaturedBody({}, (errors) => {
        throw new Error(errors.join('|'));
      }),
    ).toThrow(/at least one of/);
  });

  it('改不存在的精选项 → FEATURED_NOT_FOUND', async () => {
    const { service } = build();
    await expect(service.update('999', { sortWeight: 1 }, ADMIN)).rejects.toSatisfy(
      (error: unknown) => {
        expectAppError(error, 'FEATURED_NOT_FOUND');
        return true;
      },
    );
  });

  it('下架是软下架（active=false，保留历史）', async () => {
    const { service, repository } = build();
    repository.seedGate({ contentId: '100' });
    await service.create('100', {}, ADMIN);

    const off = await service.deactivate('100', ADMIN);
    expect(off.active).toBe(false);
    // 记录还在（不是删除）
    expect(await repository.findFeatured('100')).not.toBeNull();
  });
});

describe('列表', () => {
  it('公开面过滤掉下架的、以及内容已被撤下的', async () => {
    const { service, repository } = build();
    for (const contentId of ['100', '101', '102']) {
      repository.seedGate({ contentId });
      await service.create(contentId, {}, ADMIN);
    }
    await service.deactivate('101', ADMIN);
    // 102 的内容后来被撤下 —— 精选项不会自动消失，公开面必须自己过滤
    repository.seedGate({ contentId: '102', pipelineStatus: ContentPipelineStatus.REJECTED });

    const publicList = await service.list({ publicOnly: true, limit: 10 });
    expect(publicList.rows.map((row) => row.contentId)).toEqual(['100']);

    const adminList = await service.list({ publicOnly: false, limit: 10 });
    expect(adminList.rows).toHaveLength(3);
  });

  it('权重高的在前（docs/10 的「实时编辑流」按权重排）', async () => {
    const { service, repository } = build();
    for (const contentId of ['100', '101']) {
      repository.seedGate({ contentId });
      await service.create(contentId, {}, ADMIN);
    }
    await service.update('100', { sortWeight: 1 }, ADMIN);
    await service.update('101', { sortWeight: 99 }, ADMIN);

    const list = await service.list({ publicOnly: false, limit: 10 });
    expect(list.rows.map((row) => row.contentId)).toEqual(['101', '100']);
  });
});

describe('请求校验与截断', () => {
  it('limit 被夹到上限（不报错 —— 分页参数不值得 400）', () => {
    const parsed = parseFeaturedListQuery({ limit: '9999' }, (errors) => {
      throw new Error(errors.join('|'));
    });
    expect(parsed.limit).toBe(MAX_FEATURED_LIMIT);
  });

  it('非法 cursor 报错（静默忽略会让管理员以为翻页成功了）', () => {
    expect(() =>
      parseFeaturedListQuery({ cursor: 'abc' }, (errors) => {
        throw new Error(errors.join('|'));
      }),
    ).toThrow(/cursor/);
  });

  it('create 的 contentId 必须是十进制字符串', () => {
    expect(() =>
      parseCreateFeaturedBody({ contentId: 'abc' }, (errors) => {
        throw new Error(errors.join('|'));
      }),
    ).toThrow(/contentId/);
  });

  it('超长标题按**字符**截断（不劈开代理对）', () => {
    // 一个 emoji 是 2 个 UTF-16 码元，`slice` 会把它劈成两半
    const emoji = '🙂';
    const long = emoji.repeat(MAX_CUSTOM_TITLE_LENGTH + 10);

    const clamped = clampChars(long, MAX_CUSTOM_TITLE_LENGTH) as string;
    expect(Array.from(clamped)).toHaveLength(MAX_CUSTOM_TITLE_LENGTH);
    // 截断之后每一个码点仍然是完整的 emoji
    expect(clamped).toBe(emoji.repeat(MAX_CUSTOM_TITLE_LENGTH));
    expect(clamped.includes('�')).toBe(false);
  });

  it('null 保持 null（不清空成空串）', () => {
    expect(clampChars(null, 10)).toBeNull();
  });
});
