import { createHash } from 'node:crypto';
import { FieldPath, type Firestore } from '@google-cloud/firestore';
import { z } from 'zod';
import { enforceUid } from './authPolicy.js';

const collection = 'mcpOAuthLinkAttempts';
const fail = (message: string): never => {
  throw new Error(message);
};
const cursor = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z
  .object({
    uid: z.string(),
    cutoff: z.number().int().nonnegative(),
    after: cursor.optional(),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();
export interface CleanupRow {
  id: string;
  ownerUid: unknown;
  createdAt: unknown;
  expiresAt: unknown;
  version: string;
}
export interface CleanupCandidate {
  id: string;
  expiresAt: number;
  version: string;
}
export interface CleanupStore {
  page(uid: string, after: string | undefined, limit: number): Promise<CleanupRow[]>;
  /** Transactionally recheck exact owner, version, expiry and shape before deletion. */
  remove(uid: string, candidate: CleanupCandidate, cutoff: number): Promise<boolean>;
}
function eligible(
  row: CleanupRow,
  uid: string,
  cutoff: number,
): row is CleanupRow & { expiresAt: number } {
  return (
    cursor.safeParse(row.id).success &&
    row.ownerUid === uid &&
    Number.isSafeInteger(row.createdAt) &&
    Number.isSafeInteger(row.expiresAt) &&
    (row.createdAt as number) >= 0 &&
    (row.expiresAt as number) - (row.createdAt as number) === 300_000 &&
    (row.expiresAt as number) <= cutoff &&
    typeof row.version === 'string' &&
    row.version.length > 0
  );
}
export async function runLinkCleanup(
  store: CleanupStore,
  value: unknown,
  options: { now?: number; apply?: boolean; expectedHash?: string } = {},
) {
  const input = inputSchema.parse(value);
  const uid = enforceUid(input.uid);
  const now = options.now ?? Date.now();
  if (input.cutoff > now - 3_600_000) return fail('Cutoff must be at least one hour in the past');
  if (options.apply && !cursor.safeParse(options.expectedHash).success)
    return fail('Apply requires the reviewed plan hash');
  const rows = await store.page(uid, input.after, input.limit);
  if (rows.length > input.limit) return fail('Cleanup page exceeded its bound');
  const candidates = rows
    .filter((row) => eligible(row, uid, input.cutoff))
    .map((row) => ({ id: row.id, expiresAt: row.expiresAt as number, version: row.version }));
  const nextAfter = rows.length === input.limit ? rows.at(-1)!.id : undefined;
  if (nextAfter !== undefined) cursor.parse(nextAfter);
  const planHash = createHash('sha256')
    .update(
      JSON.stringify({
        collection,
        uid,
        cutoff: input.cutoff,
        after: input.after ?? null,
        limit: input.limit,
        candidates,
        nextAfter: nextAfter ?? null,
      }),
    )
    .digest('hex');
  if (options.apply && options.expectedHash !== planHash)
    return fail('Cleanup plan changed; review a fresh dry-run');
  let deleted = 0,
    changed = 0;
  if (options.apply)
    for (const candidate of candidates) {
      if (await store.remove(uid, candidate, input.cutoff)) deleted++;
      else changed++;
    }
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    collection,
    ownerUid: uid,
    cutoff: input.cutoff,
    scanned: rows.length,
    candidates,
    planHash,
    deleted,
    changed,
    ...(nextAfter ? { nextAfter } : {}),
  };
}
const version = (snapshot: { updateTime?: { seconds: number; nanoseconds: number } }) =>
  snapshot.updateTime ? `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}` : '';
export function firestoreLinkCleanupStore(db: Firestore): CleanupStore {
  const attempts = db.collection(collection);
  return {
    async page(uid, after, limit) {
      let query = attempts.where('ownerUid', '==', uid).orderBy(FieldPath.documentId());
      if (after) query = query.startAfter(after);
      // Do not retrieve PKCE verifiers, nonces or browser hashes for planning.
      const rows = await query.limit(limit).select('ownerUid', 'createdAt', 'expiresAt').get();
      return rows.docs.map((row) => ({
        id: row.id,
        ownerUid: row.get('ownerUid'),
        createdAt: row.get('createdAt'),
        expiresAt: row.get('expiresAt'),
        version: version(row),
      }));
    },
    async remove(uid, candidate, cutoff) {
      cursor.parse(candidate.id);
      const ref = attempts.doc(candidate.id);
      return db.runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        if (!fresh.exists || version(fresh) !== candidate.version) return false;
        const row = {
          id: fresh.id,
          ownerUid: fresh.get('ownerUid'),
          createdAt: fresh.get('createdAt'),
          expiresAt: fresh.get('expiresAt'),
          version: version(fresh),
        };
        if (!eligible(row, uid, cutoff) || row.expiresAt !== candidate.expiresAt) return false;
        tx.delete(ref);
        return true;
      });
    },
  };
}
export function parseLinkCleanupArgs(args: string[]) {
  const allowed = new Set([
    '--project',
    '--owner-uid',
    '--expired-before',
    '--after',
    '--limit',
    '--expected-plan-hash',
  ]);
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--apply') {
      if (apply) return fail('Duplicate argument');
      apply = true;
      continue;
    }
    if (!allowed.has(key) || values.has(key) || !args[i + 1] || args[i + 1].startsWith('--'))
      return fail('Invalid cleanup arguments');
    values.set(key, args[++i]);
  }
  if (values.get('--project') !== 'antboard-2025')
    return fail('Explicit approved project antboard-2025 is required');
  const uid = enforceUid(values.get('--owner-uid'));
  const date = values.get('--expired-before') ?? '';
  const cutoff = Date.parse(date);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date) ||
    !Number.isFinite(cutoff) ||
    new Date(cutoff).toISOString() !== date ||
    cutoff > Date.now() - 3_600_000
  )
    return fail('Explicit UTC cutoff at least one hour old is required');
  const input = inputSchema.parse({
    uid,
    cutoff,
    after: values.get('--after'),
    limit: values.has('--limit') ? Number(values.get('--limit')) : 100,
  });
  const expectedHash = values.get('--expected-plan-hash');
  if (apply && !cursor.safeParse(expectedHash).success)
    return fail('Apply requires the reviewed plan hash');
  if (!apply && expectedHash !== undefined) return fail('Plan hashes are only accepted with apply');
  return { project: 'antboard-2025', input, apply, expectedHash };
}
