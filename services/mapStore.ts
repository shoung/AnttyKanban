import { collection, doc, getDoc, getDocs, runTransaction } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { createMapRecord, updateMapRecord, readMapRecord, mapRecordForStorage } from './mapPolicy';
import { idSchema } from '../mindmap/lib/model';
function active(uid: string) {
  if (!uid || auth.currentUser?.uid !== uid) throw new Error('帳號已變更，請重新開啟工作區');
}
export async function mapRequest<T>(uid: string, url: string, init?: RequestInit): Promise<T> {
  active(uid);
  const id = url.startsWith('/api/maps/')
    ? idSchema.parse(url.slice('/api/maps/'.length))
    : undefined;
  const ref = id ? doc(db, 'users', uid, 'mindmaps', id) : undefined;
  const method = init?.method || 'GET';
  if (method === 'GET' && !ref) {
    const snapshot = await getDocs(collection(db, 'users', uid, 'mindmaps'));
    active(uid);
    const maps = snapshot.docs
      .map((d) => readMapRecord(uid, d.data()))
      .map(({ id, title, revision, updatedAt }) => ({ id, title, revision, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { maps } as T;
  }
  if (method === 'GET' && ref) {
    const snapshot = await getDoc(ref);
    active(uid);
    if (!snapshot.exists()) throw new Error('心智圖不存在');
    return readMapRecord(uid, snapshot.data()) as T;
  }
  const body = JSON.parse(String(init?.body || '{}'));
  if (method === 'POST' && !ref) {
    const next = createMapRecord(uid, crypto.randomUUID(), body);
    await runTransaction(db, async (transaction) => {
      active(uid);
      const target = doc(db, 'users', uid, 'mindmaps', next.id);
      if ((await transaction.get(target)).exists()) throw new Error('心智圖 ID 衝突');
      active(uid);
      transaction.set(target, mapRecordForStorage(next));
    });
    active(uid);
    return next as T;
  }
  if (method === 'PUT' && ref) {
    const next = await runTransaction(db, async (transaction) => {
      active(uid);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('心智圖不存在');
      const record = updateMapRecord(uid, snapshot.data(), body);
      active(uid);
      transaction.set(ref, mapRecordForStorage(record));
      return record;
    });
    active(uid);
    return next as T;
  }
  throw new Error('Unsupported map operation');
}
