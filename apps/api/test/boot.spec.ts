import { describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  ContentPipelineStatus,
  SourceType,
  PlatformErrorCode,
} from '@signal/contracts';
import { createApiApp } from '../src/bootstrap';

/**
 * 验收项：`contracts import` + `三个 app 空壳可启动`（api 部分）。
 */
describe('@signal/api 空壳', () => {
  it('可以从 api 正确 import 公共契约', () => {
    expect(API_PREFIX).toBe('/api/v1');
    expect(SourceType.X_USER).toBe('X_USER');
    expect(ContentPipelineStatus.REVIEW_PENDING).toBe('REVIEW_PENDING');
    expect(PlatformErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
  });

  it('Nest 应用可创建、可真实监听 HTTP、可正常关闭', async () => {
    const app = await createApiApp();

    await app.listen(0, '127.0.0.1');
    const baseUrl = await app.getUrl();

    // 真实发一次 HTTP 请求：证明 HTTP 栈已起来（无路由时应为 404）。
    const response = await fetch(`${baseUrl}${API_PREFIX}/__bootstrap_probe__`);
    expect(response.status).toBe(404);

    await app.close();
  });
});
