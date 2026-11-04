# Calendar OAuth Implementation Plan

> **For agentic workers:** Use the existing assigned implementation worker and test-first execution. Changes are local only.

**Goal:** Add optional, per-user Google primary-calendar event CRUD without changing existing Firebase sign-in.

**Architecture:** A Vercel API validates Firebase identity, owns a separate Google authorization-code flow, stores encrypted refresh tokens in backend-only Firestore collections, and provides one shared UID-scoped service to the UI and MCP. OAuth state is browser-bound, single-use and short-lived; all event operations pin `primary` on the server.

**Tech Stack:** Existing React/TypeScript/Firebase, Node crypto, Firebase Admin, official google-auth-library, Node test runner.

**Spec:** The implementation assignment and `docs/calendar-oauth.md` security design.

## Global Constraints

- No real credentials, grants, online permission changes, deployment or live calendar mutations.
- Calendar is opt-in and missing configuration never breaks existing Firebase login.
- No caller calendar ID, user ID, attendees, sharing, calendar deletion or arbitrary Google API proxying.
- Google token revocation is project-wide; disconnect requires explicit acknowledgement.

## Review Focus

- State replay, expiry, browser mismatch, concurrent callbacks and disconnect races fail closed.
- Google-account substitution cannot link another account to the Firebase user.
- Refresh-token omission never deletes an existing valid same-account token.
- Revocation failure disables local use and preserves only an encrypted pending-revocation credential.
- External failures and malformed events do not expose secrets or silently mutate unrelated data.

## Steps

- [x] Write crypto and core behavior tests, run red, implement focused security/core modules, run green.
- [x] Add Firestore transactional persistence and official Google OAuth adapter; expose UID-only service functions.
- [x] Add authenticated HTTP API with same-origin mutations, bounded input, secure callback cookies and safe errors.
- [x] Add account-scoped CalendarWorkspace component with explicit consent/disconnect and personal event CRUD.
- [x] Document setup, rules, migration, grant limitations and remaining live-verification gates.
- [x] Run all tests, typecheck, lint and production build; report unrun or blocked checks accurately.

## Verification outcome

Calendar-specific checks passed: 31 backend/security tests and 5 UI tests. Whole-worktree UI (22 tests), typecheck, lint and production build also passed on 2026-11-04. The last aggregate backend run at this handoff had two failing in-progress MCP tests outside the Calendar files; the integration owner was notified. No live credentials, grants, provider calls or deployment were used.
