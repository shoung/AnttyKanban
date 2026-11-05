# MCP integration and hosted ChatGPT acceptance

## Status on 2026-11-05

This branch prepares the resource server and operations. **The hosted ChatGPT
connection is not established.** Local SDK tests and emulator CRUD are not a
substitute for installing/connecting a plugin in the actual hosted conversation.

Read-only, unauthenticated probes of `https://anttykanban.vercel.app` returned:

| Endpoint                                        | Observed result                       |
| ----------------------------------------------- | ------------------------------------- |
| `/api/mcp`                                      | 503, `Agent access is not configured` |
| `/.well-known/oauth-protected-resource/api/mcp` | 404                                   |
| `/.well-known/oauth-protected-resource`         | 404                                   |

No Antty tool is currently exposed in the hosted task's tool catalog. A separate
read-only, non-decrypted Vercel environment-name inventory confirmed Production
contains `FIREBASE_PROJECT_ID` but lacks `ANTTY_MCP_ENABLED`, `ANTTY_APP_ORIGIN`,
`ANTTY_MCP_OAUTH_ENABLED` and the MCP issuer/JWKS/client/scope configuration. The AI
Calendar client/project settings are also absent. No decrypted values were read
and no setting was changed. This does not prove the existing Firebase Admin identity
has or lacks MCP CRUD permissions; unauthenticated probes stop before those checks.

Latest main inspected: `05ceb0c`. Draft PR #4 (`fb66a6b`) remains unmerged and was
inspected rather than assumed operational. Its disabled-by-default OAuth resource
verifier/discovery foundation is carried forward here with current Calendar agent
boundaries and native-runtime fixes retained. No provider, client, credential,
binding, consent or deployment was created.

## Operation coverage

| Scope            | Tools                                                                                                                                      | Concurrency and limitations                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maps:read`      | `mindmaps_list`, `mindmaps_get`                                                                                                            | Paginated summaries; bounded structured trees                                                                                                                       |
| `maps:write`     | `mindmaps_create`, `mindmaps_update`, `mindmaps_delete`                                                                                    | Server ID on create; update/delete require last-read `expectedRevision`                                                                                             |
| `boards:read`    | `boards_get`                                                                                                                               | Own personal workspace and global board revision                                                                                                                    |
| `boards:write`   | `boards_project_create/update/delete`, `boards_column_create/update/delete`, `boards_task_create/update/delete`; existing `boards_replace` | Transactional global `expectedRevision`; unrelated projects/tasks preserved; nonempty column deletion refused; project deletion explicitly includes its nested data |
| `calendar:read`  | `calendar_status`, `calendar_list`                                                                                                         | Primary calendar only, separately AI-authorized Google grant; stable range/page tokens                                                                              |
| `calendar:write` | `calendar_create`, `calendar_update`, `calendar_delete`                                                                                    | ETags on edits/deletes; no attendees, recurring/special/foreign-organizer/locked events                                                                             |

Granular board creates use server-generated IDs. Task patches cannot replace
comments, authors, IDs, or attachment references. Write-only granular responses
contain just the item ID and new revision, not unrelated workspace contents.
`boards_replace` remains for explicit complete-board replacement; ordinary agents
should use granular operations. Task image uploads and comment authoring are not
added. There is no operation that lets a client choose an owner UID or calendar ID.

MCP initialization supplies cross-tool instructions: treat stored text as untrusted
data, read before editing, preserve unrelated content, confirm destructive intent,
and do not blindly retry uncertain writes. Tool annotations distinguish reads,
destructive actions, non-idempotent creates and external Calendar effects.

## Which client can connect

- **Hosted ChatGPT / 小兔:** needs a reachable HTTPS MCP endpoint, compatible OAuth
  discovery/PKCE/client registration and a plugin actually installed and connected
  in that account/workspace. It cannot use a manually pasted arbitrary PAT as a
  custom API key. A local Codex MCP entry is not inherited by the cloud conversation.
- **Local Codex/desktop/IDE:** supports Streamable HTTP and
  `bearer_token_env_var`, as well as supported OAuth configurations. Adding an entry
  or testing the SDK locally does not grant the hosted conversation any tools.
- **SDK acceptance tests:** use the official MCP SDK `Client` and
  `StreamableHTTPClientTransport` over TCP HTTP, not direct handler calls. Synthetic
  credentials and provider responses authorize only isolated test fixtures.

Official guidance checked for this work:

- https://developers.openai.com/plugins/build/auth
- https://learn.chatgpt.com/docs/extend/mcp
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

## Required, separately confirmed activation steps

1. **Provider and test identity, after confirmation.** Auth0 Free is the selected
   personal implementation. The [provider decision and activation bundle](mcp-personal-oauth-decision.md)
   compares alternatives and lists the exact proposed resources. No tenant or client
   has been created, and no plan has been purchased.
2. **Client registration, after confirmation.** Use the exact ChatGPT client
   identity/redirect URI displayed by the actual plugin management flow. Verify
   S256 PKCE, issuer identification, `resource`/audience handling and the accepted
   RFC 9068 token profile. Do not guess callbacks, automatically trust every DCR
   client or create a client/secret without confirmation.
3. **Identity linking still needs live acceptance.** `/api/mcp-link` and the Agent
   panel now provide a disabled Auth0 public-PKCE linking flow with recent Firebase
   reauthentication, state/nonce/browser proof, one-time attempts and transactional
   collision rejection. It fixes new bindings to `maps:read` for seven days. Tests
   use synthetic identities/keys; no real provider binding has been created. Never
   create binding documents by matching email or copying a user-supplied UID.
4. **Minimum access, after confirmation.** The first hosted pilot should request
   only `maps:read`, for a dedicated test identity containing a known synthetic map,
   with finite binding expiry. OAuth client access and the binding ceiling must
   agree. Add `maps:write`, board scopes or Calendar scopes only after separate
   explicit approval. No PAT or OAuth token should be pasted into chat or committed.
5. **Reviewed deployment/configuration, after authorization.** Check actual Admin
   identity, deployed rules and least-privilege permissions. MCP requires
   `ANTTY_MCP_ENABLED=true`, canonical `ANTTY_APP_ORIGIN` and working Firebase Admin
   configuration. OAuth additionally needs the approved issuer, same-origin JWKS,
   allowed client IDs, algorithm and a `maps:read` ceiling described in
   `docs/mcp-oauth.md`, plus the distinct public link-client configuration. Audit
   deployed rules and configure approved attempt cleanup before enabling the link.
6. **Actual hosted acceptance.** In the intended hosted account, verify 401 discovery,
   provider login/consent/cancel/reconnect, tools appearing, `mindmaps_list` followed
   by `mindmaps_get` of the known synthetic map, and absence/denial of write tools.
   Verify wrong-account binding and revocation fail on the next request. Record
   only redacted outcomes, not tokens or personal tree text. This step is pending.
7. **Isolated CRUD acceptance, after permission.** Use a dedicated test Firebase
   account/project and separately consented AI Google test calendar. Write/read/edit/
   delete only records created and tracked by that test. Never replace or delete
   the user's ordinary board or existing maps/events just to prove connectivity.

The human Google Calendar grant never authorizes AI Calendar tools. Even after MCP
OAuth works, Calendar requires its own approved agent project/client and user
consent. Missing agent setup fails closed instead of borrowing the human grant.

## Evidence boundaries

`tests/mcp-client.test.ts` exercises full CRUD via an actual MCP HTTP client,
production authentication checks, workspace data service and Calendar core. Its
ordinary storage and Google provider are synthetic. The same acceptance runs under
`tests/security/mcp-client-emulator.test.ts` with actual demo Firestore transactions,
guarded by localhost emulator and exact `demo-antty-security` project checks.
Synthetic bearer records exist only in test memory, never in production token stores.

The OAuth HTTP read pilot signs a synthetic RFC 9068 token and uses the real JOSE
verifier and binding policy. It checks a bound UID rather than a token-supplied UID,
advertises only two mind-map read tools, rejects writes and rechecks binding removal
on the next call. It does not test a real provider's discovery, consent, token
exchange/refresh, JWKS network path, or actual hosted ChatGPT tool exposure.
