import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareLegacyOwnerRules } from '../server/legacyRules.ts';

test('legacy rule preparation adds only exact owner matches and leaves modern/private policy unchanged', async () => {
  const firestore = await readFile(
    new URL('../security/firestore.rules.draft', import.meta.url),
    'utf8',
  );
  const storage = await readFile(
    new URL('../security/storage.rules.draft', import.meta.url),
    'utf8',
  );
  const result = prepareLegacyOwnerRules({ firestore, storage }, 'verified-fixture-owner');
  assert.match(result.firestore, /match \/boards\/default/);
  assert.match(result.storage, /match \/task-images\/\{fileName\}/);
  for (const source of [result.firestore, result.storage]) {
    assert.match(source, /request.auth.uid == "verified-fixture-owner"/);
    assert.doesNotMatch(source, /allow read, write: if request.auth != null;/);
    assert.match(source, /match \/\{path=\*\*\} \{ allow read, write: if false; \}/);
  }
  assert.equal(result.firestore.replace(result.firestoreAddition, ''), firestore);
  assert.equal(result.storage.replace(result.storageAddition, ''), storage);
  const wildcardBoard = firestore.replace(
    '  match /databases/{database}/documents {',
    '  match /databases/{database}/documents {\n    match /boards/{boardId} { allow read: if request.auth != null; }',
  );
  assert.throws(
    () => prepareLegacyOwnerRules({ firestore: wildcardBoard, storage }, 'owner'),
    /review|legacy/i,
  );
  const wildcardStorage = storage.replace(
    '  match /b/{bucket}/o {',
    '  match /b/{bucket}/o {\n    match /{anything=**} { allow read: if true; }',
  );
  assert.throws(
    () => prepareLegacyOwnerRules({ firestore, storage: wildcardStorage }, 'owner'),
    /review|legacy/i,
  );
  assert.throws(
    () => prepareLegacyOwnerRules({ firestore: result.firestore, storage }, 'other'),
    /legacy/i,
  );
  assert.throws(
    () => prepareLegacyOwnerRules({ firestore, storage: result.storage }, 'other'),
    /legacy/i,
  );
  for (const uid of ['', '../escape', 'unverified"; allow read, write: if true;', 'a'.repeat(129)])
    assert.throws(() => prepareLegacyOwnerRules({ firestore, storage }, uid));
  assert.throws(() =>
    prepareLegacyOwnerRules({ firestore: 'unexpected live policy', storage }, 'owner'),
  );
});
