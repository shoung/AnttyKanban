import React, { useEffect } from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import type { CalendarOptions, EventInput } from '@fullcalendar/core';
import type { CalendarStatus } from '../server/calendar/core';
import { CalendarWorkspace } from '../components/CalendarWorkspace';

const state = vi.hoisted(() => ({
  props: {} as CalendarOptions,
  onStatus: undefined as undefined | ((s: CalendarStatus | null, checking?: boolean) => void),
}));
vi.mock('@fullcalendar/react', () => ({
  default: function MockCalendar(props: CalendarOptions) {
    state.props = props;
    useEffect(() => {
      (props.datesSet as (arg: object) => void)?.({
        startStr: '2026-11-01T00:00:00Z',
        endStr: '2026-12-13T00:00:00Z',
      });
    }, [props.datesSet]);
    return (
      <div aria-label="Calendar grid">
        {(props.events as EventInput[]).map((e) => (
          <button
            key={e.id}
            onClick={() => (props.eventClick as (arg: object) => void)?.({ event: { id: e.id } })}
          >
            {e.title}
          </button>
        ))}
      </div>
    );
  },
}));
vi.mock('../components/ManualCalendarConnection', () => ({
  ManualCalendarConnection: ({
    onStatusChange,
  }: {
    onStatusChange?: (s: CalendarStatus | null, checking?: boolean) => void;
  }) => {
    state.onStatus = onStatusChange;
    return <div>Human connection controls</div>;
  },
}));
vi.mock('../components/AgentCalendarAccess', () => ({
  AgentCalendarAccess: () => <div>Agent connection controls</div>,
}));
const user = { uid: 'user-a', getIdToken: vi.fn(async () => 'token-a') } as unknown as User;
const connected = { configured: true, status: 'connected', calendar: 'primary' };
const event = {
  id: 'one',
  etag: '"v1"',
  summary: 'Personal event',
  readOnly: false,
  description: 'Notes',
  location: 'Taipei',
  start: { date: '2026-11-05' },
  end: { date: '2026-11-06' },
};
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function backend(events: Array<Omit<typeof event, 'etag'> & { etag?: string }> = [event]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url) => {
    return reply(url.includes('action=status') ? connected : { events });
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return fetcher(url, init);
  });
  return { calls, fetcher };
}
async function ready() {
  await screen.findByRole('button', { name: event.summary });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '新增活動' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
}
function openNew() {
  fireEvent.click(screen.getByRole('button', { name: '新增活動' }));
  fireEvent.change(screen.getByLabelText('活動名稱'), { target: { value: 'New event' } });
}
const writes = (calls: Array<{ init: RequestInit }>) =>
  calls.filter((c) => ['POST', 'PATCH', 'DELETE'].includes(c.init.method!));
beforeEach(() => {
  window.history.replaceState({}, '', '/');
  state.onStatus = undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('disconnected users see separate connection settings without events or editor', async () => {
  const fetcher = vi.fn<(url: string) => Promise<Response>>(async () =>
    reply({ ...connected, status: 'disconnected' }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<CalendarWorkspace user={user} />);
  await screen.findByText('請先連接個人日曆');
  expect(fetcher.mock.calls.every((c) => c[0].includes('action=status'))).toBe(true);
  expect(screen.queryByLabelText('活動名稱')).toBeNull();
  expect(screen.getByText('Human connection controls')).toBeTruthy();
  expect(screen.getByText('Agent connection controls')).toBeTruthy();
  expect(document.querySelector('iframe')).toBeNull();
});

test('loads the visible range and all pages with Firebase auth, never the agent API', async () => {
  const { calls, fetcher } = backend();
  fetcher.mockImplementation(async (url) => {
    if (url.includes('action=status')) return reply(connected);
    return reply(
      url.includes('pageToken=next')
        ? { events: [{ ...event, id: 'two', summary: 'Second page' }] }
        : { events: [event], nextPageToken: 'next' },
    );
  });
  render(<CalendarWorkspace user={user} />);
  await ready();
  expect(await screen.findByText('Second page')).toBeTruthy();
  for (const { url, init } of calls) {
    expect(url.startsWith('/api/calendar?')).toBe(true);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-a' });
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
    if (url.includes('action=events')) {
      const params = new URL(url, 'https://test.invalid').searchParams;
      expect(Date.parse(params.get('timeMin')!)).toBe(Date.parse('2026-11-01T00:00:00Z'));
      expect(Date.parse(params.get('timeMax')!)).toBe(Date.parse('2026-12-13T00:00:00Z'));
    }
  }
});

test('all-day edit sends original ETag and exclusive end with no extra fields', async () => {
  const { calls, fetcher } = backend();
  render(<CalendarWorkspace user={user} />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: event.summary }));
  expect((screen.getByLabelText('結束日期（含當日）') as HTMLInputElement).value).toBe(
    '2026-11-05',
  );
  fireEvent.change(screen.getByLabelText('活動名稱'), { target: { value: 'Updated' } });
  fetcher.mockResolvedValueOnce(reply({ ...event, summary: 'Updated', etag: '"v2"' }));
  fireEvent.click(screen.getByRole('button', { name: '儲存活動' }));
  await waitFor(() => expect(writes(calls)).toHaveLength(1));
  expect(writes(calls)[0].init.method).toBe('PATCH');
  expect(JSON.parse(String(writes(calls)[0].init.body))).toEqual({
    eventId: 'one',
    etag: '"v1"',
    event: {
      summary: 'Updated',
      description: 'Notes',
      location: 'Taipei',
      start: event.start,
      end: event.end,
    },
  });
});

test('duplicate create submissions send one POST and block retry after uncertain network result', async () => {
  const { calls, fetcher } = backend();
  render(<CalendarWorkspace user={user} />);
  await ready();
  openNew();
  let fail!: (error: Error) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const form = screen.getByLabelText('活動名稱').closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(writes(calls)).toHaveLength(1));
  await act(async () => fail(new TypeError('private upstream secret')));
  expect((await screen.findByRole('alert')).textContent).toContain('重新整理');
  expect(screen.getByRole('alert').textContent).not.toContain('private upstream secret');
  fireEvent.submit(form);
  expect(writes(calls)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '重新整理' }));
  await ready();
  expect(screen.queryByLabelText('活動名稱')).toBeNull();
});

test('delete requires confirmation and sends eventId plus ETag', async () => {
  const { calls, fetcher } = backend();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<CalendarWorkspace user={user} />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: event.summary }));
  fireEvent.click(screen.getByRole('button', { name: '刪除活動' }));
  expect(writes(calls)).toHaveLength(0);
  confirm.mockReturnValue(true);
  fetcher.mockResolvedValueOnce(reply({ deleted: true }));
  fireEvent.click(screen.getByRole('button', { name: '刪除活動' }));
  await waitFor(() => expect(writes(calls)).toHaveLength(1));
  expect(writes(calls)[0].init.method).toBe('DELETE');
  expect(JSON.parse(String(writes(calls)[0].init.body))).toEqual({ eventId: 'one', etag: '"v1"' });
});

test.each([{ readOnly: true }, { etag: undefined }])(
  'unsupported or unversioned events cannot be edited: %j',
  async (extra) => {
    const { calls } = backend([{ ...event, ...extra }]);
    render(<CalendarWorkspace user={user} />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: event.summary }));
    expect(screen.getByText(/此活動目前僅供檢視/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '儲存活動' })).toBeNull();
    expect(screen.queryByRole('button', { name: '刪除活動' })).toBeNull();
    expect((state.props.events as EventInput[])[0].editable).toBe(false);
    expect(writes(calls)).toHaveLength(0);
  },
);

test.each(['eventDrop', 'eventResize'] as const)(
  '%s uses ETag and rolls back on conflict',
  async (handler) => {
    const { calls, fetcher } = backend();
    render(<CalendarWorkspace user={user} />);
    await ready();
    fetcher.mockResolvedValueOnce(reply({ error: 'EVENT_CHANGED' }, 409));
    const revert = vi.fn();
    await act(async () =>
      (state.props[handler] as (arg: object) => void)({
        event: { id: 'one', startStr: '2026-11-06', endStr: '2026-11-07', allDay: true },
        revert,
      }),
    );
    await waitFor(() => expect(revert).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert').textContent).toContain('已變更');
    expect(state.props.editable).toBe(false);
    // The body is inspected by the backend through the submitted request.
    expect(
      fetcher.mock.calls.some(
        ([, init]) => init.method === 'PATCH' && String(init.body).includes('v1'),
      ),
    ).toBe(true);
    expect(writes(calls)).toHaveLength(1);
  },
);

test('partial pagination failure clears events and keeps mutations locked', async () => {
  const { fetcher } = backend();
  fetcher.mockImplementation(async (url) =>
    url.includes('action=status')
      ? reply(connected)
      : url.includes('pageToken=next')
        ? reply({ error: 'RATE_LIMITED' }, 429)
        : reply({ events: [event], nextPageToken: 'next' }),
  );
  render(<CalendarWorkspace user={user} />);
  await screen.findByRole('alert');
  expect(screen.queryByText(event.summary)).toBeNull();
  expect((screen.getByRole('button', { name: '新增活動' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test('account switch discards old data and aborts requests waiting for a token', async () => {
  let resolve!: (token: string) => void;
  const oldUser = {
    uid: 'old',
    getIdToken: () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  } as User;
  const { calls } = backend();
  const { rerender } = render(<CalendarWorkspace user={oldUser} />);
  rerender(<CalendarWorkspace user={user} />);
  await ready();
  await act(async () => resolve('old-secret'));
  expect(JSON.stringify(calls)).not.toContain('old-secret');
});

test('late previous-account event response never appears after account switch', async () => {
  const { fetcher } = backend();
  let finish!: (r: Response) => void;
  fetcher.mockImplementation(async (url, init) => {
    if (url.includes('action=status')) return reply(connected);
    if ((init.headers as Record<string, string>).Authorization === 'Bearer token-a')
      return new Promise((r) => {
        finish = r;
      });
    return reply({ events: [{ ...event, summary: 'Account B' }] });
  });
  const { rerender } = render(<CalendarWorkspace user={user} />);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  rerender(
    <CalendarWorkspace user={{ uid: 'user-b', getIdToken: async () => 'token-b' } as User} />,
  );
  await screen.findByText('Account B');
  await act(async () => finish(reply({ events: [event] })));
  expect(screen.queryByText(event.summary)).toBeNull();
});

test('an unknown connection status preserves the unsaved editor but disables writes', async () => {
  backend();
  render(<CalendarWorkspace user={user} />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: event.summary }));
  const details = screen.getByText('連線設定').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(state.onStatus).toBeTypeOf('function'));
  await act(async () => state.onStatus?.(null));
  expect(screen.queryByText(event.summary)).not.toBeNull();
  expect((screen.getByLabelText('活動名稱') as HTMLInputElement).value).toBe(event.summary);
  expect(
    (screen.getByRole('button', { name: '儲存活動' }) as HTMLButtonElement).matches(':disabled'),
  ).toBe(true);
});

test('an older list response cannot clear a newer failed connection check', async () => {
  const { calls, fetcher } = backend();
  render(<CalendarWorkspace user={user} />);
  await ready();
  openNew();
  const details = screen.getByText('連線設定').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(state.onStatus).toBeTypeOf('function'));
  let finish!: (r: Response) => void;
  fetcher.mockResolvedValueOnce(reply(connected)).mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: '重新整理' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () => {
    state.onStatus?.(null, true);
    state.onStatus?.(null, false);
  });
  await act(async () => finish(reply({ events: [event] })));
  expect(
    (screen.getByRole('button', { name: '儲存活動' }) as HTMLButtonElement).matches(':disabled'),
  ).toBe(true);
  expect((screen.getByLabelText('活動名稱') as HTMLInputElement).value).toBe('New event');
  expect(writes(calls)).toHaveLength(0);
  await act(async () => state.onStatus?.(connected as CalendarStatus, false));
  expect(
    (screen.getByRole('button', { name: '儲存活動' }) as HTMLButtonElement).matches(':disabled'),
  ).toBe(false);
});

test('opening a different event replaces the previous editor draft', async () => {
  backend([event, { ...event, id: 'two', summary: 'Second event' }]);
  render(<CalendarWorkspace user={user} />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: event.summary }));
  fireEvent.click(screen.getByRole('button', { name: 'Second event' }));
  expect((screen.getByLabelText('活動名稱') as HTMLInputElement).value).toBe('Second event');
});

test('late previous-range response cannot overwrite the new visible range', async () => {
  const { fetcher } = backend();
  let finish!: (r: Response) => void;
  fetcher.mockImplementation(async (url) => {
    if (url.includes('action=status')) return reply(connected);
    if (url.includes('2026-11'))
      return new Promise((r) => {
        finish = r;
      });
    return reply({ events: [{ ...event, summary: 'December event' }] });
  });
  render(<CalendarWorkspace user={user} />);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () =>
    (state.props.datesSet as (arg: object) => void)({
      startStr: '2026-12-01T00:00:00Z',
      endStr: '2027-01-12T00:00:00Z',
    }),
  );
  await screen.findByText('December event');
  await act(async () => finish(reply({ events: [event] })));
  expect(screen.queryByText(event.summary)).toBeNull();
});

test('all-day creation writes only an event payload and appears in the current view', async () => {
  const { calls, fetcher } = backend();
  render(<CalendarWorkspace user={user} />);
  await ready();
  await act(async () =>
    (state.props.select as (arg: object) => void)({
      startStr: '2026-11-10',
      endStr: '2026-11-12',
      allDay: true,
    }),
  );
  fireEvent.change(screen.getByLabelText('活動名稱'), { target: { value: 'New selected event' } });
  fetcher.mockResolvedValueOnce(
    reply(
      {
        ...event,
        id: 'created',
        summary: 'New selected event',
        start: { date: '2026-11-10' },
        end: { date: '2026-11-12' },
      },
      201,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '儲存活動' }));
  await screen.findByRole('button', { name: 'New selected event' });
  const mutation = writes(calls)[0];
  expect(mutation.init.method).toBe('POST');
  expect(JSON.parse(String(mutation.init.body))).toEqual({
    summary: 'New selected event',
    description: '',
    location: '',
    start: { date: '2026-11-10' },
    end: { date: '2026-11-12' },
  });
});

test('navigation and connection status cannot cancel or unlock an in-flight mutation', async () => {
  const { calls, fetcher } = backend();
  render(<CalendarWorkspace user={user} />);
  await ready();
  const details = screen.getByText('連線設定').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(state.onStatus).toBeTypeOf('function'));
  openNew();
  let finish!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  fireEvent.submit(screen.getByLabelText('活動名稱').closest('form')!);
  await waitFor(() => expect(writes(calls)).toHaveLength(1));
  const before = calls.length;
  await act(async () => {
    (state.props.datesSet as (arg: object) => void)({
      startStr: '2026-12-01T00:00:00Z',
      endStr: '2027-01-12T00:00:00Z',
    });
    state.onStatus?.(null);
  });
  expect(writes(calls)[0].init.signal?.aborted).toBe(false);
  expect(calls).toHaveLength(before);
  expect((screen.getByRole('button', { name: '新增活動' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => finish(reply({ ...event, id: 'created', summary: 'Created safely' })));
  await ready();
  expect(calls.slice(before).some((c) => c.url.includes('timeMin=2026-12'))).toBe(true);
  expect(writes(calls)).toHaveLength(1);
});

test('replacement User object aborts the old write and can finish a fresh authenticated read', async () => {
  const { calls, fetcher } = backend();
  const { rerender } = render(<CalendarWorkspace user={user} />);
  await ready();
  openNew();
  fetcher.mockImplementationOnce(() => new Promise<Response>(() => {}));
  fireEvent.submit(screen.getByLabelText('活動名稱').closest('form')!);
  await waitFor(() => expect(writes(calls)).toHaveLength(1));
  rerender(
    <CalendarWorkspace
      user={{ uid: user.uid, getIdToken: async () => 'replacement-token' } as User}
    />,
  );
  await ready();
  expect(writes(calls)[0].init.signal?.aborted).toBe(true);
  expect(calls.at(-1)?.init.headers).toMatchObject({ Authorization: 'Bearer replacement-token' });
});

test('a late old-session completion cannot unlock a newer pending write', async () => {
  const { calls, fetcher } = backend();
  const { rerender } = render(<CalendarWorkspace user={user} />);
  await ready();
  const details = screen.getByText('連線設定').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(state.onStatus).toBeTypeOf('function'));
  await act(async () => {
    state.onStatus?.(null);
    state.onStatus?.(connected as CalendarStatus);
  });
  await ready();
  details.open = false;
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(screen.queryByText('Human connection controls')).toBeNull());
  openNew();
  let finishOld!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finishOld = r;
      }),
  );
  fireEvent.submit(screen.getByLabelText('活動名稱').closest('form')!);
  await waitFor(() => expect(writes(calls)).toHaveLength(1));
  rerender(
    <CalendarWorkspace user={{ uid: user.uid, getIdToken: async () => 'new-session' } as User} />,
  );
  await ready();
  openNew();
  fetcher.mockImplementationOnce(() => new Promise<Response>(() => {}));
  const form = screen.getByLabelText('活動名稱').closest('form')!;
  fireEvent.submit(form);
  await waitFor(() => expect(writes(calls)).toHaveLength(2));
  await act(async () => finishOld(reply({ ...event, id: 'old-created' })));
  await act(async () => {
    fireEvent.submit(form);
  });
  expect(writes(calls)).toHaveLength(2);
});
