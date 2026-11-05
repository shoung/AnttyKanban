import test from 'node:test';
import assert from 'node:assert/strict';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { firestoreOAuthRepository } from '../../server/mcpFirebaseOAuthStore.ts';
import { oauthFixture } from '../fixtures/firebase-oauth.ts';
import { firestoreOAuthCleanupStore, runOAuthCleanup } from '../../server/mcpOAuthCleanup.ts';
import { createHash } from 'node:crypto';

test('Firebase OAuth real Firestore transactions reject code replay and consent after revocation in demo emulator', async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(?:127\.0\.0\.1|localhost):\d+$/);
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-antty-security');
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: 'owner', expiry_date: Date.now() + 3600000 });
  const db = new Firestore({
    projectId: 'demo-antty-security',
    host: process.env.FIRESTORE_EMULATOR_HOST,
    ssl: false,
    auth: new GoogleAuth({ projectId: 'demo-antty-security', authClient }),
  });
  try {
    const f = oauthFixture(firestoreOAuthRepository(db), `oauth-${randomUUID()}`);
    const { code } = await f.approve();
    const exchanges = await Promise.allSettled([f.exchange(code), f.exchange(code)]);
    assert.equal(exchanges.filter((x) => x.status === 'fulfilled').length, 1);
    const first = exchanges.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof f.exchange>>
    >;
    // A correctly authenticated replay revokes the successfully issued grant as RFC6749 recommends.
    await assert.rejects(f.service.authenticate(first.value.access_token));
    const second = await f.approve();
    const token = await f.exchange(second.code);
    const pending = await f.begin();
    const grant = (await f.service.list(f.identity.uid)).find((g) => g.enabled)!;
    await f.service.revoke(f.identity.uid, grant.id);
    await assert.rejects(f.service.decide(f.identity, pending.id, pending.browserSecret, true));
    await assert.rejects(f.service.authenticate(token.access_token));
    // Revocation and exchange overlap: either exchange fails, or its token cannot be used afterward.
    const next = await f.approve();
    const active = (await f.service.list(f.identity.uid)).find((g) => g.enabled)!;
    const race = await Promise.allSettled([
      f.exchange(next.code),
      f.service.revoke(f.identity.uid, active.id),
    ]);
    assert.equal(race[1].status, 'fulfilled');
    if (race[0].status === 'fulfilled')
      await assert.rejects(f.service.authenticate(race[0].value.access_token));

    const expiredId = createHash('sha256').update(randomUUID()).digest('hex'),
      activeId = createHash('sha256').update(randomUUID()).digest('hex');
    const cutoff = Date.now() - 86_400_000,
      expired = db.collection('mcpAuthRequests').doc(expiredId),
      live = db.collection('mcpAuthRequests').doc(activeId);
    await expired.set({
      expiresAt: cutoff - 1000,
      ownerUid: f.identity.uid,
      browserHash: 'never-print-sensitive-fixture',
    });
    await live.set({ expiresAt: Date.now() + 300000, ownerUid: f.identity.uid });
    const cleanup = firestoreOAuthCleanupStore(db),
      plan = await runOAuthCleanup(cleanup, { table: 'requests', cutoff });
    assert.doesNotMatch(JSON.stringify(plan), /never-print-sensitive-fixture/);
    const candidate = plan.rows.find((r) => r.id === expiredId)!;
    assert.ok(candidate);
    await expired.update({ changed: true });
    assert.equal(await cleanup.remove('mcpAuthRequests', candidate, cutoff), false);
    await assert.rejects(
      runOAuthCleanup(cleanup, {
        table: 'requests',
        cutoff,
        apply: true,
        expectedHash: plan.planHash,
      }),
    );
    const reviewed = await runOAuthCleanup(cleanup, { table: 'requests', cutoff });
    await runOAuthCleanup(cleanup, {
      table: 'requests',
      cutoff,
      apply: true,
      expectedHash: reviewed.planHash,
    });
    assert.equal((await expired.get()).exists, false);
    assert.equal((await live.get()).exists, true);
  } finally {
    await db.terminate();
  }
});
