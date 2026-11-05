# Interactive Calendar Implementation Plan

**Goal:** Replace the embedded calendar with FullCalendar Standard month/week/day views and primary-calendar personal event CRUD.

**Architecture:** Reuse `/api/calendar?action=events` and the existing human grant. Keep AI consent independent. A scoped React workspace loads only the visible range, follows pagination, and gates writes until a complete fresh read succeeds. A separate date adapter keeps Google exclusive all-day ends and browser-local timed editing explicit. Scoped CSS variables provide the future skin boundary.

**Tech stack:** React 19, TypeScript, FullCalendar Standard 6.1.20 (MIT), existing Firebase authentication and Calendar backend.

**Spec:** Approved first-phase scope in the delegated task; existing backend restrictions in `docs/calendar-workflows.md`.

## Constraints

- No merge, deployment, credential changes, new OAuth scope, AI fallback, or real calendar mutations.
- Only primary-calendar personal nonrecurring events are editable; locked, invited, special and recurring events stay read-only. ETags remain mandatory for UI updates/deletes.
- Event data stays in component memory, separated by Firebase UID. Abort and disregard stale requests after range, grant or identity changes.
- No automatic mutation retry. An uncertain result or conflict requires a successful refresh before further writes.

## Review focus

- Late responses after account or visible-range changes must never replace current data.
- All-day dates and DST transitions must not shift or silently normalize.
- Pagination failures must not present an incomplete list as complete or enable writes.
- Failed drag/resize must roll back; repeated clicks must issue one write.
- Reconnect/configuration errors must remove editing access without provider secrets entering messages.

## Tasks

1. Date adapter and locked-event guard. Write failing adapter and backend regressions, run them red, implement, then verify. Files: `services/calendarDates.ts`, `tests/calendar-dates.test.ts`, `server/calendar/core.ts`, `tests/calendar-core.test.ts`.
2. Interactive workspace and event editor. Replace embed-specific tests with authenticated range/pagination, CRUD, conflict, drag rollback and account isolation tests; verify red, implement and verify. Files: `components/CalendarWorkspace.tsx`, `components/CalendarEventEditor.tsx`, `components/calendar.css`, `components/ManualCalendarConnection.tsx`, `tests/calendar.ui.test.tsx`, `tests/calendar-grid.ui.test.tsx`.
3. Document limitations/licensing/costs and block automatic feature deployment. Run unit/UI suites, typecheck, lint, production build, native-runtime and rules checks where available; inspect the real calendar UI with synthetic data. Request an independent review of the final diff. Files: `docs/calendar-native-view.md`, `vercel.json`, lockfile/package manifest.

## Progress

- Fresh clone of latest main `12095bf`; isolated branch `feat/calendar-interactive-ui`. No checkout-local `.agents`, skills or AGENTS.md were present.
- Baseline passed: 127 unit/native-runtime tests and 57 UI tests.
- Task 1 complete: date adapters, DST/exclusive-end coverage, locked-event backend guard.
- Task 2 complete: interactive views, event editor, authenticated pagination/CRUD, ETags, read-only handling and account/range cancellation.
- Independent review requested one Important fix: range/connection reads must not abort or unlock writes. Fixed by separating account/write lifetime from read generations, deferring reads while locked, refreshing after success, and requiring explicit refresh after failure. The navigation-during-write regression failed before the fix and passed afterward.
- Follow-up requested by user: fixed the connection-status recheck UX finding. Temporary checking is separate from a confirmed lost grant; drafts/date/view survive status checks and reconnects within the same Firebase UID. Original editor ETags remain unchanged. New real FullCalendar regressions were observed failing before the fix; full verification and focused independent review run again before updating draft PR #9.
- Local browser verification used synthetic data only: desktop month, dark week/day, 390px mobile layout, editor save, read-only event details and actual drag from November 5 to November 6. Temporary preview removed and local server stopped.
- Task 3 complete: 133 unit/native tests, 59 UI tests and 5 emulator rules tests passed; typecheck, lint, build and diff checks passed. See `docs/calendar-interactive-verification.md`. No credentials, scopes, cloud configuration, deployment or real events changed.
- Follow-up complete locally: 133 unit/native tests, 62 UI tests and 5 emulator rules tests passed with clean typecheck/lint/build/diff checks. The focused independent review's older-read/newer-check race was reproduced red and fixed green with a connection-check generation. Existing mutation locks, identity cancellation and original ETags remain in force.
