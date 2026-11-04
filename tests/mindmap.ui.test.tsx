/* eslint-disable @typescript-eslint/no-explicit-any -- React Flow test adapter and synthetic response fixtures intentionally model partial external objects. */
import React from 'react';
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: any) => <>{children}</>,
  useReactFlow: () => ({ fitView: vi.fn() }),
  ReactFlow: ({ nodes, nodeTypes, onNodeClick, children }: any) => (
    <div data-testid="canvas">
      {nodes.map((n: any) => {
        const Component = nodeTypes[n.type];
        return (
          <div key={n.id} onClick={() => onNodeClick(null, n)}>
            <Component {...n} />
          </div>
        );
      })}
      {children}
    </div>
  ),
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
}));
import Workspace from '../mindmap/components/Workspace';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test('create map, add/edit child, undo/redo, autosave and reopen', async () => {
  let stored: any;
  let saves = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/maps' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        stored = {
          ...body,
          id: 'map1',
          revision: 1,
          updatedAt: new Date().toISOString(),
        };
        return Response.json(stored);
      }
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        expect(body.expectedRevision).toBe(stored.revision);
        stored = { ...stored, ...body, revision: stored.revision + 1 };
        saves++;
        return Response.json(stored);
      }
      if (url === '/api/maps') return Response.json({ maps: stored ? [stored] : [] });
      return Response.json(stored);
    }),
  );
  render(<Workspace />);
  fireEvent.click(await screen.findByRole('button', { name: '建立第一張心智圖' }));
  fireEvent.change(screen.getByPlaceholderText('例如：新遊戲的可能性'), {
    target: { value: '測試腦暴' },
  });
  fireEvent.click(screen.getByRole('button', { name: /開始發想/ }));
  await screen.findByTestId('canvas');
  fireEvent.click(screen.getByRole('button', { name: /子節點 Tab/ }));
  const input = await screen.findByLabelText('編輯節點');
  fireEvent.change(input, { target: { value: '新的分支內容' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByText('新的分支內容')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '復原 (Ctrl/⌘ Z)' }));
  expect(screen.queryByText('新的分支內容')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重做 (Ctrl/⌘ Shift Z)' }));
  expect(await screen.findByText('新的分支內容')).toBeTruthy();
  await waitFor(() => expect(saves).toBeGreaterThan(0), { timeout: 3000 });
  expect(stored.root.children[0].text).toBe('新的分支內容');
  expect(screen.getByText('已儲存')).toBeTruthy();
});
test('authentication failure offers login and does not claim saved data', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'Unauthorized' }, { status: 401 })),
  );
  render(<Workspace />);
  expect(await screen.findByText('請先登入你的 Google 帳號')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Google 登入/ })).toBeTruthy();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setupDelayed() {
  const original = {
    id: 'original',
    title: '原圖',
    revision: 1,
    updatedAt: new Date().toISOString(),
    root: { id: 'root', text: '原始想法', children: [] },
  };
  let stored = structuredClone(original);
  let reads = 0;
  let saves = 0;
  const pendingRead = deferred<Response>();
  const pendingCreate = deferred<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return pendingCreate.promise;
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        stored = { ...stored, ...body, revision: stored.revision + 1 };
        saves++;
        return Response.json(stored);
      }
      if (url === '/api/maps') return Response.json({ maps: [stored] });
      if (++reads === 1) return Response.json(stored);
      return pendingRead.promise;
    }),
  );
  return {
    original,
    pendingRead,
    pendingCreate,
    getStored: () => stored,
    getSaves: () => saves,
  };
}
async function openOriginal() {
  render(<Workspace />);
  fireEvent.click(await screen.findByRole('button', { name: /原圖/ }));
  await screen.findByText('原始想法');
}
test('delayed reload cannot overwrite edits made after request begins', async () => {
  const state = setupDelayed();
  await openOriginal();
  fireEvent.click(screen.getByRole('button', { name: '重新讀取最新版本（含 AI 修改）' }));
  fireEvent.doubleClick(screen.getByText('原始想法'));
  fireEvent.change(screen.getByLabelText('編輯節點'), {
    target: { value: '等待讀取時的新想法' },
  });
  state.pendingRead.resolve(Response.json(state.original));
  await screen.findByText('讀取期間有新的編輯，已保留目前內容。需要時可再次重新讀取。');
  expect((screen.getByLabelText('編輯節點') as HTMLTextAreaElement).value).toBe(
    '等待讀取時的新想法',
  );
  await waitFor(() => expect(state.getSaves()).toBe(1), { timeout: 3000 });
  expect(state.getStored().root.text).toBe('等待讀取時的新想法');
});
test('delayed create preserves current edits and does not switch to new map', async () => {
  const state = setupDelayed();
  await openOriginal();
  fireEvent.click(screen.getByRole('button', { name: /建立心智圖/ }));
  fireEvent.change(screen.getByPlaceholderText('例如：新遊戲的可能性'), {
    target: { value: '新建立的圖' },
  });
  fireEvent.click(screen.getByRole('button', { name: /開始發想/ }));
  fireEvent.click(screen.getByRole('button', { name: '關閉' }));
  fireEvent.doubleClick(screen.getByText('原始想法'));
  fireEvent.change(screen.getByLabelText('編輯節點'), {
    target: { value: '不能遺失的想法' },
  });
  state.pendingCreate.resolve(
    Response.json({ ...state.original, id: 'new-map', title: '新建立的圖' }),
  );
  await screen.findByText('新圖已建立並加入清單；目前編輯已保留，沒有自動切換。');
  expect((screen.getByLabelText('心智圖名稱') as HTMLInputElement).value).toBe('原圖');
  await waitFor(() => expect(state.getSaves()).toBe(1), { timeout: 3000 });
  expect(state.getStored().root.text).toBe('不能遺失的想法');
});
test('focused draft immediately marks dirty, warns on leave, and saves without blur', async () => {
  const state = setupDelayed();
  await openOriginal();
  fireEvent.doubleClick(screen.getByText('原始想法'));
  const textarea = screen.getByLabelText('編輯節點');
  fireEvent.change(textarea, { target: { value: '持續輸入中的草稿' } });
  expect(screen.getByText('等待儲存')).toBeTruthy();
  const leave = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(true);
  fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
  expect(screen.getByLabelText('編輯節點')).toBeTruthy();
  await waitFor(() => expect(state.getSaves()).toBe(1), { timeout: 3000 });
  expect(state.getStored().root.text).toBe('持續輸入中的草稿');
  expect(screen.getByLabelText('編輯節點')).toBeTruthy();
});

test('in-flight save prevents switching and preserves edits made during the save', async () => {
  const pending = deferred<Response>();
  let stored = {
    id: 'original',
    title: '原圖',
    revision: 1,
    updatedAt: new Date().toISOString(),
    root: { id: 'root', text: '原始想法', children: [] },
  };
  let saves = 0;
  let reads = 0;
  let submitted: any;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/maps' && !init?.method) return Response.json({ maps: [stored] });
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        expect(body.expectedRevision).toBe(stored.revision);
        saves++;
        if (saves === 1) {
          submitted = body;
          return pending.promise;
        }
        stored = { ...stored, ...body, revision: stored.revision + 1 };
        return Response.json(stored);
      }
      reads++;
      return Response.json(stored);
    }),
  );
  await openOriginal();
  fireEvent.doubleClick(screen.getByText('原始想法'));
  fireEvent.change(screen.getByLabelText('編輯節點'), {
    target: { value: '第一個版本' },
  });
  await waitFor(() => expect(saves).toBe(1), { timeout: 3000 });
  fireEvent.click(screen.getByRole('button', { name: /原圖/ }));
  expect(reads).toBe(1);
  fireEvent.change(screen.getByLabelText('編輯節點'), {
    target: { value: '儲存期間的新版本' },
  });
  stored = { ...stored, ...submitted, revision: 2 };
  pending.resolve(Response.json(stored));
  await waitFor(() => expect(saves).toBe(2), { timeout: 3000 });
  expect(stored.root.text).toBe('儲存期間的新版本');
  expect(stored.revision).toBe(3);
});

test('correcting a rejected title resumes autosave without manual retry', async () => {
  let stored = {
    id: 'original',
    title: '原圖',
    revision: 1,
    updatedAt: new Date().toISOString(),
    root: { id: 'root', text: '原始想法', children: [] },
  };
  let saves = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        if (body.title.length > 200) return Response.json({ error: '標題太長' }, { status: 400 });
        stored = { ...stored, ...body, revision: stored.revision + 1 };
        saves++;
        return Response.json(stored);
      }
      return Response.json(url === '/api/maps' ? { maps: [stored] } : stored);
    }),
  );
  await openOriginal();
  const title = screen.getByLabelText('心智圖名稱');
  expect(title.getAttribute('maxlength')).toBe('200');
  fireEvent.change(title, { target: { value: 'a'.repeat(201) } });
  await screen.findByText('標題太長', {}, { timeout: 3000 });
  fireEvent.change(title, { target: { value: '修正後的標題' } });
  await waitFor(() => expect(saves).toBe(1), { timeout: 3000 });
  expect(stored.title).toBe('修正後的標題');
  expect(screen.queryByText('標題太長')).toBeNull();
});
test('empty-content notice clears after corrected content saves', async () => {
  const state = setupDelayed();
  await openOriginal();
  fireEvent.doubleClick(screen.getByText('原始想法'));
  const input = screen.getByLabelText('編輯節點');
  fireEvent.change(input, { target: { value: '' } });
  await screen.findByText(
    '標題與節點不能留空；輸入中的內容會保留，填好後會自動儲存。',
    {},
    { timeout: 3000 },
  );
  expect(state.getSaves()).toBe(0);
  fireEvent.change(input, { target: { value: '填好的內容' } });
  await waitFor(() => expect(state.getSaves()).toBe(1), { timeout: 3000 });
  expect(
    screen.queryByText('標題與節點不能留空；輸入中的內容會保留，填好後會自動儲存。'),
  ).toBeNull();
});
