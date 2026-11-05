/** Manual operator utility, never a public endpoint or automatic job. No live invocation without approval. */
import {
  parseLinkCleanupArgs,
  runLinkCleanup,
  firestoreLinkCleanupStore,
} from '../server/mcpLinkCleanup.ts';

let applying = false;
try {
  const options = parseLinkCleanupArgs(process.argv.slice(2));
  applying = options.apply;
  if (
    process.env.FIRESTORE_EMULATOR_HOST ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.FIREBASE_PROJECT_ID !== options.project
  )
    throw new Error('Invalid operator environment');
  // Import and initialize only after input/environment validation. Existing server
  // policy requires explicit approved Admin configuration; never discover/login here.
  const { getAdminDb } = await import('../server/firebase.ts');
  const db = getAdminDb();
  try {
    const result = await runLinkCleanup(firestoreLinkCleanupStore(db), options.input, {
      apply: options.apply,
      expectedHash: options.expectedHash,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.terminate();
  }
} catch {
  // SDK errors/stacks can contain credentials or document contents. Do not print them.
  console.error(
    applying
      ? 'Cleanup failed; writes may be partial. Do not retry apply blindly. Review a new dry-run.'
      : 'Cleanup unavailable or invalid arguments. Requires --project antboard-2025 --owner-uid VERIFIED_TEST_UID --expired-before YYYY-MM-DDTHH:mm:ss.sssZ, existing approved Admin environment, and a cutoff at least one hour old. No cleanup was requested.',
  );
  process.exitCode = 1;
}
