import React from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const mocked = vi.hoisted(() => ({
  user: { uid: 'alice', displayName: 'Alice', email: 'alice@example.test' },
  upload: vi.fn(),
  watch: undefined as undefined | ((data: unknown) => void),
  remoteRevision: 1,
  save: vi.fn(),
}));
vi.mock('../firebase', () => ({
  auth: { currentUser: mocked.user },
  storage: {},
  googleProvider: {},
}));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (u: unknown) => void) => {
    cb(mocked.user);
    return () => {};
  },
  signOut: vi.fn(),
  signInWithPopup: vi.fn(),
}));
vi.mock('firebase/storage', () => ({
  ref: (_s: unknown, path: string) => path,
  uploadBytes: (...args: unknown[]) => mocked.upload(...args),
  getBlob: vi.fn(),
}));
vi.mock('../services/boardStore', () => ({
  subscribeBoard: (_uid: string, cb: (data: unknown) => void) => {
    mocked.watch = cb;
    return () => {};
  },
  saveBoard: (...args: unknown[]) => mocked.save(...args),
}));
import { TaskModal } from '../components/TaskModal';
import App from '../App';
const columns = [{ id: 'c', title: 'To do', color: '#fff' }];
const task = {
  id: 't',
  title: 'Original',
  columnId: 'c',
  tags: [],
  assignee: '',
  order: 0,
  comments: [],
};
const board = (revision: number, title = 'Original') => ({
  ownerUid: 'alice',
  revision,
  projects: [
    {
      id: 'p',
      name: 'Project',
      columns: columns.map((x) => ({ ...x })),
      tasks: [{ ...task, title }],
    },
  ],
});
beforeEach(() => {
  mocked.remoteRevision = 1;
  mocked.watch = undefined;
  mocked.save.mockReset();
  mocked.upload.mockReset();
  mocked.save.mockImplementation(async (_uid, projects, revision) => {
    if (revision !== mocked.remoteRevision) throw new Error('Board revision conflict');
    return { ownerUid: 'alice', projects, revision: revision + 1 };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('closing and reopening during an upload restores editing and ignores old upload', async () => {
  let finish!: () => void;
  mocked.upload.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    onSave: vi.fn(),
    columns,
    currentUser: mocked.user,
    initialData: task,
  };
  const { rerender, container } = render(<TaskModal {...props} />);
  const fileInput = container.querySelector('input[type="file"]')!;
  fireEvent.change(fileInput, {
    target: { files: [new File(['png'], 'a.png', { type: 'image/png' })] },
  });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '上傳中...' }) as HTMLButtonElement).disabled).toBe(
      true,
    ),
  );
  rerender(<TaskModal {...props} isOpen={false} />);
  rerender(<TaskModal {...props} />);
  expect((screen.getByRole('button', { name: '儲存' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => {
    finish();
  });
  expect(screen.queryByRole('button', { name: '放大檢視任務圖片' })).toBeNull();
});

test('columns reference updates do not reset an open modal draft', () => {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    onSave: vi.fn(),
    columns,
    currentUser: mocked.user,
    initialData: task,
  };
  const { rerender } = render(<TaskModal {...props} />);
  fireEvent.change(screen.getByPlaceholderText('輸入任務名稱...'), {
    target: { value: 'Unsaved draft' },
  });
  rerender(<TaskModal {...props} columns={columns.map((x) => ({ ...x }))} />);
  expect((screen.getByPlaceholderText('輸入任務名稱...') as HTMLInputElement).value).toBe(
    'Unsaved draft',
  );
});

test('remote snapshot while editing preserves draft and saves against its original revision', async () => {
  render(<App />);
  await waitFor(() => expect(mocked.watch).toBeDefined());
  act(() => mocked.watch!(board(1)));
  fireEvent.click(await screen.findByText('Original'));
  fireEvent.change(screen.getByPlaceholderText('輸入任務名稱...'), {
    target: { value: 'My draft' },
  });
  mocked.remoteRevision = 2;
  act(() => mocked.watch!(board(2, 'Remote version')));
  expect((screen.getByPlaceholderText('輸入任務名稱...') as HTMLInputElement).value).toBe(
    'My draft',
  );
  fireEvent.click(screen.getByRole('button', { name: '儲存' }));
  await screen.findByText(/儲存未完成/);
  expect(mocked.save.mock.calls[0][2]).toBe(1);
  expect(mocked.save.mock.calls[0][1][0].tasks[0].title).toBe('My draft');
  expect(screen.getByRole('button', { name: '下載目前草稿備份' })).toBeTruthy();
});

test('cancelling a draft applies the buffered remote board without writing', async () => {
  render(<App />);
  await waitFor(() => expect(mocked.watch).toBeDefined());
  act(() => mocked.watch!(board(1)));
  fireEvent.click(await screen.findByText('Original'));
  fireEvent.change(screen.getByPlaceholderText('輸入任務名稱...'), {
    target: { value: 'Discard me' },
  });
  act(() => mocked.watch!(board(2, 'Remote after cancel')));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(await screen.findByText('Remote after cancel')).toBeTruthy();
  expect(mocked.save).not.toHaveBeenCalled();
});
