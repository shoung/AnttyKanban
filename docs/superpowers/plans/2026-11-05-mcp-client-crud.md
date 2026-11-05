# MCP client integration and CRUD plan

Goal: make the current MCP code verifiable through an actual SDK Streamable HTTP
client, preserve hosted ChatGPT OAuth requirements, and avoid whole-board replacement
for ordinary board operations. This is code preparation, not production activation.

Base: latest main `05ceb0c`. Existing draft #4 was inspected at `fb66a6b`; its disabled
OAuth resource-server foundation is carried forward on this separate isolated branch,
with Calendar agent separation retained. No checkout `.agents/skills` or AGENTS.md
was present. Baseline: 133 unit/native tests and 62 UI tests passed.

1. Retain the reviewed disabled OAuth resource verifier/discovery from #4; resolve
   current-main conflicts without removing agent Calendar handlers or deployment bans.
2. Add strict, transactional project/column/task CRUD under existing board scopes,
   with mandatory board revisions, no client-selected UID, preserved unrelated content,
   no implicit deletion of tasks, and bounded responses that do not expose unrelated
   board content to write-only grants. Verify with failing tests before implementation.
3. Exercise real MCP SDK HTTP initialization, tools/list and calls against actual
   workspace services and isolated demo Firestore data. Exercise Calendar core with a
   synthetic Google gateway and explicitly distinguish that from live Google testing.
   Cover mind-map trees, pagination, revisions, ETags, revoked/read-only credentials,
   UID injection, account isolation, missing agent consent and readonly events.
4. Verify a minimal OAuth read pilot over SDK HTTP using synthetic issuer keys and
   server bindings; keep live identity linking/provider setup gated. Document hosted
   connection steps and exact permission/release blockers, then run full checks,
   independent review and draft PR CI. Never merge or deploy.

Observed live blockers (unauthenticated, read-only probes on 2026-11-05):
`/api/mcp` returns 503 `Agent access is not configured`; both protected-resource
discovery URLs return 404. The current hosted tool catalog has no Antty connection.
#4 has no identity-binding write flow and no approved live provider/client. Creating
credentials, bindings, OAuth consent or persistent access requires separate explicit
confirmation; no such operation is authorized by this code task.

## Completed code and local verification

- Nine strict granular board tools use the existing `boards:write` scope and
  transactionally preserve unrelated records. The original complete replacement
  tool remains available for explicit use.
- Real SDK HTTP acceptance passes with in-memory storage and actual demo Firestore
  transactions, including all workspace CRUD, continuation pagination, concurrent
  revision contention and write-only response/scope restrictions. Google is synthetic.
- Synthetic signed OAuth minimal read pilot verifies the actual token/binding policy
  and denies writes and subsequent access after binding removal.
- Independent review found no Critical/Important issues. Its task-order edge was
  reproduced red and fixed green as a recoverable conflict, without data loss.
- 155 unit/native tests, 62 UI tests and 6 emulator tests passed; typecheck, lint,
  build and diff checks passed. No production changes were made.
- Vercel non-decrypted environment-name inspection confirms missing project-level
  MCP/origin/OAuth and AI Calendar configuration. Hosted acceptance and the
  provider-specific dual-proof linking flow remain explicitly incomplete.
