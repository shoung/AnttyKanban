/** Local review preparation only. No cloud calls, writes or deployment. */
import { createHash } from 'node:crypto';

// Reviewed deny-by-default drafts at main 5c3e58b. Updating either base requires
// deliberately reviewing/pinning it again, never merging unknown matching allows.
const reviewedHashes = {
  firestore: 'c91f4743929c8ca01a5bb15f3a70fde4f5ff26889e2f9cdc518e39ff180ad485',
  storage: '678671788e4e97634555c1f32b8f97f3daa47b8dcc605eed7f054153ab992f58',
};
const ruleHash = (source: string) =>
  createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
export function prepareLegacyOwnerRules(
  sources: { firestore: string; storage: string },
  verifiedOwnerUid: string,
) {
  // This workflow is for an explicitly verified Google-linked Firebase UID.
  // Never infer ownership from email, updatedBy or the first signed-in user.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(verifiedOwnerUid))
    throw new Error('An explicitly verified owner UID is required');
  const firestoreAnchor = '  match /databases/{database}/documents {';
  const storageAnchor = '  match /b/{bucket}/o {';
  if (
    sources.firestore.split(firestoreAnchor).length !== 2 ||
    sources.storage.split(storageAnchor).length !== 2 ||
    !sources.firestore.includes('match /{path=**} { allow read, write: if false; }') ||
    !sources.storage.includes('match /{path=**} { allow read, write: if false; }')
  )
    throw new Error('Unexpected rule draft; review the base policy first');
  if (
    /match\s*\/boards\s*\/default\s*\{/.test(sources.firestore) ||
    /match\s*\/task-images\s*\//.test(sources.storage) ||
    /allow\s+read\s*,\s*write\s*:\s*if\s+request.auth\s*!=\s*null\s*;/.test(
      sources.firestore + sources.storage,
    )
  )
    throw new Error('Existing legacy allows must be replaced, never overlapped');
  if (
    ruleHash(sources.firestore) !== reviewedHashes.firestore ||
    ruleHash(sources.storage) !== reviewedHashes.storage
  )
    throw new Error(
      'Unreviewed rule base; review all overlapping allows before preparing legacy access',
    );
  const owner = JSON.stringify(verifiedOwnerUid);
  const firestoreAddition = `
    // Legacy compatibility: verified owner only; no data migration or deletion.
    match /boards/default {
      allow read, write: if request.auth != null && request.auth.uid == ${owner};
    }`;
  const storageAddition = `
    // Legacy compatibility: verified owner only. Existing bearer URLs are unaffected.
    match /task-images/{fileName} {
      allow read, write: if request.auth != null && request.auth.uid == ${owner};
    }`;
  return {
    firestore: sources.firestore.replace(firestoreAnchor, firestoreAnchor + firestoreAddition),
    storage: sources.storage.replace(storageAnchor, storageAnchor + storageAddition),
    firestoreAddition,
    storageAddition,
  };
}
