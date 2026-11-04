import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import type { CalendarStatus } from '../server/calendar/core';
import { Button } from './Button';

const messages: Record<string, string> = {
  OAUTH_CANCELLED: '已取消人工 API 授權。',
  GOOGLE_ACCOUNT_MISMATCH: '請使用和目前 Antty 登入相同的 Google 帳號。',
  CALENDAR_SCOPE_REQUIRED: '未授予必要的日曆權限。',
  OAUTH_STATE_INVALID: '授權流程已過期或瀏覽器不符，請重新開始。',
  CALENDAR_GRANT_MISMATCH: '授權設定已變更，請管理員修復原設定；不會覆寫既有授權。',
  LEGACY_CALENDAR_GRANT: '舊版授權需要重新連接；若要撤銷舊授權，請到 Google 帳號設定處理。',
  AUTHENTICATION_REQUIRED: '請重新登入 Antty 後再試。',
};
export function ManualCalendarConnection({ user }: { user: User }) {
  return <Connection key={user.uid} user={user} />;
}
function Connection({ user }: { user: User }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const requests = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const locked = useRef(true);
  const request = useCallback(
    async <T,>(action: string, body?: unknown): Promise<T> => {
      const controller = new AbortController();
      requests.current.add(controller);
      const check = () => {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      };
      try {
        const token = await user.getIdToken();
        check();
        const response = await fetch(`/api/calendar?action=${action}`, {
          method: body === undefined ? 'GET' : 'POST',
          mode: 'same-origin',
          credentials: 'same-origin',
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        check();
        const data = await response.json();
        check();
        if (!response.ok)
          throw new Error(typeof data?.error === 'string' ? data.error : 'REQUEST_FAILED');
        return data as T;
      } finally {
        requests.current.delete(controller);
      }
    },
    [user],
  );
  const load = useCallback(
    async () => setStatus(await request<CalendarStatus>('status')),
    [request],
  );
  useEffect(() => {
    const current = ++generation.current;
    locked.current = true;
    setBusy(true);
    const active = requests.current;
    const url = new URL(window.location.href);
    const callback = url.searchParams.get('calendar');
    if (callback) {
      if (callback === 'connected')
        setNotice('人工日曆 API 已連接。嵌入視圖仍使用 Google 瀏覽器登入。');
      else setError(messages[callback] ?? '日曆 API 授權未完成，請重試。');
      url.searchParams.delete('calendar');
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    load()
      .catch(() => {
        if (generation.current === current) setError('目前無法讀取人工 API 連線狀態。');
      })
      .finally(() => {
        if (generation.current === current) {
          locked.current = false;
          setBusy(false);
        }
      });
    return () => {
      generation.current = current + 1;
      active.forEach((c) => c.abort());
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
        const code = failure instanceof Error ? failure.message : '';
        setError(messages[code] ?? '人工 API 連線操作未完成，請稍後重試。');
        if (code === 'CALENDAR_GRANT_MISMATCH')
          setStatus({ configured: true, status: 'configuration_changed', calendar: 'primary' });
      }
    } finally {
      if (generation.current === current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  function connect() {
    void run(async () => {
      const result = await request<{ authorizationUrl: string }>('connect', {});
      const url = new URL(result.authorizationUrl);
      if (
        url.origin !== 'https://accounts.google.com' ||
        url.username ||
        url.password ||
        !['/o/oauth2/v2/auth', '/o/oauth2/auth'].includes(url.pathname)
      )
        throw new Error('INVALID_URL');
      window.location.assign(url.toString());
    });
  }
  function disconnect() {
    if (
      locked.current ||
      !window.confirm(
        '撤銷人工 API 授權可能一併撤銷同一 Google Cloud 專案內其他 Google 授權。日曆活動不會被刪除，嵌入視圖的 Google 登入也不是這筆 API 授權。確定繼續？',
      )
    )
      return;
    void run(async () => {
      const result = await request<{ status: string }>('disconnect', {
        confirmProjectRevocation: true,
      });
      await load();
      setNotice(
        result.status === 'revocation_pending'
          ? '本站已停止存取，Google 撤銷尚未完成，請稍後重試。'
          : '人工 API 授權已撤銷，日曆活動保留。',
      );
    });
  }
  return (
    <section
      aria-label="人工日曆 API 連線"
      className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
    >
      <h2 className="font-semibold dark:text-white">人工日曆 API 連線</h2>
      <p className="mt-2 text-sm text-slate-500">
        這是 Antty 後端的連線，與 Google 嵌入視圖和 AI 授權分開。使用 Google 原生日曆不需要先連接此
        API。
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-blue-700">
          {notice}
        </p>
      )}
      <p className="mt-3 text-sm text-slate-500">
        {!status
          ? busy
            ? '正在確認連線狀態…'
            : '目前無法讀取連線狀態。'
          : status.status === 'connected'
            ? '人工 API 已連接。'
            : status.status === 'not_configured'
              ? '人工 API 尚未設定完成。'
              : status.status === 'configuration_changed'
                ? '設定已變更，請管理員修復後再操作。'
                : status.status === 'revocation_pending'
                  ? 'Google 撤銷尚未完成。'
                  : '人工 API 尚未連接或需要重新授權。'}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => void run(load)}>
          重新整理 API 連線
        </Button>
        {status && ['disconnected', 'reconnect_required'].includes(status.status) && (
          <Button disabled={busy} onClick={connect}>
            連接人工 API
          </Button>
        )}
        {status && ['connected', 'revocation_pending'].includes(status.status) && (
          <Button variant="ghost" disabled={busy} onClick={disconnect}>
            {status.status === 'revocation_pending' ? '重試 API 撤銷' : '撤銷人工 API 授權'}
          </Button>
        )}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        連接時會請求可讀寫本人擁有日曆的持續權限；本區不會新增、修改或刪除活動。
      </p>
    </section>
  );
}
