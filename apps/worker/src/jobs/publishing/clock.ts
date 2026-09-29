/**
 * 可注入时钟。
 *
 * 为什么需要：本模块的**每一个**行为都与「现在几点」有关，而且全部要可断言：
 *
 * 1. 调度槽位（`docs/10` 的 00:10 / 05:30 / 07:00 / 07:30 / 08:00）是
 *    **上海业务时区**的钟点，跨 UTC 日界；
 * 2. 候选窗口是「该业务日 08:00 之前的 24 小时」；
 * 3. `publishedAt` 的写入值。
 *
 * 用真实时间写测试只能断言「大概是现在」，而上面三条恰恰是最容易写错的地方。
 *
 * 与 `jobs/ai/clock.ts`、`jobs/content/clock.ts` 以及各 api 模块的
 * `clock.ts` 同一模式，刻意各留一份：跨模块 import 会把两个模块的
 * 生命周期绑在一起，而它只有三行。
 *
 * ⚠ 写注释时不要把「星号 + 斜杠」连着打出来（例如想写 glob
 * `jobs/<area>/clock.ts` 时不要写成那个星号形式）——
 * 那个字符对会**提前闭合块注释**，剩下的内容变成代码，
 * 报出来的错会是「Unterminated template literal」这种离题万里的东西。
 */

import { Injectable } from '@nestjs/common';

/** 注入 token。 */
export const PUBLISHING_CLOCK = 'PUBLISHING_CLOCK';

export interface PublishingClock {
  now(): Date;
}

@Injectable()
export class SystemPublishingClock implements PublishingClock {
  now(): Date {
    return new Date();
  }
}
