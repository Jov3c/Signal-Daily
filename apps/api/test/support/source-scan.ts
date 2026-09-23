/**
 * 测试用的源码静态扫描工具。
 *
 * 放在单独文件里，是因为「正则里要匹配换行」这件事在测试文件里内联写
 * 容易被各种转义层吃掉（`\n` 变成真的换行，正则就变了意思）。
 * 这里统一用 `String.raw` 构造，语义一目了然。
 */

import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type SourceFile = {
  path: string;
  /** 相对扫描根目录的路径，统一用 `/` 分隔。 */
  relativePath: string;
  content: string;
  /** 去掉块注释与行注释后的内容。 */
  code: string;
};

/** 递归收集 `.ts` 文件。 */
export function collectSourceFiles(dir: string, found: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collectSourceFiles(full, found);
    } else if (/\.ts$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** 去掉注释，避免注释里的字样造成误报。 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 读取目录下所有源码文件。 */
export function readSourceFiles(root: string): SourceFile[] {
  return collectSourceFiles(root).map((file) => {
    const content = readFileSync(file, 'utf8');
    return {
      path: file,
      relativePath: relative(root, file).split(sep).join('/'),
      content,
      code: stripComments(content),
    };
  });
}

/**
 * 「把角色写成 ADMIN」的写入型模式。
 *
 * 用 `String.raw` 明确表达：`\s` 是空白、`\n` 是换行 —— 换行要排除掉，
 * 否则一个匹配会跨行吞掉大段代码，报出莫名其妙的位置。
 */
export const ROLE_ADMIN_WRITE_PATTERNS: RegExp[] = [
  // 对象字面量 / Prisma data：role: UserRole.ADMIN（同一行内）
  new RegExp(String.raw`role\s*:\s*[^,;{}\n]*ADMIN`),
  // 属性赋值：something.role = UserRole.ADMIN
  new RegExp(String.raw`\.role\s*=\s*[^;\n]*ADMIN`),
];
