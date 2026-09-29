/**
 * 队列名与并发度的再导出。
 *
 * ⚠ 数值**不是**本模块的自由选择 —— `docs/13` 规定 publishing 队列并发为 1，
 * 契约里已有 `QUEUE_CONCURRENCY[QueueName.PUBLISHING] = 1`（Agent 00 的 `queues.ts`）。
 * 这里只是把它取出来，不重新定义。
 *
 * 为什么单独一个文件：`queue.ts`（入队侧）import 了 `bullmq` 与 `@signal/config`，
 * 而 `publishing.worker.ts` 只需要这两个常量。放在这里让「消费者需要的常量」
 * 不依赖入队侧的整个模块图（与 Agent 06 的 `ai/queue-names.ts` 同一理由）。
 */

import { QUEUE_CONCURRENCY, QueueName } from '@signal/contracts';

/** publishing 队列名（`docs/13` 的固定 Queue 名）。 */
export const PUBLISHING_QUEUE_NAME = QueueName.PUBLISHING;

/** publishing 队列初始并发度（`docs/13`：publishing = 1）。 */
export const QUEUE_CONCURRENCY_FOR_PUBLISHING = QUEUE_CONCURRENCY[QueueName.PUBLISHING];
