import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';
import { prepareLegacyOwnerRules } from '../../server/legacyRules.ts';

let env: RulesTestEnvironment;
const owner = 'legacy-owner-fixture';
before(async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(?:127\.0\.0\.1|localhost):\d+$/);
  assert.match(
    process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '',
    /^(?:127\.0\.0\.1|localhost):\d+$/,
  );
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-antty-security');
  const rules = prepareLegacyOwnerRules(
    {
      firestore: await readFile(
        new URL('../../security/firestore.rules.draft', import.meta.url),
        'utf8',
      ),
      storage: await readFile(
        new URL('../../security/storage.rules.draft', import.meta.url),
        'utf8',
      ),
    },
    owner,
  );
  // Separate demo data namespace. Storage /internal/setRules is emulator-global,
  // so the security suite must load these rule variants serially.
  env = await initializeTestEnvironment({
    projectId: 'demo-antty-legacy-isolation',
    firestore: { rules: rules.firestore },
    storage: { rules: rules.storage },
  });
});
after(async () => {
  await env?.cleanup();
});

test('legacy owner keeps exact board access; new test users and anonymous callers cannot read, write or delete it', async () => {
  const own = env.authenticatedContext(owner).firestore(),
    other = env.authenticatedContext('pilot-user').firestore(),
    anon = env.unauthenticatedContext().firestore();
  const path = 'boards/default';
  await assertSucceeds(setDoc(doc(own, path), { projects: [], legacy: true }));
  await assertSucceeds(getDoc(doc(own, path)));
  await assertSucceeds(setDoc(doc(own, path), { projects: [], changed: true }));
  for (const db of [other, anon]) {
    await assertFails(getDoc(doc(db, path)));
    await assertFails(setDoc(doc(db, path), { projects: ['forged'] }));
    await assertFails(deleteDoc(doc(db, path)));
  }
  await assertFails(setDoc(doc(own, 'boards/another'), { legacy: true }));
  for (const path of [
    'mcpAuthRequests/private',
    'mcpAuthOwners/private',
    'mcpAuthGrants/private',
    'mcpAuthCodes/private',
    'mcpAuthTokens/private',
    'calendarConnections/private',
  ]) {
    await assertFails(getDoc(doc(own, path)));
    await assertFails(setDoc(doc(own, path), { probe: true }));
  }
});

test('legacy owner keeps flat attachment access; foreign/anonymous SDK access is denied without touching bearer tokens', async () => {
  const own = env.authenticatedContext(owner).storage(),
    other = env.authenticatedContext('pilot-user').storage(),
    anon = env.unauthenticatedContext().storage();
  const path = 'task-images/legacy-fixture';
  await assertSucceeds(
    uploadBytes(ref(own, path), new Uint8Array([1, 2, 3]), { contentType: 'image/png' }),
  );
  await assertSucceeds(getBytes(ref(own, path)));
  for (const storage of [other, anon]) {
    await assertFails(getBytes(ref(storage, path)));
    await assertFails(
      uploadBytes(ref(storage, path), new Uint8Array([4]), { contentType: 'image/png' }),
    );
    await assertFails(deleteObject(ref(storage, path)));
  }
  await assertFails(
    uploadBytes(ref(own, 'task-images/nested/unexpected'), new Uint8Array([1]), {
      contentType: 'image/png',
    }),
  );
});

test('owner-scoped board/map/image policy remains intact under the legacy compatibility rules', async () => {
  const uid = 'pilot-user',
    own = env.authenticatedContext(uid).firestore(),
    foreign = env.authenticatedContext(owner).firestore();
  const board = {
    ownerUid: uid,
    projects: [],
    schemaVersion: 1,
    revision: 1,
    updatedAt: serverTimestamp(),
  };
  await assertSucceeds(setDoc(doc(own, `users/${uid}/boards/default`), board));
  await assertFails(getDoc(doc(foreign, `users/${uid}/boards/default`)));
  await assertFails(setDoc(doc(own, `users/${uid}/boards/default`), board));
  const mapPath = `users/${uid}/mindmaps/test`;
  await assertSucceeds(
    setDoc(doc(own, mapPath), {
      ownerUid: uid,
      id: 'test',
      title: 'Synthetic',
      rootJson: '{}',
      schemaVersion: 1,
      revision: 1,
      updatedAt: '2026-11-05T00:00:00.000Z',
    }),
  );
  await assertFails(getDoc(doc(foreign, mapPath)));
  const storage = env.authenticatedContext(uid).storage(),
    foreignStorage = env.authenticatedContext(owner).storage(),
    imagePath = `users/${uid}/task-images/new`;
  await assertSucceeds(
    uploadBytes(ref(storage, imagePath), new Uint8Array([1]), { contentType: 'image/png' }),
  );
  await assertFails(getBytes(ref(foreignStorage, imagePath)));
  await assertFails(
    uploadBytes(ref(storage, imagePath), new Uint8Array([2]), { contentType: 'image/png' }),
  );
  await assertFails(deleteObject(ref(storage, imagePath)));
  await assertFails(
    uploadBytes(ref(storage, `users/${uid}/task-images/svg`), new Uint8Array([1]), {
      contentType: 'image/svg+xml',
    }),
  );
});
