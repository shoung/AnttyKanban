import { doc, onSnapshot, runTransaction, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { Project } from '../types';
import { boardPath, decodeBoard, prepareBoardWrite, type BoardState } from './boardSafety';

function requireAccount(uid: string) {
  if (auth.currentUser?.uid !== uid) throw new Error('Account changed. Reload your workspace.');
}

export function subscribeBoard(
  uid: string,
  onData: (board: BoardState) => void,
  onError: (error: Error) => void,
) {
  requireAccount(uid);
  return onSnapshot(
    doc(db, boardPath(uid)),
    { includeMetadataChanges: true },
    (snapshot) => {
      // A cache-only empty result is not proof the remote account has no board.
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      try {
        requireAccount(uid);
        onData(decodeBoard(uid, snapshot.exists() ? snapshot.data() : null));
      } catch (error) {
        onError(error instanceof Error ? error : new Error('Invalid board data'));
      }
    },
    onError,
  );
}

export async function saveBoard(
  uid: string,
  projects: Project[],
  expectedRevision: number,
): Promise<BoardState> {
  requireAccount(uid);
  const target = doc(db, boardPath(uid));
  return runTransaction(db, async (transaction) => {
    requireAccount(uid);
    const snapshot = await transaction.get(target);
    requireAccount(uid);
    const next = prepareBoardWrite(
      uid,
      projects,
      expectedRevision,
      snapshot.exists() ? snapshot.data() : null,
    );
    // Drop optional undefined fields, which Firestore rejects. Validation happened first.
    const serialized = JSON.parse(JSON.stringify(next)) as typeof next;
    transaction.set(target, { ...serialized, updatedAt: serverTimestamp() });
    return serialized;
  });
}
