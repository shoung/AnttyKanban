import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import AgentAccess from '../components/AgentAccess';

const user = {
  uid: 'alice',
  email: 'alice@example.com',
  getIdToken: async () => 'firebase-a',
} as User;
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('Agent access defaults to read-only and never creates a token on load', async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(init);
      return response({ tokens: [], endpoint: 'https://antty.example/api/mcp' });
    }),
  );
  render(<AgentAccess user={user} />);
  await screen.findByText('https://antty.example/api/mcp');
  expect((screen.getByLabelText('讀取心智圖') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('修改心智圖') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('修改 Google 日曆') as HTMLInputElement).checked).toBe(false);
  expect(requests.every((request) => !request.method || request.method === 'GET')).toBe(true);
});

test('Disabled backend gives honest status and no token creation action', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ error: 'Agent access is not configured' }, 503)),
  );
  render(<AgentAccess user={user} />);
  await screen.findByText('Agent 存取尚未啟用');
  expect(screen.queryByRole('button', { name: '建立權杖' })).toBeNull();
});

test('Creating a token requires explicit confirmation and displays the secret only in this account', async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(init);
      return init.method === 'POST'
        ? response(
            {
              token: 'antty_secret_once',
              id: '1',
              scopes: ['maps:read'],
              expiresAt: Date.now() + 1000,
            },
            201,
          )
        : response({ tokens: [], endpoint: 'https://antty.example/api/mcp' });
    }),
  );
  const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { rerender } = render(<AgentAccess user={user} />);
  await screen.findByLabelText('權杖名稱');
  fireEvent.change(screen.getByLabelText('權杖名稱'), { target: { value: 'My agent' } });
  fireEvent.click(screen.getByRole('button', { name: '建立權杖' }));
  expect(requests.some((request) => request.method === 'POST')).toBe(false);
  confirmation.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '建立權杖' }));
  await screen.findByDisplayValue('antty_secret_once');
  fireEvent.click(screen.getByRole('button', { name: '複製權杖' }));
  await screen.findByText('無法自動複製，請手動選取權杖。');
  const request = requests.find((row) => row.method === 'POST')!;
  expect(JSON.parse(request.body as string)).toEqual({
    name: 'My agent',
    scopes: ['maps:read', 'boards:read', 'calendar:read'],
    days: 30,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  rerender(<AgentAccess user={{ ...user, uid: 'bob' } as User} />);
  expect(screen.queryByDisplayValue('antty_secret_once')).toBeNull();
  await waitFor(() => expect(screen.queryByText('https://antty.example/api/mcp')).toBeNull());
});

test('Token listing follows bounded page cursors without losing earlier rows', async () => {
  const token = (id: string, name: string) => ({
    id,
    name,
    scopes: ['maps:read'],
    createdAt: 1,
    expiresAt: 4_000_000_000_000,
    revoked: false,
  });
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return response(
        url.includes('?after=')
          ? {
              tokens: [token('b'.repeat(64), 'Second agent')],
              endpoint: 'https://antty.example/api/mcp',
            }
          : {
              tokens: [token('a'.repeat(64), 'First agent')],
              nextAfter: 'a'.repeat(64),
              endpoint: 'https://antty.example/api/mcp',
            },
      );
    }),
  );
  render(<AgentAccess user={user} />);
  await screen.findByText('First agent');
  fireEvent.click(screen.getByRole('button', { name: '載入更多權杖' }));
  await screen.findByText('Second agent');
  expect(screen.getByText('First agent')).toBeTruthy();
  expect(calls).toContain('/api/agent-tokens?after=' + 'a'.repeat(64));
  expect(screen.queryByRole('button', { name: '載入更多權杖' })).toBeNull();
});
