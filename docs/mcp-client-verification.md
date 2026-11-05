# MCP client verification — 2026-11-05

Base main: `05ceb0c`. Branch: `feat/mcp-client-crud`.

| Check                               | Result                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline before changes             | 133 unit/native tests, 62 UI tests passed                                                                                                |
| Final unit/native suite             | 168 passed, including SDK HTTP, synthetic OIDC linking/OAuth read, manual-cleanup guards and native disabled-handler checks              |
| Official SDK Streamable HTTP CRUD   | Passed through actual HTTP handler/auth/data service                                                                                     |
| Demo Firestore persistence          | 8 emulator tests passed, including SDK CRUD, linking transactions, private-path rules, revocation ordering and restricted manual cleanup |
| Synthetic OAuth read pilot          | Signature, issuer/resource/client/scopes, bound UID, read tools and immediate binding denial passed                                      |
| UI regression suite                 | 67 passed                                                                                                                                |
| Typecheck / lint / production build | Passed                                                                                                                                   |
| Production unauthenticated probe    | MCP 503; both OAuth metadata routes 404, connection not live                                                                             |

The final suite includes the independently reviewed task-order saturation
regression. PR CI separately reruns the checks on Node 22 and Node 26.

The SDK client covers:

- Mind-map create/read/update/delete with a nested tree, stale revision denial,
  read-only scope denial, other-account denial and caller UID-injection rejection.
- Board project/column/task create/read/update/delete, preserved unrelated data,
  strict patches, mandatory revisions and refusal to delete a nonempty column.
- Calendar create/list/update/delete through the real Calendar core with a
  synthetic Google gateway; stale ETag and invited-event denial. A human-only grant
  cannot enable an AI operation; no real Google activity occurs.
- Revoked synthetic PATs and removed OAuth bindings fail the next HTTP request.
- MCP initialization instructions and OAuth tool auth metadata reach the client.

The emulator fixture refuses to run without a loopback Firestore endpoint and exact
`demo-antty-security` project. It uses the emulator's synthetic reserved owner token
through an explicit GoogleAuth client, never ambient ADC or production credentials.
The workspace UID and created document IDs are isolated per run.

Independent read-only review found no Critical/Important security issue. Its Minor
task-order saturation issue was reproduced with a failing test and corrected to a
recoverable 409 without modifying existing data. Its suggested coverage was added:
the HTTP acceptance also follows continuation pagination, races two writes with one
revision (exactly one commits), and verifies a write-only board credential cannot
read boards or receive unrelated contents in a mutation result.

## Personal Auth0 identity-linking extension

Added a disabled-by-default public-PKCE linking application flow, verified recent
Firebase/OIDC dual proofs, single-use browser-bound attempts and fixed seven-day
`maps:read` bindings. No new library or managed provider account is required to run
the synthetic tests. The real SDK HTTP pilot now obtains its binding through the
linking service and a cryptographically verified synthetic ID token, rather than
inserting a static binding fixture; service revocation denies the next MCP request.

Independent review identified a pending-callback/local-revocation race. It was
reproduced as a failing actual Firestore emulator regression, then fixed by an
owner revocation epoch captured and checked transactionally. The passing test also
pauses a real service callback at exchange, revokes locally, resumes, and verifies
the binding remains disabled. New explicit same-owner linking still works.
Owner-filtered cursor pagination across 52 emulator bindings and UI controls avoids
losing revocation access as subject records accumulate. The reviewer independently
reran 13 focused Node tests and five linking UI tests, and found no remaining
Critical/Important issue after the fix. Emulator results were inspected by review,
not independently rerun by the reviewer.

## Restricted-test preparation without TTL

`scripts/mcp-link-cleanup.ts` is a manual operator utility, dry-run by default.
Five additional unit/CLI checks verify exact owner/project/cutoff inputs, no
credential initialization on missing arguments, no secret output, reviewed plan
hashes and preservation of concurrent changes. An additional actual demo Firestore
test verifies owner filtering, projected fields, version rechecks and preservation
of live/foreign/malformed attempts, bindings and revocation epochs. No live cleanup
was run, and no TTL, scheduler, billing change or new Admin credential was created.
Independent read-only review reran the five tests and found no Critical/Important
issue; it inspected the eight-test emulator log rather than rerunning emulators.

Read-only preparation found an Auth0 Dashboard login screen, no configured Auth0
connection, Vercel deployment protection, no custom test environment/domain, and
the code's production-only WIF boundary. The exact signup/terms, identity,
credential, hosting and cleanup operator-access gates are documented in
[mcp-restricted-test-setup.md](mcp-restricted-test-setup.md). No personal identity was
submitted and no signup/login/terms agreement was completed.

Provider comparison, current published free limits, actual configuration evidence
and the concrete activation/approval bundle are in
[mcp-personal-oauth-decision.md](mcp-personal-oauth-decision.md). Firestore TTL is a
billable feature, not part of the free allowance; no billing change was made.

No external credentials, OAuth clients, production identity bindings, IAM/environment changes,
deployment, merge or production data mutations were made. **Hosted ChatGPT
installation, actual provider consent and a real `mindmaps_list`/`mindmaps_get`
call in 小兔 remain unverified and blocked**, as detailed in
`docs/mcp-client-integration.md`. The new linking code still needs approved provider
configuration, actual rules/cleanup checks and live isolated acceptance. This PR
is not an authorization server and does not complete the hosted connection.
