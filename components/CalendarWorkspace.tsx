import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin, { type EventResizeDoneArg } from '@fullcalendar/interaction';
import zhTw from '@fullcalendar/core/locales/zh-tw';
import type { DatesSetArg, EventDropArg, EventInput } from '@fullcalendar/core';
import { CalendarDays, ExternalLink } from 'lucide-react';
import type { CalendarEvent, CalendarEventInput, CalendarStatus } from '../server/calendar/core';
import {
  draftForEvent,
  draftForSelection,
  movedEvent,
  type EventDraft,
} from '../services/calendarDates';
import { Button } from './Button';
import { AgentCalendarAccess } from './AgentCalendarAccess';
import { ManualCalendarConnection } from './ManualCalendarConnection';
import { CalendarEventEditor } from './CalendarEventEditor';
import './calendar.css';

const plugins = [dayGridPlugin, timeGridPlugin, interactionPlugin];
const messages: Record<string, string> = {
  EVENT_CHANGED: '活動已變更，請重新整理後再編輯，避免覆蓋其他修改。',
  EVENT_NOT_FOUND: '活動已刪除或無法存取，請重新整理。',
  PERSONAL_EVENTS_ONLY: '此活動目前僅供檢視，請重新整理或到 Google 日曆處理。',
  RATE_LIMITED: 'Google 暫時限制請求，請稍候再重新整理。',
  GOOGLE_PERMISSION_DENIED: 'Google 拒絕存取，請檢查個人日曆授權後重新整理。',
  RECONNECT_REQUIRED: '個人日曆授權已失效，請重新連接。',
  AUTHENTICATION_REQUIRED: '請重新登入 Antty 後再連接日曆。',
  CALENDAR_NOT_CONNECTED: '個人日曆已中斷連線，請重新連接。',
  CALENDAR_GRANT_MISMATCH: '日曆授權設定已變更，請由管理員檢查。',
  CALENDAR_NOT_CONFIGURED: '個人日曆服務尚未設定，請由管理員檢查。',
};
interface Range {
  timeMin: string;
  timeMax: string;
}
interface Page {
  events: CalendarEvent[];
  nextPageToken?: string;
}
interface Editor {
  draft: EventDraft;
  event?: CalendarEvent;
}
/** Account changes unmount all in-memory events, drafts, and pending requests. */
export function CalendarWorkspace({ user }: { user: User }) {
  return <CalendarAccountWorkspace key={user.uid} user={user} />;
}
function CalendarAccountWorkspace({ user }: { user: User }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [range, setRange] = useState<Range | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loadedUser, setLoadedUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(() => {
    const params = new URL(window.location.href).searchParams;
    return params.has('calendar') || params.has('calendarAgent');
  });
  const requests = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const accountGeneration = useRef(0);
  const writeLock = useRef(false);
  const readyRef = useRef(false);
  const invalidateAccount = useCallback(() => {
    accountGeneration.current++;
  }, []);
  const ready =
    loadedUser === user && !loading && !writing && !needsRefresh && status?.status === 'connected';

  const request = useCallback(
    async <T,>(
      action: string,
      controller: AbortController,
      method = 'GET',
      body?: unknown,
    ): Promise<T> => {
      const check = () => {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      };
      const token = await user.getIdToken();
      check();
      const response = await fetch(`/api/calendar?action=${action}`, {
        method,
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
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
    },
    [user],
  );

  useEffect(() => {
    const active = requests.current;
    invalidateAccount();
    writeLock.current = false;
    setWriting(false);
    return () => {
      invalidateAccount();
      active.forEach((c) => c.abort());
    };
  }, [request, invalidateAccount]);

  useEffect(() => {
    // A range or refresh may arrive while Google is still processing a write.
    // Keep that write locked; success schedules a fresh read, failure requires explicit refresh.
    if (writeLock.current) return;
    const current = ++generation.current;
    const controller = new AbortController();
    requests.current.add(controller);
    readyRef.current = false;
    setLoading(true);
    setLoadedUser(null);
    setEvents([]);
    setEditor(null);
    setError('');
    void (async () => {
      const next = await request<CalendarStatus>('status', controller);
      if (generation.current !== current) return;
      setStatus(next);
      if (next.status !== 'connected') {
        setConnectionsOpen(true);
        return;
      }
      if (!range) return;
      const accumulated = new Map<string, CalendarEvent>();
      const tokens = new Set<string>();
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({ ...range, ...(pageToken ? { pageToken } : {}) });
        const page = await request<Page>(`events&${query}`, controller);
        if (generation.current !== current) return;
        if (!Array.isArray(page.events)) throw new Error('REQUEST_FAILED');
        page.events.forEach((event) => accumulated.set(event.id, event));
        pageToken = page.nextPageToken;
        if (pageToken) {
          if (tokens.has(pageToken) || tokens.size >= 100) throw new Error('INCOMPLETE_CALENDAR');
          tokens.add(pageToken);
        }
      } while (pageToken);
      setEvents([...accumulated.values()]);
      setLoadedUser(user);
      setNeedsRefresh(false);
      readyRef.current = true;
    })()
      .catch((failure) => {
        if (controller.signal.aborted || generation.current !== current) return;
        const code = failure instanceof Error ? failure.message : '';
        setError(messages[code] ?? '無法完整讀取日曆，請重新整理後再操作。');
        setNeedsRefresh(true);
        if (
          ['RECONNECT_REQUIRED', 'AUTHENTICATION_REQUIRED', 'CALENDAR_NOT_CONNECTED'].includes(code)
        ) {
          setStatus(null);
          setConnectionsOpen(true);
        }
      })
      .finally(() => {
        requests.current.delete(controller);
        if (generation.current === current) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [request, range, reload, user]);

  const datesSet = useCallback((info: DatesSetArg) => {
    const next = { timeMin: info.startStr, timeMax: info.endStr };
    setRange((previous) => {
      if (previous?.timeMin === next.timeMin && previous.timeMax === next.timeMax) return previous;
      readyRef.current = false;
      return next;
    });
  }, []);

  const onStatusChange = useCallback((next: CalendarStatus | null) => {
    if (writeLock.current) return;
    accountGeneration.current++;
    generation.current++;
    requests.current.forEach((c) => c.abort());
    readyRef.current = false;
    writeLock.current = false;
    setWriting(false);
    setLoading(false);
    setStatus(next);
    setEvents([]);
    setEditor(null);
    setLoadedUser(null);
    if (next) setReload((value) => value + 1);
  }, []);

  async function mutate(
    method: 'POST' | 'PATCH' | 'DELETE',
    input?: CalendarEventInput,
    original?: CalendarEvent,
    revert?: () => void,
  ) {
    if (
      !ready ||
      !readyRef.current ||
      writeLock.current ||
      (original && (original.readOnly || !original.etag))
    ) {
      revert?.();
      return;
    }
    writeLock.current = true;
    setWriting(true);
    setError('');
    setNotice('');
    const current = accountGeneration.current;
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const body =
        method === 'POST'
          ? input
          : {
              eventId: original!.id,
              etag: original!.etag,
              ...(method === 'PATCH' ? { event: input } : {}),
            };
      const result = await request<CalendarEvent>('events', controller, method, body);
      if (current !== accountGeneration.current) return;
      setEvents((previous) =>
        method === 'DELETE'
          ? previous.filter((e) => e.id !== original!.id)
          : [...previous.filter((e) => e.id !== result.id), result],
      );
      setEditor(null);
      setNotice(method === 'DELETE' ? '活動已刪除。' : '活動已儲存至 Google 日曆。');
      setLoadedUser(null);
      setReload((value) => value + 1);
    } catch (failure) {
      revert?.();
      if (controller.signal.aborted || current !== accountGeneration.current) return;
      readyRef.current = false;
      setNeedsRefresh(true);
      const code = failure instanceof Error ? failure.message : '';
      setError(
        messages[code] ??
          '無法確認操作結果；請先重新整理並檢查活動，再決定是否重做，避免重複建立。',
      );
      if (
        [
          'RECONNECT_REQUIRED',
          'CALENDAR_NOT_CONNECTED',
          'AUTHENTICATION_REQUIRED',
          'CALENDAR_GRANT_MISMATCH',
        ].includes(code)
      ) {
        setStatus(null);
        setEvents([]);
        setEditor(null);
        setConnectionsOpen(true);
      }
    } finally {
      requests.current.delete(controller);
      if (current === accountGeneration.current) {
        writeLock.current = false;
        setWriting(false);
      }
    }
  }

  function move(info: EventDropArg | EventResizeDoneArg) {
    const original = events.find((e) => e.id === info.event.id);
    if (!original || !ready || !info.event.startStr || !info.event.endStr) {
      info.revert();
      return;
    }
    try {
      void mutate(
        'PATCH',
        movedEvent(original, info.event.startStr, info.event.endStr, info.event.allDay),
        original,
        info.revert,
      );
    } catch {
      info.revert();
      setError('無法使用此起訖時間，請開啟活動編輯。');
    }
  }

  const calendarEvents = useMemo<EventInput[]>(
    () =>
      events.map((event) => ({
        id: event.id,
        title: event.summary,
        start: event.start.date ?? event.start.dateTime,
        end: event.end.date ?? event.end.dateTime,
        allDay: Boolean(event.start.date),
        editable: ready && !event.readOnly && Boolean(event.etag),
        classNames: event.readOnly || !event.etag ? ['antty-event-readonly'] : [],
      })),
    [events, ready],
  );

  function newEvent() {
    if (!ready || writeLock.current) return;
    const start = new Date();
    start.setSeconds(0, 0);
    setEditor({
      draft: draftForSelection(
        start.toISOString(),
        new Date(start.getTime() + 3_600_000).toISOString(),
        false,
      ),
    });
  }
  return (
    <section
      className="antty-calendar h-full overflow-y-auto bg-slate-50 p-4 dark:bg-slate-950 md:p-6"
      aria-label="Google 日曆工作區"
    >
      <div className="space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900 dark:text-white">
              <CalendarDays size={24} />
              我的日曆
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              主要日曆 · 瀏覽器時區：{Intl.DateTimeFormat().resolvedOptions().timeZone}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!ready} onClick={newEvent}>
              新增活動
            </Button>
            <Button
              variant="secondary"
              disabled={loading || writing}
              onClick={() => {
                readyRef.current = false;
                setNotice('');
                setReload((n) => n + 1);
              }}
            >
              重新整理
            </Button>
            <a
              className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 dark:text-blue-300"
              href="https://calendar.google.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              開啟 Google 日曆
              <ExternalLink size={16} />
            </a>
          </div>
        </header>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          點選日期或拖曳選取時段建立活動；點選活動編輯，也可拖曳移動或調整長度。重複、受邀及特殊活動目前僅供檢視。Google
          的變更請按「重新整理」讀取。
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-200"
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
        {editor && (
          <CalendarEventEditor
            key={editor.event?.id ?? `${editor.draft.start}/${editor.draft.end}`}
            initial={editor.draft}
            event={editor.event}
            busy={writing}
            blocked={!ready}
            onClose={() => setEditor(null)}
            onSave={(input) => void mutate(editor.event ? 'PATCH' : 'POST', input, editor.event)}
            onDelete={() => {
              if (
                ready &&
                !writeLock.current &&
                window.confirm('確定要刪除此活動？此操作會同步到 Google 日曆。')
              )
                void mutate('DELETE', undefined, editor.event);
            }}
          />
        )}
        {status?.status === 'connected' ? (
          <div
            className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900 md:p-5"
            aria-busy={loading || writing}
            inert={writing}
          >
            {loading && (
              <p role="status" className="mb-3 text-sm text-slate-500">
                正在讀取活動…
              </p>
            )}
            {!loading && !error && events.length === 0 && (
              <p role="status" className="mb-3 text-sm text-slate-500">
                這段期間沒有活動。
              </p>
            )}
            <FullCalendar
              plugins={plugins}
              locale={zhTw}
              timeZone="local"
              initialView="dayGridMonth"
              height="auto"
              headerToolbar={{
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay',
              }}
              buttonText={{ today: '今天', month: '月', week: '週', day: '日' }}
              events={calendarEvents}
              datesSet={datesSet}
              editable={ready}
              selectable={ready}
              selectMirror
              nowIndicator
              dayMaxEvents
              eventResizableFromStart
              allDayMaintainDuration
              eventDurationEditable={ready}
              eventStartEditable={ready}
              eventDrop={move}
              eventResize={move}
              eventClick={(info) => {
                if (loading || writing) return;
                const event = events.find((e) => e.id === info.event.id);
                if (event) setEditor({ event, draft: draftForEvent(event) });
              }}
              select={(info) => {
                if (ready && !writeLock.current)
                  setEditor({ draft: draftForSelection(info.startStr, info.endStr, info.allDay) });
              }}
              dateClick={(info) => {
                if (!ready || writeLock.current) return;
                const end = info.allDay
                  ? new Date(Date.parse(`${info.dateStr}T00:00:00Z`) + 86_400_000)
                      .toISOString()
                      .slice(0, 10)
                  : new Date(info.date.getTime() + 3_600_000).toISOString();
                setEditor({ draft: draftForSelection(info.dateStr, end, info.allDay) });
              }}
            />
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
            <h2 className="text-lg font-semibold dark:text-white">
              {loading ? '正在檢查個人日曆連線…' : '請先連接個人日曆'}
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              使用下方個人 API 連線設定授權。AI 日曆權限需另行連接。
            </p>
          </div>
        )}
        <details
          inert={writing}
          open={connectionsOpen}
          onToggle={(e) => setConnectionsOpen(e.currentTarget.open)}
          className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
        >
          <summary className="cursor-pointer font-semibold text-slate-900 dark:text-white">
            連線設定
          </summary>
          {connectionsOpen && (
            <div className="mt-4 space-y-4">
              <ManualCalendarConnection user={user} onStatusChange={onStatusChange} />
              <AgentCalendarAccess user={user} />
            </div>
          )}
        </details>
      </div>
    </section>
  );
}
export default CalendarWorkspace;
