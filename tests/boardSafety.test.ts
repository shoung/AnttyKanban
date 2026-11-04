import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boardPath,
  decodeBoard,
  prepareBoardWrite,
  AccountEpoch,
} from '../services/boardSafety.ts';

const projects = [
  { id: 'p', name: 'A', columns: [{ id: 'c', title: 'To do', color: '#fff' }], tasks: [] },
];
test('board path cannot escape the authenticated account', () => {
  assert.equal(boardPath('alice'), 'users/alice/boards/default');
  for (const uid of ['', '../alice', 'a/b']) assert.throws(() => boardPath(uid), /invalid/i);
});
test('missing personal board is empty, not seeded from shared content', () => {
  assert.deepEqual(decodeBoard('alice', null), { ownerUid: 'alice', projects: [], revision: 0 });
});
test('stored owner mismatch and malformed boards fail closed', () => {
  assert.throws(
    () => decodeBoard('alice', { ownerUid: 'bob', projects, revision: 1, schemaVersion: 1 }),
    /invalid/i,
  );
  assert.throws(
    () =>
      decodeBoard('alice', { ownerUid: 'alice', projects: 'bad', revision: 1, schemaVersion: 1 }),
    /invalid/i,
  );
  assert.throws(
    () => decodeBoard('alice', { ownerUid: 'alice', projects, revision: -1, schemaVersion: 1 }),
    /invalid/i,
  );
});
test('stale revision cannot overwrite newer remote board', () => {
  assert.throws(
    () =>
      prepareBoardWrite('alice', projects, 1, {
        ownerUid: 'alice',
        projects,
        revision: 2,
        schemaVersion: 1,
      }),
    /conflict/i,
  );
});
test('creation starts at revision one and updates advance exactly once', () => {
  const created = prepareBoardWrite('alice', projects, 0, null);
  assert.equal(created.revision, 1);
  assert.equal(created.ownerUid, 'alice');
  assert.equal(prepareBoardWrite('alice', [], 1, created).revision, 2);
  assert.throws(() => prepareBoardWrite('alice', projects, 1, null), /conflict/i);
});
test('invalid task reference is rejected rather than silently dropped', () => {
  assert.throws(
    () =>
      prepareBoardWrite(
        'alice',
        [
          {
            ...projects[0],
            tasks: [
              {
                id: 't',
                title: 'Task',
                columnId: 'missing',
                tags: [],
                assignee: '',
                order: 0,
                comments: [],
              },
            ],
          },
        ],
        0,
        null,
      ),
    /invalid/i,
  );
});
test('switching accounts or signing out invalidates late callbacks', () => {
  const scope = new AccountEpoch();
  const a = scope.switchTo('alice');
  assert.equal(scope.isCurrent(a), true);
  const b = scope.switchTo('bob');
  assert.equal(scope.isCurrent(a), false);
  assert.equal(scope.isCurrent(b), true);
  scope.switchTo(null);
  assert.equal(scope.isCurrent(b), false);
});
test('returning to same account does not revive an old operation', () => {
  const scope = new AccountEpoch();
  const a = scope.switchTo('alice');
  scope.switchTo('bob');
  scope.switchTo('alice');
  assert.equal(scope.isCurrent(a), false);
});

test('attachment validation rejects oversized or active image content', async () => {
  const { attachmentPath } = await import('../services/boardSafety.ts');
  assert.throws(() => attachmentPath('alice', 'image/svg+xml', 1024, 'photo'), /invalid/i);
  assert.throws(() => attachmentPath('alice', 'image/png', 11 * 1024 * 1024, 'photo'), /invalid/i);
  assert.throws(() => attachmentPath('alice', 'image/png', 20, '../escape'), /invalid/i);
  assert.equal(
    attachmentPath('alice', 'image/png', 1024, 'unique-id'),
    'users/alice/task-images/unique-id',
  );
});

test('private attachment selection never falls back to a bearer URL across owners', async () => {
  const { attachmentSource } = await import('../services/boardSafety.ts');
  assert.deepEqual(
    attachmentSource('alice', 'users/alice/task-images/id', 'https://example.invalid/token'),
    { kind: 'private', path: 'users/alice/task-images/id' },
  );
  assert.deepEqual(
    attachmentSource('bob', 'users/alice/task-images/id', 'https://example.invalid/token'),
    { kind: 'none' },
  );
  assert.deepEqual(
    attachmentSource(null, 'users/alice/task-images/id', 'https://example.invalid/token'),
    { kind: 'none' },
  );
  assert.deepEqual(attachmentSource('alice', 'task-images/old', 'https://example.invalid/old'), {
    kind: 'legacy',
    url: 'https://example.invalid/old',
  });
  assert.deepEqual(attachmentSource('alice', 'task-images/old', 'javascript:alert(1)'), {
    kind: 'none',
  });
});
