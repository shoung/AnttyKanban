import type { CalendarDate, CalendarEvent, CalendarEventInput } from '../server/calendar/core';

export interface EventDraft {
  summary: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string;
  end: string;
}

function dateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('INVALID_EVENT');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error('INVALID_EVENT');
  return value;
}

function shiftDay(value: string, days: number): string {
  const date = new Date(`${dateOnly(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** datetime-local fields always use the browser's explicitly labelled timezone. */
function localTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_EVENT');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function timedDate(value: string, original?: CalendarDate): CalendarDate {
  // Preserve seconds, offset and the later occurrence of an ambiguous DST time on text-only edits.
  if (original?.dateTime && localTime(original.dateTime) === value) return { ...original };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('INVALID_EVENT');
  const date = new Date(value);
  // Reject invalid dates and nonexistent local times instead of allowing Date's DST normalization.
  if (!Number.isFinite(date.getTime()) || localTime(date.toISOString()) !== value)
    throw new Error('INVALID_EVENT');
  return {
    dateTime: date.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function draftForSelection(start: string, end: string, allDay: boolean): EventDraft {
  return {
    summary: '',
    description: '',
    location: '',
    allDay,
    start: allDay ? dateOnly(start.slice(0, 10)) : localTime(start),
    end: allDay ? shiftDay(end.slice(0, 10), -1) : localTime(end),
  };
}

export function draftForEvent(event: CalendarEvent): EventDraft {
  const allDay = Boolean(event.start.date);
  return {
    ...draftForSelection(
      event.start.date ?? event.start.dateTime!,
      event.end.date ?? event.end.dateTime!,
      allDay,
    ),
    summary: event.summary,
    description: event.description ?? '',
    location: event.location ?? '',
  };
}

export function eventFromDraft(draft: EventDraft, original?: CalendarEvent): CalendarEventInput {
  const start = draft.allDay
    ? { date: dateOnly(draft.start) }
    : timedDate(draft.start, original?.start);
  const end = draft.allDay ? { date: shiftDay(draft.end, 1) } : timedDate(draft.end, original?.end);
  if (
    !draft.summary.trim() ||
    draft.summary.length > 500 ||
    draft.description.length > 8000 ||
    draft.location.length > 1000 ||
    Date.parse(end.date ?? end.dateTime!) <= Date.parse(start.date ?? start.dateTime!)
  )
    throw new Error('INVALID_EVENT');
  return {
    summary: draft.summary.trim(),
    description: draft.description,
    location: draft.location,
    start,
    end,
  };
}

export function movedEvent(
  event: CalendarEvent,
  start: string,
  end: string,
  allDay: boolean,
): CalendarEventInput {
  const draft = draftForSelection(start, end, allDay);
  const content = {
    summary: event.summary,
    description: event.description ?? '',
    location: event.location ?? '',
  };
  if (allDay) return eventFromDraft({ ...draft, ...content });
  const first = new Date(start);
  const last = new Date(end);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) || last <= first)
    throw new Error('INVALID_EVENT');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    ...content,
    start: { dateTime: first.toISOString(), timeZone },
    end: { dateTime: last.toISOString(), timeZone },
  };
}
