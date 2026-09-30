/**
 * 请求解析与校验的公共工具。
 *
 * **下游一律从这里 import**（相对路径 `../../common/validation`），
 * 不要在各模块里再抄一份 —— 这几个函数原先在 api 内被复制了 2～10 份，
 * 且都是逐字相同。
 *
 * 与 `@nestjs/class-validator` 的关系：本项目的 DTO 全部**手写**，
 * 理由见各模块 `dto/` 的文件头（PATCH 要区分「没给」与「给了 null」、
 * 要把所有错误一次收齐、校验规则本身就是契约 `docs/04`/`docs/09`）。
 */

import { AppError, PlatformErrorCode } from '@signal/contracts';

/**
 * 校验失败的统一抛出（400）。
 *
 * `details.fields` 只含**字段名与原因**，不回显用户给的值 ——
 * 响应与日志都会拿到它，回显原值等于把用户输入原样搬运出去。
 */
export function invalid(errors: string[]): AppError {
  return new AppError({
    code: PlatformErrorCode.VALIDATION_FAILED,
    httpStatus: 400,
    safeMessage: 'Request validation failed',
    details: { fields: errors },
  });
}

/**
 * 是否含 ASCII 控制字符（含 CR / LF / NUL / DEL）。
 *
 * 用显式码点判断而不是正则字符类：正则写控制字符范围可读性差，
 * 而且容易在转义层被改坏。
 *
 * 控制字符会进日志与响应头，因此任何字符串字段都不接受。
 */
export function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * 解析正整数分页参数：缺省或非法 → 回退默认值；越界 → **夹到边界，不报错**。
 *
 * ⚠ 这个「夹边界」是**刻意的**，与筛选参数的处理**故意相反**：
 * 分页参数不值得 400（`?pageSize=9999` 夹到上限即可），
 * 而筛选参数非法必须 400 —— 静默忽略会让管理员看到一个**错误的结果集**
 * 却以为已经筛过了。
 *
 * 这条不对称有测试守着：`apps/api/test/admin-ops-units.spec.ts`
 * 的「分页参数夹边界、筛选参数报错（这两者的不对称是有意的）」。
 * **改这里的语义会让那条测试变红 —— 那是设计如此，不要"顺手"统一。**
 */
export function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
