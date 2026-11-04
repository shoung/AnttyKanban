# Managed OAuth for Antty MCP

## Intent and scope

Prepare the existing private MCP resource server for ChatGPT web using a managed OAuth provider, without replacing Firebase login, minting credentials, configuring external services, or deploying. This is a reviewable implementation foundation, not a claim that a live ChatGPT connection exists.

The implementation decision is to use an external authorization server. Antty remains a resource server. Authorization-code + S256 PKCE, consent, client registration and refresh-token lifecycle belong to the selected provider. No new authorization server or token-passthrough proxy is built.

## Approaches

- Keep PAT-only access: already works with compatible local MCP clients, but does not provide ChatGPT web OAuth.
- Managed OAuth provider: selected for this implementation because mature providers own the security-sensitive grant lifecycle. Provider configuration and live identity linking remain explicit release gates.
- Self-hosted authorization server using SDK routes: not selected because code/refresh/consent storage and replay protections substantially expand the security surface.

## Resource-server contract

- Keep the existing stateless Streamable HTTP endpoint and PAT path unchanged.
- OAuth is independently disabled by default. Invalid enabled configuration fails closed, while valid PATs remain usable.
- Resource/audience is exactly the canonical application origin plus `/api/mcp`.
- Trust one explicitly configured HTTPS issuer and same-origin HTTPS JWKS endpoint. Never follow token-supplied URLs or JWKS redirects.
- Use the existing `jose` package for asymmetric JWT signature verification. Pin algorithms, issuer, audience, required expiration/issued-at/subject claims, bounded lifetime, and configured OAuth client IDs. Reject ID tokens, unsigned tokens, symmetric algorithms, missing claims and unsupported authorization scopes.
- Trust only pre-existing, server-managed identity bindings keyed by a hash of the exact issuer and subject. Never map email, an arbitrary token `uid`, or a caller-supplied UID to Firebase.
- Bindings include exact issuer/subject, Firebase owner UID, enabled state, explicitly approved scope ceiling, allowed client IDs, a not-before cutoff, a finite expiry, and the original verified Firebase auth_time. No automatic account or binding creation is provided.
- Each request rereads the binding and Firebase account to enforce disablement, scope reduction, revocation and deleted accounts. Firebase revocation applies to both the original Firebase auth_time and the external token issuance time, so refresh cannot resurrect the old identity proof.
- Expose public RFC 9728 resource metadata and a discoverable 401 challenge. Metadata contains only public provider/resource/scopes, never subjects, bindings or tokens. Advertise only configured scopes, with read-only scopes as the maximum initial rollout.
- Keep existing per-tool scope enforcement and add OAuth scheme metadata only for OAuth-authenticated sessions.

## Identity-linking release gate

Before writing any real binding, implement and verify an operator-approved linking workflow that proves both the current Firebase session and the provider subject in one nonce-bound, short-lived transaction. Firebase session verification must check revocation; OAuth identity proof must verify issuer/audience/signature, state/nonce/PKCE and an exact callback. Obtain explicit consent showing both account labels and scope ceiling. Create the binding atomically without reassignment, and keep an audit record. An alternative is a managed provider external-authentication bridge that derives a stable external identity from a server-verified Firebase UID; this must be reviewed against that provider's actual API. Email equality is never proof.

This change intentionally provides no binding write endpoint or automatic migration. With no verified binding, OAuth access is denied. External provider selection, approval, configuration and this identity-linking gate must be resolved before end-to-end connection can be claimed.

## Non-goals

No new Google Calendar grants, no secret in a `VITE_` value, no production data or identities in tests, no open DCR endpoint, no arbitrary issuer discovery, no provider management token, no automatic deployment or weakening of Firestore rules.

## Verification

Use generated in-memory test keys and synthetic accounts. Cover signature/issuer/audience/client/type confusion, time boundaries, scope injection, mapping mismatch and same-email different-subject cases, revoked/deleted Firebase users, OAuth-disabled PAT compatibility, metadata headers/routes, and a real SDK HTTP round trip. Run the full unit/UI/typecheck/lint/build checks and emulator rules tests where available. Independently review security before requesting production setup.
