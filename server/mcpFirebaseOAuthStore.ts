import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from './firebase.js';
import type { OAuthRepository, OAuthTable } from './mcpFirebaseOAuth.js';

const collections: Record<OAuthTable, string> = {
  requests: 'mcpAuthRequests',
  owners: 'mcpAuthOwners',
  grants: 'mcpAuthGrants',
  codes: 'mcpAuthCodes',
  tokens: 'mcpAuthTokens',
};
export function firestoreOAuthRepository(db: Firestore = getAdminDb()): OAuthRepository {
  const ref = (table: OAuthTable, id: string) => db.collection(collections[table]).doc(id);
  return {
    transaction: (work) =>
      db.runTransaction(async (transaction) => {
        // Buffer writes so service-level read/validate order never violates Firestore's read-before-write rule.
        const writes: { table: OAuthTable; id: string; row: unknown }[] = [];
        const result = await work({
          get: async (table, id) => (await transaction.get(ref(table, id))).data() ?? null,
          set: (table, id, row) => {
            writes.push({ table, id, row });
          },
        });
        for (const write of writes)
          transaction.set(ref(write.table, write.id), write.row as Record<string, unknown>);
        return result;
      }),
    async listGrants(uid, after) {
      let query = db
        .collection(collections.grants)
        .where('ownerUid', '==', uid)
        .orderBy(FieldPath.documentId())
        .limit(51);
      if (after) query = query.startAfter(after);
      return (await query.get()).docs.map((doc) => ({ id: doc.id, row: doc.data() }));
    },
  };
}
