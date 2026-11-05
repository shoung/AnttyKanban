# Interactive Calendar verification — 2026-11-05

Base: main `12095bf`. Branch: `feat/calendar-interactive-ui`.

| Check | Result |
| --- | --- |
| `npm test` | 133 passed, including emitted/native Node API runtime and authorization isolation |
| `vitest run --configLoader native` | 62 passed across 8 UI files (including connection-check draft preservation) |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed, no warnings |
| `npm run build` | Passed; calendar remains a lazy-loaded chunk |
| `npm run test:rules` | 5 passed against demo Firestore/Storage emulators; no production project |
| `git diff --check` | Passed |

The ordinary UI command also passed earlier in this branch (56 tests before the
last lifecycle regressions). The native Vitest config loader avoids this Windows
sandbox's esbuild ancestor-directory access problem without changing repository
configuration. CI continues to use the repository's ordinary commands.

Independent read-only review found one Important issue: range/connection changes
could cancel a pending write and prematurely release its lock. The regression
was observed failing, then passed with independent write/account lifecycle,
deferred reads and a complete post-success refresh. Additional tests cover
replacement User objects and late old-session responses.

Browser verification used a temporary localhost-only preview and synthetic
events/tokens: desktop month, dark week/day, 390×844 mobile toolbar/grid, personal
event edit/save, read-only event fields, and an actual drag from November 5 to 6
confirmed in the editor. The preview files and server were removed/stopped.

No real Calendar mutation, OAuth consent, credential/configuration change,
deployment or merge was performed. Real authenticated Google acceptance testing,
OAuth longevity and the separate AI workflow remain pending.

The connection-status UX finding is fixed in the follow-up: real FullCalendar
regressions preserve the navigated week/date and typed new/existing drafts across
opening settings, successful and failed rechecks, closing a pending check, late
responses and disconnect/reconnect. Status checking/uncertainty disables writes;
these tests confirm that rechecks send no event mutations.
The focused independent follow-up review also identified an older list response
clearing a newer failed check. A connection-check generation now prevents that
response from enabling writes; the ordering regression was observed red then green.
Unsupported recurrence/attendee/multi-calendar
operations remain outside this phase. Client write locking is not cross-tab
server-side idempotency.

The build retains upstream Rollup annotation notices and the existing app's large
main-chunk warning. Dependency installation reported the same 30 advisories as
the baseline (24 moderate, 6 high); this change does not remediate unrelated
dependencies. Feature-branch automatic Vercel deployment is explicitly disabled.

Baseline GitHub Actions run 41971572648 passed the complete Node 22/26 matrix on
functional commit `83619df`. The subsequent notices-only commit added distributed
MIT copyright and license text for FullCalendar and Preact; its build verified that
`public/third-party-notices.txt` is copied unchanged to `dist`.

The draft-preservation follow-up reran 133 unit/native tests, 62 UI tests, 5 demo
security-rule tests, typecheck, lint, production build and diff checks successfully
before updating the same draft PR. No deployment or real calendar data was used.
