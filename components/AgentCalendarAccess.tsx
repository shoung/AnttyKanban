import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { Bot, Link, RefreshCw, Unplug } from 'lucide-react';
import { Button } from './Button';
import type { CalendarStatus } from '../server/calendar/core';

const errors: Record<string, string> = {
  CALENDAR_GRANT_MISMATCH: '請管理員修復原有 AI 授權設定；修復前不能重新授權或撤銷。',
  CALENDAR_NOT_CONFIGURED: 'AI 日曆尚未設定完成，不影響手動日曆與 Google 登入。',
  AUTHENTICATION_REQUIRED: '登入狀態已失效，請重新登入後再試。',
  RECONNECT_REQUIRED: 'AI 日曆授權已失效，請重新授權。',
  OAUTH_CANCELLED: '已取消 AI 日曆授權。',
  OAUTH_STATE_INVALID: 'AI 授權流程已過期或瀏覽器不符，請重新授權。',
  GOOGLE_ACCOUNT_MISMATCH: '請選擇和目前登入相同的 Google 帳號。',
  CALENDAR_SCOPE_REQUIRED: '尚未授予 AI 日曆權限，請重新確認授權。',
  OFFLINE_ACCESS_REQUIRED: '未取得持續連線所需的授權，請重新授權。',
  CONNECTION_CHANGED: 'AI 日曆授權已變更，請重新整理後再試。',
  REVOCATION_PENDING: '已停止 AI 存取，請完成撤銷後再授權。',
  ORIGIN_NOT_ALLOWED: '此網址尚未獲准使用 AI 日曆服務。',
};
function errorText(error: unknown) {
  return errors[error instanceof Error ? error.message : ''] ?? 'AI 日曆暫時無法使用，請稍後再試。';
}

/** Account changes discard all prior authorization state and pending requests. */
export function AgentCalendarAccess({ user }: { user: User }) {
  return <AccountAccess key={user.uid} user={user} />;
}
function AccountAccess({ user }: { user: User }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requests = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const locked = useRef(true);
  const request = useCallback(
    async <T,>(action: string, method = 'GET', body?: unknown): Promise<T> => {
      const controller = new AbortController();
      requests.current.add(controller);
      const checkActive = () => {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      };
      try {
        const token = await user.getIdToken();
        checkActive();
        const response = await fetch(`/api/calendar-agent?action=${action}`, {
          method,
          credentials: 'same-origin',
          mode: 'same-origin',
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        checkActive();
        const data = await response.json().catch(() => {
          throw new Error('CALENDAR_NOT_CONFIGURED');
        });
        checkActive();
        if (!response.ok)
          throw new Error(typeof data?.error === 'string' ? data.error : 'CALENDAR_REQUEST_FAILED');
        return data as T;
      } finally {
        requests.current.delete(controller);
      }
    },
    [user],
  );
  const load = useCallback(async () => {
    const next = await request<CalendarStatus>('status');
    setStatus(next);
  }, [request]);
  useEffect(() => {
    const current = ++generation.current;
    const activeRequests = requests.current;
    locked.current = true;
    setBusy(true);
    const url = new URL(window.location.href);
    const callback = url.searchParams.get('calendarAgent');
    if (callback) {
      if (callback === 'connected') setNotice('AI 日曆授權已完成。');
      else setError(errorText(new Error(callback)));
      url.searchParams.delete('calendarAgent');
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    load()
      .catch((failure: unknown) => {
        if (
          generation.current === current &&
          !(failure instanceof Error && failure.name === 'AbortError')
        )
          setError(errorText(failure));
      })
      .finally(() => {
        if (generation.current === current) {
          locked.current = false;
          setBusy(false);
        }
      });
    return () => {
      generation.current = current + 1;
      activeRequests.forEach((controller) => controller.abort());
    };
  }, [load]);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    const current = generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      if (
        generation.current === current &&
        !(failure instanceof Error && failure.name === 'AbortError')
      ) {
        if (failure instanceof Error && failure.message === 'CALENDAR_GRANT_MISMATCH') {
          setStatus({ configured: true, status: 'configuration_changed', calendar: 'primary' });
        } else setError(errorText(failure));
      }
    } finally {
      if (generation.current === current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  const connect = () =>
    run(async () => {
      const result = await request<{ authorizationUrl: string }>('connect', 'POST', {});
      const url = new URL(result.authorizationUrl);
      if (
        url.origin !== 'https://accounts.google.com' ||
        url.username ||
        url.password ||
        !['/o/oauth2/v2/auth', '/o/oauth2/auth'].includes(url.pathname)
      )
        throw new Error('OAUTH_EXCHANGE_FAILED');
      window.location.assign(url.toString());
    });
  const disconnect = () => {
    if (
      locked.current ||
      !window.confirm(
        '撤銷會停止 AI 日曆存取。Google 會一併撤銷同一 Google Cloud 專案下這個帳號的其他 Google API 授權，可能影響手動日曆；不同 OAuth 用戶端也無法避免此影響。日曆活動不會被刪除。確定繼續？',
      )
    )
      return;
    void run(async () => {
      const result = await request<{ status: string }>('disconnect', 'POST', {
        confirmProjectRevocation: true,
      });
      await load();
      setNotice(
        result.status === 'revocation_pending'
          ? '已停止 AI 存取，Google 撤銷尚未完成，請稍後重試。'
          : '已撤銷 AI 日曆授權，日曆活動保留。',
      );
    });
  };
  const configured = status?.configured === true && status.status !== 'not_configured';
  return (
    <section
      aria-label="AI 日曆授權"
      className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-white">
            <Bot size={20} /> AI 日曆授權
          </h2>
          <p className="mt-2 text-sm text-slate-500">
            AI／MCP 使用獨立授權，與你手動操作日曆的授權分開。此處只管理授權，不操作活動。
          </p>
        </div>
        <Button variant="secondary" disabled={busy} onClick={() => void run(load)}>
          <RefreshCw size={16} className="mr-2" />
          重新整理 AI 授權
        </Button>
      </header>
      <p className="mt-3 text-sm leading-6 text-amber-700 dark:text-amber-300">
        Google 撤銷可能影響同一 Google Cloud 專案的其他授權。僅使用不同 OAuth
        用戶端不足以隔離撤銷，管理員應使用不同 Google Cloud 專案。
      </p>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-4 text-sm text-blue-700 dark:text-blue-300">
          {notice}
        </p>
      )}
      {!status && (
        <p className="mt-4 text-sm text-slate-500">
          {busy ? '正在確認 AI 日曆授權…' : '目前無法讀取 AI 授權狀態，請稍後重新整理。'}
        </p>
      )}
      {status && !configured && (
        <div className="mt-4">
          <h3 className="font-medium dark:text-white">AI 日曆尚未啟用</h3>
          <p className="mt-2 text-sm text-slate-500">
            管理員尚未完成獨立 AI 授權設定，不影響手動日曆與 Google 登入。
          </p>
        </div>
      )}
      {configured && status.status === 'configuration_changed' && (
        <p role="alert" className="mt-4 text-sm text-amber-700 dark:text-amber-300">
          請管理員修復原有 AI 授權設定；修復前不能重新授權或撤銷。
        </p>
      )}
      {configured && ['disconnected', 'reconnect_required'].includes(status.status) && (
        <div className="mt-4">
          <p className="text-sm text-slate-500">
            {status.status === 'reconnect_required'
              ? 'AI 日曆授權已失效，請重新授權。'
              : '尚未授權 AI 使用你的主日曆。Google 登入或手動日曆連結不會自動授權 AI。'}
          </p>
          <Button className="mt-4" disabled={busy} onClick={() => void connect()}>
            <Link size={16} className="mr-2" />
            授權 AI 使用日曆
          </Button>
        </div>
      )}
      {configured && status.status === 'connected' && (
        <div className="mt-4">
          <p className="text-sm text-slate-500">AI 已取得主日曆授權。</p>
          <Button className="mt-4" variant="ghost" disabled={busy} onClick={disconnect}>
            <Unplug size={16} className="mr-2" />
            撤銷 AI 日曆授權
          </Button>
        </div>
      )}
      {configured && status.status === 'revocation_pending' && (
        <div className="mt-4">
          <p className="text-sm text-slate-500">
            已停止 AI 存取，Google 撤銷尚待完成；完成前無法重新授權。
          </p>
          <Button className="mt-4" disabled={busy} onClick={disconnect}>
            重試撤銷 AI 授權
          </Button>
        </div>
      )}
    </section>
  );
}
