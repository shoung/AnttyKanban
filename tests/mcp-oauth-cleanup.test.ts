import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  parseOAuthCleanupArgs,
  runOAuthCleanup,
  type OAuthCleanupStore,
} from '../server/mcpOAuthCleanup.ts';

test('OAuth cleanup is bounded, dry-run first, secret-free and requires exact reviewed plan with rechecks', async () => {
  const now = 1_800_000_000_000,
    cutoff = now - 86_400_000;
  let removals = 0;
  const store: OAuthCleanupStore = {
    page: async () => [{ id: 'a'.repeat(64), expiresAt: cutoff - 1, version: '1:1' }],
    remove: async () => {
      removals++;
      return false;
    },
  };
  const plan = await runOAuthCleanup(store, { table: 'requests', cutoff }, now);
  assert.equal(removals, 0);
  assert.equal(plan.mode, 'dry-run');
  await assert.rejects(runOAuthCleanup(store, { table: 'owners', cutoff }, now));
  await assert.rejects(runOAuthCleanup(store, { table: 'requests', cutoff: now }, now));
  await assert.rejects(
    runOAuthCleanup(
      store,
      { table: 'requests', cutoff, apply: true, expectedHash: 'b'.repeat(64) },
      now,
    ),
  );
  assert.equal(removals, 0);
  const result = await runOAuthCleanup(
    store,
    { table: 'requests', cutoff, apply: true, expectedHash: plan.planHash },
    now,
  );
  assert.equal(result.changed, 1);
  assert.equal(result.deleted, 0);
  await assert.rejects(
    runOAuthCleanup(
      { ...store, page: async () => Array(101).fill(plan.rows[0]) },
      { table: 'requests', cutoff },
      now,
    ),
  );
});
test('cleanup CLI validates explicit project and cutoff before credentials, and never prints environment or errors', () => {
  assert.throws(() =>
    parseOAuthCleanupArgs([
      '--project',
      'other',
      '--table',
      'tokens',
      '--expired-before',
      '2026-01-01T00:00:00.000Z',
    ]),
  );
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/mcp-oauth-cleanup.ts'], {
    encoding: 'utf8',
    env: { ...process.env, FIREBASE_PROJECT_ID: 'do-not-disclose-fixture' },
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-disclose-fixture|at .*\.ts/);
});
