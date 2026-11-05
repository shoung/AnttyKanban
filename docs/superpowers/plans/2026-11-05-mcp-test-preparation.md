# Restricted MCP test preparation plan

> **For agentic workers:** Use superpowers:executing-plans for this bounded preparation task.

**Goal:** Prepare the approved read-only pilot without creating accounts, credentials, grants, billing features or deployments.

**Architecture:** Keep the disabled Auth0/Firebase linking implementation. Prepare exact human setup steps and a manual, dry-run-first cleanup utility restricted to one verified Firebase UID's expired linking attempts. Reuse existing explicitly configured Admin authentication; no TTL, cron, service account key or new IAM scope.

**Spec:** Latest delegation: user approves preparation of a seven-day maps:read test, but concrete credentials, persistent access, personal-data submission, terms acceptance, login and deployment still require appropriate confirmation.

## Global constraints

- No live writes or production cleanup in this task; only guarded local demo emulator mutations.
- Never alter bindings, owner revocation epochs, maps, boards, events or other accounts during cleanup.
- No Firebase Auth provider changes; test Firebase login needs an existing owner-approved Google identity.
- No production deployment, preview protection bypass or expansion of WIF trust.

## Review focus

- Cleanup must preserve live, malformed, foreign-owner or concurrently changed attempts.
- Apply must require a reviewed exact plan hash and a cutoff at least one hour old.
- CLI validation must fail before loading credentials for missing/unsafe inputs.
- Logs/plans must contain no nonce, verifier, browser secret, token or email.
- A protected preview plus production-pinned WIF is not a ready test environment.

### Task 1: Manual cleanup preparation

- [x] Write failing tests for dry-run, target boundaries, plan mismatch and transaction recheck.
- [x] Implement bounded owner-filtered planning and reviewed-hash apply, with a non-secret CLI and no automatic scheduling.
- [x] Verify against isolated demo Firestore, including foreign and concurrent document preservation.

### Task 2: Registration and credential handoff

- [x] Read official signup, terms links, tenant/app/user creation instructions and inspect existing connections read-only.
- [x] Document owner-email/region/name decisions, exact public IDs versus secrets, test identities, deployment blockers and stage-specific approvals.
- [x] Run relevant tests/type/lint/build, obtain review, and update existing draft PR10 only.
