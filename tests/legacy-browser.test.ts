import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBrowserMigrationPlan,
  migrationDocument,
  verifyMigrationTarget,
} from '../services/legacyBrowserPolicy.ts';
const projects = [
  {
    id: 'p',
    name: 'Existing',
    columns: [{ id: 'c', title: 'To do', color: '#fff' }],
    tasks: [
      {
        id: 't',
        title: 'Task',
        columnId: 'c',
        order: 0,
        tags: [],
        assignee: '',
        comments: [],
        imagePath: 'task-images/old',
        imageUrl: 'https://example.invalid/old',
      },
    ],
  },
];
const source = { projects, updatedAt: '2026-08-12T12:07:56.518Z', updatedBy: 'not-the-owner' };
test('browser migration creates full backup and safe image inventory without inferring ownership', async () => {
  const plan = await createBrowserMigrationPlan('alice', source, false);
  assert.equal(plan.targetPath, 'users/alice/boards/default');
  assert.deepEqual(plan.source, source);
  assert.equal(plan.sourceHash.length, 64);
  assert.equal(plan.images[0].path, 'task-images/old');
  assert.equal(plan.images[0].hasLegacyUrl, true);
  assert.equal(plan.counts.projects, 1);
  assert.equal(plan.counts.tasks, 1);
});
test('existing target still permits backup but never a migration write', async () => {
  const plan = await createBrowserMigrationPlan('alice', source, true);
  assert.deepEqual(plan.source, source);
  await assert.rejects(() => migrationDocument('alice', plan, source, true), /exists/);
});
test('migration rejects account switching, changed source and destination races', async () => {
  const plan = await createBrowserMigrationPlan('alice', source, false);
  await assert.rejects(() => migrationDocument('bob', plan, source, false), /account/i);
  await assert.rejects(
    () => migrationDocument('alice', plan, { ...source, updatedAt: 'changed' }, false),
    /changed/i,
  );
  await assert.rejects(() => migrationDocument('alice', plan, source, true), /exists/i);
  const next = await migrationDocument('alice', plan, source, false);
  assert.equal(next.revision, 1);
  assert.equal(next.ownerUid, 'alice');
  assert.deepEqual(next.projects, projects);
});
test('verification checks owner and content, handles absent or conflicting target without writes', async () => {
  const plan = await createBrowserMigrationPlan('alice', source, false);
  const next = await migrationDocument('alice', plan, source, false);
  assert.equal(await verifyMigrationTarget('alice', plan, null), 'absent');
  assert.equal(await verifyMigrationTarget('alice', plan, next), 'verified');
  assert.equal(
    await verifyMigrationTarget('alice', plan, { ...next, ownerUid: 'bob' }),
    'different',
  );
  assert.equal(await verifyMigrationTarget('alice', plan, { ...next, projects: [] }), 'different');
});

test('migration rejects a preview project or foreign bucket rather than mislabeling its backup', async () => {
  const { assertLegacyProject } = await import('../services/legacyBrowserPolicy.ts');
  assert.throws(
    () =>
      assertLegacyProject({
        authProject: 'preview',
        dbProject: 'preview',
        storageProject: 'preview',
        storageBucket: 'preview.appspot.com',
      }),
    /project/i,
  );
  assert.throws(
    () =>
      assertLegacyProject({
        authProject: 'antboard-2025',
        dbProject: 'antboard-2025',
        storageProject: 'other',
        storageBucket: 'antboard-2025.firebasestorage.app',
      }),
    /project/i,
  );
  assert.throws(
    () =>
      assertLegacyProject({
        authProject: 'antboard-2025',
        dbProject: 'antboard-2025',
        storageProject: 'antboard-2025',
        storageBucket: 'other.appspot.com',
      }),
    /bucket/i,
  );
  assert.deepEqual(
    assertLegacyProject({
      authProject: 'antboard-2025',
      dbProject: 'antboard-2025',
      storageProject: 'antboard-2025',
      storageBucket: 'antboard-2025.firebasestorage.app',
    }),
    { projectId: 'antboard-2025', storageBucket: 'antboard-2025.firebasestorage.app' },
  );
});
