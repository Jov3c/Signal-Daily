/**
 * 可注入时钟。
 *
 * 为什么需要：**每日预算统计的是「上海业务日」**，而业务日的边界
 * （UTC 16:00 跨日）是一个必须被精确断言的行为。用真实时间写测试
 * 只能断言「大概是今天」，无法覆盖「上海 00:00 前后一分钟属于不同业务日」
 * 这类边界 —— 而那正是最容易写错的地方。
 *
 * 与 `modules/sources/clock.ts`、`modules/auth/clock.ts` 同一模式，
 * 刻意各留一份：跨模块 import 会把两个模块的生命周期绑在一起，
 * 而它只有三行。
 */

import { Injectable } from '@nestjs/common';

/** 注入 token。 */
export const AI_CLOCK = 'AI_CLOCK';

export interface AiClock {
  now(): Date;
}

@Injectable()
export class SystemAiClock implements AiClock {
  now(): Date {
    return new Date();
  }
}
