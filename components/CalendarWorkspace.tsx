import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import { CalendarDays, ExternalLink } from 'lucide-react';
import { Button } from './Button';
import { AgentCalendarAccess } from './AgentCalendarAccess';
import { ManualCalendarConnection } from './ManualCalendarConnection';
import { validateCalendarEmbedUrl } from '../services/calendarEmbed';

const storageKey = (uid: string) => `antty:calendar-embed:${uid}`;
const storageError = '瀏覽器無法儲存或讀取設定。請檢查網站儲存權限，或直接開啟 Google 日曆。';
const invalidUrlError = '請貼上有效的 Google 日曆官方嵌入網址，不要貼上 HTML、登入網址或憑證。';
function readEmbed(uid: string): { url: string; error: string } {
  try {
    const saved = window.localStorage.getItem(storageKey(uid));
    if (!saved) return { url: '', error: '' };
    const validated = validateCalendarEmbedUrl(saved);
    return validated.ok ? { url: validated.url, error: '' } : { url: '', error: invalidUrlError };
  } catch {
    return { url: '', error: storageError };
  }
}

/** Remount before displaying a different Firebase account's browser-local settings. */
export function CalendarWorkspace({ user }: { user: User }) {
  return <CalendarAccountWorkspace key={user.uid} user={user} />;
}
function CalendarAccountWorkspace({ user }: { user: User }) {
  const [initial] = useState(() => readEmbed(user.uid));
  const [embedUrl, setEmbedUrl] = useState(initial.url);
  const [draft, setDraft] = useState(initial.url);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [connectionsOpen, setConnectionsOpen] = useState(() => {
    const params = new URL(window.location.href).searchParams;
    return params.has('calendar') || params.has('calendarAgent');
  });

  function save(event: React.FormEvent) {
    event.preventDefault();
    setNotice('');
    const validated = validateCalendarEmbedUrl(draft);
    if (!validated.ok) {
      setError(invalidUrlError);
      return;
    }
    try {
      window.localStorage.setItem(storageKey(user.uid), validated.url);
      setEmbedUrl(validated.url);
      setDraft(validated.url);
      setError('');
      setNotice('已儲存此帳號在這個瀏覽器的顯示設定。這不代表 Google 已登入或日曆已載入。');
    } catch {
      setError(storageError);
    }
  }
  function clear() {
    // Hide immediately even if persistent storage is unavailable.
    setEmbedUrl('');
    setDraft('');
    setNotice('');
    try {
      window.localStorage.removeItem(storageKey(user.uid));
      setError('');
      setNotice('已清除此帳號在這個瀏覽器的日曆顯示設定。');
    } catch {
      setError(
        '已停止顯示，但瀏覽器未能清除儲存的網址；重新載入後可能再次出現。請清除本站儲存資料。',
      );
    }
  }
  const linkClass =
    'inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-blue-700 dark:border-slate-700 dark:bg-slate-900 dark:text-blue-300';
  return (
    <section
      className="h-full overflow-y-auto bg-slate-50 p-4 dark:bg-slate-950 md:p-6"
      aria-label="Google 日曆工作區"
    >
      <div className="w-full space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900 dark:text-white">
              <CalendarDays size={24} />
              Google 日曆
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              使用 Google 官方日曆檢視，新增與編輯活動請到 Google 日曆。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              className={linkClass}
              href="https://calendar.google.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              開啟 Google 日曆
              <ExternalLink size={16} />
            </a>
            <a
              className={linkClass}
              href="https://calendar.google.com/calendar/r/eventedit?action=TEMPLATE"
              target="_blank"
              rel="noopener noreferrer"
            >
              在 Google 新增活動
              <ExternalLink size={16} />
            </a>
          </div>
        </header>
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
          Google 瀏覽器登入、目前選用的帳號與 Cookie，和 Antty 的登入及日曆 OAuth
          授權各自獨立。私人日曆不需要設為公開；能否顯示取決於 Google
          的存取權限與瀏覽器設定。封鎖第三方 Cookie
          可能使嵌入畫面無法登入。若畫面空白或要求登入，請按「開啟 Google
          日曆」。新增活動連結只開啟草稿，不會自動建立活動。
        </p>
        {embedUrl ? (
          <iframe
            key={embedUrl}
            title="Google 官方日曆"
            src={embedUrl}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            className="block w-full rounded-2xl border border-slate-200 bg-white dark:border-slate-800"
            style={{ height: '70vh', minHeight: '480px' }}
          />
        ) : (
          <div className="flex min-h-[50vh] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
            <CalendarDays className="mb-4 text-blue-500" size={40} />
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              尚未設定日曆檢視
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
              在下方「日曆顯示設定」貼上 Google 官方嵌入網址，或直接開啟 Google 日曆。此檢視不需要
              Antty 的日曆 API 連線。
            </p>
          </div>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-200"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-xl bg-blue-50 p-4 text-sm text-blue-700 dark:bg-blue-950 dark:text-blue-200"
          >
            {notice}
          </p>
        )}
        <details className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <summary className="cursor-pointer font-semibold text-slate-900 dark:text-white">
            日曆顯示設定
          </summary>
          <form onSubmit={save} className="mt-4 space-y-3">
            <p className="text-sm leading-6 text-slate-500">
              在 Google 日曆的「設定 → 我的日曆設定 → 整合日曆 → 嵌入程式碼」取得 iframe 的 src
              網址。只貼上 https://calendar.google.com/calendar/embed 開頭的網址，不要貼整段
              HTML。請勿貼上私人 iCal 網址、OAuth token 或密碼。
            </p>
            <p className="text-sm leading-6 text-slate-500">
              網址只儲存在此瀏覽器，依目前 Antty 帳號分開，不會上傳至 Antty 伺服器。嵌入時瀏覽器會向
              Google
              請求該網址。這不是共用裝置上的保密機制：同一瀏覽器的其他使用者可能讀取儲存資料，而且
              Google 可能仍登入另一個帳號。共用瀏覽器使用完畢後請清除設定，並檢查 Google 登入帳號。
            </p>
            <label className="block text-sm text-slate-700 dark:text-slate-200">
              Google 日曆嵌入網址
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">儲存顯示設定</Button>
              <Button type="button" variant="secondary" onClick={clear}>
                清除顯示設定
              </Button>
            </div>
          </form>
        </details>
        <details
          open={connectionsOpen}
          onToggle={(event) => setConnectionsOpen(event.currentTarget.open)}
          className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
        >
          <summary className="cursor-pointer font-semibold text-slate-900 dark:text-white">
            日曆連線設定
          </summary>
          <p className="my-4 text-sm text-slate-500">
            以下 API 授權與上方 Google 嵌入檢視分開管理，不會替嵌入畫面登入 Google。
          </p>
          {connectionsOpen && (
            <div className="space-y-4">
              <ManualCalendarConnection user={user} />
              <AgentCalendarAccess user={user} />
            </div>
          )}
        </details>
      </div>
    </section>
  );
}
export default CalendarWorkspace;
