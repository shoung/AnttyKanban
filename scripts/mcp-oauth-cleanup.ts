/** Manual operator tool. Never execute on a live project without explicit approval. */
import {
  parseOAuthCleanupArgs,
  runOAuthCleanup,
  firestoreOAuthCleanupStore,
} from '../server/mcpOAuthCleanup.ts';
let applying = false;
try {
  const options = parseOAuthCleanupArgs(process.argv.slice(2));
  applying = options.input.apply;
  if (
    process.env.FIRESTORE_EMULATOR_HOST ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.FIREBASE_PROJECT_ID !== options.project
  )
    throw new Error('Invalid operator environment');
  if (options.input.cutoff > Date.now() - 86_400_000) throw new Error('Cutoff too recent');
  if (applying && !options.input.expectedHash) throw new Error('Missing reviewed plan');
  const { getAdminDb } = await import('../server/firebase.ts');
  const db = getAdminDb();
  try {
    console.log(
      JSON.stringify(await runOAuthCleanup(firestoreOAuthCleanupStore(db), options.input), null, 2),
    );
  } finally {
    await db.terminate();
  }
} catch {
  console.error(
    applying
      ? 'Cleanup failed; changes may be partial. Review a new dry-run before retrying.'
      : 'Cleanup unavailable or invalid arguments. Use --project antboard-2025 --table requests|codes|tokens|grants --expired-before ISO_UTC_AT_LEAST_24H_OLD. Dry-run by default, at most 100 rows, approved existing Admin environment required.',
  );
  process.exitCode = 1;
}
