# Firebase MCP OAuth Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect hosted ChatGPT to Antty using existing Firebase identities without Auth0.

**Architecture:** A disabled-by-default first-party OAuth AS issues hashed opaque access tokens after browser-bound Firebase consent. Durable Firestore transactions bind single-use codes and revocation to a UID, fixed client, exact redirect, resource and approved scopes. Existing MCP tools enforce their existing account and data isolation rules.

**Tech Stack:** TypeScript, React, Firebase Admin/Auth/Firestore, node:crypto, existing MCP SDK.

**Spec:** `docs/superpowers/specs/2026-11-05-firebase-mcp-oauth-design.md`

## Global Constraints

- No Auth0 resources, live credentials, deployment, real user data or paid TTL changes.
- Maps:read default; all persistent access disabled until separately approved activation.
- No refresh tokens, dynamic registration or token passthrough.
- Preserve all existing account, revision, ETag and Calendar human/AI boundaries.

## Review Focus

- Two tabs, account switches and delayed callbacks must not authorize the wrong identity.
- Simultaneous code exchanges and grant revocation must not restore access.
- Host/redirect/resource variations and duplicate query/form parameters must fail closed.
- A failed or disabled backend must not silently fall back to another token type.
- A broad request or client configuration change must not broaden an existing grant.

## Task 1: Durable authorization service

Files: `server/mcpFirebaseOAuth.ts`, `server/mcpFirebaseOAuthStore.ts`, `tests/mcp-firebase-oauth.test.ts`, emulator tests.

- [x] Write and run failing configuration, grant lifecycle and adversarial tests.
- [x] Implement fixed config, request parsing, consent and token verification with transactional storage interface.
- [x] Implement Firestore adapter; verify replay/revoke concurrency against isolated emulator.

## Task 2: HTTP protocol and MCP integration

Files: `api/mcp-auth.ts`, `api/mcp.ts`, `api/mcp-oauth-metadata.ts`, `vercel.json`, HTTP and MCP client tests.

- [x] Write failing discovery/authorize/token/management HTTP tests.
- [x] Implement bounded HTTP endpoints, OAuth errors, cookie/session binding, form parsing and metadata.
- [x] Integrate first-party bearer verification without failed-token fallback; verify a real local SDK read/revoke flow.

## Task 3: Consent and account UI

Files: `components/McpOAuthConsent.tsx`, `components/McpOAuthConnections.tsx`, `components/AgentAccess.tsx`, `App.tsx`, UI tests.

- [x] Test explicit Firebase consent, cancel, double clicks, failures and account change before implementation.
- [x] Add isolated consent route and owner-only grant management. Remove Auth0 from the current user flow.
- [x] Verify controlled redirects, busy/error states, minimal scopes and expiry copy.

## Task 4: Review and delivery

- [x] Document exact disabled settings, activation gates, protocol choices and pending hosted acceptance.
- [x] Run unit/UI/emulator/type/lint/build checks; independent security review and fixes.
- [x] Update existing draft PR without merging or deploying. Record exact commit and CI.

## Execution ledger

User expressly requested complete implementation after selecting Firebase, so no additional design-approval loop is required. Existing isolated task checkout and feature branch are reused; no main checkout edits. The previous Auth0 code remains inactive historical compatibility code until this replacement is verified; it must not appear in the active user flow.

Completed locally: 181 unit/native, 73 UI, 9 emulator checks; typecheck/lint/build passed. Independent review found one callback query encoding issue, reproduced failing then fixed for approve/cancel. No remaining Critical/Important finding. Additional parent fixes cover public cross-origin discovery, malformed UI pages, StrictMode generation guards and Windows Fetch-forbidden ephemeral ports. Current task checkout reused on feature branch; no merge/deployment/real grants/credentials changed.

Ruling: use fixed public-client registration and opaque token hashes instead of external RFC9068 JWT issuance. This avoids new provider credentials and signing keys; the server now owns OAuth protocol/state maintenance. If real hosted client setup cannot use predefined public none+S256, stop and report the exact mismatch before changing client authentication.

Ruling: seven-day grant cap does not provide seven-day background access: no refresh tokens are issued, access expires after one hour and reconnect/reconsent is required. Longer unattended use needs a separately reviewed and approved extension.

Ruling: retain legacy disabled managed/Auth0 code as historical compatibility in the existing draft; remove it from active UI and explicitly disable link dispatch in Firebase mode. Both flag families cannot be active together.

Follow-up reliability review: reproduced Firestore code14 and Firebase Admin auth/network-request-failed as erroneous401 responses, then separated trusted OAuth/record decisions from backend dependency failures. Unknown repository/transport failures also map to sanitized503. Regressions verify recovery without code consumption/grant revocation/extra SDK authorization redirects, while missing/disabled/revoked account and unknown token stay denied. Actual public POST /oauth/revoke replaces the direct service call in SDK acceptance; HTTP adverse-client/origin/ambiguity/idempotency cases pass. Full follow-up checks:183 unit/native,73 UI,9 emulator; type/lint/build pass. Production rules and actual ChatGPT callback remain unverified; no deployment or grant changes.
