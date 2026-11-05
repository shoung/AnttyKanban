import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { CalendarWorkspace } from '../components/CalendarWorkspace';

vi.mock('../components/ManualCalendarConnection', () => ({
  ManualCalendarConnection: () => <div>Manual connection controls</div>,
}));
vi.mock('../components/AgentCalendarAccess', () => ({
  AgentCalendarAccess: () => <div>Agent connection controls</div>,
}));
const user = {
  uid: 'user-a',
  email: 'a@example.com',
  getIdToken: vi.fn(async () => 'token-a'),
} as unknown as User;
const embed =
  'https://calendar.google.com/calendar/embed?ctz=Asia%2FTaipei&src=example%40example.com';
const key = (uid: string) => `antty:calendar-embed:${uid}`;
const frame = () => screen.queryByTitle('Google 官方日曆') as HTMLIFrameElement | null;
function save(value: string) {
  fireEvent.click(screen.getByText('日曆顯示設定'));
  fireEvent.change(screen.getByLabelText('Google 日曆嵌入網址'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '儲存顯示設定' }));
}
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('missing configuration offers Google fallback without API fetches or event editor', () => {
  render(<CalendarWorkspace user={user} />);
  expect(screen.getByText('尚未設定日曆檢視')).toBeTruthy();
  expect(frame()).toBeNull();
  expect(screen.queryByLabelText('活動名稱')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(user.getIdToken).not.toHaveBeenCalled();
});

test('Google links safely open full calendar and only a new-event draft', () => {
  render(<CalendarWorkspace user={user} />);
  for (const [label, href] of [
    ['開啟 Google 日曆', 'https://calendar.google.com/'],
    ['在 Google 新增活動', 'https://calendar.google.com/calendar/r/eventedit?action=TEMPLATE'],
  ]) {
    const link = screen.getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(href);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  }
  expect(screen.getByText(/新增活動連結只開啟草稿/)).toBeTruthy();
});

test('explicit save validates a URL, persists only current UID, and renders protected full-width iframe', () => {
  render(<CalendarWorkspace user={user} />);
  fireEvent.change(screen.getByLabelText('Google 日曆嵌入網址'), { target: { value: embed } });
  expect(frame()).toBeNull();
  expect(localStorage.getItem(key(user.uid))).toBeNull();
  fireEvent.click(screen.getByText('日曆顯示設定'));
  fireEvent.click(screen.getByRole('button', { name: '儲存顯示設定' }));
  expect(frame()?.src).toBe(embed);
  expect(localStorage.getItem(key(user.uid))).toBe(embed);
  expect(localStorage.length).toBe(1);
  expect(frame()?.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame()?.getAttribute('sandbox')).toBe(
    'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  );
  expect(frame()?.className).toContain('w-full');
  expect(frame()?.style.height).toBe('70vh');
  fireEvent.load(frame()!);
  expect(screen.queryByText('Google 日曆已連結。')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test('account switching immediately removes previous iframe and draft, then loads only new UID setting', () => {
  localStorage.setItem(key('user-a'), embed);
  const { rerender } = render(<CalendarWorkspace user={user} />);
  const previous = frame();
  expect(previous?.src).toBe(embed);
  rerender(<CalendarWorkspace user={{ ...user, uid: 'user-b' } as User} />);
  expect(frame()).toBeNull();
  expect(previous?.isConnected).toBe(false);
  expect((screen.getByLabelText('Google 日曆嵌入網址') as HTMLInputElement).value).toBe('');
  const other = 'https://calendar.google.com/calendar/embed?src=other%40example.com';
  save(other);
  expect(localStorage.getItem(key('user-a'))).toBe(embed);
  expect(localStorage.getItem(key('user-b'))).toBe(other);
  rerender(<CalendarWorkspace user={user} />);
  expect(frame()?.src).toBe(embed);
});

test('explains shared-browser storage limits and independent Google login without requiring public calendar', () => {
  render(<CalendarWorkspace user={user} />);
  expect(screen.getByText(/這不是共用裝置上的保密機制/)).toBeTruthy();
  expect(screen.getByText(/私人日曆不需要設為公開/)).toBeTruthy();
  expect(screen.getByText(/和 Antty 的登入及日曆 OAuth 授權各自獨立/)).toBeTruthy();
});

test.each([
  'https://attacker.example/calendar/embed?src=secret',
  'https://calendar.google.com.attacker.example/calendar/embed',
  '<iframe src="https://calendar.google.com/calendar/embed"></iframe>',
  'javascript:alert(1)',
  'https://calendar.google.com/calendar/embed?access_token=secret',
])('rejects unsafe user input without loading, persisting, or echoing it in error: %s', (value) => {
  render(<CalendarWorkspace user={user} />);
  save(value);
  expect(frame()).toBeNull();
  expect(localStorage.length).toBe(0);
  expect(screen.getByRole('alert').textContent).not.toContain(value);
  expect(screen.getByRole('alert').textContent).toContain('有效的 Google 日曆官方嵌入網址');
  expect(fetch).not.toHaveBeenCalled();
});

test('validates persisted values before display and does not echo invalid stored content', () => {
  localStorage.setItem(key(user.uid), 'https://attacker.example/private-value');
  render(<CalendarWorkspace user={user} />);
  expect(frame()).toBeNull();
  expect(screen.getByRole('alert').textContent).not.toContain('private-value');
  expect((screen.getByLabelText('Google 日曆嵌入網址') as HTMLInputElement).value).toBe('');
});

test('save failure retains current iframe and reports storage failure without claiming saved', () => {
  localStorage.setItem(key(user.uid), embed);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError');
  });
  render(<CalendarWorkspace user={user} />);
  save('https://calendar.google.com/calendar/embed?src=other%40example.com');
  expect(frame()?.src).toBe(embed);
  expect(screen.getByRole('alert').textContent).toContain('無法儲存或讀取');
  expect(screen.queryByRole('status')).toBeNull();
});

test('read failure safely falls back to Google links', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('SecurityError');
  });
  render(<CalendarWorkspace user={user} />);
  expect(frame()).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('無法儲存或讀取');
  expect(screen.getByRole('link', { name: '開啟 Google 日曆' })).toBeTruthy();
});

test('explicit clear removes only current UID setting and unmounts iframe', () => {
  localStorage.setItem(key(user.uid), embed);
  localStorage.setItem(key('user-b'), embed);
  render(<CalendarWorkspace user={user} />);
  fireEvent.click(screen.getByText('日曆顯示設定'));
  fireEvent.click(screen.getByRole('button', { name: '清除顯示設定' }));
  expect(frame()).toBeNull();
  expect(localStorage.getItem(key(user.uid))).toBeNull();
  expect(localStorage.getItem(key('user-b'))).toBe(embed);
  expect(fetch).not.toHaveBeenCalled();
});

test('failed clear still hides iframe and warns that persisted data remains', () => {
  localStorage.setItem(key(user.uid), embed);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('SecurityError');
  });
  render(<CalendarWorkspace user={user} />);
  fireEvent.click(screen.getByText('日曆顯示設定'));
  fireEvent.click(screen.getByRole('button', { name: '清除顯示設定' }));
  expect(frame()).toBeNull();
  expect(localStorage.getItem(key(user.uid))).toBe(embed);
  expect(screen.getByRole('alert').textContent).toContain('重新載入後可能再次出現');
});

test('manual and agent connection controls remain separate in collapsible settings', async () => {
  render(<CalendarWorkspace user={user} />);
  expect(screen.queryByText('Manual connection controls')).toBeNull();
  const details = screen.getByText('日曆連線設定').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(screen.getByText('Manual connection controls')).toBeTruthy());
  expect(screen.getByText('Agent connection controls')).toBeTruthy();
  expect(screen.queryByLabelText('活動名稱')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['calendar', 'calendarAgent'])(
  'OAuth callback %s opens connection settings for status feedback',
  (marker) => {
    window.history.replaceState({}, '', `/?${marker}=connected`);
    render(<CalendarWorkspace user={user} />);
    expect(screen.getByText('日曆連線設定').closest('details')?.open).toBe(true);
    expect(screen.getByText('Manual connection controls')).toBeTruthy();
    expect(screen.getByText('Agent connection controls')).toBeTruthy();
  },
);
