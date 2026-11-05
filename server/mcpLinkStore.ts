import { randomBytes } from 'node:crypto';
import { FieldPath, type Firestore } from '@google-cloud/firestore';
import { getAdminDb } from './firebase.js';
import { linkFailure, validateLinkAttempt, type LinkRepository } from './mcpLink.js';

export function firestoreLinkRepository(db: Firestore = getAdminDb()): LinkRepository {
  const attempts = db.collection('mcpOAuthLinkAttempts');
  const bindings = db.collection('mcpOAuthBindings');
  const owners = db.collection('mcpOAuthLinkOwners');
  const epoch = () => randomBytes(32).toString('base64url');
  const readEpoch = (data: Record<string, unknown> | undefined, uid: string) => {
    if (
      data?.ownerUid !== uid ||
      typeof data.epoch !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.epoch)
    )
      return linkFailure(503);
    return data.epoch;
  };
  return {
    async put(id, attempt) {
      const ref = owners.doc(attempt.ownerUid);
      await db.runTransaction(async (tx) => {
        const owner = await tx.get(ref);
        const revocationEpoch = owner.exists ? readEpoch(owner.data(), attempt.ownerUid) : epoch();
        if (!owner.exists) tx.create(ref, { ownerUid: attempt.ownerUid, epoch: revocationEpoch });
        // Numeric expiresAt is not a TTL field; cleanup uses a separate timestamp.
        tx.create(attempts.doc(id), {
          ...attempt,
          revocationEpoch,
          deleteAfter: new Date(attempt.expiresAt),
        });
      });
    },
    async take(id, browserHash, fingerprint, now) {
      const ref = attempts.doc(id);
      return db.runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data();
        if (data) delete data.deleteAfter;
        const row = validateLinkAttempt(data, browserHash, fingerprint, now);
        tx.delete(ref);
        return row;
      });
    },
    async bind(id, binding, attempt) {
      if (attempt.ownerUid !== binding.ownerUid) return linkFailure();
      const ref = bindings.doc(id);
      await db.runTransaction(async (tx) => {
        const owner = await tx.get(owners.doc(binding.ownerUid));
        if (readEpoch(owner.data(), binding.ownerUid) !== attempt.revocationEpoch)
          return linkFailure();
        const old = await tx.get(ref);
        if (
          old.exists &&
          (old.get('ownerUid') !== binding.ownerUid ||
            old.get('issuer') !== binding.issuer ||
            old.get('subject') !== binding.subject ||
            old.get('schemaVersion') !== 1)
        )
          return linkFailure(409);
        tx.set(ref, binding);
      });
    },
    async list(uid, after) {
      let query = bindings.where('ownerUid', '==', uid).orderBy(FieldPath.documentId());
      if (after) query = query.startAfter(after);
      const rows = await query.limit(51).get();
      return rows.docs.map((row) => ({
        id: row.id,
        subject: String(row.get('subject')),
        expiresAt: Number(row.get('expiresAt')),
        enabled: row.get('enabled') === true,
      }));
    },
    async revoke(uid, id) {
      const ref = bindings.doc(id);
      await db.runTransaction(async (tx) => {
        const row = await tx.get(ref);
        const ownerRef = owners.doc(uid);
        const owner = await tx.get(ownerRef);
        if (!row.exists || row.get('ownerUid') !== uid)
          throw Object.assign(new Error('Link not found'), { status: 404 });
        if (owner.exists) readEpoch(owner.data(), uid);
        // Invalidate every pending link before committing revocation. A callback
        // racing this transaction either commits first then is revoked, or fails.
        tx.set(ownerRef, { ownerUid: uid, epoch: epoch() });
        tx.update(ref, { enabled: false });
      });
    },
  };
}
