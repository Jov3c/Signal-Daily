/**
 * 队列名与并发度的再导出。
 *
 * 单独一个文件的原因：`queue.ts`（入队侧）会 import `bullmq` 之外的东西，
 * 而 `ai.worker.ts` 只需要这两个常量。把它们放在这里，
 * 让「消费者需要的常量」不依赖入队侧的模块图。
 *
 * ⚠ 数值**不是**本模块的自由选择 —— `docs/13` 规定 ai 队列并发为 3，
 * 契约里已有 `QUEUE_CONCURRENCY[QueueName.AI] = 3`（Agent 00 的 `queues.ts`）。
 * 这里只是把它取出来，不重新定义。
 */

import { QueueName, QUEUE_CONCURRENCY } from '@signal/contracts';

/** AI 队列名（`docs/13` 的固定 Queue 名）。 */
export const AI_QUEUE_NAME = QueueName.AI;

/** AI 队列初始并发度（`docs/13`：ai = 3）。 */
export const QUEUE_CONCURRENCY_FOR_AI = QUEUE_CONCURRENCY[QueueName.AI];
