import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { CalendarWorkspace } from '../components/CalendarWorkspace';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
test('real FullCalendar renders month, week and day views and opens editable all-day event', async () => {
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('action=status')
              ? { configured: true, status: 'connected', calendar: 'primary' }
              : {
                  events: [
                    {
                      id: 'one',
                      etag: '"v1"',
                      readOnly: false,
                      summary: 'Real grid event',
                      start: { date: '2026-11-05' },
                      end: { date: '2026-11-06' },
                    },
                  ],
                },
          ),
        ),
    ),
  );
  const { container } = render(
    <CalendarWorkspace
      user={{ uid: 'grid-user', getIdToken: async () => 'synthetic-token' } as User}
    />,
  );
  const event = await screen.findByText('Real grid event');
  expect(container.querySelector('.fc-dayGridMonth-view')).toBeTruthy();
  fireEvent.click(event);
  expect((screen.getByLabelText('開始日期') as HTMLInputElement).value).toBe('2026-11-05');
  fireEvent.click(screen.getByRole('button', { name: '關閉編輯' }));
  fireEvent.click(screen.getByRole('button', { name: '週' }));
  await waitFor(() => expect(container.querySelector('.fc-timeGridWeek-view')).toBeTruthy());
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '新增活動' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '日' }));
  await waitFor(() => expect(container.querySelector('.fc-timeGridDay-view')).toBeTruthy());
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '新增活動' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect(container.querySelector('iframe')).toBeNull();
});
