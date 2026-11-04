import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLegacyMigration } from '../services/legacyMigration.ts';
const raw = {
  projects: [
    {
      id: 'p',
      name: 'Legacy',
      columns: [{ id: 'c', title: 'One', color: '#fff' }],
      tasks: [
        {
          id: 't',
          title: 'Task',
          columnId: 'c',
          tags: [],
          assignee: 'A',
          order: 0,
          comments: [],
          imagePath: 'task-images/old',
          imageUrl: 'https://example.invalid/legacy',
        },
      ],
    },
  ],
  updatedBy: 'last-editor-not-owner',
};
test('legacy migration pins explicit UID and preserves source IDs and attachments', () => {
  const plan = prepareLegacyMigration('verified-owner', raw, false);
  assert.equal(plan.targetPath, 'users/verified-owner/boards/default');
  assert.equal(plan.document.ownerUid, 'verified-owner');
  assert.equal(plan.document.projects[0].tasks[0].imagePath, 'task-images/old');
  assert.equal(plan.counts.tasks, 1);
  assert.equal(plan.counts.images, 1);
  assert.equal(plan.sourcePath, 'boards/default');
  assert.equal(plan.sourceHash.length, 64);
});
test('migration never overwrites an existing destination or guesses owner', () => {
  assert.throws(() => prepareLegacyMigration('', raw, false), /invalid/i);
  assert.throws(() => prepareLegacyMigration('owner', raw, true), /exists/i);
  assert.throws(() => prepareLegacyMigration('owner', { projects: 'broken' }, false), /invalid/i);
});
test('migration hash detects content changes and distinguishes destination UIDs', () => {
  const a = prepareLegacyMigration('alice', raw, false);
  const b = prepareLegacyMigration('bob', raw, false);
  const changed = prepareLegacyMigration('alice', { ...raw, updatedBy: 'someone-else' }, false);
  assert.equal(a.sourceHash, b.sourceHash);
  assert.notEqual(a.migrationId, b.migrationId);
  assert.notEqual(a.sourceHash, changed.sourceHash);
  assert.equal(
    a.sourceHash,
    prepareLegacyMigration('alice', { updatedBy: raw.updatedBy, projects: raw.projects }, false)
      .sourceHash,
  );
});
