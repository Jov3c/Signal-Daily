/**
 * 可注入时钟。
 *
 * 为什么需要：本模块有**三处**依赖「现在几点」的行为，而它们都必须可断言：
 *
 * 1. `publishedAt` / `scheduledAt` 的写入值；
 * 2. 后台列表与归档的「默认当月」—— `?year=&month=` 缺省时用的是
 *    **上海业务时区的当月**，而它在 UTC 侧的日界是 16:00；
 * 3. `docs/10` 的「排期缺省值 = 该业务日上海 08:00」。
 *
 * 用真实时间写测试只能断言「大概是现在」，而业务日边界恰恰是最容易写错的地方。
 *
 * 与 `modules/auth/clock.ts`、`modules/sources/clock.ts`、
 * `modules/admin-review/clock.ts` 同一模式，**刻意各留一份**：
 * 跨模块 import 会把两个模块的生命周期绑在一起，而它只有三行。
 */

import { Injectable } from '@nestjs/common';

/** 注入 token。 */
export const DAILY_CLOCK = 'DAILY_CLOCK';

export interface DailyClock {
  now(): Date;
}

@Injectable()
export class SystemDailyClock implements DailyClock {
  now(): Date {
    return new Date();
  }
}
