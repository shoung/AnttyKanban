import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { CalendarDays, Link, RefreshCw, Trash2, Pencil, Unplug } from 'lucide-react';
import { Button } from './Button';
import type { CalendarEvent, CalendarEventInput, CalendarStatus } from '../server/calendar/core';

const errorMessages: Record<string, string> = {
  CALENDAR_NOT_CONFIGURED: '日曆服務尚未設定完成，原本的 Google 登入仍可使用。',
  AUTHENTICATION_REQUIRED: '登入狀態已失效，請重新登入後再試。',
  CALENDAR_NOT_CONNECTED: '請先連結你的 Google 日曆。',
  RECONNECT_REQUIRED: 'Google 日曆授權已失效，請重新連結。',
  OAUTH_CANCELLED: '已取消日曆授權，原本的登入不受影響。',
  OAUTH_STATE_INVALID: '授權流程已過期或瀏覽器不符，請重新點選連結。',
  GOOGLE_ACCOUNT_MISMATCH: '請選擇和目前登入相同的 Google 帳號。',
  CALENDAR_SCOPE_REQUIRED: '尚未授予日曆權限，請重新連結並確認授權。',
  OFFLINE_ACCESS_REQUIRED: '未取得持續連線所需的授權，請重新連結。',
  EVENT_CHANGED: '這個活動已在其他地方更新，請重新整理後再編輯。',
  EVENT_NOT_FOUND: '活動已被移除，請重新整理。',
  PERSONAL_EVENTS_ONLY: '為避免寄出邀請或改動整個系列，這類活動請到 Google 日曆編輯。',
  INVALID_EVENT: '請確認活動名稱、日期與時間，結束必須晚於開始。',
  GOOGLE_PERMISSION_DENIED: 'Google 拒絕日曆存取，請確認帳號權限或重新連結。',
  CONNECTION_CHANGED: '日曆連線已變更，請重新整理後再試。',
  REVOCATION_PENDING: '已停止本站存取，請先完成撤銷後再連結。',
  RATE_LIMITED: 'Google 暫時限制請求，請稍後再試。',
  ORIGIN_NOT_ALLOWED: '此網址尚未獲准使用日曆服務，請使用正式網站。',
};
function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return errorMessages[code] ?? '日曆暫時無法使用，請稍後再試。';
}
function dateInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}
function eventWhen(event: CalendarEvent): string {
  if (event.start?.date) return `${event.start.date} · 全天`;
  if (!event.start?.dateTime) return '時間未提供';
  return new Intl.DateTimeFormat('zh-TW', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(event.start.dateTime));
}
interface FormState {
  summary: string;
  description: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
}
const emptyForm = (): FormState => ({
  summary: '',
  description: '',
  location: '',
  start: '',
  end: '',
  allDay: false,
});

/** A UID key remounts all form and event state immediately when the signed-in account changes. */
export function CalendarWorkspace({ user }: { user: User }) {
  return <CalendarAccountWorkspace key={user.uid} user={user} />;
}
function CalendarAccountWorkspace({ user }: { user: User }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [range, setRange] = useState<{ timeMin: string; timeMax: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const requests = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const request = useCallback(
    async <T,>(action: string, method = 'GET', body?: unknown): Promise<T> => {
      const controller = new AbortController();
      requests.current.add(controller);
      try {
        const token = await user.getIdToken();
        const response = await fetch(`/api/calendar?action=${action}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => {
          throw new Error('CALENDAR_NOT_CONFIGURED');
        });
        if (!response.ok)
          throw new Error(typeof data.error === 'string' ? data.error : 'CALENDAR_REQUEST_FAILED');
        return data as T;
      } finally {
        requests.current.delete(controller);
      }
    },
    [user],
  );
  const load = useCallback(async () => {
    const current = await request<CalendarStatus>('status');
    if (!mounted.current) return;
    setStatus(current);
    if (current.status === 'connected') {
      const result = await request<{
        events: CalendarEvent[];
        timeMin: string;
        timeMax: string;
        nextPageToken?: string;
      }>('events');
      if (!mounted.current) return;
      setEvents(result.events);
      setNextPageToken(result.nextPageToken);
      setRange({ timeMin: result.timeMin, timeMax: result.timeMax });
    } else {
      setEvents([]);
      setNextPageToken(undefined);
    }
  }, [request]);
  useEffect(() => {
    mounted.current = true;
    const activeRequests = requests.current;
    const callback = new URL(window.location.href).searchParams.get('calendar');
    if (callback) {
      if (callback === 'connected') setNotice('Google 日曆已連結。');
      else setError(errorText(new Error(callback)));
      const url = new URL(window.location.href);
      url.searchParams.delete('calendar');
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    load()
      .catch((failure: unknown) => {
        if (mounted.current && !(failure instanceof Error && failure.name === 'AbortError'))
          setError(errorText(failure));
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
    return () => {
      mounted.current = false;
      activeRequests.forEach((controller) => controller.abort());
    };
  }, [load]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      if (mounted.current) {
        setError(errorText(failure));
        if (failure instanceof Error && failure.message === 'RECONNECT_REQUIRED')
          setStatus({ configured: true, status: 'reconnect_required', calendar: 'primary' });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const connect = () =>
    run(async () => {
      const result = await request<{ authorizationUrl: string }>('connect', 'POST', {});
      const url = new URL(result.authorizationUrl);
      if (url.origin !== 'https://accounts.google.com') throw new Error('OAUTH_EXCHANGE_FAILED');
      if (mounted.current) window.location.assign(url.toString());
    });
  const disconnect = () => {
    if (
      !window.confirm(
        '斷開會停止本站存取並撤銷 Google 授權。Google 會一併撤銷同一 Google Cloud 專案下，這個帳號授予的其他 Google API 權限；相關功能之後可能需要重新連結。日曆活動不會被刪除。確定繼續？',
      )
    )
      return;
    void run(async () => {
      const result = await request<{ status: string }>('disconnect', 'POST', {
        confirmProjectRevocation: true,
      });
      if (!mounted.current) return;
      setEditing(null);
      setForm(emptyForm());
      setEvents([]);
      await load();
      if (mounted.current)
        setNotice(
          result.status === 'revocation_pending'
            ? '已停止本站存取，Google 撤銷尚未完成。請稍後按「重試撤銷」。'
            : '已斷開 Google 日曆，活動保留在你的 Google 帳號中。',
        );
    });
  };
  function edit(event: CalendarEvent) {
    setEditing(event);
    setError('');
    setForm({
      summary: event.summary,
      description: event.description ?? '',
      location: event.location ?? '',
      start: event.start.date ?? dateInput(event.start.dateTime ?? ''),
      end: event.end.date ?? dateInput(event.end.dateTime ?? ''),
      allDay: Boolean(event.start.date),
    });
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    void run(async () => {
      if (!form.summary.trim() || !form.start || !form.end) throw new Error('INVALID_EVENT');
      const startTime = Date.parse(form.start);
      const endTime = Date.parse(form.end);
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime)
        throw new Error('INVALID_EVENT');
      const payload: CalendarEventInput = {
        summary: form.summary.trim(),
        description: form.description,
        location: form.location,
        start: form.allDay
          ? { date: form.start }
          : { dateTime: new Date(form.start).toISOString() },
        end: form.allDay ? { date: form.end } : { dateTime: new Date(form.end).toISOString() },
      };
      if (editing)
        await request('events', 'PATCH', {
          eventId: editing.id,
          etag: editing.etag,
          event: payload,
        });
      else await request('events', 'POST', payload);
      if (!mounted.current) return;
      setForm(emptyForm());
      setEditing(null);
      await load();
      if (mounted.current) setNotice(editing ? '活動已更新。' : '活動已新增。');
    });
  }
  const remove = (event: CalendarEvent) => {
    if (!window.confirm(`確定刪除「${event.summary}」？這會從你的 Google 主日曆刪除活動。`)) return;
    void run(async () => {
      await request('events', 'DELETE', { eventId: event.id, etag: event.etag });
      if (!mounted.current) return;
      if (editing?.id === event.id) {
        setEditing(null);
        setForm(emptyForm());
      }
      await load();
      if (mounted.current) setNotice('活動已刪除。');
    });
  };
  const field =
    'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';
  const connected = status?.status === 'connected';
  return (
    <section
      className="h-full overflow-y-auto bg-slate-50 p-4 dark:bg-slate-950 md:p-8"
      aria-label="Google 日曆工作區"
    >
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-600 dark:text-blue-400">
              <CalendarDays size={18} /> 個人行程
            </div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Google 日曆</h1>
            <p className="mt-2 text-sm text-slate-500">{user.email} · 只操作你的主日曆</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => void run(load)}>
              <RefreshCw size={16} className="mr-2" />
              重新整理
            </Button>
            {connected && (
              <Button variant="ghost" disabled={busy} onClick={disconnect}>
                <Unplug size={16} className="mr-2" />
                斷開連結
              </Button>
            )}
          </div>
        </header>
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-xl bg-blue-50 p-4 text-sm text-blue-700 dark:bg-blue-950 dark:text-blue-200"
          >
            {notice}
          </p>
        )}
        {!status && (
          <p className="p-8 text-center text-slate-500">
            {busy ? '正在確認日曆連線…' : '目前無法讀取日曆狀態，可稍後重新整理。'}
          </p>
        )}
        {status?.status === 'not_configured' && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-semibold dark:text-white">日曆尚未啟用</h2>
            <p className="mt-2 text-sm text-slate-500">
              管理員尚未完成伺服器與 Google 授權設定。這不影響原本的 Google 登入、看板或心智圖。
            </p>
          </div>
        )}
        {status && ['disconnected', 'reconnect_required'].includes(status.status) && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-semibold dark:text-white">
              {status.status === 'reconnect_required' ? '請重新連結日曆' : '尚未連結 Google 日曆'}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
              每個帳號需獨立授權，Google 登入不會自動取得日曆權限。Google
              授權畫面可能顯示你擁有的所有日曆，本站會在伺服器限制為你的主日曆。持續連線憑證僅加密保存在伺服器。
            </p>
            <Button className="mt-5" disabled={busy} onClick={() => void connect()}>
              <Link size={16} className="mr-2" />
              連結 Google 日曆
            </Button>
          </div>
        )}
        {status?.status === 'revocation_pending' && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <h2 className="font-semibold">已停止本站存取，Google 撤銷尚待完成</h2>
            <p className="mt-2 text-sm">完成撤銷前不會再讀寫日曆，也不能重新連結。</p>
            <Button className="mt-4" disabled={busy} onClick={disconnect}>
              重試撤銷
            </Button>
          </div>
        )}
        {connected && (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
              <div className="border-b border-slate-100 p-5 dark:border-slate-800">
                <h2 className="font-semibold dark:text-white">最近與即將到來的活動</h2>
                <p className="mt-1 text-xs text-slate-500">
                  過去 30 天至未來 90 天 · 時間依此裝置時區顯示
                </p>
              </div>
              {events.length === 0 && (
                <p className="p-8 text-center text-sm text-slate-500">
                  {busy ? '載入中…' : '這段期間沒有活動。'}
                </p>
              )}
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {events.map((event) => (
                  <li key={event.id} className="flex items-start justify-between gap-3 p-5">
                    <div className="min-w-0">
                      <p className="text-xs text-blue-600 dark:text-blue-400">{eventWhen(event)}</p>
                      <h3 className="mt-1 break-words font-medium text-slate-900 dark:text-slate-100">
                        {event.summary}
                      </h3>
                      {event.location && (
                        <p className="mt-1 break-words text-xs text-slate-500">{event.location}</p>
                      )}
                      {event.readOnly && (
                        <p className="mt-2 text-xs text-slate-400">
                          邀請、重複或特殊活動，請在 Google 日曆編輯。
                        </p>
                      )}
                    </div>
                    {!event.readOnly && event.etag && (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`編輯 ${event.summary}`}
                          disabled={busy}
                          onClick={() => edit(event)}
                        >
                          <Pencil size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`刪除 ${event.summary}`}
                          disabled={busy}
                          onClick={() => remove(event)}
                        >
                          <Trash2 size={16} />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {nextPageToken && range && (
                <div className="p-4">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await request<{
                          events: CalendarEvent[];
                          nextPageToken?: string;
                        }>(
                          `events&pageToken=${encodeURIComponent(nextPageToken)}&timeMin=${encodeURIComponent(range.timeMin)}&timeMax=${encodeURIComponent(range.timeMax)}`,
                        );
                        if (mounted.current) {
                          setEvents((previous) => [
                            ...previous,
                            ...result.events.filter(
                              (item) => !previous.some((old) => old.id === item.id),
                            ),
                          ]);
                          setNextPageToken(result.nextPageToken);
                        }
                      })
                    }
                  >
                    載入更多
                  </Button>
                </div>
              )}
            </div>
            <form
              onSubmit={submit}
              className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
            >
              <h2 className="font-semibold dark:text-white">
                {editing ? '編輯活動' : '新增個人活動'}
              </h2>
              <label className="block text-sm text-slate-600 dark:text-slate-300">
                活動名稱
                <input
                  aria-label="活動名稱"
                  className={`${field} mt-1`}
                  required
                  maxLength={500}
                  disabled={busy}
                  value={form.summary}
                  onChange={(event) => setForm({ ...form, summary: event.target.value })}
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={form.allDay}
                  disabled={busy}
                  onChange={(event) =>
                    setForm({ ...form, allDay: event.target.checked, start: '', end: '' })
                  }
                />
                全天活動
              </label>
              <label className="block text-sm text-slate-600 dark:text-slate-300">
                開始時間
                <input
                  aria-label="開始時間"
                  className={`${field} mt-1`}
                  type={form.allDay ? 'date' : 'datetime-local'}
                  required
                  disabled={busy}
                  value={form.start}
                  onChange={(event) => setForm({ ...form, start: event.target.value })}
                />
              </label>
              <label className="block text-sm text-slate-600 dark:text-slate-300">
                結束時間
                <input
                  aria-label="結束時間"
                  className={`${field} mt-1`}
                  type={form.allDay ? 'date' : 'datetime-local'}
                  required
                  disabled={busy}
                  value={form.end}
                  onChange={(event) => setForm({ ...form, end: event.target.value })}
                />
              </label>
              {form.allDay && (
                <p className="text-xs text-slate-500">
                  全天活動的結束日期不包含當天，單日活動請選隔天。
                </p>
              )}
              <label className="block text-sm text-slate-600 dark:text-slate-300">
                地點
                <input
                  className={`${field} mt-1`}
                  maxLength={1000}
                  disabled={busy}
                  value={form.location}
                  onChange={(event) => setForm({ ...form, location: event.target.value })}
                />
              </label>
              <label className="block text-sm text-slate-600 dark:text-slate-300">
                說明
                <textarea
                  className={`${field} mt-1`}
                  rows={3}
                  maxLength={8000}
                  disabled={busy}
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </label>
              <p className="text-xs leading-5 text-slate-500">
                不新增參與者、不寄出邀請、不變更日曆分享權限。
              </p>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {editing ? '儲存變更' : '新增活動'}
                </Button>
                {editing && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      setForm(emptyForm());
                    }}
                  >
                    取消
                  </Button>
                )}
              </div>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}

export default CalendarWorkspace;
