import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  runLinkCleanup,
  parseLinkCleanupArgs,
  type CleanupStore,
  type CleanupRow,
} from '../server/mcpLinkCleanup.ts';

const NOW = 1_800_000_000_000;
const id = (n: number) => n.toString(16).padStart(64, '0');
const expired = (n: number): CleanupRow => ({
  id: id(n),
  ownerUid: 'alice',
  createdAt: NOW - 7_500_000,
  expiresAt: NOW - 7_200_000,
  version: 'v1',
});
function fixture() {
  const privateRow = {
    ...expired(1),
    nonce: 'fixture-private-nonce',
    verifier: 'fixture-private-verifier',
  };
  const rows = new Map<string, CleanupRow>([
    [id(1), privateRow],
    [id(2), { ...expired(2), createdAt: NOW - 1000, expiresAt: NOW + 299_000 }],
    [id(3), { ...expired(3), ownerUid: 'bob' }],
    [id(4), { ...expired(4), expiresAt: 'malformed' }],
  ]);
  const deletes: string[] = [];
  let changeOnDelete = false;
  const store: CleanupStore = {
    async page(uid, after, limit) {
      return [...rows.values()]
        .filter((row) => row.ownerUid === uid && (!after || row.id > after))
        .slice(0, limit);
    },
    async remove(uid, candidate, cutoff) {
      if (changeOnDelete) return false;
      const row = rows.get(candidate.id);
      if (
        !row ||
        row.ownerUid !== uid ||
        row.version !== candidate.version ||
        typeof row.expiresAt !== 'number' ||
        row.expiresAt > cutoff
      )
        return false;
      rows.delete(row.id);
      deletes.push(row.id);
      return true;
    },
  };
  return {
    store,
    rows,
    deletes,
    change: () => {
      changeOnDelete = true;
    },
  };
}
const input = { uid: 'alice', cutoff: NOW - 3_600_000, limit: 100 };
test('cleanup dry-run plans only old, well-formed attempts for the exact owner without writing or exposing secrets', async () => {
  const f = fixture();
  const result = await runLinkCleanup(f.store, input, { now: NOW });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.scanned, 3);
  assert.deepEqual(
    result.candidates.map((row) => row.id),
    [id(1)],
  );
  assert.equal(result.deleted, 0);
  assert.equal(f.rows.size, 4);
  assert.deepEqual(f.deletes, []);
  assert.match(result.planHash, /^[a-f0-9]{64}$/);
  assert.equal('ownerUid' in result.candidates[0], false);
  assert.equal(JSON.stringify(result).includes('fixture-private'), false);
});

test('operator CLI fails closed with no credentials and missing arguments, without SDK errors or token output', async () => {
  await assert.rejects(
    promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/mcp-link-cleanup.ts'], {
      env: { NODE_ENV: 'production' },
      timeout: 10_000,
    }),
    (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, '');
      assert.match(failure.stderr, /^Cleanup unavailable or invalid arguments\./);
      assert.doesNotMatch(failure.stderr, /MetadataLookup|Error:|Credential|nonce|verifier/);
      return true;
    },
  );
});
test('cleanup refuses a mismatched/unreviewed plan and a cutoff newer than one hour', async () => {
  const f = fixture();
  await assert.rejects(runLinkCleanup(f.store, input, { now: NOW, apply: true }));
  await assert.rejects(
    runLinkCleanup(f.store, input, { now: NOW, apply: true, expectedHash: 'a'.repeat(64) }),
  );
  await assert.rejects(runLinkCleanup(f.store, { ...input, cutoff: NOW - 1000 }, { now: NOW }));
  await assert.rejects(runLinkCleanup(f.store, { ...input, uid: '../bob' }, { now: NOW }));
  assert.deepEqual(f.deletes, []);
});
test('reviewed apply deletes only candidates and preserves concurrent changes; changed plans require a fresh review', async () => {
  const f = fixture();
  const plan = await runLinkCleanup(f.store, input, { now: NOW });
  const applied = await runLinkCleanup(f.store, input, {
    now: NOW,
    apply: true,
    expectedHash: plan.planHash,
  });
  assert.equal(applied.deleted, 1);
  assert.deepEqual(f.deletes, [id(1)]);
  assert.ok(f.rows.has(id(2)) && f.rows.has(id(3)) && f.rows.has(id(4)));
  const changed = fixture();
  const old = await runLinkCleanup(changed.store, input, { now: NOW });
  changed.rows.set(id(5), expired(5));
  await assert.rejects(
    runLinkCleanup(changed.store, input, { now: NOW, apply: true, expectedHash: old.planHash }),
  );
  const concurrent = fixture();
  const before = await runLinkCleanup(concurrent.store, input, { now: NOW });
  concurrent.change();
  const preserved = await runLinkCleanup(concurrent.store, input, {
    now: NOW,
    apply: true,
    expectedHash: before.planHash,
  });
  assert.equal(preserved.deleted, 0);
  assert.equal(preserved.changed, 1);
});
test('CLI requires an explicit exact project, owner and UTC cutoff; apply requires a reviewed hash, never implicit credentials', () => {
  const args = [
    '--project',
    'antboard-2025',
    '--owner-uid',
    'alice',
    '--expired-before',
    '2026-01-01T00:00:00.000Z',
  ];
  assert.equal(parseLinkCleanupArgs(args).apply, false);
  assert.throws(() => parseLinkCleanupArgs([]));
  assert.throws(() => parseLinkCleanupArgs([...args, '--apply']));
  assert.throws(() => parseLinkCleanupArgs([...args, '--unknown', 'x']));
  assert.throws(() => parseLinkCleanupArgs([...args, '--owner-uid', 'bob']));
  assert.throws(() =>
    parseLinkCleanupArgs(
      args.map((value) => (value === 'antboard-2025' ? 'other-project' : value)),
    ),
  );
  assert.throws(() =>
    parseLinkCleanupArgs(args.map((value) => (value.startsWith('2026-') ? '2026-01-01' : value))),
  );
  assert.equal(
    parseLinkCleanupArgs([...args, '--apply', '--expected-plan-hash', 'a'.repeat(64)]).apply,
    true,
  );
});
