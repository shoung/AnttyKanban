# MCP identity linking implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Prepare a usable, disabled-by-default personal Auth0/Firebase identity link without creating credentials or activating production access.

**Architecture:** Keep Firebase as the workspace authority. A separate Auth0 public linking application uses server-held S256 PKCE and OIDC nonce/state; its verified subject is bound to the recently authenticated Firebase UID. ChatGPT uses a separate, explicitly allowlisted OAuth client. First link permits only maps:read for seven days, without requesting refresh tokens.

**Tech stack:** Existing Node HTTP handlers, jose, Firebase Admin/Firestore, React. No new dependencies.

**Spec:** Parent delegation: personal hosted ChatGPT MCP, preserve account isolation, no credentials/grants/deployment without approval.

## Global constraints

- No deployment, production writes, new credentials or widened Google permissions.
- No email-based binding, arbitrary issuer/client URLs, client-selected UID/scopes or automatic renewal.
- Do not call the hosted connection complete until real ChatGPT tools are invoked.

## Review focus

- Stale/revoked Firebase identity must not create or restore a binding.
- Cross-browser callbacks, state replay and concurrent callbacks must fail closed.
- Existing subjects cannot silently move owners or widen scopes.
- Provider network errors must neither leak credentials nor silently retry an uncertain grant.
- Account changes and stale asynchronous UI requests must not create a link for another account.

### Task 1: Linking service and HTTP boundary

- [x] Add failing tests for S256/nonce, exact issuer/audience, Firebase recency/revocation, state replay, browser binding, ownership collisions and narrow binding.
- [x] Run tests and confirm missing service fails.
- [x] Implement strict disabled configuration, server-only attempts, transactional consume/bind/revoke, bounded provider fetch and authenticated handler.
- [x] Confirm tests pass and native runtime imports fail closed.

### Task 2: Personal setup UI and provider decision

- [x] Add regression tests for disabled UI, explicit consent, fresh Firebase reauthentication, duplicate submit and account switch.
- [x] Implement a separate OAuth link panel in Agent access; public linking PKCE needs no Antty client secret, refresh token or Management API key.
- [x] Document Auth0 vs Descope vs self-hosting, current free limits, exact resource/client settings and one approval bundle.
- [x] Run unit/UI/emulator tests, typecheck, lint and build. Obtain independent review and update draft PR10 only.
