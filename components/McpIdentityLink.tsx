import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GoogleAuthProvider, reauthenticateWithPopup, type User } from 'firebase/auth';
import { Button } from './Button';

interface LinkStatus {
  configured: true;
  authorizationOrigin: string;
  endpoint: string;
  scopes: ['maps:read'];
  days: 7;
  nextAfter?: string;
  links: { id: string; subject: string; expiresAt: number; enabled: boolean }[];
}
export default function McpIdentityLink({ user }: { user: User }) {
  return <AccountIdentityLink key={user.uid} user={user} />;
}
function AccountIdentityLink({ user }: { user: User }) {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const request = useCallback(
    async <T,>(method = 'GET', body?: unknown, fresh = false, after?: string): Promise<T> => {
      const controller = new AbortController();
      requests.current.add(controller);
      try {
        const token = await user.getIdToken(fresh);
        if (!mounted.current || controller.signal.aborted)
          throw new DOMException('Aborted', 'AbortError');
        const response = await fetch(
          `/api/mcp-link${after ? `?after=${encodeURIComponent(after)}` : ''}`,
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
          throw Object.assign(
            new Error(
              response.status === 401 ? '請重新登入後再試。' : '身分綁定暫時無法使用，請重新檢查。',
            ),
            { status: response.status },
          );
        return (await response.json()) as T;
      } finally {
        requests.current.delete(controller);
      }
    },
    [user],
  );
  const load = useCallback(async () => {
    const value = await request<LinkStatus>();
    if (!mounted.current) return;
    if (
      value.configured !== true ||
      value.days !== 7 ||
      value.scopes?.length !== 1 ||
      value.scopes[0] !== 'maps:read' ||
      !Array.isArray(value.links)
    )
      throw new Error('身分綁定設定尚未就緒。');
    setStatus(value);
    setDisabled(false);
  }, [request]);
  const showError = useCallback((failure: unknown) => {
    if (!mounted.current || (failure instanceof Error && failure.name === 'AbortError')) return;
    if ((failure as { status?: number }).status === 503) setDisabled(true);
    else setError(failure instanceof Error ? failure.message : '身分綁定失敗，請重新嘗試。');
  }, []);
  useEffect(() => {
    mounted.current = true;
    const active = requests.current;
    const url = new URL(window.location.href);
    if (url.searchParams.has('mcpLink')) {
      setNotice(
        url.searchParams.get('mcpLink') === 'success'
          ? '授權已返回，請檢查下方身分綁定。這不代表 ChatGPT 已連接成功。'
          : '授權未完成或已逾時。請重新開始綁定。',
      );
      url.searchParams.delete('mcpLink');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    load()
      .catch(showError)
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
    return () => {
      mounted.current = false;
      active.forEach((controller) => controller.abort());
    };
  }, [load, showError]);
  async function run(action: () => Promise<void>) {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      showError(failure);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function connect() {
    if (!status || busy || inFlight.current) return;
    if (
      !window.confirm(
        `將目前 Antty 帳號（${user.email ?? user.uid}）綁定到你接下來登入的 Auth0 身分。允許指定的 ChatGPT client 僅能讀取心智圖，期限 7 天，不會自動續期。\n將先驗證目前 Google 登入，再前往 Auth0。是否繼續？`,
      )
    )
      return;
    await run(async () => {
      const credential = await reauthenticateWithPopup(user, new GoogleAuthProvider());
      if (!mounted.current) return;
      if (credential.user.uid !== user.uid) throw new Error('登入帳號已變更，請重新開始。');
      const result = await request<{ authorizationUrl: string }>('POST', { consent: true }, true);
      if (!mounted.current) return;
      const url = new URL(result.authorizationUrl);
      if (
        url.protocol !== 'https:' ||
        url.origin !== status.authorizationOrigin ||
        url.pathname !== '/authorize' ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error('授權網址無效，請重新檢查設定。');
      window.location.assign(url.href);
    });
  }
  async function revoke(id: string) {
    if (
      !window.confirm(
        '撤銷此身分在 Antty 的存取權？此操作立即停止 Antty MCP 存取；Auth0 和 ChatGPT 內的連線需另外移除。',
      )
    )
      return;
    await run(async () => {
      await request('DELETE', { id });
      if (!mounted.current) return;
      setNotice('已撤銷 Antty 身分綁定。');
      await load();
    });
  }
  async function loadMore() {
    if (!status?.nextAfter) return;
    const page = await request<LinkStatus>('GET', undefined, false, status.nextAfter);
    if (!mounted.current) return;
    setStatus(
      (current) =>
        current && {
          ...current,
          nextAfter: page.nextAfter,
          links: [
            ...current.links,
            ...page.links.filter((row) => !current.links.some((old) => old.id === row.id)),
          ],
        },
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
      <h3 className="font-semibold">ChatGPT 身分綁定</h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        保留 Firebase 登入，透過 Auth0 OAuth 提供個人 MCP
        存取。此階段僅讀取心智圖，七天到期；尚未開放看板、日曆或寫入。
      </p>
      {disabled && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          尚未設定 Auth0、後端未啟用，或服務暫時無法使用。需先完成供應商設定並核准啟用，才能綁定。
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {busy && !status && !disabled && <p className="text-sm">正在檢查身分綁定…</p>}
      {(disabled || !status) && (
        <Button variant="secondary" disabled={busy} onClick={() => void run(load)}>
          重新檢查身分綁定
        </Button>
      )}
      {status && !disabled && (
        <>
          <p className="text-xs break-all">MCP：{status.endpoint}</p>
          {status.links.length === 0 && <p className="text-sm">目前沒有身分綁定。</p>}
          {status.links.map((link) => (
            <div
              key={link.id}
              className="flex flex-wrap gap-3 items-center justify-between border-t border-slate-200 dark:border-slate-700 pt-3"
            >
              <div className="text-sm break-all">
                <p>{link.subject}</p>
                <p>
                  {link.enabled
                    ? `到期：${new Date(link.expiresAt).toLocaleString('zh-TW')}`
                    : '已撤銷'}
                </p>
              </div>
              {link.enabled && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => void revoke(link.id)}
                >
                  撤銷此身分綁定
                </Button>
              )}
            </div>
          ))}
          {status.nextAfter && (
            <Button variant="secondary" disabled={busy} onClick={() => void run(loadMore)}>
              載入更多身分綁定
            </Button>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void connect()}>
              綁定 ChatGPT 身分
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void run(load)}>
              重新檢查身分綁定
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            綁定後仍需在 ChatGPT 加入自訂 MCP 並完成
            OAuth；以實際工具呼叫確認連線。撤銷綁定後，新請求立即被拒絕。
          </p>
        </>
      )}
    </div>
  );
}
