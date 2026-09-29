/**
 * 可注入时钟。
 *
 * 为什么需要：审核决策要写 `reviewedAt`、Dashboard 要按**上海业务日**统计
 * 「今日抓取」。两者都是**可断言的行为** —— 用真实时间写测试只能断言
 * 「大概是现在」，而业务日边界（UTC 16:00 跨日）恰恰是最容易写错的地方。
 *
 * 与 `modules/auth/clock.ts`、`modules/sources/clock.ts` 同一模式，
 * 刻意各留一份：跨模块 import 会把两个模块的生命周期绑在一起，而它只有三行。
 */

import { Injectable } from '@nestjs/common';

/** 注入 token。 */
export const ADMIN_REVIEW_CLOCK = 'ADMIN_REVIEW_CLOCK';

export interface AdminReviewClock {
  now(): Date;
}

@Injectable()
export class SystemAdminReviewClock implements AdminReviewClock {
  now(): Date {
    return new Date();
  }
}
