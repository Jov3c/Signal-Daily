/**
 * 可注入时钟。
 *
 * 为什么需要：`nextFetchAt` 的推进（新建 / 启用 → `now`）是**可断言的行为**，
 * 用真实时间写测试只能断言「大概是现在」，那是不可靠的断言。
 * 有了时钟替身就能精确断言「启用后 `nextFetchAt` 恰好等于当时的 now」。
 *
 * 刻意不复用 `modules/auth/clock.ts`：跨模块 import 会让两个模块的
 * 生命周期绑在一起，而它只有三行。
 */

import { Injectable } from '@nestjs/common';

/** 注入 token。 */
export const SOURCE_CLOCK = 'SOURCE_CLOCK';

export interface SourceClock {
  now(): Date;
}

@Injectable()
export class SystemSourceClock implements SourceClock {
  now(): Date {
    return new Date();
  }
}
