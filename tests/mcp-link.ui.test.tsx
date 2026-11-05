import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import McpIdentityLink from '../components/McpIdentityLink';

const reauthenticate = vi.hoisted(() => vi.fn());
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class {},
  reauthenticateWithPopup: reauthenticate,
}));
const user = {
  uid: 'alice',
  email: 'alice@example.com',
  getIdToken: vi.fn(async () => 'fresh-firebase'),
} as unknown as User;
const payload = {
  configured: true,
  authorizationOrigin: 'https://personal.auth0.com',
  endpoint: 'https://antty.example/api/mcp',
  scopes: ['maps:read'],
  days: 7,
  links: [],
};
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const authUrl = 'https://personal.auth0.com/authorize?state=synthetic';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  reauthenticate.mockReset();
  window.history.replaceState(null, '', '/');
});
function navigation() {
  const assign = vi.fn();
  const original = window;
  vi.stubGlobal(
    'window',
    new Proxy(original, {
      get(target, key) {
        return key === 'location'
          ? { href: original.location.href, assign }
          : Reflect.get(target, key);
      },
    }),
  );
  return assign;
}
test('OAuth linking fails closed with a precise setup message and never reauthenticates on load', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ error: 'unconfigured' }, 503)),
  );
  render(<McpIdentityLink user={user} />);
  expect(await screen.findByText(/尚未設定 Auth0/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '綁定 ChatGPT 身分' })).toBeNull();
  expect(reauthenticate).not.toHaveBeenCalled();
});

test('binding pages preserve all loaded revocation controls', async () => {
  const row = (id: string) => ({
    id: id.repeat(64),
    subject: `auth0|${id}`,
    expiresAt: Date.now() + 10000,
    enabled: true,
  });
  const fetcher = vi.fn(async (url: string) =>
    reply(
      url.includes('after=')
        ? { ...payload, links: [row('b')] }
        : { ...payload, links: [row('a')], nextAfter: 'a'.repeat(64) },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<McpIdentityLink user={user} />);
  fireEvent.click(await screen.findByRole('button', { name: '載入更多身分綁定' }));
  expect(await screen.findByText('auth0|b')).toBeTruthy();
  expect(screen.getByText('auth0|a')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '撤銷此身分綁定' })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: '載入更多身分綁定' })).toBeNull();
  expect(fetcher.mock.calls[1][0]).toBe(`/api/mcp-link?after=${'a'.repeat(64)}`);
});
test('link requires consent and recent Firebase reauthentication, rejects duplicate submits, and stays read-only', async () => {
  const assign = navigation();
  let done!: (value: { user: User }) => void;
  reauthenticate.mockReturnValue(
    new Promise((resolve) => {
      done = resolve;
    }),
  );
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    reply(init.method === 'POST' ? { authorizationUrl: authUrl } : payload),
  );
  vi.stubGlobal('fetch', fetcher);
  const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<McpIdentityLink user={user} />);
  const button = await screen.findByRole('button', { name: '綁定 ChatGPT 身分' });
  fireEvent.click(button);
  expect(reauthenticate).not.toHaveBeenCalled();
  confirmation.mockReturnValue(true);
  fireEvent.click(button);
  fireEvent.click(button);
  expect(reauthenticate).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => done({ user }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith(authUrl));
  expect(fetcher.mock.calls[1][1]).toEqual(
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ consent: true }),
      headers: { Authorization: 'Bearer fresh-firebase', 'Content-Type': 'application/json' },
    }),
  );
  expect(user.getIdToken).toHaveBeenCalledWith(true);
  expect(confirmation.mock.calls.at(-1)?.[0]).toContain('7 天');
  expect(confirmation.mock.calls.at(-1)?.[0]).toContain('僅能讀取心智圖');
});
test('account switch cancels an outstanding reauthentication before any linking mutation or redirect', async () => {
  const assign = navigation();
  let done!: (value: { user: User }) => void;
  reauthenticate.mockReturnValue(
    new Promise((resolve) => {
      done = resolve;
    }),
  );
  const fetcher = vi.fn(async () => reply(payload));
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { rerender } = render(<McpIdentityLink user={user} />);
  fireEvent.click(await screen.findByRole('button', { name: '綁定 ChatGPT 身分' }));
  const bob = { ...user, uid: 'bob' } as User;
  rerender(<McpIdentityLink user={bob} />);
  await act(async () => done({ user }));
  expect(
    fetcher.mock.calls.every((call: unknown[]) => (call[1] as RequestInit).method !== 'POST'),
  ).toBe(true);
  expect(assign).not.toHaveBeenCalled();
});
test('revocation is explicit and owner-authenticated; unsafe provider redirects are rejected', async () => {
  const assign = navigation();
  reauthenticate.mockResolvedValue({ user });
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    reply(
      init.method === 'POST'
        ? { authorizationUrl: 'https://attacker.example/authorize' }
        : init.method === 'DELETE'
          ? { revoked: true }
          : {
              ...payload,
              links: [
                {
                  id: 'a'.repeat(64),
                  subject: 'auth0|alice',
                  enabled: true,
                  expiresAt: Date.now() + 10000,
                },
              ],
            },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<McpIdentityLink user={user} />);
  fireEvent.click(await screen.findByRole('button', { name: '撤銷此身分綁定' }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '撤銷此身分綁定' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some((call) => call[1].method === 'DELETE')).toBe(true),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '綁定 ChatGPT 身分' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '綁定 ChatGPT 身分' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(assign).not.toHaveBeenCalled();
});
