import { createHash } from 'node:crypto';
import type { Firestore } from '@google-cloud/firestore';
import { z } from 'zod';

const collections = {
  requests: 'mcpAuthRequests',
  codes: 'mcpAuthCodes',
  tokens: 'mcpAuthTokens',
  grants: 'mcpAuthGrants',
} as const;
const optionsSchema = z
  .object({
    table: z.enum(['requests', 'codes', 'tokens', 'grants']),
    cutoff: z.number().int().nonnegative(),
    apply: z.boolean().default(false),
    expectedHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
interface Candidate {
  id: string;
  expiresAt: number;
  version: string;
}
export interface OAuthCleanupStore {
  page(collection: string, cutoff: number): Promise<Candidate[]>;
  remove(collection: string, row: Candidate, cutoff: number): Promise<boolean>;
}
export async function runOAuthCleanup(store: OAuthCleanupStore, input: unknown, now = Date.now()) {
  const options = optionsSchema.parse(input);
  if (options.cutoff > now - 86_400_000) throw new Error('Cutoff must be at least 24 hours old');
  const collection = collections[options.table],
    rows = await store.page(collection, options.cutoff);
  if (
    rows.length > 100 ||
    rows.some(
      (r) =>
        !/^[a-f0-9]{64}$/.test(r.id) ||
        !Number.isSafeInteger(r.expiresAt) ||
        r.expiresAt < 0 ||
        r.expiresAt > options.cutoff ||
        !r.version,
    )
  )
    throw new Error('Invalid cleanup page');
  const planHash = createHash('sha256')
    .update(JSON.stringify({ collection, cutoff: options.cutoff, rows }))
    .digest('hex');
  if (options.apply && options.expectedHash !== planHash)
    throw new Error('Review a fresh dry run before apply');
  let deleted = 0,
    changed = 0;
  if (options.apply)
    for (const row of rows) {
      if (await store.remove(collection, row, options.cutoff)) deleted++;
      else changed++;
    }
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    collection,
    cutoff: options.cutoff,
    rows,
    planHash,
    deleted,
    changed,
  };
}
const version = (row: { updateTime?: { seconds: number; nanoseconds: number } }) =>
  row.updateTime ? `${row.updateTime.seconds}:${row.updateTime.nanoseconds}` : '';
export function firestoreOAuthCleanupStore(db: Firestore): OAuthCleanupStore {
  return {
    async page(collection, cutoff) {
      if (
        !Object.values(collections).includes(
          collection as (typeof collections)[keyof typeof collections],
        )
      )
        throw new Error('Unknown collection');
      const snapshot = await db
        .collection(collection)
        .where('expiresAt', '<=', cutoff)
        .orderBy('expiresAt')
        .limit(100)
        .select('expiresAt')
        .get();
      return snapshot.docs.map((doc) => ({
        id: doc.id,
        expiresAt: doc.get('expiresAt') as number,
        version: version(doc),
      }));
    },
    async remove(collection, row, cutoff) {
      if (
        !Object.values(collections).includes(
          collection as (typeof collections)[keyof typeof collections],
        )
      )
        throw new Error('Unknown collection');
      return db.runTransaction(async (tx) => {
        const ref = db.collection(collection).doc(row.id),
          doc = await tx.get(ref);
        if (
          !doc.exists ||
          version(doc) !== row.version ||
          doc.get('expiresAt') !== row.expiresAt ||
          row.expiresAt > cutoff
        )
          return false;
        tx.delete(ref);
        return true;
      });
    },
  };
}
export function parseOAuthCleanupArgs(args: string[]) {
  const values: Record<string, string> = {};
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') {
      if (apply) throw new Error('Duplicate apply');
      apply = true;
      continue;
    }
    const key = args[i];
    if (
      !['--project', '--table', '--expired-before', '--expected-hash'].includes(key) ||
      values[key] ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error('Invalid arguments');
    values[key] = args[++i];
  }
  const cutoff = Date.parse(values['--expired-before'] ?? '');
  if (
    values['--project'] !== 'antboard-2025' ||
    !Number.isFinite(cutoff) ||
    new Date(cutoff).toISOString() !== values['--expired-before']
  )
    throw new Error('Invalid project/cutoff');
  return {
    project: values['--project'],
    input: optionsSchema.parse({
      table: values['--table'],
      cutoff,
      apply,
      ...(values['--expected-hash'] ? { expectedHash: values['--expected-hash'] } : {}),
    }),
  };
}
