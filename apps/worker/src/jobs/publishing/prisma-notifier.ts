/**
 * `PublishingNotifier` 的 Prisma 实现 —— 写 `admin_notifications`。
 *
 * ── 幂等怎么做（以及为什么只能这么做）────────────────────────────────
 * `admin_notifications` **没有唯一约束**（Agent 07 的说明；`docs/05`
 * 也没为它定义状态枚举，所以 schema 保持字符串）。
 * 因此幂等只能在应用层做：**先按 `(type, targetUrl)` 查一次，有就不写**。
 *
 * 代价必须说清楚：并发下两个实例可能同时查空并各写一行，
 * 于是管理员看到两条一样的提醒。**这是刻意接受的** ——
 * 通知重复一次只是噪音，漏掉一次意味着日报没人管。
 * 与之相对，Agent 07 的 `notification.scan()` 用同一手法。
 */

import { Inject, Injectable } from '@nestjs/common';
import type { PublishingNotifier, PublishingNotificationInput } from './notifier';
import { PublishingPrismaService } from './prisma.service';

@Injectable()
export class PrismaPublishingNotifier implements PublishingNotifier {
  constructor(@Inject(PublishingPrismaService) private readonly prisma: PublishingPrismaService) {}

  async notify(input: PublishingNotificationInput): Promise<boolean> {
    const existing = await this.prisma.adminNotification.findFirst({
      where: { type: input.type, targetUrl: input.targetUrl },
      select: { id: true },
    });
    if (existing !== null) return false;

    await this.prisma.adminNotification.create({
      data: {
        type: input.type,
        title: input.title,
        body: input.body,
        targetUrl: input.targetUrl,
        // `docs/05` 没有为通知定义枚举，schema 里是带默认值的字符串列。
        // 显式写出来（而不是依赖默认值）是为了让「新建即未读」这件事
        // 在代码里可见 —— 默认值一变，这里不会静默跟着变。
        status: 'UNREAD',
        emailStatus: 'NONE',
      },
      select: { id: true },
    });
    return true;
  }
}
