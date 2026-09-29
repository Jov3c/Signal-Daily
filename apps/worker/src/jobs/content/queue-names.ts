/**
 * 队列名与 Job 名的再导出。
 *
 * 单独一个文件的原因与 Agent 06 的 `jobs/ai/queue-names.ts` 相同：
 * 消费者（`content.worker.ts`）只需要这几个常量，而 `queue.ts`（入队侧）
 * 还会 import bullmq 之外的东西。分开放，消费者的模块图更小。
 *
 * ⚠ 数值**不是**本模块的自由选择：`docs/13` 固定了 Queue 名与 Job 名，
 * 契约里也已有 `QUEUE_CONCURRENCY[QueueName.CONTENT_PIPELINE] = 8`。
 * 这里只是取出来，不重新定义。
 */

import { JobName, QueueName, QUEUE_CONCURRENCY } from '@signal/contracts';

/** `content-pipeline`（`docs/13` 的固定 Queue 名）。 */
export const CONTENT_PIPELINE_QUEUE_NAME = QueueName.CONTENT_PIPELINE;

/** `content.normalize`（`docs/13` 的固定 Job 名）。 */
export const CONTENT_PIPELINE_JOB_NAME = JobName.CONTENT_NORMALIZE;

/** 并发度（`docs/13`：content-pipeline = 8）。 */
export const QUEUE_CONCURRENCY_FOR_CONTENT_PIPELINE = QUEUE_CONCURRENCY[QueueName.CONTENT_PIPELINE];
