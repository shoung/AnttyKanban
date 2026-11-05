import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { firestoreLinkRepository } from '../../server/mcpLinkStore.ts';
import { oauthBindingId, type McpOAuthBinding } from '../../server/mcpOAuth.ts';
import { createMcpLinkService, type LinkAttempt } from '../../server/mcpLink.ts';

test('link attempts consume once transactionally; bindings reject foreign reassignment/revocation in isolated emulator', async () => {
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
  const id = randomUUID(),
    uid = `link-fixture-${randomUUID()}`,
    timestamp = Date.now();
  const subject = `auth0|${id}`;
  const bindingId = oauthBindingId('https://fixture.auth0.com/', subject);
  const pageUid = `page-${uid}`;
  const pageIds = Array.from({ length: 52 }, (_, i) =>
    oauthBindingId('https://fixture.auth0.com/', `${subject}-${i}`),
  );
  const repository = firestoreLinkRepository(db);
  const attempt: Omit<LinkAttempt, 'revocationEpoch'> = {
    ownerUid: uid,
    createdAt: timestamp,
    expiresAt: timestamp + 300_000,
    firebaseAuthTime: timestamp - 1000,
    nonce: 'n'.repeat(43),
    verifier: 'v'.repeat(43),
    browserHash: 'b'.repeat(64),
    fingerprint: 'fixture',
  };
  const binding: McpOAuthBinding = {
    schemaVersion: 1,
    issuer: 'https://fixture.auth0.com/',
    subject,
    ownerUid: uid,
    clientIds: ['fixture-chatgpt'],
    scopes: ['maps:read'],
    enabled: true,
    firebaseAuthTime: timestamp - 1000,
    validAfter: timestamp,
    expiresAt: timestamp + 86_400_000,
  };
  try {
    await repository.put(id, attempt);
    assert.ok(
      (await db.doc(`mcpOAuthLinkAttempts/${id}`).get()).get('deleteAfter').toDate() instanceof
        Date,
    );
    await assert.rejects(repository.take(id, 'wrong-browser', 'fixture', timestamp));
    const outcomes = await Promise.allSettled([
      repository.take(id, attempt.browserHash, 'fixture', timestamp),
      repository.take(id, attempt.browserHash, 'fixture', timestamp),
    ]);
    assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1);
    const consumed = outcomes.find(
      (row): row is PromiseFulfilledResult<LinkAttempt> => row.status === 'fulfilled',
    )!.value;
    assert.equal((await db.doc(`mcpOAuthLinkAttempts/${id}`).get()).exists, false);
    await repository.bind(bindingId, binding, consumed);
    assert.deepEqual(
      (await repository.list(uid)).map((row) => row.id),
      [bindingId],
    );
    assert.deepEqual(await repository.list('foreign-user'), []);
    await assert.rejects(
      repository.bind(bindingId, { ...binding, ownerUid: 'foreign-user' }, consumed),
    );
    await assert.rejects(repository.revoke('foreign-user', bindingId));
    await repository.revoke(uid, bindingId);
    assert.equal((await db.doc(`mcpOAuthBindings/${bindingId}`).get()).get('enabled'), false);
    const batch = db.batch();
    for (const [i, pageId] of pageIds.entries())
      batch.set(db.doc(`mcpOAuthBindings/${pageId}`), {
        ...binding,
        ownerUid: pageUid,
        subject: `${subject}-${i}`,
      });
    await batch.commit();
    const first = await repository.list(pageUid);
    assert.equal(first.length, 51);
    const next = await repository.list(pageUid, first[49].id);
    assert.equal(next.length, 2);
    assert.ok(next.every((row) => !first.slice(0, 50).some((old) => old.id === row.id)));
    assert.equal(new Set([...first.slice(0, 50), ...next].map((row) => row.id)).size, 52);
    // A revoked subject still cannot be claimed by a different Firebase owner.
    await assert.rejects(
      repository.bind(bindingId, { ...binding, ownerUid: 'foreign-user' }, consumed),
    );
    // An already-started callback must never undo an explicit local revocation.
    await assert.rejects(
      repository.bind(bindingId, { ...binding, firebaseAuthTime: timestamp }, consumed),
    );
    await repository.put(`${id}-fresh`, attempt);
    const fresh = await repository.take(`${id}-fresh`, attempt.browserHash, 'fixture', timestamp);
    await repository.bind(bindingId, { ...binding, firebaseAuthTime: timestamp }, fresh);
    assert.equal((await db.doc(`mcpOAuthBindings/${bindingId}`).get()).get('enabled'), true);
    // Exercise the whole callback ordering, not only a direct repository call.
    let resume!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const exchanging = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = createMcpLinkService(
      {
        oauth: {
          issuer: binding.issuer,
          jwksUri: `${binding.issuer}.well-known/jwks.json`,
          resource: 'https://antty.example/api/mcp',
          metadataUrl: '',
          scopes: ['maps:read'],
          clientIds: binding.clientIds,
          algorithm: 'RS256',
        },
        clientId: 'link-public',
        callbackUrl: 'https://antty.example/api/mcp-link?action=callback',
      },
      {
        repository,
        now: () => timestamp,
        getAccount: async () => ({ disabled: false }),
        async exchange() {
          entered();
          await paused;
          return subject;
        },
      },
    );
    const started = await service.begin({ uid, authTime: timestamp - 1000 });
    const pending = service.complete({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'code',
      browserSecret: started.browserSecret,
      issuer: binding.issuer,
    });
    await exchanging;
    try {
      await repository.revoke(uid, bindingId);
    } finally {
      resume();
    }
    await assert.rejects(pending, (error: unknown) => (error as { status: number }).status === 400);
    assert.equal((await db.doc(`mcpOAuthBindings/${bindingId}`).get()).get('enabled'), false);
  } finally {
    await db.doc(`mcpOAuthLinkAttempts/${id}`).delete();
    await db.doc(`mcpOAuthLinkAttempts/${id}-fresh`).delete();
    await db.doc(`mcpOAuthBindings/${bindingId}`).delete();
    await db.doc(`mcpOAuthLinkOwners/${uid}`).delete();
    const cleanup = db.batch();
    for (const pageId of pageIds) cleanup.delete(db.doc(`mcpOAuthBindings/${pageId}`));
    await cleanup.commit();
    await db.terminate();
  }
});
