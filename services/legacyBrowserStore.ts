import { doc, getDocFromServer, runTransaction, serverTimestamp } from 'firebase/firestore';
import { getMetadata, ref } from 'firebase/storage';
import { auth, db, storage } from '../firebase';
import { boardPath } from './boardSafety';
import {
  assertLegacyProject,
  createBrowserMigrationPlan,
  migrationDocument,
  verifyMigrationTarget,
  type BrowserMigrationPlan,
} from './legacyBrowserPolicy';
function verifiedProject() {
  return assertLegacyProject({
    authProject: auth.app.options.projectId,
    dbProject: db.app.options.projectId,
    storageProject: storage.app.options.projectId,
    storageBucket: storage.app.options.storageBucket,
  });
}
function current(uid: string) {
  verifiedProject();
  if (auth.currentUser?.uid !== uid) throw new Error('Account changed. No migration is permitted.');
}
export interface ImageCheck {
  path: string | null;
  status: 'verified' | 'unverified';
  size?: number;
  contentType?: string;
  generation?: string;
  md5Hash?: string;
  reason?: string;
}
export async function loadLegacyMigration(uid: string) {
  current(uid);
  const source = await getDocFromServer(doc(db, 'boards/default'));
  current(uid);
  if (!source.exists()) throw new Error('找不到舊看板，未建立任何資料。');
  let targetStatus: 'absent' | 'exists' | 'unreadable' = 'unreadable';
  try {
    const target = await getDocFromServer(doc(db, boardPath(uid)));
    current(uid);
    targetStatus = target.exists() ? 'exists' : 'absent';
  } catch {
    current(uid);
  }
  const plan = await createBrowserMigrationPlan(uid, source.data(), targetStatus !== 'absent');
  current(uid);
  const images: ImageCheck[] = [];
  for (const image of plan.images) {
    current(uid);
    if (
      !image.path ||
      (image.path.startsWith('users/') && !image.path.startsWith(`users/${uid}/task-images/`))
    ) {
      images.push({
        path: image.path,
        status: 'unverified',
        reason: '只有舊網址或路徑不屬於目前帳號，需另行查核。',
      });
      continue;
    }
    try {
      const info = await getMetadata(ref(storage, image.path));
      current(uid);
      images.push({
        path: image.path,
        status: 'verified',
        size: info.size,
        contentType: info.contentType,
        generation: info.generation,
        md5Hash: info.md5Hash,
      });
    } catch {
      current(uid);
      images.push({
        path: image.path,
        status: 'unverified',
        reason: '圖片物件無法確認，原參照保留。',
      });
    }
  }
  return { ...verifiedProject(), plan, targetStatus, images };
}
export async function applyLegacyMigration(uid: string, plan: BrowserMigrationPlan) {
  current(uid);
  await runTransaction(db, async (transaction) => {
    current(uid);
    const sourceRef = doc(db, 'boards/default');
    const targetRef = doc(db, boardPath(uid));
    const [source, target] = await Promise.all([
      transaction.get(sourceRef),
      transaction.get(targetRef),
    ]);
    current(uid);
    const next = await migrationDocument(
      uid,
      plan,
      source.exists() ? source.data() : null,
      target.exists(),
    );
    current(uid);
    // Reading target absence makes this a create-only transaction. A racing create forces a retry and rejection.
    transaction.set(targetRef, { ...next, updatedAt: serverTimestamp() });
  });
  current(uid);
  return verifyLegacyMigration(uid, plan);
}
export async function verifyLegacyMigration(uid: string, plan: BrowserMigrationPlan) {
  current(uid);
  const [source, target] = await Promise.all([
    getDocFromServer(doc(db, 'boards/default')),
    getDocFromServer(doc(db, boardPath(uid))),
  ]);
  current(uid);
  const targetStatus = await verifyMigrationTarget(
    uid,
    plan,
    target.exists() ? target.data() : null,
  );
  const sourcePlan = await createBrowserMigrationPlan(
    uid,
    source.exists() ? source.data() : null,
    target.exists(),
  );
  current(uid);
  return { targetStatus, sourceUnchanged: sourcePlan.sourceHash === plan.sourceHash };
}
