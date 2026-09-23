/**
 * Clock 端口。
 *
 * 存在的理由：OTP 过期、Session 过期、OAuth state 时效都靠时间判定，
 * 而「等 10 分钟」不可能写进测试。把时间做成可注入的依赖，
 * 过期路径就能用**毫秒级**的真实断言覆盖，而不是靠 sleep 或只读代码猜。
 */

export const CLOCK = 'AUTH_CLOCK';

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
