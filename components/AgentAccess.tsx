import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { KeyRound, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from './Button';
import McpOAuthConnections from './McpOAuthConnections';

type Scope =
  | 'maps:read'
  | 'maps:write'
  | 'boards:read'
  | 'boards:write'
  | 'calendar:read'
  | 'calendar:write';
interface TokenSummary {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}
interface TokenList {
  tokens: TokenSummary[];
  endpoint: string;
  nextAfter?: string;
}
const choices: { value: Scope; label: string }[] = [
  { value: 'maps:read', label: '讀取心智圖' },
  { value: 'maps:write', label: '修改心智圖' },
  { value: 'boards:read', label: '讀取專案看板' },
  { value: 'boards:write', label: '修改專案看板' },
  { value: 'calendar:read', label: '讀取 Google 日曆' },
  { value: 'calendar:write', label: '修改 Google 日曆' },
];
const defaultScopes: Scope[] = ['maps:read', 'boards:read', 'calendar:read'];

/** A key removes old-account tokens and one-time secrets synchronously on account switch. */
export default function AgentAccess({ user }: { user: User }) {
  return <AccountAgentAccess key={user.uid} user={user} />;
}
function AccountAgentAccess({ user }: { user: User }) {
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [endpoint, setEndpoint] = useState('');
  const [nextAfter, setNextAfter] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [days, setDays] = useState(30);
  const [scopes, setScopes] = useState<Scope[]>(defaultScopes);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const request = useCallback(
    async <T,>(method = 'GET', body?: unknown, after?: string): Promise<T> => {
      const controller = new AbortController();
      requests.current.add(controller);
      try {
        const idToken = await user.getIdToken();
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const response = await fetch(
          `/api/agent-tokens${after ? `?after=${encodeURIComponent(after)}` : ''}`,
          {
            method,
            credentials: 'omit',
            cache: 'no-store',
            headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
          },
        );
        const data = await response.json().catch(() => {
          throw Object.assign(new Error('Agent 服務尚未提供。'), { status: 503 });
        });
        if (!response.ok)
          throw Object.assign(
            new Error(
              response.status === 401
                ? '登入已失效，請重新登入。'
                : response.status === 429
                  ? '操作太頻繁，請稍後再試。'
                  : '無法完成操作，請稍後再試。',
            ),
            { status: response.status },
          );
        return data as T;
      } finally {
        requests.current.delete(controller);
      }
    },
    [user],
  );
  const load = useCallback(async () => {
    const data = await request<TokenList>();
    if (!mounted.current) return;
    setTokens(data.tokens);
    setNextAfter(data.nextAfter);
    setLoadedAt(Date.now());
    setEndpoint(data.endpoint);
    setLoaded(true);
    setDisabled(false);
  }, [request]);
  const showError = useCallback((failure: unknown) => {
    if (!mounted.current || (failure instanceof Error && failure.name === 'AbortError')) return;
    if ((failure as { status?: number }).status === 503) setDisabled(true);
    setError(failure instanceof Error ? failure.message : '無法完成操作，請稍後再試。');
  }, []);
  useEffect(() => {
    mounted.current = true;
    const activeRequests = requests.current;
    load()
      .catch(showError)
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
    return () => {
      mounted.current = false;
      activeRequests.forEach((controller) => controller.abort());
    };
  }, [load, showError]);
  async function run(action: () => Promise<void>) {
    if (inFlight.current || busy) return;
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
  async function loadMore() {
    if (!nextAfter) return;
    const data = await request<TokenList>('GET', undefined, nextAfter);
    if (!mounted.current) return;
    setTokens((current) => [
      ...current,
      ...data.tokens.filter((token) => !current.some((old) => old.id === token.id)),
    ]);
    setNextAfter(data.nextAfter);
    setLoadedAt(Date.now());
  }
  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      if (mounted.current) setNotice('權杖已複製，請妥善保存。');
    } catch {
      if (mounted.current) setError('無法自動複製，請手動選取權杖。');
    }
  }
  async function create() {
    if (!name.trim() || scopes.length === 0 || days < 1 || days > 90) {
      setError('請填寫名稱、選擇至少一項權限，並設定 1 至 90 天有效期。');
      return;
    }
    const writeWarning = scopes.includes('calendar:write')
      ? '\n包含 Google 日曆修改權限：可在你已連結的主要日曆新增、修改及刪除個人活動。'
      : '';
    const scopeText = choices
      .filter((choice) => scopes.includes(choice.value))
      .map((choice) => choice.label)
      .join('、');
    if (
      !window.confirm(
        `建立「${name.trim()}」的 Agent 權杖？\n權限：${scopeText}\n有效期：${days} 天。持有者可代表目前帳號執行這些操作，請只交給信任的 Agent。${writeWarning}`,
      )
    )
      return;
    await run(async () => {
      const created = await request<{ token: string }>('POST', { name: name.trim(), scopes, days });
      if (!mounted.current) return;
      setSecret(created.token);
      setName('');
      setNotice('已建立權杖。完整內容只顯示這一次。');
      await load();
    });
  }
  async function revoke(token: TokenSummary) {
    if (!window.confirm(`撤銷「${token.name}」？使用這枚權杖的 Agent 將無法繼續存取你的資料。`))
      return;
    await run(async () => {
      await request('DELETE', { id: token.id });
      if (!mounted.current) return;
      setSecret('');
      setNotice('已撤銷權杖。');
      await load();
    });
  }
  const fieldClass =
    'w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm';
  return (
    <section className="mx-auto max-w-4xl p-4 sm:p-8 space-y-6" aria-label="Agent 存取">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <KeyRound size={22} />
            Agent 存取
          </h2>
          <p className="mt-1 text-sm text-slate-500">只授權目前帳號的資料，隨時可以撤銷。</p>
        </div>
        <Button variant="secondary" disabled={busy} onClick={() => void run(load)}>
          <RefreshCw size={16} className="mr-2" />
          重新整理
        </Button>
      </header>
      <div className="rounded-xl bg-blue-50 dark:bg-blue-950/40 p-4 text-sm space-y-2">
        <p className="font-medium flex items-center gap-2">
          <ShieldCheck size={18} />
          預設只有讀取權限
        </p>
        <p>
          這裡提供自訂 Bearer 權杖的 MCP 連線，適用於支援自訂 Authorization 標頭的客戶端。目前不是
          ChatGPT 網頁版的 OAuth 連接方式；後者需要另外完成授權服務設定與帳號連結。
        </p>
        <p>
          權杖等同所選範圍的帳號存取權，請不要貼到公開對話、原始碼或版本庫。Google
          日曆必須先在「日曆」頁連結。
        </p>
      </div>
      <McpOAuthConnections user={user} />
      {disabled ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 p-4">
          <h3 className="font-semibold">Agent 存取尚未啟用</h3>
          <p className="text-sm mt-1">後端設定完成後才可建立權杖，不影響原本的登入與看板。</p>
        </div>
      ) : (
        error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )
      )}
      {notice && (
        <p role="status" className="text-sm text-emerald-600">
          {notice}
        </p>
      )}
      {busy && !loaded && !disabled && (
        <p className="text-sm text-slate-500">正在讀取此帳號的存取設定…</p>
      )}
      {loaded && !disabled && (
        <>
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
            <p className="text-sm font-medium">MCP 端點</p>
            <p className="mt-1 break-all text-sm">{endpoint}</p>
            <p className="mt-2 text-xs text-slate-500">
              Streamable HTTP · Authorization: Bearer 你的權杖 · 每次請求都須驗證
            </p>
          </div>
          {secret && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-3">
              <p className="font-semibold">請現在保存權杖，關閉後無法再次查看。</p>
              <label className="block text-sm">
                一次性權杖
                <textarea
                  readOnly
                  value={secret}
                  className={`${fieldClass} mt-1 font-mono break-all`}
                  rows={2}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => void copySecret()}>
                  複製權杖
                </Button>
                <Button variant="ghost" onClick={() => setSecret('')}>
                  已保存，關閉顯示
                </Button>
              </div>
            </div>
          )}
          <form
            className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <h3 className="font-semibold">建立新權杖</h3>
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="text-sm">
                權杖名稱
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={busy}
                  className={`${fieldClass} mt-1`}
                  placeholder="例如：我的桌面 Agent"
                />
              </label>
              <label className="text-sm">
                有效天數
                <input
                  type="number"
                  value={days}
                  min={1}
                  max={90}
                  required
                  disabled={busy}
                  onChange={(event) => setDays(Number(event.target.value))}
                  className={`${fieldClass} mt-1`}
                />
              </label>
            </div>
            <fieldset disabled={busy} className="grid sm:grid-cols-2 gap-3">
              <legend className="text-sm font-medium mb-2">授權範圍</legend>
              {choices.map((choice) => (
                <label key={choice.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.includes(choice.value)}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, choice.value]
                          : current.filter((scope) => scope !== choice.value),
                      )
                    }
                  />
                  {choice.label}
                </label>
              ))}
            </fieldset>
            {scopes.some((scope) => scope.endsWith(':write')) && (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                修改權限允許 Agent 更動或刪除對應資料。
                {scopes.includes('calendar:write') &&
                  'Google 日曆修改會直接影響真實的主要日曆活動，不包含邀請他人或週期活動。'}
              </p>
            )}
            <Button type="submit" disabled={busy || scopes.length === 0}>
              建立權杖
            </Button>
          </form>
          <div className="space-y-3">
            <h3 className="font-semibold">此帳號的權杖</h3>
            {tokens.length === 0 && <p className="text-sm text-slate-500">還沒有建立權杖。</p>}
            {tokens.map((token) => {
              const expired = token.expiresAt <= loadedAt;
              return (
                <div
                  key={token.id}
                  className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 flex flex-wrap justify-between gap-3"
                >
                  <div>
                    <p className="font-medium">
                      {token.name}{' '}
                      <span className="text-xs text-slate-500">
                        {token.revoked ? '已撤銷' : expired ? '已到期' : '有效'}
                      </span>
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      到期：{new Date(token.expiresAt).toLocaleString('zh-TW')}
                    </p>
                    <p className="text-xs mt-1">
                      {token.scopes
                        .map(
                          (scope) =>
                            choices.find((choice) => choice.value === scope)?.label ?? scope,
                        )
                        .join('、')}
                    </p>
                  </div>
                  {!token.revoked && (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => void revoke(token)}
                    >
                      <Trash2 size={14} className="mr-1" />
                      撤銷
                    </Button>
                  )}
                </div>
              );
            })}
            {nextAfter && (
              <Button variant="secondary" disabled={busy} onClick={() => void run(loadMore)}>
                載入更多權杖
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
