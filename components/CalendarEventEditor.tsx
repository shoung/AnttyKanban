import React, { useEffect, useRef, useState } from 'react';
import type { CalendarEvent, CalendarEventInput } from '../server/calendar/core';
import { eventFromDraft, type EventDraft } from '../services/calendarDates';
import { Button } from './Button';

interface Props {
  initial: EventDraft;
  event?: CalendarEvent;
  busy: boolean;
  blocked: boolean;
  onSave(input: CalendarEventInput): void;
  onDelete(): void;
  onClose(): void;
}
export function CalendarEventEditor({
  initial,
  event,
  busy,
  blocked,
  onSave,
  onDelete,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const title = useRef<HTMLInputElement>(null);
  const readOnly = Boolean(event && (event.readOnly || !event.etag));
  useEffect(() => {
    title.current?.focus();
  }, []);
  function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || blocked || readOnly) return;
    try {
      const input = eventFromDraft(draft, event);
      setError('');
      onSave(input);
    } catch {
      setError('請填寫活動名稱與有效的起訖時間；結束需晚於開始。夏令時間跳過的時間無法使用。');
    }
  }
  const fieldClass =
    'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-white';
  const field = (
    key: 'summary' | 'location' | 'start' | 'end',
    label: string,
    type = 'text',
    maxLength?: number,
  ) => (
    <label className="block text-sm">
      {label}
      <input
        ref={key === 'summary' ? title : undefined}
        className={fieldClass}
        type={type}
        required={key !== 'location'}
        maxLength={maxLength}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <section
      aria-label="活動詳細資料"
      className="rounded-2xl border border-slate-200 bg-white p-5 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{event ? '活動詳細資料' : '建立新活動'}</h2>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          關閉編輯
        </Button>
      </div>
      {readOnly && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-300">
          此活動目前僅供檢視：重複、受邀、特殊、鎖定或缺少版本資料的活動，請到 Google 日曆處理。
        </p>
      )}
      <form onSubmit={save}>
        <fieldset disabled={busy || blocked || readOnly} className="space-y-4 disabled:opacity-70">
          {field('summary', '活動名稱', 'text', 500)}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.allDay}
              onChange={(e) => {
                const allDay = e.target.checked;
                setDraft({
                  ...draft,
                  allDay,
                  start: allDay ? draft.start.slice(0, 10) : `${draft.start}T09:00`,
                  end: allDay ? draft.end.slice(0, 10) : `${draft.end}T10:00`,
                });
              }}
            />
            全天活動
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            {field(
              'start',
              draft.allDay ? '開始日期' : '開始時間',
              draft.allDay ? 'date' : 'datetime-local',
            )}
            {field(
              'end',
              draft.allDay ? '結束日期（含當日）' : '結束時間',
              draft.allDay ? 'date' : 'datetime-local',
            )}
          </div>
          <p className="text-xs text-slate-500">
            {draft.allDay
              ? '全天活動以日期儲存，結束日期包含當日。'
              : `時間以瀏覽器時區 ${Intl.DateTimeFormat().resolvedOptions().timeZone} 顯示與編輯。夏令時間重複的時間若重新輸入，採用第一次出現的時刻。`}
          </p>
          {field('location', '地點', 'text', 1000)}
          <label className="block text-sm">
            說明
            <textarea
              className={fieldClass}
              rows={3}
              maxLength={8000}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <Button type="submit">{busy ? '儲存中…' : '儲存活動'}</Button>
              {event && (
                <Button type="button" variant="danger" onClick={onDelete}>
                  刪除活動
                </Button>
              )}
            </div>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
      </form>
      <a
        className="mt-4 inline-block text-sm text-blue-700 dark:text-blue-300"
        href={event?.htmlLink ?? 'https://calendar.google.com/'}
        target="_blank"
        rel="noopener noreferrer"
      >
        在 Google 日曆開啟
      </a>
    </section>
  );
}
