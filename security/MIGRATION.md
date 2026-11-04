# Deployment gate and legacy preservation

These rules are drafts, not an instruction to deploy. No production rules or records have been changed by this implementation.

The owner confirmed the legacy shared board belongs solely to them. The destination Firebase UID is not yet verified. Do not infer UID from `updatedBy`, the first login, a display name, or a guessed email.

1. Read/export current Firestore and Storage rules, Firebase Auth user identity, `boards/default`, and referenced image inventory through authorized access. Keep the backup private; download URLs contain bearer access tokens.
2. Ask the owner to choose/sign into the destination account and confirm its verified UID. Do not modify rules, credentials, or persistent access without the required approval.
3. Produce a dry-run manifest with source path, source hash/update time, project/task/comment/image counts, destination UID/path, and deterministic migration ID. Do not copy to all accounts.
4. Transactionally create the destination board only if absent and source remains unchanged. Validate with `validateProjects`; preserve identifiers and comments. If a personal board already exists, stop for a merge decision rather than overwrite it. Record migration completion separately so retries cannot duplicate data.
5. Compare read-back counts and hashes. Preserve `boards/default` and every original image. Copy images only when authorized; rewriting links is a separate verified step. Do not delete/revoke legacy token URLs automatically.
6. Review the existing rules before integrating new matches. The draft default-deny must not accidentally revoke unrelated access. Run emulator isolation/revision tests, then conduct authorized two-account live smoke tests before switching production.

## Privacy boundary

Firebase `getDownloadURL` URLs are bearer links. Owner-only Storage rules do not revoke an already distributed token URL. New attachments persist only their owner-scoped imagePath and render through authenticated getBlob plus short-lived local object URLs. Legacy attachments retain token URLs for compatibility, so never describe legacy attachments as inaccessible to anyone with their URL. New blob reads require bucket CORS configuration appropriate for the authorized application origin; a CORS failure must not fall back to a bearer URL. Never expose server-only calendar refresh tokens or MCP token documents in client-readable paths.

## Write and session safety

The app starts each authenticated account empty until a server-confirmed snapshot arrives. It never reads/initializes the legacy shared document. Unknown/offline-only read state disables writes. Account epochs invalidate delayed callbacks even after A→B→A switches. Board writes use expected revisions in Firestore transactions; conflicting or failed saves retain a downloadable draft and block further writes until reload. Realtime snapshots received during a save are buffered. Client and server code should use the same `prepareBoardWrite` validation.

## Required emulator cases

- Unauthenticated reads/writes denied on every path.
- Account A reads/creates its board; B cannot read or write it.
- Forged ownerUid, revision rollback/jump, extra keys, invalid schema denied.
- First revision is 1; updates increment by exactly 1; direct deletes denied.
- Legacy shared board and server-only credential/token paths denied by the new draft.
- Map owner/id/revision rules mirror boards; stored rootJson is a nonempty bounded string (512000 characters); parsed tree structure and byte limits are validated by app and server. Serialized storage avoids Firestore nested-field depth limits for the 32-level UI tree.
- Storage owner succeeds on new raster upload; cross-owner read/write, SVG, >10 MiB, overwrite/delete denied.

Mindmaps persist the tree as rootJson rather than nested root maps/arrays. Rules reject raw root, bound the serialized string, and cannot parse JSON or deeply validate every task/tree node. Client data is untrusted; MCP/server entry points also validate schemas, ownership and revision independently. Admin SDK bypasses Firestore rules.

## Offline operator tool (not executed)

`scripts/migrate-legacy-board.ts` defaults to dry-run, pins project `antboard-2025`, checks the explicitly provided UID is an enabled Google-linked Firebase user, and uses existing ambient Admin credentials. It writes a private full source backup and content-hash manifest before any optional apply. Invocation requires `--verified-target-uid` and `--backup-dir`; apply additionally requires `--apply --expected-source-hash` from reviewed output. Each run gets unique local backup filenames. Apply rechecks source hash and destination absence inside a transaction, creates a completion marker, then verifies canonical project content on read-back. It never writes or deletes the legacy source or its images. A pre-existing destination blocks migration and requires a separate merge decision.

Example after required identity/operation approval: `node --import tsx scripts/migrate-legacy-board.ts --verified-target-uid VERIFIED_UID --backup-dir /private/antty-backups`. Never store backups or token-bearing legacy URLs in Git. Malformed legacy content is rejected instead of silently repaired; review the private backup and add an explicit, tested transformation if needed.

Run emulator-only isolation tests using `XDG_CONFIG_HOME=/tmp/antty-firebase-config FIREBASE_EMULATORS_PATH=/tmp/antty-firebase-emulators npx firebase emulators:exec --config security/firebase.emulators.json --project demo-antty-security --only firestore,storage 'node --import tsx --test tests/security/*.test.ts'`. This uses a demo project and local rules only, not production credentials or deployment.

## Browser fallback without Admin credentials (prepared, not automatically executed)

The signed-in operator can open `/?legacyMigration=1`. It uses the existing Firebase client session and Security Rules; it never extracts tokens or creates credentials. The tool reads `boards/default`, checks `users/{currentUid}/boards/default`, inventories image object metadata where allowed, and downloads a full JSON-safe source backup with SHA-256 plus counts. A denied destination read permits backup only. Existing destinations are never overwritten. Non-JSON Firestore values or malformed legacy fields stop this browser route and require administrator export rather than silent conversion.

Before submission, the operator must independently verify the signed-in Google account and its Firebase UID, enter that UID, download/open the backup, and confirm source contents plus image inventory. Every referenced image object must be readable through the current account; URL-only/unreadable/foreign-owner paths block the tool's submit button. The backup contains original legacy URLs and only image metadata, not binary image backups. Keep it private, outside Git, and preserve the original Storage objects.

Submission records a sessionStorage intent before a transaction. The transaction rereads source and target, rechecks source SHA-256, and sets the destination only when its read proves absence; a racing creation causes retry and rejection. Target existence is the durable duplicate-write guard. No separate migration-marker path or additional rule is needed. A success is reported only after server reads verify exact project content, owner/schema/revision and unchanged source. Failed or uncertain submissions remain locally locked; the UI offers read-back only, never automatic retry. A verification mismatch requires manual investigation, not deletion/recreation.

This is an explicit import utility, not automatic first-login claiming. It adds no permissions and depends on the pre-existing legacy read rule and approved new owner-scoped board rules. Preserving the old shared rule also preserves its old access exposure until separately authorized cleanup. The query flag is a routing convenience, not an authorization boundary. After the one-time migration, remove or disable this operator workflow in a separate reviewed deployment.

The browser tool checks the actual Auth, Firestore, and Storage app project IDs before any read or write, pins all three to `antboard-2025`, and pins the Storage bucket to `antboard-2025.firebasestorage.app`. A preview/test-project override fails closed. Backups record these verified runtime identifiers rather than an unverified label. The review branch `feat/legacy-browser-migration` has automatic Vercel deployment disabled in `vercel.json`; opening this PR does not authorize merge, production rollout, rule changes, or live migration.
