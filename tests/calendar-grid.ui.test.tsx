import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { CalendarWorkspace } from '../components/CalendarWorkspace';

vi.mock('../components/AgentCalendarAccess', () => ({
  AgentCalendarAccess: () => <div>Separate AI controls</div>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test.each(['new', 'existing'])(
  'connection checks retain the navigated week and unsaved %s draft',
  async (mode) => {
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    const connected = { configured: true, status: 'connected', calendar: 'primary' };
    let currentStatus = connected;
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    let deferStatus = false;
    let finish!: (r: Response) => void;
    const writes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (init.method !== 'GET') writes.push(init.method!);
        if (url.includes('action=status')) {
          if (deferStatus) {
            deferStatus = false;
            return new Promise<Response>((resolve) => {
              finish = resolve;
            });
          }
          return reply(currentStatus);
        }
        return reply({
          events: [
            {
              id: 'retained',
              etag: '"v1"',
              readOnly: false,
              summary: 'Retained event',
              start: { date: '2026-11-12' },
              end: { date: '2026-11-13' },
            },
          ],
        });
      }),
    );
    const { container } = render(
      <CalendarWorkspace
        user={{ uid: 'retained-user', getIdToken: async () => 'synthetic' } as User}
      />,
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '新增活動' }) as HTMLButtonElement).matches(
          ':disabled',
        ),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '週' }));
    fireEvent.click(screen.getByRole('button', { name: '下個' }));
    await screen.findByText('Retained event');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '新增活動' }) as HTMLButtonElement).matches(
          ':disabled',
        ),
      ).toBe(false),
    );
    if (mode === 'new') fireEvent.click(screen.getByRole('button', { name: '新增活動' }));
    else fireEvent.click(screen.getByText('Retained event'));
    fireEvent.change(screen.getByLabelText('活動名稱'), { target: { value: 'My unsaved title' } });
    fireEvent.change(screen.getByLabelText('說明'), { target: { value: 'My unsaved notes' } });
    const titleInput = screen.getByLabelText('活動名稱');
    const view = container.querySelector('.fc-timeGridWeek-view');
    const heading = container.querySelector('.fc-toolbar-title')!.textContent;
    function expectRetained() {
      expect(container.querySelector('.fc-timeGridWeek-view')).toBe(view);
      expect(container.querySelector('.fc-toolbar-title')?.textContent).toBe(heading);
      expect(screen.getByLabelText('活動名稱')).toBe(titleInput);
      expect((titleInput as HTMLInputElement).value).toBe('My unsaved title');
      expect((screen.getByLabelText('說明') as HTMLTextAreaElement).value).toBe('My unsaved notes');
    }
    deferStatus = true;
    const details = screen.getByText('連線設定').closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expectRetained();
    expect(
      (screen.getByRole('button', { name: '儲存活動' }) as HTMLButtonElement).matches(':disabled'),
    ).toBe(true);
    await act(async () => finish(reply(connected)));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '儲存活動' }) as HTMLButtonElement).matches(
          ':disabled',
        ),
      ).toBe(false),
    );
    expectRetained();

    // A failed readonly recheck preserves the draft but cannot re-enable writes.
    deferStatus = true;
    const previousFinish = finish;
    fireEvent.click(screen.getByRole('button', { name: '重新整理 API 連線' }));
    await waitFor(() => expect(finish).not.toBe(previousFinish));
    expectRetained();
    await act(async () => finish(reply({ error: 'GOOGLE_UNAVAILABLE' }, 502)));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expectRetained();
    expect(
      (screen.getByRole('button', { name: '儲存活動' }) as HTMLButtonElement).matches(':disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重新整理 API 連線' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '儲存活動' }) as HTMLButtonElement).matches(
          ':disabled',
        ),
      ).toBe(false),
    );
    expectRetained();
    expect(writes).toEqual([]);

    // Closing the panel during a check must not leave the workspace permanently blocked.
    deferStatus = true;
    const lastFinish = finish;
    fireEvent.click(screen.getByRole('button', { name: '重新整理 API 連線' }));
    await waitFor(() => expect(finish).not.toBe(lastFinish));
    const abandonedCheck = finish;
    details.open = false;
    fireEvent(details, new Event('toggle'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '重新整理 API 連線' })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '儲存活動' }) as HTMLButtonElement).matches(
          ':disabled',
        ),
      ).toBe(false),
    );
    await act(async () => abandonedCheck(reply({ ...connected, status: 'disconnected' })));
    expectRetained();

    // A confirmed lost grant clears event data and blocks writes, while preserving this UID's draft/view.
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重新整理 API 連線' }).matches(':disabled')).toBe(
        false,
      ),
    );
    currentStatus = { ...connected, status: 'disconnected' };
    fireEvent.click(screen.getByRole('button', { name: '重新整理 API 連線' }));
    await screen.findByText('請先連接個人日曆');
    expectRetained();
    expect(
      (screen.getByRole('button', { name: '儲存活動' }) as HTMLButtonElement).matches(':disabled'),
    ).toBe(true);
    expect(container.querySelector('.fc-event')).toBeNull();
    currentStatus = connected;
    fireEvent.click(screen.getByRole('button', { name: '重新整理 API 連線' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '儲存活動' }) as HTMLButtonElement).matches(
          ':disabled',
        ),
      ).toBe(false),
    );
    expectRetained();
    expect(writes).toEqual([]);
  },
);
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
    expect(
      (screen.getByRole('button', { name: '新增活動' }) as HTMLButtonElement).matches(':disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '日' }));
  await waitFor(() => expect(container.querySelector('.fc-timeGridDay-view')).toBeTruthy());
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '新增活動' }) as HTMLButtonElement).matches(':disabled'),
    ).toBe(false),
  );
  expect(container.querySelector('iframe')).toBeNull();
});
