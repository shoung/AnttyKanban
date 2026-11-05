# Managed OAuth for ChatGPT MCP

## Status: implementation foundation, not an activated connection

Antty now has a managed-OAuth **resource-server** path alongside the existing personal-access-token (PAT) path. It remains disabled by default. This change does not create an authorization server, an OAuth client, a provider account, a Firebase identity binding, a secret, or a live ChatGPT connection. No production deployment is part of this change.

Before enabling OAuth, select and configure a compatible managed provider and complete a separately reviewed identity-linking workflow. **Without a verified binding, every OAuth request is denied.** A Firebase login alone does not authorize a new MCP client. Google Calendar OAuth is downstream authorization and cannot substitute for MCP OAuth.

## What works in which client

- ChatGPT web custom MCP plugins support OAuth, no authentication, or mixed authentication. They cannot send an arbitrary manually entered PAT. Never make private Antty data anonymous to bypass that limit.
- A local Codex host (ChatGPT desktop, CLI or IDE) supports Streamable HTTP with `bearer_token_env_var`. The existing PAT remains available for that route. Local configuration does not automatically install a plugin in a hosted conversation.
- The managed provider owns OAuth discovery, authorization-code + S256 PKCE, exact callback checking, consent, client identification, token issuance, refresh rotation and provider-side revocation. Antty verifies access tokens and maps the authenticated subject to an existing Firebase account.

Sources: [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [custom MCP connection](https://developers.openai.com/api/docs/guides/custom-mcp-server), [local MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

## Provider shortlist, checked 2026-11-04

### Auth0: best fit for the strict JWT contract in this patch

Auth0 documents MCP discovery, client registration and resource identifiers. Its RFC 9068 access-token profile provides explicit access-token typing and `client_id`, unlike its default legacy token profile. Configure that profile for the Antty API; do not weaken Antty validation to accept generic ID tokens. Its Resource Parameter Compatibility Profile must be enabled where required so the MCP `resource` parameter targets the Antty API, rather than `userinfo`.

For an initial controlled pilot, use an approved pre-registered ChatGPT OAuth client with the exact callback shown by the actual ChatGPT connection. Alternatively, explicitly approve the appropriate CIMD client. Do not infer a callback from a blog, and do not silently accept every DCR-created client. Pin the resulting client ID in both server config and the user's verified binding.

The public pricing page currently lists a $0 tier with up to 25,000 monthly active users; the displayed 500-MAU paid examples are $35/month Essentials and $240/month Professional. Exact feature entitlement, production/development separation, quotas and billing must be checked in the intended tenant before signup or purchase. No plan was selected or bought.

Sources: [Auth for MCP](https://auth0.com/ai/docs/mcp/overview), [resource compatibility](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0), [RFC 9068 profiles](https://auth0.com/blog/jwt-access-tokens-profiles-now-in-ga/), [pricing](https://auth0.com/pricing).

### Descope: attractive existing-login bridge, token profile still needs validation

Descope documents DCR, CIMD and pre-registered clients, and a Bring Your Own Auth path. Its External Authentication action redirects to the existing login page, then requires the application's backend to complete a provider request. This could preserve the existing Firebase login UX without migration. A management credential and that bridge would be new persistent access and require separate approval and security review.

The exact emitted issuer, audience, `typ`, client and subject claims must be verified against this patch's RFC 9068 contract. Compatibility has **not** been established with a live Descope tenant. If its standard token format differs, a separately reviewed provider-specific verifier is needed; do not relax the generic verifier or accept a user-editable UID claim. Pre-registered Descope clients also require a resource access policy.

Its published free tier currently includes 7,500 MAUs, 2,000 monthly active consents and 2,000 monthly active tokens. Pro starts at $249/month billed annually. Feature eligibility for the chosen external-auth flow and exact limits still require tenant verification. No tenant or plan was created.

Sources: [MCP authorization](https://docs.descope.com/mcp), [registration methods](https://docs.descope.com/agentic-identity-hub/core-components/mcp-servers/registration-methods), [Bring Your Own Auth](https://docs.descope.com/mcp/bring-your-own-auth), [pricing](https://www.descope.com/pricing).

## Resource-server configuration

Configure these server-only values through the approved deployment configuration:

- Existing `ANTTY_MCP_ENABLED=true`, `ANTTY_APP_ORIGIN` and Firebase Admin configuration.
- `ANTTY_MCP_OAUTH_ENABLED=true` only after the release gates below are met.
- `ANTTY_MCP_OAUTH_ISSUER`: exact canonical public HTTPS issuer, including any path and trailing slash. No query, fragment or credentials.
- `ANTTY_MCP_OAUTH_JWKS_URI`: explicitly pinned public HTTPS JWKS on the same origin as the issuer. Cross-origin JWKS setups are not supported by this first implementation.
- `ANTTY_MCP_OAUTH_CLIENT_IDS`: JSON array of approved client IDs. Client IDs are public identifiers, not client secrets. At most 20 are accepted.
- `ANTTY_MCP_OAUTH_SCOPES`: space-separated Antty permissions. Start with `maps:read boards:read`; add Calendar or write scopes only with explicit consent and corresponding binding changes.
- `ANTTY_MCP_OAUTH_ALGORITHM`: `RS256` (default) or `ES256`; one pinned algorithm, never `none` or a symmetric algorithm.

The resource/audience is derived, not separately configurable: `${ANTTY_APP_ORIGIN}/api/mcp`. The provider must issue tokens for precisely that resource. Tokens need RFC 9068 access-token typing (`at+jwt` or its `application/` form), `iss`, `sub`, `aud`, `iat`, `exp`, `jti`, `client_id`, and `scope`. Maximum access-token age and lifetime are 3,600 seconds; there is no extra expiration grace period. Standard OIDC scopes (`openid`, `profile`, `email`, `offline_access`) never confer Antty access. Other unknown scopes are rejected.

The public metadata routes are:

- `/.well-known/oauth-protected-resource/api/mcp` (canonical RFC 9728 path-specific location)
- `/.well-known/oauth-protected-resource` (compatibility alias)

Both rewrite to `/api/mcp-oauth-metadata`. An unauthenticated MCP request advertises the canonical metadata URL in `WWW-Authenticate`. OAuth-disabled metadata returns 404. Public metadata permits credential-free cross-origin reads; the MCP and token-management endpoints keep their existing Host/Origin protections. Provider authorization-server metadata is served by the provider, not spoofed or proxied by Antty.

## Firebase identity binding: mandatory gate

The `mcpOAuthBindings` collection is server-only. The ID is SHA-256 of JSON serialization of `[exactIssuer, exactSubject]`, preventing delimiter ambiguity. A version-1 record has:

- `schemaVersion: 1`, exact `issuer` and `subject`;
- `ownerUid`: existing Firebase UID, never an email;
- `enabled: true`;
- `clientIds`: explicitly approved OAuth client IDs;
- `scopes`: explicit Antty scope ceiling;
- `firebaseAuthTime`: the verified Firebase ID token's original `auth_time`, in **milliseconds**, not the time at which the server processed the link;
- `validAfter`: reject OAuth access tokens issued before this millisecond cutoff;
- `expiresAt`: finite millisecond expiry of this authorization binding.

This patch deliberately provides **no binding write API, automatic user creation, migration, or linking button**. Do not manually guess a record from matching emails or a copied token. Do not use a provider's user-editable metadata as proof of a Firebase UID.

An acceptable next implementation must prove both identities in a single, short-lived, nonce-bound transaction:

1. Reauthenticate the existing Firebase user and verify the Firebase ID token with revocation checks on the backend. Take UID and `auth_time` only from verified claims.
2. Authenticate the intended provider identity through an exact callback, state/nonce and PKCE flow. Verify the issuer and expected token audience/signature, and bind this proof to the same server-side transaction/browser session.
3. Show the two account labels, client identity, scope ceiling and expiry for explicit user consent. Labels are display only; identifiers come from verified stable subjects.
4. Transactionally create a previously absent binding; reject collisions/reassignment. Store an audit record separately without any token or secret. Set the token cutoff and require a fresh access token if needed.
5. Support authenticated disconnect, immediate local binding disablement, and provider grant/refresh revocation where permitted. Relinking after Firebase-wide revocation requires a fresh identity proof; refreshing an external token cannot bypass it.

A reviewed managed external-authentication bridge that derives a stable identity from the verified Firebase UID is another option. Its exact APIs and security guarantees must be checked before selecting it. Firebase/Google login remains unchanged until a specific linking design is approved.

Every OAuth request reads the binding and Firebase account again. Effective scopes are the intersection of the verified access token and current binding, within the server's configured maximum. A revoked/disabled/expired/mismatched binding or deleted/disabled Firebase account fails closed. The original `firebaseAuthTime` is checked against Firebase's `tokensValidAfterTime`, so newly refreshed external tokens do not revive a revoked Firebase login.

## Revocation and operations

- Disable a binding or reduce its scopes to stop/restrict the next Antty request. Never rely only on a cached tool catalog.
- Provider-side JWT revocation alone is not immediately visible to offline signature verification. An already issued token may remain valid until expiry, up to the configured 60-minute maximum, unless the local binding is disabled. A future introspection/revocation-event integration needs a reviewed provider-specific implementation.
- OAuth and PATs are independent. Disabling OAuth does not revoke existing PATs. An invalid OAuth configuration does not prevent a valid PAT from being checked. A failed OAuth token never falls back to a Firebase ID token or a weaker authorization mode.
- JWKS are fetched from the pinned URL only, without Authorization headers, without following redirects, with a five-second request timeout and 128-KiB response limit. Public keys cache for up to five minutes with a 30-second unknown-key cooldown. Changing issuer/JWKS/algorithm invalidates that instance's cache.
- Credential/provider outages return a sanitized 503 where identified; invalid credentials return a generic 401 without exposing account details. Never log Authorization headers, JWTs or provider callback parameters.
- The draft Firestore rules deny client access to the binding collection, but Admin bypasses rules. Existing broad client `allow` rules must be audited before enabling it. Merely adding a deny rule does not override an existing allow.

## Release checklist

1. Review the draft code and merge the native-runtime/WIF fix first. No auto-deployment is enabled for this feature branch.
2. Obtain authorization for the chosen provider/account setup, OAuth clients, secrets and any persistent permissions. Use a separate non-production tenant and Firebase test project.
3. Configure provider metadata with PKCE S256, approved callbacks/client registration, resource binding and the accepted token profile. Verify exact discovery and signing-key values; do not guess them.
4. Implement and independently review the dual-proof linking workflow above. Verify two real test accounts cannot bind or read one another's workspaces, including same-email/colliding-label cases. This gate is not implemented in the current patch.
5. Validate provider token expiration, refresh rotation, revocation, client restrictions and audience handling. Confirm local binding/Firebase revocation takes effect even after external refresh.
6. Run all local checks and emulator rules tests. Confirm no preview touches production data or secrets.
7. After separately authorized deployment, test actual ChatGPT web discovery, consent acceptance/cancellation, reconnect, scope denial, and a harmless read. Account/workspace plugin restrictions may still prevent connection.
8. Only after those tests call the connection live. Do not enable write scopes merely because the read pilot works.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html), [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html).
