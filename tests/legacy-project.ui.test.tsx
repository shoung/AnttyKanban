import { beforeEach, expect, test, vi } from 'vitest';
const m = vi.hoisted(() => ({
  project: 'wrong-preview',
  read: vi.fn(),
  transaction: vi.fn(),
  metadata: vi.fn(),
}));
vi.mock('../firebase', () => ({
  auth: {
    currentUser: { uid: 'alice' },
    app: {
      options: {
        get projectId() {
          return m.project;
        },
      },
    },
  },
  db: {
    app: {
      options: {
        get projectId() {
          return m.project;
        },
      },
    },
  },
  storage: {
    app: {
      options: {
        get projectId() {
          return m.project;
        },
        storageBucket: 'antboard-2025.firebasestorage.app',
      },
    },
  },
}));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  getDocFromServer: (...args: unknown[]) => m.read(...args),
  runTransaction: (...args: unknown[]) => m.transaction(...args),
  serverTimestamp: vi.fn(),
}));
vi.mock('firebase/storage', () => ({
  ref: vi.fn(),
  getMetadata: (...args: unknown[]) => m.metadata(...args),
}));
import {
  loadLegacyMigration,
  applyLegacyMigration,
  verifyLegacyMigration,
} from '../services/legacyBrowserStore';
import type { BrowserMigrationPlan } from '../services/legacyBrowserPolicy';
beforeEach(() => {
  m.read.mockClear();
  m.transaction.mockClear();
  m.metadata.mockClear();
});
test('wrong project prevents every source read, image read and migration transaction', async () => {
  await expect(loadLegacyMigration('alice')).rejects.toThrow(/Wrong Firebase project/);
  await expect(applyLegacyMigration('alice', {} as BrowserMigrationPlan)).rejects.toThrow(
    /Wrong Firebase project/,
  );
  await expect(verifyLegacyMigration('alice', {} as BrowserMigrationPlan)).rejects.toThrow(
    /Wrong Firebase project/,
  );
  expect(m.read).not.toHaveBeenCalled();
  expect(m.transaction).not.toHaveBeenCalled();
  expect(m.metadata).not.toHaveBeenCalled();
});
