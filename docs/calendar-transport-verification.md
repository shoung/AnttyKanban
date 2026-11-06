# Calendar transport verification — 2026-11-06

Base: main `6ea4f89fd107fff698b500d989a774cf677e60fd`.
Branch: `test/calendar-transport-contracts`.

## Scope and fixes

The new tests exercise the production Google gateway, and real localhost HTTP and
MCP SDK requests through CalendarService into that gateway. Identity, persistence
and the external Google network boundary use synthetic fixtures. They do not
access Google accounts, Firebase production data or real calendar events.

- PATCH sends JSON and the exact quoted last-read ETag in `If-Match`.
- DELETE forwards the ETag, sends no body and accepts Google's empty 204 response.
- Missing/stale ETags stop before a provider mutation. A concurrent change after
  the preflight GET produces a safe 409 `EVENT_CHANGED`; no automatic retry occurs.
- Network failures, timeouts, server failures and unreadable/malformed write
  acknowledgements return `GOOGLE_WRITE_UNCERTAIN` (502). The write may already
  have completed. MCP explicitly tells the caller not to retry and to read back
  the calendar first. The existing browser uncertainty flow remains unchanged.
- Malformed single-event preflights fail closed before PATCH/DELETE. Responses
  must contain event identity, ETag, dates and explicit organizer ownership data.
- Google 401/403/404/410/412/429 errors remain sanitized. The documented 403
  `rateLimitExceeded` and `userRateLimitExceeded` reasons map to `RATE_LIMITED`
  rather than a permission error. Provider messages and raw 502 errors stay private.

Synthetic applied-but-lost-response tests verify actual fixture state and read-back
for POST/PATCH/DELETE on both HTTP and MCP. This does not add cross-tab idempotency,
automatic reconciliation, or an exactly-once guarantee.

## Red-green and independent review

Before fixes, regressions reproduced unsafe uncertainty/error mapping, malformed
successful acknowledgements, malformed preflights and 403 quota classification.
The focused suite now passes all 75 cases. Independent read-only review identified
the malformed acknowledgement/preflight cases; both were reproduced before fixing.
The final independent review found no remaining important findings and separately
passed 119 relevant tests, TypeScript, targeted lint and whitespace checks.

## Full local verification

Cloud-only checkout, Node 24.22.1, Java 21.0.13:

| Check                | Result                                               |
| -------------------- | ---------------------------------------------------- |
| `npm test`           | 267 passed, no failures or skips                     |
| `npm run test:ui`    | 73 passed across 10 files                            |
| `npm run typecheck`  | Passed                                               |
| `npm run lint`       | Passed                                               |
| `npm run build`      | Passed                                               |
| `npm run test:rules` | 17 passed using only `demo-antty-security` emulators |
| `git diff --check`   | Passed                                               |

Build retains existing upstream annotation notices and the large main-chunk
warning. npm also reports the environment's `http-proxy` configuration warning.
The repository's Node 22/26 CI matrix is separate from these local Node 24 results.

Automatic Vercel deployment is disabled for this branch. No real OAuth consent,
credential/configuration change, deployment, production activation or merge was
performed. Live authenticated Google acceptance remains a separate approved step.
