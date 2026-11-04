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

let env: RulesTestEnvironment;
before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST)
    throw new Error(
      'Run only with Firebase emulators: never use a live project for security tests.',
    );
  env = await initializeTestEnvironment({
    projectId: 'demo-antty-security',
    firestore: {
      rules: await readFile(
        new URL('../../security/firestore.rules.draft', import.meta.url),
        'utf8',
      ),
    },
    storage: {
      rules: await readFile(new URL('../../security/storage.rules.draft', import.meta.url), 'utf8'),
    },
  });
});
after(async () => {
  await env?.cleanup();
});
const board = (uid: string, revision = 1) => ({
  ownerUid: uid,
  projects: [],
  revision,
  schemaVersion: 1,
  updatedAt: serverTimestamp(),
});
const map = (uid: string, id: string, revision = 1) => ({
  ownerUid: uid,
  id,
  title: 'Ideas',
  rootJson: JSON.stringify({ id: 'root', text: 'Root', children: [] }),
  revision,
  schemaVersion: 1,
  updatedAt: '2026-11-04T12:00:00.000Z',
});

test('boards isolate owner, reject anonymous, and enforce revision/shape', async () => {
  const a = env.authenticatedContext('alice').firestore();
  const b = env.authenticatedContext('bob').firestore();
  const anon = env.unauthenticatedContext().firestore();
  const path = 'users/alice/boards/default';
  await assertSucceeds(setDoc(doc(a, path), board('alice')));
  await assertSucceeds(getDoc(doc(a, path)));
  await assertFails(getDoc(doc(b, path)));
  await assertFails(getDoc(doc(anon, path)));
  await assertFails(setDoc(doc(b, path), board('bob', 2)));
  await assertFails(setDoc(doc(a, path), board('bob', 2)));
  await assertFails(setDoc(doc(a, path), board('alice', 1)));
  await assertFails(setDoc(doc(a, path), board('alice', 3)));
  await assertFails(setDoc(doc(a, path), { ...board('alice', 2), secret: 'not allowed' }));
  await assertFails(setDoc(doc(a, path), { ...board('alice', 2), projects: 'bad' }));
  await assertSucceeds(setDoc(doc(a, path), board('alice', 2)));
  await assertFails(deleteDoc(doc(a, path)));
  await assertFails(setDoc(doc(a, 'users/alice/boards/other'), board('alice')));
  await assertFails(setDoc(doc(b, 'users/bob/boards/default'), board('bob', 2)));
});

test('maps enforce owner, document ID, bounded title and revision', async () => {
  const a = env.authenticatedContext('mapper').firestore();
  const b = env.authenticatedContext('intruder').firestore();
  const path = 'users/mapper/mindmaps/map1';
  await assertSucceeds(setDoc(doc(a, path), map('mapper', 'map1')));
  await assertSucceeds(getDoc(doc(a, path)));
  await assertFails(getDoc(doc(b, path)));
  await assertFails(setDoc(doc(a, path), map('mapper', 'wrong', 2)));
  await assertFails(setDoc(doc(a, path), { ...map('mapper', 'map1', 2), title: 'x'.repeat(201) }));
  await assertFails(setDoc(doc(a, path), { ...map('mapper', 'map1', 2), rootJson: [] }));
  await assertFails(setDoc(doc(a, path), map('mapper', 'map1', 1)));
  await assertSucceeds(setDoc(doc(a, path), map('mapper', 'map1', 2)));
  await assertFails(deleteDoc(doc(a, path)));
});

test('legacy and credential paths remain inaccessible from client SDK', async () => {
  const a = env.authenticatedContext('alice').firestore();
  for (const path of [
    'boards/default',
    'calendarConnections/alice',
    'calendarOAuthStates/state',
    'mcpTokens/token',
    'users/alice/calendarConnections/google',
    'users/alice/mcpTokens/token',
  ]) {
    await assertFails(getDoc(doc(a, path)));
    await assertFails(setDoc(doc(a, path), { value: 'probe' }));
  }
});

test('storage rejects foreign reads, unsafe formats, oversized and mutable objects', async () => {
  const a = env.authenticatedContext('uploader').storage();
  const b = env.authenticatedContext('other').storage();
  const path = 'users/uploader/task-images/photo';
  await assertSucceeds(
    uploadBytes(ref(a, path), new Uint8Array([1, 2, 3]), { contentType: 'image/png' }),
  );
  await assertSucceeds(getBytes(ref(a, path)));
  await assertFails(getBytes(ref(b, path)));
  await assertFails(uploadBytes(ref(a, path), new Uint8Array([4]), { contentType: 'image/png' }));
  await assertFails(deleteObject(ref(a, path)));
  await assertFails(
    uploadBytes(ref(b, 'users/uploader/task-images/foreign'), new Uint8Array([1]), {
      contentType: 'image/png',
    }),
  );
  await assertFails(
    uploadBytes(ref(a, 'users/uploader/task-images/svg'), new Uint8Array([1]), {
      contentType: 'image/svg+xml',
    }),
  );
  await assertFails(
    uploadBytes(ref(a, 'users/uploader/task-images/large'), new Uint8Array(10 * 1024 * 1024 + 1), {
      contentType: 'image/png',
    }),
  );
});

test('serialized 32-level trees avoid Firestore nested field depth limits and reject raw root', async () => {
  const a = env.authenticatedContext('deep-mapper').firestore();
  const path = 'users/deep-mapper/mindmaps/deep';
  type Node = { id: string; text: string; children: Node[] };
  let root: Node = { id: 'n31', text: 'Leaf', children: [] };
  for (let level = 30; level >= 0; level--)
    root = { id: `n${level}`, text: 'Branch', children: [root] };
  const rootJson = JSON.stringify(root);
  await assertSucceeds(setDoc(doc(a, path), { ...map('deep-mapper', 'deep'), rootJson }));
  const result = await assertSucceeds(getDoc(doc(a, path)));
  assert.equal(result.data()?.rootJson, rootJson);
  await assertFails(
    setDoc(doc(a, path), {
      ...map('deep-mapper', 'deep', 2),
      rootJson,
      root: { id: 'raw', text: 'Extra', children: [] },
    }),
  );
  await assertFails(
    setDoc(doc(a, path), { ...map('deep-mapper', 'deep', 2), rootJson: 'x'.repeat(512001) }),
  );
});
