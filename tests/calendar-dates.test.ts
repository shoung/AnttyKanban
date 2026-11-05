import assert from 'node:assert/strict';
import test from 'node:test';
import {
  draftForEvent,
  draftForSelection,
  eventFromDraft,
  movedEvent,
} from '../services/calendarDates.ts';
import type { CalendarEvent } from '../server/calendar/core.ts';

const event: CalendarEvent = {
  id: 'one',
  etag: '"v1"',
  readOnly: false,
  summary: 'Personal',
  start: { dateTime: '2026-11-05T09:15:37+08:00', timeZone: 'Asia/Taipei' },
  end: { dateTime: '2026-11-05T10:15:37+08:00', timeZone: 'Asia/Taipei' },
};

test('untouched timed fields preserve original instant, seconds and zone', () => {
  const draft = draftForEvent(event);
  assert.deepEqual(eventFromDraft({ ...draft, summary: 'Renamed' }, event).start, event.start);
  assert.deepEqual(eventFromDraft(draft, event).end, event.end);
});

test('all-day editor uses inclusive last day but writes an exclusive end without timezone conversion', () => {
  const allDay = { ...event, start: { date: '2026-12-31' }, end: { date: '2027-01-03' } };
  const draft = draftForEvent(allDay);
  assert.equal(draft.end, '2027-01-02');
  assert.deepEqual(eventFromDraft(draft).end, { date: '2027-01-03' });
  assert.equal(draftForSelection('2026-11-05', '2026-11-06', true).end, '2026-11-05');
});

test('invalid date and nonpositive durations never become mutation payloads', () => {
  const draft = draftForSelection('2026-11-05', '2026-11-06', true);
  assert.throws(() => eventFromDraft({ ...draft, summary: 'x', start: '2026-02-30' }));
  assert.throws(() => eventFromDraft({ ...draft, summary: 'x', end: '2026-11-04' }));
  assert.throws(() => eventFromDraft({ ...draft, summary: ' ' }));
});

test('drag payload preserves content and all-day dates, never sends identifiers or read-only flags', () => {
  const input = movedEvent(event, '2026-11-06', '2026-11-08', true);
  assert.deepEqual(input.start, { date: '2026-11-06' });
  assert.deepEqual(input.end, { date: '2026-11-08' });
  assert.equal(input.summary, event.summary);
  assert.equal('id' in input, false);
  assert.equal('etag' in input, false);
});

test('timed drag preserves the exact instants including seconds', () => {
  const start = '2026-11-06T10:15:37+08:00';
  const end = '2026-11-06T11:15:37+08:00';
  const input = movedEvent(event, start, end, false);
  assert.equal(Date.parse(input.start.dateTime!), Date.parse(start));
  assert.equal(Date.parse(input.end.dateTime!), Date.parse(end));
});

test('DST gaps are rejected and unchanged repeated times preserve their original offset', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const draft = {
      ...draftForEvent(event),
      summary: 'x',
      start: '2027-03-14T02:30',
      end: '2027-03-14T04:00',
    };
    assert.throws(() => eventFromDraft(draft), /INVALID_EVENT/);
    const repeated = {
      ...event,
      start: { dateTime: '2026-11-01T01:30:00-05:00' },
      end: { dateTime: '2026-11-01T02:30:00-05:00' },
    };
    assert.deepEqual(eventFromDraft(draftForEvent(repeated), repeated).start, repeated.start);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
