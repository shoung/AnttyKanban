import process from 'node:process';
import { writeSync } from 'node:fs';
import { setTimeout, clearTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

const allowedCodes = new Set([
  'app/invalid-credential',
  'auth/insufficient-permission',
  'auth/internal-error',
  7,
  16,
  5,
  14,
  4,
]);

/** No writes, token output, document content, or real user identifiers. */
export async function runPreflight({
  env = process.env,
  load = () => import('../server/firebase.ts'),
  report = (...values) => {
    writeSync(1, values.join(' ') + '\n');
  },
} = {}) {
  let stage = 'initialize';
  let db;
  try {
    if (
      env.VERCEL_ENV !== 'production' ||
      env.FIREBASE_PROJECT_ID !== 'antboard-2025' ||
      env.FIREBASE_ADMIN_AUTH_MODE !== 'vercel-wif' ||
      env.FIREBASE_AUTH_EMULATOR_HOST ||
      env.FIRESTORE_EMULATOR_HOST
    )
      throw new Error('invalid configuration');
    const { getAdminAuth, getAdminDb } = await load();
    stage = 'auth';
    try {
      await getAdminAuth().getUser('__antty_wif_readonly_probe__');
      throw new Error('Unexpected probe collision');
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    report('WIF_AUTH_LOOKUP_OK');
    stage = 'firestore';
    db = getAdminDb();
    await db.runTransaction(
      async (transaction) => {
        await transaction.get(db.doc('_antty_probe/no-write-check'));
      },
      { readOnly: true },
    );
    report('WIF_FIRESTORE_READ_TRANSACTION_OK');
    stage = 'cleanup';
    await db.terminate();
    db = undefined;
    report('WIF_PREFLIGHT_OK');
    return true;
  } catch (error) {
    report(
      'WIF_PREFLIGHT_FAILED',
      stage,
      allowedCodes.has(error?.code) ? error.code : 'unavailable',
    );
    return false;
  } finally {
    if (db) await db.terminate().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Never let SDK exception bodies expose credential material to build logs.
  const fatal = () => {
    writeSync(2, 'WIF_PREFLIGHT_FAILED asynchronous unavailable\n');
    process.exit(1);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  const timeout = setTimeout(() => {
    writeSync(2, 'WIF_PREFLIGHT_TIMEOUT\n');
    process.exit(1);
  }, 90000);
  const success = await runPreflight();
  clearTimeout(timeout);
  process.exit(success ? 0 : 1);
}
