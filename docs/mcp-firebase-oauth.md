# Firebase-backed ChatGPT MCP authorization

Selected by the user on 2026-11-05. This replaces the proposed Auth0 signup/identity-link approach. Firebase remains Antty's login and UID authority. Antty now implements the narrow OAuth authorization-server layer needed by hosted ChatGPT. No Auth0 resource is required or created by this change; the earlier Google/Auth0 onboarding session is paused, and its completed registration/tenant state remains unconfirmed. Pausing does not revoke that earlier Google sign-in connection.

## Why Firebase plus an OAuth layer

Firebase ID tokens are intended for the Firebase project: their `aud` is the project ID and their `iss` is `https://securetoken.google.com/<projectId>`. The Firebase REST sign-in/custom-token/refresh operations do not, by themselves, implement Antty's public OAuth authorization-code endpoint, custom MCP scopes, client consent or resource-bound access tokens. Firebase's OIDC sign-in option consumes another provider; enabling it does not turn Firebase into Antty's generic OAuth authorization server. These are conclusions about the documented interfaces, not a claim that Firebase cannot be used. [Firebase verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [REST API](https://firebase.google.com/docs/reference/rest/auth), [OIDC sign-in](https://firebase.google.com/docs/auth/web/openid-connect).

ChatGPT supports predefined OAuth clients, so this implementation does not need DCR or CIMD. It publishes discovery, requires authorization code + S256 and resource indicators, and checks every MCP bearer against the specific resource/account/scope grant. Auth0 was an optional managed implementation of this layer, not a protocol requirement. [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Follow-up pilot boundary (prepared, not deployed)

Before enabling the first-party trial, this branch now requires server-only `ANTTY_MCP_FIREBASE_OAUTH_TEST_UID` with the explicitly verified test UID. Missing/invalid UID fails closed. Consent, exchange, bearer use and connection listing exclude other UIDs; owner/token revocation remains available. While the pilot is enabled, the MCP gateway applies the same UID and scope ceiling to PATs too, and new PAT issuance rejects other UIDs, wider scopes or more than seven days. With the pilot off, existing PAT behavior is unchanged.

Production still has permissive legacy board/image matches and this safety preparation has not been deployed. Follow [legacy access cutover and backup plan](legacy-access-cutover.md) before creating the test identity or activating MCP. No actual owner/test UID is inferred or configured. Add `ANTTY_MCP_FIREBASE_OAUTH_TEST_UID=<verified test UID>` to the activation bundle below; the old bundle alone is no longer sufficient for this code.

## Implemented flow

1. ChatGPT discovers `/.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-authorization-server`.
2. `/oauth/authorize` validates a fixed public client, exact configured HTTPS callback, `response_type=code`, S256 challenge, state, scopes and `resource={origin}/api/mcp`. Unknown/duplicate parameters and untrusted redirects are rejected locally.
3. A five-minute browser-bound request opens `/mcp/consent`. The user signs into their existing Firebase account. Reading the preview transactionally pins the verified UID and owner revocation epoch. Login alone grants nothing. The actual frontend response denies framing and sends no-store/no-referrer headers.
4. Approval requires explicit consent plus Firebase reauthentication within five minutes. The server snapshots the scopes/client/resource/UID into a fresh immutable grant, then returns a single-use 60-second authorization code to the validated callback. Cancel returns access_denied with the original state.
5. `/oauth/token` accepts bounded form data, a public client ID (`none` authentication), matching redirect/resource and PKCE verifier. A Firestore transaction consumes the code and issues a random opaque bearer. Only hashes are stored; Firebase ID and refresh tokens never leave Antty. The bearer expires at the earlier of one hour or grant expiry. **No OAuth refresh tokens are issued: reconnect and consent again after access-token expiry.** A grant's seven-day ceiling is not a promise of seven-day unattended access.
6. Every MCP call checks the stored token, active grant, exact resource/client/current scope ceiling and Firebase disabled/revoked account state. No failed OAuth-to-PAT/Firebase fallback. Backend/transport failures return sanitized 503 responses rather than invalid-token 401 challenges. Authenticated code replay revokes its grant; invalid PKCE cannot burn/revoke a legitimate code.
7. The AI access page lists owner-only paginated connections and can revoke one. Revocation disables that grant and invalidates already-open consent via an owner epoch; it does not disable sibling connections. `/oauth/revoke` supports token-holder revocation. Already-executing requests cannot be recalled.

Existing mindmap and board CRUD, revision/conflict protection, and Calendar ETag checks remain in their existing services. All six read/write scopes are supported by the policy, but the first deployment ceiling is `maps:read`. A later scope increase cannot expand a previously consented grant. Calendar still requires its separately approved AI Google OAuth grant; human Calendar credentials are never reused.

## Exact activation bundle — not applied

All new settings remain disabled in `.env.example`. Do not copy example IDs/callbacks into production as if verified.

| Resource                                  | Required reviewed value/action                                                                                                                                        | Consequence                                                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing Firebase project `antboard-2025` | Verify existing login, Admin WIF and deployed rules. Agree on an isolated test UID and synthetic map; do not infer an identity from email alone                       | No new Firebase provider/account migration; no new Admin key or IAM expansion presumed                                                                                                             |
| Vercel `antty_kanban`                     | Approve merge/deployment and reachable HTTPS environment separately. Existing production-only WIF and deployment protection must be respected                         | Local tests do not prove a preview can use production Admin credentials or be reached by ChatGPT                                                                                                   |
| Antty OAuth configuration                 | `ANTTY_MCP_ENABLED=true`, actual `ANTTY_APP_ORIGIN`, `ANTTY_MCP_FIREBASE_OAUTH_ENABLED=true`, `ANTTY_MCP_FIREBASE_OAUTH_SCOPES=maps:read`                             | Enables public protocol endpoints and private read-only tools; requires explicit activation approval                                                                                               |
| Fixed public OAuth registration           | `ANTTY_MCP_FIREBASE_OAUTH_CLIENTS=[{"id":"<approved public client ID>","name":"ChatGPT personal","redirectUris":["<exact callback shown by actual ChatGPT setup>"]}]` | At most five clients/five exact callbacks each. No client secret, signing key, open registration or wildcard callback. Confirm the actual ChatGPT setup permits this predefined public-client mode |
| Legacy alternatives                       | `ANTTY_MCP_OAUTH_ENABLED=false`, `ANTTY_MCP_LINK_ENABLED=false`; no Auth0 configuration                                                                               | First-party mode rejects simultaneous managed/link flags; old link backend is inactive in first-party mode                                                                                         |
| Hosted ChatGPT                            | Add the actual approved MCP endpoint with that predefined public OAuth client; complete Firebase login/consent yourself as needed                                     | This creates real persistent access and remains unperformed. Never treat SDK acceptance as hosted installation                                                                                     |

No external provider subscription is introduced. Existing Firebase/Firestore/Vercel usage and ChatGPT plan requirements still apply; this is not a guarantee of zero hosting/database costs. No paid TTL, automatic cleanup or billing change is enabled.

## Storage budget and manual cleanup

All five collections (`mcpAuthRequests`, `mcpAuthOwners`, `mcpAuthGrants`, `mcpAuthCodes`, `mcpAuthTokens`) are Admin-only and denied to browser SDKs by the draft catch-all rules. Audit the actual deployed rules before activation. Code/token/request plaintext secrets are never persisted. Owner epochs have no expiry and must not be removed to “clean up” revocation.

Before public authorization writes, persistent global budgets allow at most 120 requests/minute and 300/hour; five-minute logical expiry bounds live requests to at most 600. An additional peer budget and account consent/management quotas apply. On a proxy deployment the socket peer may represent multiple users; these conservative limits can cause shared throttling and should be evaluated in the personal pilot. Rates bound accumulation but do not remove old documents.

`scripts/mcp-oauth-cleanup.ts` is a manual, dry-run-first operator utility for one allowlisted temporary collection per run, at most 100 rows already expired at least 24 hours. It outputs only document hashes, expiry and version metadata, and a plan hash. Applying requires the reviewed hash and rechecks the exact version/expiry transactionally. It never targets owner epochs or application maps/boards/events. Existing approved Admin access and **separate approval for each live cleanup/apply** are required. No live invocation occurred.

```
node --import tsx scripts/mcp-oauth-cleanup.ts --project antboard-2025 --table requests --expired-before <exact ISO UTC cutoff at least 24h old>
# After review and approval only: repeat with --apply --expected-hash <reviewed hash>
```

## Acceptance and remaining limits

Local acceptance uses a real MCP SDK and HTTP transport with synthetic Firebase identities/data, not real Google credentials. It discovers metadata, generates S256 proof, follows consent, exchanges the code, lists only mindmap read tools, reads a synthetic map, then fails after revoke. Separate existing isolated SDK tests exercise mindmap/board/synthetic-Calendar CRUD. Actual Firestore emulator tests cover transactional code/revoke races and direct-browser denial.

Before claiming hosted completion: deploy the reviewed code only after approval, validate deployed metadata and frontend security headers, confirm exact client/callback and isolated UID, connect from the real hosted ChatGPT client, read only the approved synthetic map, verify write/board/calendar denial, revoke and verify the next real call fails. Broader CRUD and AI Calendar grants are separate explicit expansions. Long-lived refresh/offline access, DCR, CIMD and a general-purpose OAuth service are intentionally absent.
