'use client';

/**
 * 全局错误界面。
 *
 * ⚠ 没有这个文件时，一次后端故障会渲染成 Next 的默认错误页 ——
 * 而默认页在**生产构建**下只说「An error occurred」，什么线索都没有。
 * 这里至少说清：**是后端不可达，不是这一页没有内容**。
 *
 * 这个区别很重要：一个「暂无可展示内容」的空态会让人以为库里没数据，
 * 从而去查采集；而事实上是 API 挂了 —— 两个完全不同的排查方向。
 *
 * 不显示原始错误信息（`docs/14`：不把内部细节送到前端）；
 * `digest` 是 Next 给的关联 id，可以在服务端日志里对上号。
 */

import type { ReactElement } from 'react';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactElement {
  return (
    <div className="container">
      <h1>内容暂时取不到</h1>
      <p className="subtle">
        这一页需要向 Signal 的接口取数据，而接口这次没有回应。
        <strong>不是「没有内容」</strong> —— 是接口不可达或出错了。
      </p>
      <div className="end-actions" style={{ marginTop: '16px', gap: '8px' }}>
        <button type="button" className="primary-btn" onClick={reset}>
          重试
        </button>
        <a className="soft-btn" href="/">
          回到今日
        </a>
      </div>
      {error.digest === undefined ? null : (
        <p className="subtle" style={{ marginTop: '12px' }}>
          排查时可以把这个编号给运维：<code>{error.digest}</code>
        </p>
      )}
    </div>
  );
}
