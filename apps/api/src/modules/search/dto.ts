/**
 * 搜索的查询参数解析。
 *
 * ⚠ 与公开读的其他接口不同，`q` **非法一律 400**（不是用默认值兜底）：
 * 搜索的语义就是「用户输入了什么就查什么」，
 * 而一个空/超长的 `q` 不是「宽松一点」就能解决的 —— 它要么无意义
 *（空串会匹配几乎所有行），要么是攻击面（超长输入）。
 */

import { invalid } from '../../common/validation';
import { parseLimit } from '../public-read/dto';

/**
 * 查询词的长度边界（`docs/04` 的 `GET /search?q=` 没有给，本模块取）。
 *
 * 下界 2：单字符在 ngram 下几乎匹配一切，返回的东西没有意义。
 * 上界 100：与 `contracts/openapi-outline.yaml` 里 `GET /search` 的
 * `minLength: 2 / maxLength: 100` **逐字一致** —— 那是全包唯一写死了
 * 这条约束的地方，所以照它来。
 */
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;

/** 搜索一页最多返回多少条。 */
export const MAX_SEARCH_LIMIT = 30;

export type SearchQuery = {
  q: string;
  limit: number;
  offset: number;
};

export function parseSearchQuery(query: Record<string, unknown>): SearchQuery {
  const errors: string[] = [];
  const raw = query['q'];

  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push('q: is required');
  } else {
    const trimmed = raw.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      errors.push(`q: must be at least ${String(MIN_QUERY_LENGTH)} characters`);
    } else if (raw.length > MAX_QUERY_LENGTH) {
      errors.push(`q: must be at most ${String(MAX_QUERY_LENGTH)} characters`);
    }
  }

  const offsetRaw = query['offset'];
  let offset = 0;
  if (offsetRaw !== undefined && offsetRaw !== null && offsetRaw !== '') {
    const parsed = Number(offsetRaw);
    if (!Number.isInteger(parsed) || parsed < 0)
      errors.push('offset: must be a non-negative integer');
    else offset = parsed;
  }

  if (errors.length > 0) throw invalid(errors);

  return {
    q: (raw as string).trim(),
    limit: parseLimit(query['limit'], 20, MAX_SEARCH_LIMIT),
    offset,
  };
}
