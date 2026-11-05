# MCP client verification — 2026-11-05

Base main: `05ceb0c`. Branch: `feat/mcp-client-crud`.

| Check | Result |
| --- | --- |
| Baseline before changes | 133 unit/native tests, 62 UI tests passed |
| Final unit/native suite | 155 passed, including the actual SDK HTTP and OAuth read pilots |
| Official SDK Streamable HTTP CRUD | Passed through actual HTTP handler/auth/data service |
| Demo Firestore persistence | 6 emulator tests passed, including SDK CRUD with actual transactions |
| Synthetic OAuth read pilot | Signature, issuer/resource/client/scopes, bound UID, read tools and immediate binding denial passed |
| UI regression suite | 62 passed |
| Typecheck / lint / production build | Passed |
| Production unauthenticated probe | MCP 503; both OAuth metadata routes 404, connection not live |

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

No external credentials, OAuth clients, identity bindings, IAM/environment changes,
deployment, merge or production data mutations were made. **Hosted ChatGPT
installation, actual provider consent and a real `mindmaps_list`/`mindmaps_get`
call in 小兔 remain unverified and blocked**, as detailed in
`docs/mcp-client-integration.md`. The provider-specific dual-proof identity-linking
implementation is still a prerequisite; this PR is not an authorization server.
