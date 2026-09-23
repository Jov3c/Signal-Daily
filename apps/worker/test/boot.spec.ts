import { describe, expect, it } from 'vitest';
import { JOB_NAMES, QueueName, BUSINESS_TIMEZONE } from '@signal/contracts';
import { createWorkerApp } from '../src/bootstrap';

/**
 * 验收项：`contracts import` + `三个 app 空壳可启动`（worker 部分）。
 */
describe('@signal/worker 空壳', () => {
  it('可以从 worker 正确 import 公共契约', () => {
    expect(QueueName.COLLECTOR).toBe('collector');
    expect(JOB_NAMES).toContain('collector.fetch-source');
    expect(BUSINESS_TIMEZONE).toBe('Asia/Shanghai');
  });

  it('Nest standalone 应用上下文可创建并可正常关闭', async () => {
    const context = await createWorkerApp();
    expect(context).toBeDefined();
    expect(typeof context.close).toBe('function');
    await context.close();
  });
});
