import { FieldPath } from 'firebase-admin/firestore';
import { enforceUid } from './authPolicy';
import { getAdminAuth, getAdminDb } from './firebase';
import {
  assertActiveMcpAccount,
  authorizeToken,
  generateToken,
  parseTokenRequest,
  tokenHash,
  type McpTokenRecord,
} from './mcpPolicy';

export type McpTokenSummary = McpTokenRecord & { id: string };
export interface McpTokenRepository {
  create(hash: string, record: McpTokenRecord): Promise<void>;
  get(hash: string): Promise<McpTokenRecord | null>;
  list(uid: string, after?: string): Promise<McpTokenSummary[]>;
  revoke(uid: string, hash: string, now: number): Promise<boolean>;
}
const invalid = (): never => {
  throw Object.assign(new Error('Invalid, expired, or revoked agent token'), { status: 401 });
};
const validHash = (hash: string) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);

/** Only hashes are persisted. Never log, echo, or store the returned bearer secret. */
export function createTokenService(repository: McpTokenRepository, now = Date.now) {
  return {
    async issue(uid: string, input: unknown) {
      enforceUid(uid);
      const request = parseTokenRequest(input);
      const token = generateToken();
      const id = tokenHash(token);
      const createdAt = now();
      const record: McpTokenRecord = {
        ownerUid: uid,
        name: request.name,
        scopes: request.scopes,
        createdAt,
        expiresAt: createdAt + request.days * 86_400_000,
        revoked: false,
      };
      await repository.create(id, record);
      return { id, token, ...record };
    },
    async authenticate(token: string) {
      if (typeof token !== 'string' || !/^antty_[A-Za-z0-9_-]{43}$/.test(token)) invalid();
      const record = await repository.get(tokenHash(token));
      return { ...authorizeToken(record, undefined, now()), tokenIssuedAt: record!.createdAt };
    },
    async list(uid: string, after?: string): Promise<McpTokenSummary[]> {
      enforceUid(uid);
      if (after !== undefined && !validHash(after))
        throw Object.assign(new Error('Invalid token page cursor'), { status: 400 });
      const records = await repository.list(uid, after);
      return records
        .filter((row) => row.ownerUid === uid)
        .map((row) => ({
          id: row.id,
          ownerUid: uid,
          name: row.name,
          scopes: row.scopes,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          revoked: row.revoked,
          ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, 51);
    },
    async revoke(uid: string, hash: string) {
      enforceUid(uid);
      if (!validHash(hash) || !(await repository.revoke(uid, hash, now())))
        throw Object.assign(new Error('Agent token not found'), { status: 404 });
    },
  };
}

export function firestoreTokenRepository(): McpTokenRepository {
  const db = getAdminDb();
  const collection = db.collection('mcpTokens');
  return {
    async create(hash, record) {
      await collection.doc(hash).create(record);
    },
    async get(hash) {
      const row = await collection.doc(hash).get();
      return row.exists ? (row.data() as McpTokenRecord) : null;
    },
    async list(uid, after) {
      let query = collection.where('ownerUid', '==', uid).orderBy(FieldPath.documentId()).limit(51);
      if (after) query = query.startAfter(after);
      const rows = await query.get();
      return rows.docs.map((row) => ({ ...(row.data() as McpTokenRecord), id: row.id }));
    },
    async revoke(uid, hash, now) {
      return db.runTransaction(async (tx) => {
        const ref = collection.doc(hash);
        const row = await tx.get(ref);
        if (!row.exists || row.data()?.ownerUid !== uid) return false;
        tx.update(ref, { revoked: true, revokedAt: now });
        return true;
      });
    },
  };
}

export function createMcpAuthenticator(
  repository: McpTokenRepository,
  getAccount: (uid: string) => Promise<{ disabled: boolean; tokensValidAfterTime?: string }>,
  now = Date.now,
) {
  const service = createTokenService(repository, now);
  return async (token: string) => {
    const principal = await service.authenticate(token);
    try {
      const user = await getAccount(principal.uid);
      assertActiveMcpAccount(user, principal.tokenIssuedAt);
    } catch (error) {
      if ((error as { status?: number }).status === 503) throw error;
      throw Object.assign(
        new Error('Agent token account access has been revoked or is unavailable'),
        { status: 401 },
      );
    }
    return principal;
  };
}
export async function authenticateMcpToken(token: string) {
  return createMcpAuthenticator(firestoreTokenRepository(), (uid) => getAdminAuth().getUser(uid))(
    token,
  );
}
