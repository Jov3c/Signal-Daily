import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 验收项：`无重复 enum`。
 *
 * `docs/02` / `docs/18`：跨 app 的枚举与 DTO 只能来自 `@signal/contracts`，
 * 禁止在 web/api/worker 内复制 SourceType、ContentPipelineStatus 等公共类型。
 *
 * 本测试静态扫描仓库，确保这些名字只在一处被「声明」。
 * 判定为声明的形式：`enum X` / `type X` / `const X` / `interface X` / `class X`。
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CONTRACTS_SRC = join(REPO_ROOT, 'packages', 'contracts', 'src');

const SCAN_ROOTS = ['packages', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.git']);

/**
 * Frozen Contract 中的公共名字（docs/05 枚举 + reference/contracts.ts DTO
 * + docs/13 Queue/Job 名 + Error Code 注册表）。
 *
 * 早期版本只冻结了 27 个类型名，漏掉了 QueueName / JobName / JobId /
 * PlatformErrorCode 这几个**常量**。而在 apps 里复制这几个常量恰恰是最容易发生的
 * —— docs/13 明令「禁止创建近义 Queue」、docs/05 明令「禁止同义错误码」，
 * 所以它们必须一起冻结。
 */
const FROZEN_TYPE_NAMES = [
  'UserRole',
  'UserStatus',
  'UserTheme',
  'ArticleFontSize',
  'SourceType',
  'SourceKind',
  'SourceTier',
  'EvidenceType',
  'ContentType',
  'RawItemStatus',
  'ContentPipelineStatus',
  'EditorialReviewStatus',
  'DailyEditionStatus',
  'DailySectionType',
  'DailyDisplayStyle',
  'AiTaskType',
  'AiRunStatus',
  'JobRunStatus',
  'ApiEnvelope',
  'CursorEnvelope',
  'ApiError',
  'ApiErrorBody',
  'PublicSource',
  'PublicPerson',
  'PublicTopic',
  'PublicContent',
  'EvidenceSummary',
  // Queue / Job 契约（docs/13）
  'QueueName',
  'JobName',
  'JobId',
  'QUEUE_NAMES',
  'JOB_NAMES',
  'JOB_TO_QUEUE',
  'QUEUE_CONCURRENCY',
  // Error Code 注册表（docs/05 / docs/15）
  'PlatformErrorCode',
  'DomainErrorCode',
  // API 路径常量（docs/02）
  'API_PREFIX',
  'ADMIN_API_PREFIX',
  'REQUEST_ID_HEADER',
];

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** 去掉 import 语句，避免把 `import type { SourceType }` 误判为声明。 */
function stripImports(source: string): string {
  return source.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');
}

describe('公共类型唯一来源', () => {
  const files = SCAN_ROOTS.flatMap((root) => collectSourceFiles(join(REPO_ROOT, root))).filter(
    (file) => !file.startsWith(CONTRACTS_SRC),
  );

  it('扫描到了仓库源码（防止测试空跑）', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const typeName of FROZEN_TYPE_NAMES) {
    it(`${typeName} 只在 packages/contracts 中声明`, () => {
      const declaration = new RegExp(
        String.raw`\b(?:export\s+)?(?:declare\s+)?(?:enum|type|const|interface|class|abstract\s+class)\s+${typeName}\b`,
      );

      const offenders = files
        .filter((file) => declaration.test(stripImports(readFileSync(file, 'utf8'))))
        .map((file) => relative(REPO_ROOT, file).split(sep).join('/'));

      expect(offenders).toEqual([]);
    });
  }
});
