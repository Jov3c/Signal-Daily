/**
 * 发布前校验的**跨 app 一致性守卫**。
 *
 * ── 为什么需要这个文件（这是本次交付里最容易悄悄坏掉的地方）──────────
 * `preflightEdition()` 有两份**逐字相同**的副本：
 *
 * ```text
 * apps/api/src/modules/daily/preflight.ts        ← 管理员点「立即发布」
 * apps/worker/src/jobs/publishing/preflight.ts   ← 08:00 的定时发布
 * ```
 *
 * 两份的原因是硬性的：`apps/api/src/**` 与 `apps/worker/src/**` 是两个独立的
 * tsconfig 工程，跨 app import 会触发 `TS6059`（Agent 04 提取
 * `packages/source-core` 时踩过；Agent 07 的 `scoring.ts` 也因此各留一份）。
 * 按 §7 不擅自改公共契约，所以也不把它塞进 `packages/contracts`。
 *
 * **而两份规则漂移的后果是最难查的一类 bug**：管理员点得动、定时跑不动
 *（或反过来）。两条路径都「正常工作」，没有任何日志异常，
 * 只有「为什么手动能发、早上却没发」这种要靠人肉比对的疑问。
 *
 * 所以这里用**静态扫描**把两份文件钉在一起：正文必须逐字相同。
 * 这与 Agent 00 的 `no-duplicate-enums.spec.ts`、Agent 02 的
 * `auth-contract.spec.ts` 是同一手法（仓库里已有先例）。
 *
 * ⚠ 这不是形式主义：**改一份忘了另一份，这个文件立刻变红**，
 * 而且报出来的信息直接告诉你差在哪一行。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { preflightEdition, type EditionSnapshot } from '../src/modules/daily/preflight';

const API_PREFLIGHT = fileURLToPath(new URL('../src/modules/daily/preflight.ts', import.meta.url));
const WORKER_PREFLIGHT = fileURLToPath(
  new URL('../../worker/src/jobs/publishing/preflight.ts', import.meta.url),
);

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('两份 preflight.ts 必须逐字相同', () => {
  it('正文完全一致（行数与内容都比）', () => {
    const api = read(API_PREFLIGHT);
    const worker = read(WORKER_PREFLIGHT);

    // 先分行比，这样失败信息会直接指出「第几行不同」，而不是甩出两大段文本。
    const apiLines = api.split('\n');
    const workerLines = worker.split('\n');

    const firstDifference = apiLines.findIndex((line, index) => line !== workerLines[index]);
    expect(
      firstDifference,
      firstDifference === -1
        ? ''
        : `第 ${String(firstDifference + 1)} 行不同：\n` +
            `  api:    ${apiLines[firstDifference] ?? '<缺失>'}\n` +
            `  worker: ${workerLines[firstDifference] ?? '<缺失>'}\n` +
            `两份 preflight 是手工同步的副本，改一份必须逐字改另一份。`,
    ).toBe(-1);

    expect(apiLines.length).toBe(workerLines.length);
  });

  it('导出面一致（两份都必须导出同一组名字）', () => {
    const exportedOf = (source: string): string[] =>
      [...source.matchAll(/^export (?:const|function|type) ([A-Za-z0-9_]+)/gm)]
        .map((match) => match[1] as string)
        .sort();

    expect(exportedOf(read(API_PREFLIGHT))).toEqual(exportedOf(read(WORKER_PREFLIGHT)));
  });
});

/**
 * 行为层：直接对**这份实现**跑一遍 `docs/10` 的 Preflight 五条。
 *
 * ⚠ 为什么在「一致性守卫」这个文件里也放行为断言：
 * 如果两份文件一起被改错了（例如把 `MAX_LEAD_ITEMS` 从 1 改成 3），
 * 上面两条仍然全绿。这里补一条**对着 `docs/10` 的原文**的断言。
 */
describe('docs/10 的 Publish Preflight 五条', () => {
  const base = (overrides: Partial<EditionSnapshot> = {}): EditionSnapshot => ({
    businessDate: '2026-09-29',
    status: 'SCHEDULED',
    sections: [
      {
        sectionId: 's1',
        type: 'FRONT_PAGE',
        title: '首页',
        sortOrder: 0,
        items: [
          {
            itemId: 'i1',
            contentId: '100',
            displayStyle: 'LEAD',
            sortOrder: 0,
            contentExists: true,
            contentStatus: 'APPROVED',
            sourceName: 'Anthropic 官方博客',
            originalUrl: 'https://www.anthropic.com/news/example',
          },
        ],
      },
    ],
    ...overrides,
  });

  it('完整的一期通过', () => {
    expect(preflightEdition(base())).toEqual({ ok: true, issues: [] });
  });

  it('至少一个 LEAD（docs/10 第一条）', () => {
    const snapshot = base();
    const section = snapshot.sections[0];
    if (section !== undefined && section.items[0] !== undefined) {
      section.items[0].displayStyle = 'STANDARD';
    }
    const result = preflightEdition(snapshot);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.reason)).toContain('LEAD_REQUIRED');
  });

  it('Lead 只有 1 条（docs/10 的多样性）', () => {
    const snapshot = base();
    snapshot.sections[0]?.items.push({
      itemId: 'i2',
      contentId: '101',
      displayStyle: 'LEAD',
      sortOrder: 1,
      contentExists: true,
      contentStatus: 'APPROVED',
      sourceName: '某媒体',
      originalUrl: 'https://example.com/b',
    });
    const result = preflightEdition(snapshot);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.reason)).toContain('TOO_MANY_LEADS');
  });

  it('businessDate 存在', () => {
    const result = preflightEdition(base({ businessDate: '' }));
    expect(result.issues.map((issue) => issue.reason)).toContain('MISSING_BUSINESS_DATE');
  });

  it('REJECTED / ARCHIVED 阻断发布（任务书点名）', () => {
    for (const status of ['REJECTED', 'ARCHIVED']) {
      const snapshot = base();
      const item = snapshot.sections[0]?.items[0];
      if (item !== undefined) item.contentStatus = status;
      const result = preflightEdition(snapshot);
      expect(result.ok, `${status} 应当阻断发布`).toBe(false);
      expect(result.issues.map((issue) => issue.reason)).toContain('CONTENT_NOT_PUBLISHABLE');
    }
  });

  it('source / originalUrl 必须完整', () => {
    const noSource = base();
    const item = noSource.sections[0]?.items[0];
    if (item !== undefined) item.sourceName = null;
    expect(preflightEdition(noSource).issues.map((i) => i.reason)).toContain('SOURCE_MISSING');

    const noUrl = base();
    const other = noUrl.sections[0]?.items[0];
    if (other !== undefined) other.originalUrl = null;
    expect(preflightEdition(noUrl).issues.map((i) => i.reason)).toContain('ORIGINAL_URL_MISSING');
  });

  it('sortOrder 冲突（section 与 item 各自）', () => {
    const duplicateItem = base();
    duplicateItem.sections[0]?.items.push({
      itemId: 'i2',
      contentId: '101',
      displayStyle: 'STANDARD',
      // 与第一条**同号** —— DB 有唯一约束兜底，这里要提前给出可读错误
      sortOrder: 0,
      contentExists: true,
      contentStatus: 'APPROVED',
      sourceName: '某媒体',
      originalUrl: 'https://example.com/b',
    });
    expect(preflightEdition(duplicateItem).issues.map((i) => i.reason)).toContain(
      'ITEM_SORT_ORDER_CONFLICT',
    );

    const duplicateSection = base();
    duplicateSection.sections.push({
      sectionId: 's2',
      type: 'AI',
      title: 'AI',
      sortOrder: 0, // 与 FRONT_PAGE 同号
      items: [
        {
          itemId: 'i3',
          contentId: '102',
          displayStyle: 'MAJOR',
          sortOrder: 0,
          contentExists: true,
          contentStatus: 'APPROVED',
          sourceName: '某媒体',
          originalUrl: 'https://example.com/c',
        },
      ],
    });
    expect(preflightEdition(duplicateSection).issues.map((i) => i.reason)).toContain(
      'SECTION_SORT_ORDER_CONFLICT',
    );
  });

  it('空的一期也是问题（避免发布一份空白日报）', () => {
    const result = preflightEdition(base({ sections: [] }));
    expect(result.issues.map((issue) => issue.reason)).toContain('EMPTY_EDITION');
  });
});
