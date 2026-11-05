# Legacy access: read-only findings and proposed owner-only cutover

This is preparation only. No production rules, data, credentials, IAM, environment or billing settings were changed. Base is deployed main `5c3e58b`; preparation branch is `fix/legacy-rules-and-mcp-pilot`, with automatic deployment disabled.

## Verified state and dependencies

The production Console shows an existing `boards/default` and Storage `task-images/` prefix. The published Firestore and Storage rules preserve these exact legacy paths with `allow read, write: if request.auth != null`, while current `users/{uid}` board/map/image paths enforce owner checks and all unspecified paths are denied. A new test Firebase user therefore gains legacy SDK access under the current production rules, even if its MCP token has maps:read only.

Current `services/boardStore.ts` and `boardSafety.ts` read/write only `users/{uid}/boards/default`. Current uploads in `components/TaskModal.tsx` use `attachmentPath`, which produces `users/{uid}/task-images/{id}`. `SecureTaskImage.tsx` still displays approved legacy HTTP(S) imageUrl values directly, while private paths use authenticated getBlob and never fall back to another owner's bearer URL. Pre-isolation commit `0327fd2^` used the shared board in App and uploaded flat `task-images/${Date.now()}-${safeFileName}` objects, persisting getDownloadURL results. Old browser tabs, cached JS or old deployments can still depend on those paths; no browser-client inventory or all-attachment inventory has been completed.

The only current production-code legacy board reader is the explicit operator `scripts/migrate-legacy-board.ts`. Its dry-run reads that board and destination, validates a Google-linked UID, and writes a private board JSON backup plus manifest. Apply additionally creates the owner board and migration marker with source-hash/target-absence guards. It does not copy or back up image objects, prove a full restore, or run without approved ambient Admin access. It was not invoked. A board's updatedBy/email/first login is not proof of its owner UID.

## Backup verification

Read-only Firebase and Google Cloud disaster-recovery pages show PITR disabled, scheduled backups disabled and no rows in the backup table for `(default)`. This checkout has no `private-backups/` directory and no verified migration backup was found in the checked workspace. This does not establish that no external/offline copy exists. Prior exports, attachment bytes/generations/metadata, Storage recovery settings and a tested restore remain unverified. No export, backup schedule, PITR/TTL, download-token rotation or data copy was started.

## Minimal first change

Preserve all legacy data and the verified owner's existing legacy read/write behavior; remove only the ability of other Firebase identities to use those SDK paths. `prepareLegacyOwnerRules` in `server/legacyRules.ts` is a pure local renderer. It accepts only the SHA256-pinned reviewed deny-by-default drafts, normalizing CRLF for the hash, plus an explicit owner UID. It inserts these two grants and otherwise leaves the drafts byte-for-byte unchanged:

```
match /boards/default {
  allow read, write: if request.auth != null && request.auth.uid == "VERIFIED_OWNER_UID";
}
match /task-images/{fileName} {
  allow read, write: if request.auth != null && request.auth.uid == "VERIFIED_OWNER_UID";
}
```

The real owner UID is not supplied, inferred or committed. The resulting files are review artifacts, not a deployed configuration. Do not feed live broad rules into the renderer or append these blocks to them. The cutover must replace the existing permissive legacy matches: Rules combine overlapping allows, so a deny/owner-only block cannot override another broad wildcard. The pinned base rejects unknown rules (including read-only wildcard overlaps) rather than attempting a partial parser/automatic merge. Updating the base hashes requires a deliberate rule review.

Legacy owner writes remain as broad as before, restricted to that owner and exact flat path; no new revision/MIME/size/immutability constraints are retrofitted to legacy clients. Modern owner-only policy remains unchanged. Once migration and old-client retirement are separately accepted, the existing legacy-denying drafts can be considered as a second cutover. That is not part of this change.

**Existing image download-token URLs remain bearer links.** Tightening SDK rules does not revoke a previously distributed URL or remove copies already obtained. No token rotation, object replacement or attachment URL rewriting is included. The rule change prevents newly signed-in users from obtaining/altering legacy objects through the SDK; it does not promise retroactive secrecy.

## Approval and deployment sequence

1. Confirm the exact Google-linked Firebase UID that owns the entire old board and legacy image prefix. If different images have different owners, stop: one-owner rules are not an appropriate migration. Independently choose the trial account/UID; it must differ from the real legacy owner for isolation acceptance.
2. Read/export the complete current Firestore/Storage rules and version IDs into a private location. Review every matching grant against the proposed generated policy, including any unrelated live changes since this audit. Capture policy hashes and keep the original versions available; no blind draft replacement.
3. With explicit data-copy and operator-access approval, preserve a type-faithful board snapshot (including timestamps/references/bytes where present), source update time/hash, attachment reference inventory, and original referenced object bytes plus metadata/generations/checksums. Keep download tokens/private URLs out of logs/Git/public artifacts. Check current Storage recovery settings. Existing migration JSON alone is not proof of a complete restorable board-and-images backup. Verify a restore in an isolated destination, not over live data. Do not enable paid recovery features without approval.
4. Render the two owner-only policies with the confirmed UID; run unit/emulator checks and inspect the exact semantic diff against exported production rules. No source records, object contents, generations or download tokens should change.
5. Obtain explicit approval of the final rule files/UID, affected two paths, temporary behavior for old clients, backup evidence and rollback limits. Deploy Firestore and Storage rules together as a coordinated access change. Do not enable MCP or create the test identity before legacy isolation is verified.
6. Run separately approved live smoke checks: legacy owner still reads/writes a disposable approved fixture; foreign/anonymous users are denied legacy SDK access; both accounts retain only their own modern data; OAuth/credential collections are denied to clients. Do not edit real projects/images to test write denial or assume emulator success proves the live deployment.
7. Only after the rules and trial UID gate are approved/deployed: create the approved synthetic map and activate the scoped hosted MCP pilot. Keep paid TTL, Calendar grants and broader scopes off.

## Rollback and data preservation

There is no application-data migration in this cutover, so there should be no reason to restore/overwrite a board or image. If a UID/configuration mistake blocks the owner, keep MCP off, stop tests and correct the reviewed owner-only rule or use a separately approved temporary deny-all legacy policy. Prefer preserving the foreign-user denial while restoring owner access.

Restoring the old policy reopens the two paths to every authenticated account, including newly created test users. It is a security expansion, not a routine safe rollback; obtain explicit confirmation before doing that. Disabling/revoking an account alone must not be assumed to invalidate every Firebase client token immediately. Never overwrite a newer live board from a backup, delete the source/images, rotate bearer URLs or rerun a migration to repair an uncertain result. Capture the current state and re-plan first.

## One-UID MCP trial

First-party OAuth now requires `ANTTY_MCP_FIREBASE_OAUTH_TEST_UID=<verified test UID>` whenever enabled. Missing/invalid UID fails closed with503. Other UIDs are rejected before consent/account lookup; code exchange and every token use recheck the configured UID. It is server-only and excluded from discovery/errors. Existing owner/token revocation remains usable for an excluded prior owner.

When enabled, this pilot also restricts PAT redemption at the MCP gateway to that UID and the configured scope ceiling; a PAT cannot bypass the trial. New PAT issuance rejects another UID, wider scopes or more than seven days. Existing PAT listing/revocation stays owner-bound and available. With first-party OAuth off, previous PAT behavior remains unchanged; this is not a general replacement for all authorization.

Use maps:read, no refresh/offline access and one-hour access tokens. The seven-day cap applies to each grant; it is not an automatic global shutdown. Switching the configured UID blocks old grants without mutating them; switching it back may make a still-valid unrevoked grant usable again. Revoke old grants and disable MCP before such a rollback. This preparation configures no real UID, creates no account/token/map and grants no access.

The new setting must be part of the final activation approval along with the exact ChatGPT public client/callback, synthetic map identity/path and data disclosure to ChatGPT. Do not reuse the old activation bundle without this UID setting. Current production rules, hosted callback and actual trial are not changed by the code preparation.

## Test and review record

Unit tests cover exact/pinned rule bases, injected wildcard-overlap rejection, absent/invalid UID, identity gating before backend access, old-grant exclusion, metadata privacy, owner revocation, foreign-PAT denial, scope narrowing and PAT issuance bounds. A separate demo-only emulator data namespace covers legacy owner compatibility/foreign denial, unchanged modern-path policy and server-only denial. Storage rule loading uses the emulator-global `/internal/setRules`, so the full security test command now runs files serially to avoid rule variants overwriting each other. No real data/credentials are used.

Independent review found an overlapping-wildcard acceptance issue in the first renderer; a failing regression reproduced it, and pinned reviewed bases now reject it. No additional Critical/Important finding was reported in the OAuth/PAT changes. Final suite/CI results are recorded in the draft PR after validation.

Final local checks:188 unit/native,73 UI,12 serial emulator tests passed; typecheck/lint/build and diff checks passed. Existing vendor-comment/bundle-size warnings remain. Hosted/production smoke checks and restore acceptance remain unperformed.
