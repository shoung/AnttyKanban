import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { AgentCalendarAccess } from '../components/AgentCalendarAccess';

const user = { uid: 'user-a', email: 'a@example.com', getIdToken: async () => 'token-a' } as User;
const status = (value: string) => ({
  configured: value !== 'not_configured',
  status: value,
  calendar: 'primary',
});
function reply(data: unknown, code = 200) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function navigation() {
  const assign = vi.fn();
  const original = window;
  vi.stubGlobal(
    'window',
    new Proxy(original, {
      get(target, key) {
        if (key === 'location') return { href: original.location.href, assign };
        return Reflect.get(target, key);
      },
    }),
  );
  return assign;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

test('missing agent config fails closed without affecting manual Calendar', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply(status('not_configured'))),
  );
  render(<AgentCalendarAccess user={user} />);
  expect(await screen.findByText('AI 日曆尚未啟用')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '授權 AI 使用日曆' })).toBeNull();
  expect(screen.getByText(/不影響手動日曆與 Google 登入/)).toBeTruthy();
});

test('connect is explicit, authenticated, same-origin and redirects only after click', async () => {
  const assign = navigation();
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=agent-client';
  const fetcher = vi.fn<(path: string, options?: RequestInit) => Promise<Response>>(async (path) =>
    reply(path.includes('connect') ? { authorizationUrl: url } : status('disconnected')),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<AgentCalendarAccess user={user} />);
  const button = await screen.findByRole('button', { name: '授權 AI 使用日曆' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(assign).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(assign).toHaveBeenCalledWith(url));
  expect(fetcher.mock.calls[1]).toEqual([
    '/api/calendar-agent?action=connect',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: '{}',
      headers: { Authorization: 'Bearer token-a', 'Content-Type': 'application/json' },
    }),
  ]);
  expect(fetcher.mock.calls.every(([path]) => !path.includes('events'))).toBe(true);
});

test('disconnect cancel never mutates and confirmed disconnect acknowledges project revocation', async () => {
  let disconnected = false;
  const fetcher = vi.fn<(path: string, options?: RequestInit) => Promise<Response>>(
    async (path) => {
      if (path.includes('action=disconnect')) {
        disconnected = true;
        return reply({ status: 'disconnected' });
      }
      return reply(status(disconnected ? 'disconnected' : 'connected'));
    },
  );
  vi.stubGlobal('fetch', fetcher);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<AgentCalendarAccess user={user} />);
  const button = await screen.findByRole('button', { name: '撤銷 AI 日曆授權' });
  fireEvent.click(button);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('同一 Google Cloud 專案'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  confirm.mockReturnValue(true);
  fireEvent.click(button);
  await screen.findByRole('button', { name: '授權 AI 使用日曆' });
  expect(fetcher.mock.calls.find(([path]) => path.includes('action=disconnect'))).toEqual([
    '/api/calendar-agent?action=disconnect',
    expect.objectContaining({ method: 'POST', body: '{"confirmProjectRevocation":true}' }),
  ]);
});

test('repeated connect clicks issue one request while pending', async () => {
  const pending = deferred<Response>();
  const fetcher = vi.fn((path: string) =>
    path.includes('action=connect')
      ? pending.promise
      : Promise.resolve(reply(status('disconnected'))),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<AgentCalendarAccess user={user} />);
  const button = await screen.findByRole('button', { name: '授權 AI 使用日曆' });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect((button as HTMLButtonElement).disabled).toBe(true);
});

test('account change aborts pending authorization and ignores a late redirect', async () => {
  const assign = navigation();
  const pending = deferred<Response>();
  const fetcher = vi.fn<(path: string, options?: RequestInit) => Promise<Response>>((path) =>
    path.includes('action=connect')
      ? pending.promise
      : Promise.resolve(reply(status('disconnected'))),
  );
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<AgentCalendarAccess user={user} />);
  fireEvent.click(await screen.findByRole('button', { name: '授權 AI 使用日曆' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const signal = fetcher.mock.calls[1][1]?.signal;
  rerender(
    <AgentCalendarAccess
      user={{ ...user, uid: 'user-b', getIdToken: async () => 'token-b' } as User}
    />,
  );
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    pending.resolve(reply({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth' })),
  );
  expect(assign).not.toHaveBeenCalled();
  await screen.findByRole('button', { name: '授權 AI 使用日曆' });
});

test('account change while token is pending prevents any old-account fetch', async () => {
  const token = deferred<string>();
  const fetcher = vi.fn(async () => reply(status('not_configured')));
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(
    <AgentCalendarAccess user={{ ...user, getIdToken: () => token.promise } as User} />,
  );
  rerender(
    <AgentCalendarAccess
      user={{ ...user, uid: 'user-b', getIdToken: async () => 'token-b' } as User}
    />,
  );
  await screen.findByText('AI 日曆尚未啟用');
  await act(async () => token.resolve('token-a'));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
  'https://evil.example/auth',
  'https://accounts.google.com.evil.example/auth',
  'javascript:alert(1)',
  'https://user:password@accounts.google.com/o/oauth2/v2/auth',
])('rejects unsafe authorization URL %s', async (authorizationUrl) => {
  const assign = navigation();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      reply(path.includes('action=connect') ? { authorizationUrl } : status('disconnected')),
    ),
  );
  render(<AgentCalendarAccess user={user} />);
  fireEvent.click(await screen.findByRole('button', { name: '授權 AI 使用日曆' }));
  await screen.findByRole('alert');
  expect(assign).not.toHaveBeenCalled();
});

test('agent callback is consumed without touching manual Calendar callback or other parameters', async () => {
  window.history.replaceState(
    null,
    '',
    '/?calendarAgent=OAUTH_CANCELLED&calendar=connected&keep=yes#calendar',
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply(status('disconnected'))),
  );
  render(<AgentCalendarAccess user={user} />);
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('已取消'),
  );
  expect(window.location.search).toBe('?calendar=connected&keep=yes');
  expect(window.location.hash).toBe('#calendar');
});

test('configuration mismatch requires operator repair and cannot overwrite or revoke the grant', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply(status('configuration_changed'))),
  );
  render(<AgentCalendarAccess user={user} />);
  expect(await screen.findByText(/請管理員修復原有 AI 授權設定/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '授權 AI 使用日曆' })).toBeNull();
  expect(screen.queryByRole('button', { name: '撤銷 AI 日曆授權' })).toBeNull();
});

test('configuration mismatch discovered on connect disables further grant mutations', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path.includes('action=connect')
        ? reply({ error: 'CALENDAR_GRANT_MISMATCH' }, 409)
        : reply(status('disconnected')),
    ),
  );
  render(<AgentCalendarAccess user={user} />);
  fireEvent.click(await screen.findByRole('button', { name: '授權 AI 使用日曆' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: '授權 AI 使用日曆' })).toBeNull();
});

test('late old-account status cannot replace the new account status', async () => {
  const old = deferred<Response>();
  const fetcher = vi.fn((_path: string, options?: RequestInit) =>
    (options?.headers as Record<string, string>).Authorization === 'Bearer token-a'
      ? old.promise
      : Promise.resolve(reply(status('not_configured'))),
  );
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<AgentCalendarAccess user={user} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  rerender(
    <AgentCalendarAccess
      user={{ ...user, uid: 'user-b', getIdToken: async () => 'token-b' } as User}
    />,
  );
  await screen.findByText('AI 日曆尚未啟用');
  await act(async () => old.resolve(reply(status('connected'))));
  expect(screen.queryByRole('button', { name: '撤銷 AI 日曆授權' })).toBeNull();
  expect(screen.getByText('AI 日曆尚未啟用')).toBeTruthy();
});

test('StrictMode cleanup prevents duplicate token-pending status requests', async () => {
  const fetcher = vi.fn(async () => reply(status('disconnected')));
  vi.stubGlobal('fetch', fetcher);
  render(
    <React.StrictMode>
      <AgentCalendarAccess user={user} />
    </React.StrictMode>,
  );
  await screen.findByRole('button', { name: '授權 AI 使用日曆' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
