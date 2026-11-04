/** Admin-only, DRY RUN by default. Never invoke against production without approved verified UID. */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { prepareLegacyMigration } from '../services/legacyMigration.ts';

const args = process.argv.slice(2);
function arg(name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const uid = arg('--verified-target-uid');
const backupDir = arg('--backup-dir');
const apply = args.includes('--apply');
const approvedHash = arg('--expected-source-hash');
if (!uid || !backupDir || (apply && !/^[a-f0-9]{64}$/.test(approvedHash || ''))) {
  throw new Error(
    'Usage: --verified-target-uid UID --backup-dir PRIVATE_DIRECTORY [--apply --expected-source-hash REVIEWED_SHA256]. Dry-run is default.',
  );
}
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)
  throw new Error(
    'Use migration unit fixtures for emulators; this guarded operator tool requires verified production identity.',
  );
// Uses already-authorized ambient credentials. Does not create or install credentials.
initializeApp({ credential: applicationDefault(), projectId: 'antboard-2025' });
const auth = getAuth();
const user = await auth.getUser(uid);
if (user.disabled || !user.providerData.some((p) => p.providerId === 'google.com'))
  throw new Error('Destination must be an enabled, verified Google-linked Firebase user.');
const db = getFirestore();
const source = db.doc('boards/default');
const sourceSnapshot = await source.get();
if (!sourceSnapshot.exists)
  throw new Error('Legacy source is missing. No destination was created.');
const target = db.doc(`users/${uid}/boards/default`);
const destination = await target.get();
const plan = prepareLegacyMigration(uid, sourceSnapshot.data(), destination.exists);
const directory = resolve(backupDir);
await mkdir(directory, { recursive: true, mode: 0o700 });
const stem = join(directory, `antty-legacy-${plan.migrationId}-${randomUUID()}`);
// wx never overwrites an earlier backup, even on a rerun. Original remains untouched.
await writeFile(
  `${stem}.backup.json`,
  JSON.stringify(
    {
      projectId: 'antboard-2025',
      sourcePath: plan.sourcePath,
      sourceUpdateTime: sourceSnapshot.updateTime?.toDate().toISOString(),
      data: sourceSnapshot.data(),
    },
    null,
    2,
  ),
  { flag: 'wx', mode: 0o600 },
);
await writeFile(
  `${stem}.manifest.json`,
  JSON.stringify({ ...plan, document: undefined, mode: apply ? 'apply' : 'dry-run' }, null, 2),
  { flag: 'wx', mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      targetUid: uid,
      sourceHash: plan.sourceHash,
      counts: plan.counts,
      backup: `${stem}.backup.json`,
    },
    null,
    2,
  ),
);
if (apply) {
  if (approvedHash !== plan.sourceHash)
    throw new Error('Source changed since review. Backup saved; no destination written.');
  await db.runTransaction(async (transaction) => {
    const marker = db.doc(`migrations/${plan.migrationId}`);
    const [freshSource, freshTarget, existingMarker] = await Promise.all([
      transaction.get(source),
      transaction.get(target),
      transaction.get(marker),
    ]);
    if (existingMarker.exists)
      throw new Error('Migration already recorded. Verify existing result; do not repeat.');
    const fresh = prepareLegacyMigration(
      uid,
      freshSource.exists ? freshSource.data() : null,
      freshTarget.exists,
    );
    if (fresh.sourceHash !== approvedHash)
      throw new Error('Source changed during migration. Nothing was written.');
    transaction.create(target, { ...fresh.document, updatedAt: FieldValue.serverTimestamp() });
    transaction.create(marker, {
      sourcePath: plan.sourcePath,
      targetPath: plan.targetPath,
      targetUid: uid,
      sourceHash: plan.sourceHash,
      counts: plan.counts,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  const readback = await target.get();
  const data = readback.data();
  if (
    !data ||
    prepareLegacyMigration(uid, { projects: data.projects }, false).sourceHash !==
      prepareLegacyMigration(uid, { projects: plan.document.projects }, false).sourceHash
  )
    throw new Error(
      'Migration submitted but verification differs. Inspect remote; never rerun blindly.',
    );
  console.log(
    'Verified destination content. Legacy source and all attachment objects were preserved.',
  );
}
