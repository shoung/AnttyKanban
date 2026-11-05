import React, { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { Button } from './Button';
import { mcpScopeLabels } from '../services/mcpOAuthScopes';
interface Grant {
  id: string;
  clientName: string;
  scopes: string[];
  expiresAt: number;
  enabled: boolean;
}
interface Page {
  endpoint: string;
  grants: Grant[];
  nextAfter?: string;
}
export default function McpOAuthConnections({ user }: { user: User }) {
  return <Connections key={user.uid} user={user} />;
}
function Connections({ user }: { user: User }) {
  const [page, setPage] = useState<Page | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [disabled, setDisabled] = useState(false);
  const alive = useRef(true),
    flight = useRef(false),
    generation = useRef(0),
    requests = useRef(new Set<AbortController>());
  async function call<T>(method = 'GET', body?: unknown, after?: string): Promise<T> {
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const token = await user.getIdToken();
      if (!alive.current || controller.signal.aborted)
        throw new DOMException('Aborted', 'AbortError');
      const response = await fetch(
        `/oauth/connections${after ? `?after=${encodeURIComponent(after)}` : ''}`,
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
        throw Object.assign(new Error('無法讀取或更新連線，請再試一次。'), {
          status: response.status,
        });
      return (await response.json()) as T;
    } finally {
      requests.current.delete(controller);
    }
  }
  async function run(action: () => Promise<void>) {
    if (flight.current) return;
    const epoch = generation.current;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      if (alive.current && epoch === generation.current) setDisabled(false);
    } catch (failure) {
      if (alive.current && epoch === generation.current) {
        if ((failure as { status?: number }).status === 503) setDisabled(true);
        else setError(failure instanceof Error ? failure.message : '連線操作失敗。');
      }
    } finally {
      if (epoch === generation.current) {
        flight.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  async function load(after?: string) {
    const epoch = generation.current;
    const result = await call<Page>('GET', undefined, after);
    if (!Array.isArray(result.grants) || typeof result.endpoint !== 'string')
      throw new Error('連線資料無效，請重新檢查。');
    if (alive.current && epoch === generation.current)
      setPage((old) =>
        after && old
          ? {
              ...result,
              grants: [
                ...old.grants,
                ...result.grants.filter((g) => !old.grants.some((x) => x.id === g.id)),
              ],
            }
          : result,
      );
  }
  useEffect(() => {
    alive.current = true;
    const active = requests.current;
    const epoch = generation.current;
    void run(() => load());
    return () => {
      alive.current = false;
      generation.current = epoch + 1;
      flight.current = false;
      active.forEach((c) => c.abort());
    };
    // State and pending requests are replaced by the keyed account parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.uid]);
  return (
    <section className="rounded-xl border p-4 space-y-3">
      <h3 className="font-semibold">ChatGPT 連線授權</h3>
      <p className="text-sm">
        使用既有 Firebase 登入。請從 ChatGPT 新增 Antty MCP 連線，再回到 Antty 確認權限。
      </p>
      {disabled && <p>Firebase MCP OAuth 尚未啟用，需完成部署及核准設定。</p>}
      {error && <p role="alert">{error}</p>}
      {page && !disabled && (
        <>
          <p className="text-xs break-all">MCP：{page.endpoint}</p>
          {page.grants.length === 0 && <p>目前沒有 ChatGPT 授權。</p>}
          {page.grants.map((grant) => (
            <div key={grant.id} className="border-t pt-3 space-y-2">
              <p>
                {grant.clientName}：{grant.scopes.map((s) => mcpScopeLabels[s] ?? s).join('、')}
              </p>
              <p>
                {grant.enabled
                  ? `有效至 ${new Date(grant.expiresAt).toLocaleString('zh-TW')}`
                  : '已撤銷或到期'}
              </p>
              {grant.enabled && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await call('DELETE', { id: grant.id });
                      await load();
                    })
                  }
                >
                  撤銷此連線
                </Button>
              )}
            </div>
          ))}
          {page.nextAfter && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run(() => load(page.nextAfter))}
            >
              載入更多連線
            </Button>
          )}
        </>
      )}
      <Button variant="secondary" disabled={busy} onClick={() => void run(() => load())}>
        重新檢查連線
      </Button>
    </section>
  );
}
