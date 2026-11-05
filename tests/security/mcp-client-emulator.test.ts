import test from 'node:test';
import assert from 'node:assert/strict';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { firestoreWorkspaceStore } from '../../server/mcpData.ts';
import { runMcpCrudAcceptance } from '../fixtures/mcp-client.ts';

test('SDK MCP HTTP CRUD persists only isolated demo-emulator workspace documents', async () => {
  // This is an unconditional local-only guard, not a flag that permits production writes.
  assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(?:127\.0\.0\.1|localhost):\d+$/);
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-antty-security');
  // The emulator's reserved owner credential is synthetic; do not discover ambient ADC.
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: 'owner', expiry_date: Date.now() + 3_600_000 });
  const db = new Firestore({
    projectId: 'demo-antty-security',
    host: process.env.FIRESTORE_EMULATOR_HOST,
    ssl: false,
    auth: new GoogleAuth({ projectId: 'demo-antty-security', authClient }),
  });
  try {
    const result = await runMcpCrudAcceptance(firestoreWorkspaceStore(db));
    const row = await db.doc(`users/${result.uid}/boards/default`).get();
    assert.equal(row.data()?.ownerUid, result.uid);
    assert.equal(row.data()?.revision, 11);
    assert.deepEqual(row.data()?.projects, []);
    assert.equal((await db.collection(`users/${result.uid}/mindmaps`).get()).size, 0);
  } finally {
    await db.terminate();
  }
});
