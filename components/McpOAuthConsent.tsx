import React, { useEffect, useRef, useState } from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithPopup,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import { Button } from './Button';

import { mcpScopeLabels } from '../services/mcpOAuthScopes';

interface Details {
  clientName: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  days: number;
  expiresAt: number;
}
export default function McpOAuthConsent() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const requestId = new URLSearchParams(window.location.search).get('request') ?? '';
  useEffect(
    () =>
      onAuthStateChanged(auth, (value) => {
        setUser(value);
        setLoading(false);
      }),
    [],
  );
  if (!/^[A-Za-z0-9_-]{43}$/.test(requestId))
    return (
      <main className="max-w-xl mx-auto p-6">
        <p role="alert">授權要求無效，請回到 ChatGPT 重新連線。</p>
      </main>
    );
  return (
    <main className="max-w-xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-bold">連接 Antty 與 ChatGPT</h1>
      {loading ? (
        <p>正在確認登入狀態…</p>
      ) : user ? (
        <McpConsentAccount key={`${user.uid}:${requestId}`} user={user} requestId={requestId} />
      ) : (
        <>
          <p>請使用既有 Antty 帳號登入，接著檢查這次要求的權限。登入後仍需由你同意授權。</p>
          <Button
            onClick={() =>
              void signInWithPopup(auth, googleProvider).catch(() =>
                setError('登入未完成，請再試一次。'),
              )
            }
          >
            使用 Google 登入 Antty
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
export function McpConsentAccount({
  user,
  requestId,
  navigate = (url: string) => window.location.assign(url),
}: {
  user: User;
  requestId: string;
  navigate?: (url: string) => void;
}) {
  const [details, setDetails] = useState<Details | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true),
    inFlight = useRef(false),
    requests = useRef(new Set<AbortController>());
  async function request<T>(method: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const token = await user.getIdToken(method === 'POST');
      if (!alive.current || controller.signal.aborted)
        throw new DOMException('Aborted', 'AbortError');
      const response = await fetch(
        `/oauth/consent${method === 'GET' ? `?request=${encodeURIComponent(requestId)}` : ''}`,
        {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (!response.ok)
        throw new Error(
          '授權未完成。要求可能已到期、撤銷或屬於另一個帳號，請回到 ChatGPT 重新連線。',
        );
      return (await response.json()) as T;
    } finally {
      requests.current.delete(controller);
    }
  }
  useEffect(() => {
    alive.current = true;
    const active = requests.current;
    let current = true;
    void request<Details>('GET')
      .then((value) => {
        if (!alive.current || !current) return;
        const redirect = new URL(value.redirectUri);
        if (
          redirect.protocol !== 'https:' ||
          redirect.username ||
          redirect.password ||
          redirect.hash ||
          value.days !== 7 ||
          !value.scopes?.length ||
          value.scopes.some((s) => !mcpScopeLabels[s])
        )
          throw new Error('授權資料無效，請重新連線。');
        setDetails(value);
      })
      .catch((failure) => {
        if (alive.current && current)
          setError(failure instanceof Error ? failure.message : '無法讀取授權要求。');
      });
    return () => {
      current = false;
      alive.current = false;
      active.forEach((controller) => controller.abort());
    };
    // The keyed parent replaces this state and all in-flight work on account/request changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.uid, requestId]);
  async function decide(approve: boolean) {
    if (!details || busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (approve) {
        const proof = await reauthenticateWithPopup(user, new GoogleAuthProvider());
        if (!alive.current) return;
        if (proof.user.uid !== user.uid) throw new Error('登入帳號已變更，請重新連線。');
      }
      const result = await request<{ redirectUri: string }>('POST', {
        request: requestId,
        approve,
      });
      if (!alive.current) return;
      const redirect = new URL(result.redirectUri),
        base = new URL(result.redirectUri),
        expected = new URL(details.redirectUri);
      for (const key of ['code', 'state', 'iss', 'error', 'error_description']) {
        base.searchParams.delete(key);
        expected.searchParams.delete(key);
      }
      if (redirect.protocol !== 'https:' || base.href !== expected.href)
        throw new Error('回傳網址不符，已停止跳轉。請重新連線。');
      navigate(redirect.href);
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : '授權未完成，請再試一次。');
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-xl border p-5">
      <p>目前帳號：{user.email ?? user.uid}</p>
      {!details && !error && <p>正在讀取授權要求…</p>}
      {details && (
        <>
          <p>
            <strong>{details.clientName}</strong> 要求以下權限：
          </p>
          <ul className="list-disc pl-6">
            {details.scopes.map((scope) => (
              <li key={scope}>{mcpScopeLabels[scope]}</li>
            ))}
          </ul>
          <p>
            連線授權最多 7 天。每次存取權杖最多 1 小時，不會建立長期更新權杖。你可以在 Antty 的 AI
            存取設定撤銷連線。
          </p>
          <p className="text-sm break-all">
            權杖到期後，需要回到 ChatGPT 重新連線並同意授權。
            <br />
            連線服務：{details.resource}
            <br />
            返回網址：{details.redirectUri}
          </p>
          {details.scopes.some((s) => s.startsWith('calendar:')) && (
            <p>日曆操作另需已核准的 AI 日曆授權。</p>
          )}
          <div className="flex gap-3">
            <Button disabled={busy} onClick={() => void decide(true)}>
              同意授權
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>
              取消
            </Button>
          </div>
          {busy && <p role="status">正在處理授權…</p>}
        </>
      )}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
