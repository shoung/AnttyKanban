import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import McpOAuthConsent, { McpConsentAccount } from '../components/McpOAuthConsent';
import McpOAuthConnections from '../components/McpOAuthConnections';

const reauthenticate = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class {},
  reauthenticateWithPopup: reauthenticate,
  onAuthStateChanged: listen,
  signInWithPopup: vi.fn(),
}));
vi.mock('../firebase', () => ({ auth: {}, googleProvider: {} }));
const user = {
  uid: 'alice',
  email: 'alice@example.com',
  getIdToken: vi.fn(async () => 'firebase-proof'),
} as unknown as User;
const id = 'r'.repeat(43);
const details = {
  clientName: 'My ChatGPT',
  clientId: 'chatgpt',
  redirectUri: 'https://chatgpt.com/callback',
  resource: 'https://antty.example/api/mcp',
  scopes: ['maps:read'],
  days: 7,
  expiresAt: Date.now() + 300000,
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  reauthenticate.mockReset();
  listen.mockReset();
  window.history.replaceState(null, '', '/');
});

test('loading consent never grants access; approve reauthenticates once and validates the callback', async () => {
  let finish!: (value: unknown) => void;
  reauthenticate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const navigate = vi.fn();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    response(
      init.method === 'POST'
        ? {
            redirectUri:
              'https://chatgpt.com/callback?code=synthetic&state=original&iss=https%3A%2F%2Fantty.example',
          }
        : details,
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<McpConsentAccount user={user} requestId={id} navigate={navigate} />);
  expect(await screen.findByText('My ChatGPT')).toBeTruthy();
  expect(reauthenticate).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const approve = screen.getByRole('button', { name: '同意授權' });
  fireEvent.click(approve);
  fireEvent.click(approve);
  expect(reauthenticate).toHaveBeenCalledTimes(1);
  await act(async () => finish({ user }));
  await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  expect(fetcher.mock.calls[1][1]).toEqual(
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ request: id, approve: true }),
    }),
  );
});
test('cancel does not reauthenticate; failed consent preserves a retry and never navigates', async () => {
  const navigate = vi.fn();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    response(
      init.method === 'POST' ? { error: 'invalid_grant' } : details,
      init.method === 'POST' ? 400 : 200,
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<McpConsentAccount user={user} requestId={id} navigate={navigate} />);
  fireEvent.click(await screen.findByRole('button', { name: '取消' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(reauthenticate).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(false);
});
test('account changes and unmounts invalidate delayed consent; returned external redirect must match preview', async () => {
  reauthenticate.mockResolvedValue({ user });
  const navigate = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) =>
      response(
        init.method === 'POST' ? { redirectUri: 'https://evil.example/?code=synthetic' } : details,
      ),
    ),
  );
  const view = render(<McpConsentAccount user={user} requestId={id} navigate={navigate} />);
  fireEvent.click(await screen.findByRole('button', { name: '同意授權' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(navigate).not.toHaveBeenCalled();
  view.unmount();
  let done!: (value: unknown) => void;
  reauthenticate.mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const next = render(<McpConsentAccount user={user} requestId={id} navigate={navigate} />);
  fireEvent.click(await screen.findByRole('button', { name: '同意授權' }));
  next.unmount();
  await act(async () => done({ user }));
  expect(navigate).not.toHaveBeenCalled();
});

test('valid fixed callback queries survive OAuth response serialization on approval and cancellation', async () => {
  for (const approve of [true, false]) {
    const navigate = vi.fn();
    reauthenticate.mockResolvedValue({ user });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        response(
          init.method === 'POST'
            ? {
                redirectUri: `https://chatgpt.com/callback?fixed=a+b&state=s&${approve ? 'code=test' : 'error=access_denied'}`,
              }
            : { ...details, redirectUri: 'https://chatgpt.com/callback?fixed=a%20b' },
        ),
      ),
    );
    const view = render(<McpConsentAccount user={user} requestId={id} navigate={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: approve ? '同意授權' : '取消' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    view.unmount();
  }
});

test('real consent parent replaces the old account before a delayed reauthentication can submit', async () => {
  let change!: (value: User | null) => void, finish!: (value: unknown) => void;
  listen.mockImplementation((_auth: unknown, callback: (value: User | null) => void) => {
    change = callback;
    return () => {};
  });
  reauthenticate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const fetcher = vi.fn(async () => response(details));
  vi.stubGlobal('fetch', fetcher);
  window.history.replaceState(null, '', `/mcp/consent?request=${id}`);
  render(<McpOAuthConsent />);
  await act(async () => change(user));
  fireEvent.click(await screen.findByRole('button', { name: '同意授權' }));
  await act(async () => change({ ...user, uid: 'bob', email: 'bob@example.com' } as User));
  expect(await screen.findByText(/bob@example.com/)).toBeTruthy();
  expect(screen.queryByText(/alice@example.com/)).toBeNull();
  await act(async () => finish({ user }));
  expect(
    fetcher.mock.calls.every(
      (call) => (call as unknown as [string, RequestInit])[1]?.method !== 'POST',
    ),
  ).toBe(true);
});

test('connection management survives StrictMode, retains paged revoke controls and clears on account switch', async () => {
  const grant = (id: string) => ({
    id: id.repeat(64),
    clientName: `Client ${id}`,
    scopes: ['maps:read'],
    expiresAt: Date.now() + 100000,
    enabled: true,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return response({
        endpoint: 'https://antty.example/api/mcp',
        grants: [grant(url.includes('after=') ? 'b' : 'a')],
        ...(url.includes('after=') ? {} : { nextAfter: 'a'.repeat(64) }),
      });
    }),
  );
  const view = render(
    <React.StrictMode>
      <McpOAuthConnections user={user} />
    </React.StrictMode>,
  );
  expect(await screen.findByText(/Client a/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '載入更多連線' }));
  expect(await screen.findByText(/Client b/)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '撤銷此連線' })).toHaveLength(2);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  view.rerender(<McpOAuthConnections user={{ ...user, uid: 'bob' } as User} />);
  expect(screen.queryByText(/Client a/)).toBeNull();
});
