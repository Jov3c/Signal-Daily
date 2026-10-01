/**
 * 前端**镜像类型**与后端真源的字段一致性守卫。
 *
 * ── 这个文件在防什么 ────────────────────────────────────────────────
 * `apps/web` 里有一批类型是**后端模块内 DTO 的镜像**（`lib/types.ts` 与
 * `lib/admin-types.ts`）—— 因为前端 import 不了 `apps/api`，
 * 而 `@signal/contracts` 只冻结了公共枚举与公开 DTO。
 *
 * 镜像最怕的是**静默漂移**：后端把 `finalScore` 改名成 `score`，
 * 前端读到的就是 `undefined` —— 表格里那一列变成空白，
 * 类型检查不报错（前端那份声明没变），测试也不会红。
 * 这类 bug 的典型表现是「后台某一列突然空了」，没人知道为什么。
 *
 * ── 断言的是「子集」不是「相等」─────────────────────────────────────
 * 前端**允许少声明**字段（`FeaturedRow` 就故意不声明
 * `pipelineStatus` / `reviewStatus` / `publishFeatured` 那三个内部状态，
 * 那是 `docs/14` 的要求）。所以规则是：
 *
 * ```text
 * ✅ 前端读的每个字段都必须在后端类型里存在
 * ❌ 后端新增字段 → 不红（否则没人敢给后端加字段）
 * ```
 *
 * ── 这是**文本解析**，不是类型检查 ──────────────────────────────────
 * 两个 app 在同一个 tsconfig 引用图里没有交集（`docs/02`：跨 app 只共享
 * `packages/*`），所以拿不到真正的类型。解析 `export type X = { … }`
 * 的顶层字段名足够抓住「改名」这个唯一的真实风险。
 * 解析不到时会**直接失败**（而不是静默跳过）—— 那种情况说明这个守卫
 * 需要跟着源码结构更新，而不是它通过了。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BULK_REVIEW_ACTIONS } from '../lib/review-actions';

/** 仓库根（`apps/web/test/…` 往上三层）。 */
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

function readRepo(relative: string): string {
  return readFileSync(join(REPO, relative), 'utf8');
}

/**
 * 从一个 `type X = { … }` 声明里取**顶层**字段名。
 *
 * 嵌套对象被整个跳过：比较顶层已经能抓住改名，而递归比较会把
 * 「后端把嵌套对象拆成两个字段」这种正当重构也判红。
 */
function topLevelFields(rawSource: string, typeName: string, depth = 0): string[] {
  // ⚠ 必须先剥注释，两个理由：
  //   1. 注释里出现的 `{` / `}` 会让配对扫描跑偏；
  //   2. **带文档注释的字段会被漏掉** —— 字段名前面隔着一段 `/** … */` 时，
  //      下面那条 `^\s*(\w+)\s*:` 的正则匹配不上（第一版就是这么漏了
  //      `MeDto.id` / `AdminJobRun.durationMs`，而它们恰好都带注释）。
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const pattern = new RegExp(String.raw`(?:export\s+)?type\s+${typeName}\s*=\s*`);
  const match = pattern.exec(source);
  if (match === null) return [];

  // 从 `=` 之后跳过空白，再看第一个有意义的字符是什么。
  let cursor = match.index + match[0].length;
  while (cursor < source.length && /\s/.test(source[cursor] ?? '')) cursor += 1;

  /**
   * ⚠ 支持**交叉类型**：`type X = Base & { … }` —— 2026-10-02 补。
   *
   * 起因：`apps/api/src/modules/daily/service.ts` 的
   * `EditionSummary = EditionRow & { editionNoLabel; itemCount }` 是 admin 列表
   * 接口的**真源**，但原来的正则要求 `=` 后**紧跟** `{`，于是它解析出 **0 个字段**。
   *
   * 而 `expectFieldsExist` 对「解析失败」是**直接判红**的（那条设计是对的：
   * 空的会被误读成「一致」），所以只能扩展解析器，不能绕开它去指个能解析的类型 ——
   * 指 `EditionRow` 恰好会漏掉 `editionNoLabel` / `itemCount` 这两个**真正会漂移**的字段。
   *
   * 只处理**一层** `Base & { … }`：更深的交叉在这个仓库里不存在，
   * 真出现了会因为解析不到而红，不会静默漏。
   */
  const inherited: string[] = [];
  const baseMatch = /^([A-Za-z_$][\w$]*)\s*&/.exec(source.slice(cursor));
  if (baseMatch?.[1] !== undefined && depth < 2) {
    inherited.push(...topLevelFields(rawSource, baseMatch[1], depth + 1));
  }

  const braceAt = source.indexOf('{', cursor);
  if (braceAt === -1) return inherited;
  // ⚠ 要求 `{` 之前只有「空白」或「Base &」——否则它不是对象字面量别名
  //（例如 `type Foo = string`），不该硬从后面找个 `{` 来解析。
  const head = source.slice(cursor, braceAt);
  if (!/^\s*(?:[A-Za-z_$][\w$]*\s*&\s*)?$/.test(head)) return inherited;

  let depthCount = 0;
  let index = braceAt;
  const start = index;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depthCount += 1;
    else if (source[index] === '}') {
      depthCount -= 1;
      if (depthCount === 0) break;
    }
  }
  const body = source.slice(start + 1, index);

  const fields: string[] = [];
  let nested = 0;
  let current = '';
  const flush = (): void => {
    // 顶层字段行形如 `  name: T;` 或 `  name?: T;`
    const fieldMatch = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(current);
    if (fieldMatch?.[1] !== undefined) fields.push(fieldMatch[1]);
    current = '';
  };

  for (const char of body) {
    if (char === '{' || char === '(' || char === '[') nested += 1;
    if (char === '}' || char === ')' || char === ']') nested -= 1;
    if (char === ';' && nested === 0) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return [...new Set([...inherited, ...fields])];
}

/** 断言：前端声明的每个字段都在后端类型里。 */
function expectFieldsExist(
  webSource: string,
  webType: string,
  apiSource: string,
  apiType: string,
): void {
  const web = topLevelFields(webSource, webType);
  const api = topLevelFields(apiSource, apiType);

  // 两侧都不能是空的 —— 空的说明解析失败，而解析失败会被误读成「一致」。
  expect(web.length, `前端 ${webType} 解析不到字段（守卫需要更新）`).toBeGreaterThan(0);
  expect(api.length, `后端 ${apiType} 解析不到字段（源文件结构变了？）`).toBeGreaterThan(0);

  const missing = web.filter((field) => !api.includes(field));
  expect(missing, `${webType} 里这些字段在后端 ${apiType} 已经不存在`).toEqual([]);
}

const WEB_TYPES = readRepo('apps/web/lib/types.ts');
const WEB_ADMIN = readRepo('apps/web/lib/admin-types.ts');

describe('⚠ 镜像类型必须与后端真源对得上（改名就会红）', () => {
  it('`MeDto` ← Agent 02 的 users/dto/me.dto.ts', () => {
    expectFieldsExist(
      WEB_TYPES,
      'MeDto',
      readRepo('apps/api/src/modules/users/dto/me.dto.ts'),
      'MeDto',
    );
  });

  it('`UserPreferences` ← Agent 09 的 user-preferences/dto.ts（三个键）', () => {
    const apiSource = readRepo('apps/api/src/modules/user-preferences/dto.ts');
    const keys = /PREFERENCE_KEYS\s*=\s*\[([^\]]*)\]/.exec(apiSource)?.[1] ?? '';
    const apiKeys = [...keys.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');

    expect(apiKeys.length).toBe(3);
    const web = topLevelFields(WEB_TYPES, 'UserPreferences');
    expect(web.sort()).toEqual([...apiKeys].sort());
  });

  /**
   * ⚠ 真源是 **`public-view.ts` 的 `PublicFeatured`**，不是仓储的 `FeaturedRow` ——
   * 2026-10-01 改。前端镜像的是**公开响应**的形状，而 `GET /featured` 现在会过
   * `toPublicFeatured()` 那层投影（在那之前它是原样返回仓储行的）。
   *
   * 拿仓储类型当基线会让这条守卫**盯着错误的东西**：仓储可以有前台永远看不到的
   * 内部字段（`pipelineStatus` 等），而那些字段一旦进了公开响应就是泄漏 ——
   * 这条守卫本该在那时候红，盯着仓储却不会。
   * 与下面日报那条（`PublicDailyEdition ← daily/public-view.ts`）同一口径。
   */
  it('`FeaturedRow`（前端） ← featured/public-view.ts 的 `PublicFeatured`', () => {
    expectFieldsExist(
      WEB_TYPES,
      'FeaturedRow',
      readRepo('apps/api/src/modules/featured/public-view.ts'),
      'PublicFeatured',
    );
  });

  it('`PublicDailyEdition` / `PublicDailyArchiveEntry` ← Agent 08 的 daily/public-view.ts', () => {
    const api = readRepo('apps/api/src/modules/daily/public-view.ts');
    expectFieldsExist(WEB_TYPES, 'PublicDailyEdition', api, 'PublicDailyEdition');
    expectFieldsExist(WEB_TYPES, 'PublicDailyArchiveEntry', api, 'PublicDailyArchiveEntry');
  });

  /**
   * ⚠ 2026-10-02 补（清单 P3-01）。此前**没有**这条 —— 而漂移是真实存在的：
   * 前端写 `id`、后端是 `editionId`，且前端漏了 `editionNoLabel`。
   * 它没爆是因为后台日报页当前只读 `row.itemCount`；
   * **改名不会让任何测试变红**，直到有人开始读那个字段。
   *
   * 真源是 `daily/service.ts` 的 `EditionSummary`（= `EditionRow & { … }`，
   * 也就是接口实际返回的那个）。这条同时也在守解析器对**交叉类型**的支持 ——
   * 解析不出来的话 `expectFieldsExist` 会直接判红。
   */
  it('`AdminEditionRow` ← Agent 08 的 daily/service.ts 的 `EditionSummary`', () => {
    // ⚠ **两个文件拼起来给它**：`EditionSummary = EditionRow & { … }`，而基类型
    // `EditionRow` 定义在 `repository.ts` 里 —— 解析器只看一份源码，
    // 给单文件的话继承来的那 7 个字段会解析成空，然后被误判成「前端多了一堆字段」。
    // 这个类型的**声明面本来就跨这两个文件**，拼起来才是它的完整定义。
    expectFieldsExist(
      WEB_ADMIN,
      'AdminEditionRow',
      readRepo('apps/api/src/modules/daily/service.ts') +
        readRepo('apps/api/src/modules/daily/repository.ts'),
      'EditionSummary',
    );
  });

  it('`DashboardStats` / `ReviewListRow` ← Agent 07 的 admin-review/repository.ts', () => {
    const api = readRepo('apps/api/src/modules/admin-review/repository.ts');
    expectFieldsExist(WEB_ADMIN, 'DashboardStats', api, 'DashboardStats');
    expectFieldsExist(WEB_ADMIN, 'ReviewListRow', api, 'ReviewListRow');
  });

  it('`ReviewDetail`（嵌套一并比对 —— docs/09 的「必须同时看到」清单）', () => {
    // ⚠ `ReviewDetail` 的类型定义在 **service.ts 的返回值**里，不是
    // repository 的 `export type`。所以拿它自己的形状与 service 的
    // 返回字面量比对是做不到的；这里退一步，断言 service 里确实拼出了
    // 那几块（少了任何一块都意味着 docs/09 的清单不再完整）。
    const api = readRepo('apps/api/src/modules/admin-review/review.service.ts');
    for (const block of [
      'content:',
      'source:',
      'aiScore:',
      'event:',
      'similarContents:',
      'review:',
    ]) {
      expect(api, `review.service.ts 里缺少 ${block}`).toContain(block);
    }
    const web = topLevelFields(WEB_ADMIN, 'ReviewDetail');
    expect(web.sort()).toEqual([
      'aiScore',
      'content',
      'event',
      'review',
      'similarContents',
      'source',
    ]);
  });

  it('`SourceDto` ← Agent 03 的 sources/dto/source.dto.ts', () => {
    const source = readRepo('apps/api/src/modules/sources/dto/source.dto.ts');
    expectFieldsExist(WEB_ADMIN, 'SourceDto', source, 'SourceDto');
  });

  it('`AdminJobRun` / `AdminNotification` ← Agent 12 的 admin-ops/repository.ts', () => {
    const api = readRepo('apps/api/src/modules/admin-ops/repository.ts');
    expectFieldsExist(WEB_ADMIN, 'AdminJobRun', api, 'AdminJobRun');
    expectFieldsExist(WEB_ADMIN, 'AdminNotification', api, 'AdminNotification');
  });

  it('`AiUsageView` 的四块 ← Agent 12 的 admin-ops/service.ts', () => {
    const api = readRepo('apps/api/src/modules/admin-ops/service.ts');
    // 同样是「在 service 里拼出来的」类型，按块断言。
    for (const block of ['window:', 'totals:', 'byTaskType:', 'byModel:', 'daily:', 'recent:']) {
      expect(api, `admin-ops/service.ts 里缺少 ${block}`).toContain(block);
    }
    const web = topLevelFields(WEB_ADMIN, 'AiUsageView');
    expect(web.sort()).toEqual(['byModel', 'byTaskType', 'daily', 'recent', 'totals', 'window']);
  });
});

describe('⚠ 动作名与状态名是两套，最容易被当成一个', () => {
  it('批量的动作名等于后端的 `BULK_REVIEW_ACTIONS`', () => {
    const api = readRepo('apps/api/src/modules/admin-review/dto/review.dto.ts');
    const raw = /BULK_REVIEW_ACTIONS\s*=\s*\[([^\]]*)\]/.exec(api)?.[1] ?? '';
    const apiActions = [...raw.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');

    expect(apiActions.length).toBeGreaterThan(0);
    expect([...BULK_REVIEW_ACTIONS]).toEqual(apiActions);
  });

  it('批量动作是 `DEFER` / `REJECT`，**不是** `DEFERRED` / `REJECTED`', () => {
    // 后一组是 `EditorialReviewStatus` 的取值，是**结果**的过去式。
    // 把状态名当动作名发出去会 400 —— 而那只有运行时才看得见。
    expect([...BULK_REVIEW_ACTIONS]).toEqual(['DEFER', 'REJECT']);
  });

  it('单条决策的五个动作与后端的 `REVIEW_ACTIONS` 一致', () => {
    const api = readRepo('apps/api/src/modules/admin-review/dto/review.dto.ts');
    const raw = /export const REVIEW_ACTIONS\s*=\s*\[([^\]]*)\]/.exec(api)?.[1] ?? '';
    const apiActions = [...raw.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');

    const web = readRepo('apps/web/lib/review-actions.ts');
    for (const action of apiActions) {
      expect(web, `前端缺少动作 ${action}`).toContain(`'${action}'`);
    }
  });
});

describe('守卫本身有效（防止空跑）', () => {
  it('解析函数在真实源码上确实取到了字段', () => {
    expect(topLevelFields(WEB_TYPES, 'MeDto').length).toBeGreaterThan(4);
    expect(
      topLevelFields(readRepo('apps/api/src/modules/admin-ops/repository.ts'), 'AdminJobRun')
        .length,
    ).toBeGreaterThan(5);
  });

  it('解析一个不存在的类型会返回空数组（不会误报成功）', () => {
    expect(topLevelFields(WEB_TYPES, 'NoSuchType')).toEqual([]);
  });
});
