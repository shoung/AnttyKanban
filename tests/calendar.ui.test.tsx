import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { CalendarWorkspace } from '../components/CalendarWorkspace';

const user = { uid: 'user-a', email: 'a@example.com', getIdToken: async () => 'token-a' } as User;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('missing backend config preserves base login and offers no fake connect', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ configured: false, status: 'not_configured', calendar: 'primary' })),
  );
  render(<CalendarWorkspace user={user} />);
  expect(await screen.findByText('日曆尚未啟用')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '連結 Google 日曆' })).toBeNull();
  expect(screen.getByText(/不影響原本的 Google 登入/)).toBeTruthy();
});

test('events from a previous user disappear immediately during account switch', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('status')
        ? reply({ configured: true, status: 'connected', calendar: 'primary' })
        : reply({
            events: [
              {
                id: 'event1',
                summary: 'Private A event',
                start: { dateTime: '2026-11-04T12:00:00Z' },
                end: { dateTime: '2026-11-04T13:00:00Z' },
                readOnly: true,
              },
            ],
          }),
    ),
  );
  const { rerender } = render(<CalendarWorkspace user={user} />);
  await screen.findByText('Private A event');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  rerender(
    <CalendarWorkspace
      user={{ ...user, uid: 'user-b', getIdToken: async () => 'token-b' } as User}
    />,
  );
  expect(screen.queryByText('Private A event')).toBeNull();
});

test('disconnect cancellation never sends a mutation', async () => {
  const fetcher = vi.fn(async (url: string) =>
    url.includes('status')
      ? reply({ configured: true, status: 'connected', calendar: 'primary' })
      : reply({ events: [] }),
  );
  vi.stubGlobal('fetch', fetcher);
  const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<CalendarWorkspace user={user} />);
  fireEvent.click(await screen.findByRole('button', { name: '斷開連結' }));
  expect(confirmation).toHaveBeenCalledWith(expect.stringContaining('同一 Google Cloud 專案'));
  expect(fetcher.mock.calls.some(([url]) => url.includes('disconnect'))).toBe(false);
});

test('creating a personal event sends only validated event fields and no user ID', async () => {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('status'))
      return reply({ configured: true, status: 'connected', calendar: 'primary' });
    if (options?.method === 'POST') return reply({ id: 'new' }, 201);
    return reply({ events: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<CalendarWorkspace user={user} />);
  await screen.findByLabelText('活動名稱');
  fireEvent.change(screen.getByLabelText('活動名稱'), { target: { value: 'Write song' } });
  fireEvent.change(screen.getByLabelText('開始時間'), { target: { value: '2026-11-04T12:00' } });
  fireEvent.change(screen.getByLabelText('結束時間'), { target: { value: '2026-11-04T13:00' } });
  fireEvent.click(screen.getByRole('button', { name: '新增活動' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true),
  );
  const [, request] = fetcher.mock.calls.find(([, options]) => options?.method === 'POST')!;
  const payload = JSON.parse(request!.body as string);
  expect(payload.summary).toBe('Write song');
  expect(Object.keys(payload).sort()).toEqual([
    'description',
    'end',
    'location',
    'start',
    'summary',
  ]);
  expect(request!.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer token-a' }));
});

test('edit and delete preserve the selected event ID and ETag', async () => {
  const event = {
    id: 'event-123',
    etag: '"revision-4"',
    summary: 'Original title',
    start: { dateTime: '2026-11-04T12:00:00Z' },
    end: { dateTime: '2026-11-04T13:00:00Z' },
    readOnly: false,
  };
  let savedEvent = { ...event };
  let deleted = false;
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('status'))
        return reply({ configured: true, status: 'connected', calendar: 'primary' });
      if (options?.method === 'PATCH') {
        const body = JSON.parse(options.body as string);
        writes.push({ method: 'PATCH', body });
        savedEvent = { ...savedEvent, ...body.event };
        return reply(savedEvent);
      }
      if (options?.method === 'DELETE') {
        writes.push({ method: 'DELETE', body: JSON.parse(options.body as string) });
        deleted = true;
        return reply({ deleted: true });
      }
      return reply({ events: deleted ? [] : [savedEvent] });
    }),
  );
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<CalendarWorkspace user={user} />);
  const edit = await screen.findByRole('button', { name: '編輯 Original title' });
  await waitFor(() => expect((edit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(edit);
  fireEvent.change(screen.getByLabelText('活動名稱'), { target: { value: 'Updated title' } });
  fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
  await screen.findByText('Updated title');
  expect(writes[0].body).toEqual(
    expect.objectContaining({ eventId: 'event-123', etag: '"revision-4"' }),
  );
  const remove = screen.getByRole('button', { name: '刪除 Updated title' });
  await waitFor(() => expect((remove as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(remove);
  await screen.findByText('活動已刪除。');
  expect(writes[1]).toEqual({
    method: 'DELETE',
    body: { eventId: 'event-123', etag: '"revision-4"' },
  });
  expect(screen.queryByText('Updated title')).toBeNull();
});
