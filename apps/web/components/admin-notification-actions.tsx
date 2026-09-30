'use client';

/**
 * 标记通知已读。
 *
 * ⚠ 幂等：后端用 `updateMany` + `status='UNREAD'` 作为条件，
 * **已经读过的不改写 `readAt`**（否则「什么时候读的」会被每次点开覆盖）。
 * 所以界面上重复点不会产生副作用，按钮也不需要「禁用已读的」——
 * 页面本来就不给已读的显示这个按钮。
 */

import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest, ApiClientError } from '../lib/client-api';
import { useToast } from './toast';

export function MarkReadButton({ notificationId }: { notificationId: string }): ReactElement {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function markRead(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest(`/admin/notifications/${notificationId}/read`, { method: 'POST' });
      router.refresh();
    } catch (error) {
      toast.show(
        error instanceof ApiClientError && error.isUnauthorized ? '请重新登录' : '操作失败',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="quiet-action" disabled={busy} onClick={() => void markRead()}>
      标记已读
    </button>
  );
}
