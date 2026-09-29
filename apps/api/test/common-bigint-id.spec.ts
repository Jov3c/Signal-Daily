/**
 * `common/prisma/bigint-id.ts` 的守卫。
 *
 * ── 为什么现在才有这个文件 ────────────────────────────────────────────
 * 这个 3 行的函数**缺了 BIGINT 上界**，被上报了**四次**
 *（Agent 03 的 CCR 第 8 项 → Agent 07 → Agent 09 的 CCR 第 0 项 → 本次修复），
 * 而它此前**一行测试都没有**。下游四个模块各自在自己的边界上又实现了一遍
 * 上界检查 —— 四份重复就是「没在源头修」的成本。
 *
 * 这条守卫的作用很直接：**把上界改回去就变红**。
 */

import { describe, expect, it } from 'vitest';
import { MAX_BINDABLE_ID, toBigIntId, toIdString } from '../src/common/prisma/bigint-id';

describe('toBigIntId 的边界', () => {
  it('合法 id 正常解析', () => {
    expect(toBigIntId('0')).toBe(0n);
    expect(toBigIntId('42')).toBe(42n);
    expect(toBigIntId('1')).toBe(1n);
  });

  it('畸形输入 → `null`（不抛 `SyntaxError`）', () => {
    for (const bad of ['', 'abc', '-1', '1.5', ' 42', '42 ', '0x1f', '+1', '١٢٣']) {
      expect(toBigIntId(bad), bad).toBeNull();
    }
  });

  it('超过 20 位 → `null`（模式本身就挡住了）', () => {
    expect(toBigIntId('1'.repeat(21))).toBeNull();
  });

  it('⚠ **恰好等于可绑定上界** → 通过', () => {
    expect(MAX_BINDABLE_ID).toBe(9_223_372_036_854_775_807n);
    expect(toBigIntId('9223372036854775807')).toBe(MAX_BINDABLE_ID);
  });

  it('⚠ **超过可绑定上界** → `null`（这正是被上报四次的洞）', () => {
    // 上界 +1
    expect(toBigIntId('9223372036854775808')).toBeNull();
    // BIGINT UNSIGNED 的**合法上限** —— 它格式完全合法，
    // 但 Prisma 按有符号 64 位绑定，直接传会让驱动抛
    // `PrismaClientUnknownRequestError`（→ 500 而不是 404）。
    expect(toBigIntId('18446744073709551615')).toBeNull();
    // 20 个 9
    expect(toBigIntId('99999999999999999999')).toBeNull();
  });

  it('上界是**有符号** 64 位的最大值（不是无符号的）', () => {
    // 如果哪天有人把它改成 `2n ** 64n - 1n`，上面那条会红 ——
    // 这正是要守住的：Prisma 的绑定是有符号的。
    expect(MAX_BINDABLE_ID).toBe(2n ** 63n - 1n);
    expect(MAX_BINDABLE_ID).toBeLessThan(2n ** 64n - 1n);
  });
});

describe('toIdString', () => {
  it('bigint → 十进制字符串', () => {
    expect(toIdString(0n)).toBe('0');
    expect(toIdString(MAX_BINDABLE_ID)).toBe('9223372036854775807');
  });
});
