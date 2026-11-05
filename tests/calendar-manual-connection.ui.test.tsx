import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { ManualCalendarConnection } from '../components/ManualCalendarConnection';
const user = { uid: 'user-a', getIdToken: async () => 'synthetic-token' } as User;
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

test('manual connection status never reads or mutates events and explains separate AI consent', async () => {
  const fetcher = vi.fn(async () =>
    reply({ configured: true, status: 'connected', calendar: 'primary' }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<ManualCalendarConnection user={user} />);
  expect(await screen.findByText('人工 API 已連接。')).toBeTruthy();
  expect(screen.getByText(/與 AI 日曆授權分開/)).toBeTruthy();
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledWith('/api/calendar?action=status', expect.any(Object));
});

test('manual disconnect requires confirmation and does not revoke when cancelled', async () => {
  const fetcher = vi.fn(async () =>
    reply({ configured: true, status: 'connected', calendar: 'primary' }),
  );
  vi.stubGlobal('fetch', fetcher);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<ManualCalendarConnection user={user} />);
  fireEvent.click(await screen.findByRole('button', { name: '撤銷人工 API 授權' }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('同一 Google Cloud 專案'));
  expect(fetcher.mock.calls).toHaveLength(1);
});

test('manual callback consumes only its own marker and preserves other workflow marker', async () => {
  window.history.replaceState({}, '', '/?calendar=connected&calendarAgent=OAUTH_CANCELLED');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ configured: true, status: 'connected', calendar: 'primary' })),
  );
  render(<ManualCalendarConnection user={user} />);
  expect(await screen.findByText(/人工日曆 API 已連接，可在 Antty 檢視與操作/)).toBeTruthy();
  expect(window.location.search).toBe('?calendarAgent=OAUTH_CANCELLED');
});

test('manual configuration drift disables connect and never echoes provider errors', async () => {
  let count = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ++count === 1
        ? reply({ configured: true, status: 'disconnected', calendar: 'primary' })
        : reply({ error: 'CALENDAR_GRANT_MISMATCH', private: 'do-not-render' }, 409),
    ),
  );
  render(<ManualCalendarConnection user={user} />);
  fireEvent.click(await screen.findByRole('button', { name: '連接人工 API' }));
  expect(await screen.findByText(/授權設定已變更，請管理員修復原設定/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '連接人工 API' })).toBeNull();
  expect(screen.queryByText('do-not-render')).toBeNull();
});

test('switching users aborts old token wait before any old request is sent', async () => {
  let resolve!: (token: string) => void;
  const old = {
    uid: 'old',
    getIdToken: () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  } as User;
  const fetcher = vi.fn(async () =>
    reply({ configured: false, status: 'not_configured', calendar: 'primary' }),
  );
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<ManualCalendarConnection user={old} />);
  rerender(<ManualCalendarConnection user={user} />);
  await screen.findByText('人工 API 尚未設定完成。');
  resolve('old-private-token');
  await waitFor(() => expect(fetcher.mock.calls).toHaveLength(1));
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain('old-private-token');
});

test('same UID user replacement locks mutations while the replacement status loads', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply({ configured: true, status: 'connected', calendar: 'primary' }))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetcher);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { rerender } = render(<ManualCalendarConnection user={user} />);
  await screen.findByText('人工 API 已連接。');
  rerender(
    <ManualCalendarConnection
      user={{ uid: user.uid, getIdToken: async () => 'replacement-token' } as User}
    />,
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: '撤銷人工 API 授權' }));
  expect(confirm).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(2);
  finish(reply({ configured: true, status: 'connected', calendar: 'primary' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '撤銷人工 API 授權' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
});
