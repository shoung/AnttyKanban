import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, expect, vi } from 'vitest';
import type { User } from 'firebase/auth';
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  apply: vi.fn(),
  verify: vi.fn(),
  user: { uid: 'alice', email: 'alice@example.test' },
}));
vi.mock('../firebase', () => ({ auth: { currentUser: mocks.user } }));
vi.mock('../services/legacyBrowserStore', () => ({
  loadLegacyMigration: (...args: unknown[]) => mocks.load(...args),
  applyLegacyMigration: (...args: unknown[]) => mocks.apply(...args),
  verifyLegacyMigration: (...args: unknown[]) => mocks.verify(...args),
}));
import { LegacyMigration } from '../components/LegacyMigration';
const fixture = {
  projectId: 'antboard-2025',
  storageBucket: 'antboard-2025.firebasestorage.app',
  plan: {
    ownerUid: 'alice',
    sourcePath: 'boards/default',
    targetPath: 'users/alice/boards/default',
    targetExists: false,
    source: { projects: [] },
    sourceHash: 'a'.repeat(64),
    projectHash: 'b'.repeat(64),
    counts: { projects: 4, tasks: 12, comments: 3, images: 0 },
    images: [],
  },
  targetStatus: 'absent',
  images: [],
};
beforeEach(() => {
  sessionStorage.clear();
  mocks.load.mockReset().mockResolvedValue(fixture);
  mocks.apply.mockReset().mockResolvedValue({ targetStatus: 'verified', sourceUnchanged: true });
  mocks.verify.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        return 'blob:backup';
      }
      static revokeObjectURL() {}
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function prepare() {
  render(<LegacyMigration user={mocks.user as User} />);
  fireEvent.click(screen.getByRole('button', { name: /讀取舊看板/ }));
  await screen.findByText(/4 個專案/);
}
function submitButton() {
  return screen.getByRole('button', { name: /建立新工作區副本/ }) as HTMLButtonElement;
}
function confirmBackup() {
  fireEvent.click(screen.getByRole('button', { name: '下載完整 JSON 備份' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('確認目的 UID'), { target: { value: 'alice' } });
}
test('no automatic migration, explicit download acknowledgement and matching UID required', async () => {
  await prepare();
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(submitButton().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('確認目的 UID'), { target: { value: 'alice' } });
  expect(submitButton().disabled).toBe(true);
  confirmBackup();
  expect(submitButton().disabled).toBe(false);
  fireEvent.click(submitButton());
  await screen.findByText(/遷移成功並已讀回驗證/);
  expect(mocks.apply).toHaveBeenCalledTimes(1);
  expect(submitButton().disabled).toBe(true);
});
test('unreadable or existing destination allows backup but never a write', async () => {
  mocks.load.mockResolvedValue({ ...fixture, targetStatus: 'unreadable' });
  await prepare();
  confirmBackup();
  expect(submitButton().disabled).toBe(true);
  expect(mocks.apply).not.toHaveBeenCalled();
});
test('uncertain submission stays locked across page remount and only allows read-back', async () => {
  mocks.apply.mockRejectedValue(new Error('network uncertain'));
  await prepare();
  confirmBackup();
  fireEvent.click(submitButton());
  await screen.findByText(/未確認完成/);
  expect(submitButton().disabled).toBe(true);
  cleanup();
  await prepare();
  confirmBackup();
  expect(submitButton().disabled).toBe(true);
  expect(mocks.apply).toHaveBeenCalledTimes(1);
  mocks.verify.mockResolvedValue({ targetStatus: 'verified', sourceUnchanged: true });
  fireEvent.click(screen.getByRole('button', { name: /核對遠端結果/ }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/已驗證/));
  expect(mocks.apply).toHaveBeenCalledTimes(1);
});
