import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { firestoreLinkCleanupStore, runLinkCleanup } from '../../server/mcpLinkCleanup.ts';

test('manual cleanup transactions preserve live, foreign, changed and non-attempt documents in isolated emulator', async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(?:127\.0\.0\.1|localhost):\d+$/);
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-antty-security');
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: 'owner', expiry_date: Date.now() + 3_600_000 });
  const db = new Firestore({
    projectId: 'demo-antty-security',
    host: process.env.FIRESTORE_EMULATOR_HOST,
    ssl: false,
    auth: new GoogleAuth({ projectId: 'demo-antty-security', authClient }),
  });
  const uid = `cleanup-fixture-${randomUUID()}`;
  const ids = Array.from({ length: 4 }, () =>
    createHash('sha256').update(randomUUID()).digest('hex'),
  );
  const paths = ids.map((id) => `mcpOAuthLinkAttempts/${id}`);
  const binding = `mcpOAuthBindings/${ids[0]}`,
    owner = `mcpOAuthLinkOwners/${uid}`;
  const timestamp = Date.now();
  const row = {
    ownerUid: uid,
    createdAt: timestamp - 7_500_000,
    expiresAt: timestamp - 7_200_000,
    nonce: 'synthetic-private-nonce',
    verifier: 'synthetic-private-verifier',
  };
  const store = firestoreLinkCleanupStore(db);
  const input = { uid, cutoff: timestamp - 3_600_000, limit: 100 };
  try {
    const seed = db.batch();
    seed.set(db.doc(paths[0]), row);
    seed.set(db.doc(paths[1]), { ...row, createdAt: timestamp, expiresAt: timestamp + 300_000 });
    seed.set(db.doc(paths[2]), { ...row, ownerUid: `${uid}-foreign` });
    seed.set(db.doc(paths[3]), { ...row, expiresAt: 'malformed' });
    seed.set(db.doc(binding), { ownerUid: uid, enabled: false });
    seed.set(db.doc(owner), { ownerUid: uid, epoch: 'e'.repeat(43) });
    await seed.commit();
    const plan = await runLinkCleanup(store, input, { now: timestamp });
    assert.equal(plan.scanned, 3);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].id, ids[0]);
    assert.equal(JSON.stringify(plan).includes('synthetic-private'), false);
    assert.equal((await db.doc(paths[0]).get()).exists, true);
    await db.doc(paths[0]).update({ changed: true });
    assert.equal(await store.remove(uid, plan.candidates[0], input.cutoff), false);
    await assert.rejects(
      runLinkCleanup(store, input, { now: timestamp, apply: true, expectedHash: plan.planHash }),
    );
    const fresh = await runLinkCleanup(store, input, { now: timestamp });
    const applied = await runLinkCleanup(store, input, {
      now: timestamp,
      apply: true,
      expectedHash: fresh.planHash,
    });
    assert.equal(applied.deleted, 1);
    assert.equal((await db.doc(paths[0]).get()).exists, false);
    for (const path of [...paths.slice(1), binding, owner])
      assert.equal((await db.doc(path).get()).exists, true);
    assert.equal((await db.doc(binding).get()).get('enabled'), false);
    assert.equal((await db.doc(owner).get()).get('epoch'), 'e'.repeat(43));
  } finally {
    const cleanup = db.batch();
    for (const path of [...paths, binding, owner]) cleanup.delete(db.doc(path));
    await cleanup.commit();
    await db.terminate();
  }
});
