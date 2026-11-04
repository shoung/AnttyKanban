# Optional Google Calendar integration

## What is implemented

The existing Firebase Google sign-in stays unchanged. Calendar is an explicit, optional connection for each Firebase UID. The connected Google account must match that user's verified Firebase `google.com` provider subject, so a callback cannot silently attach another account. The UI operates the authenticated user's **primary calendar** only.

A Vercel function at `/api/calendar` exposes status, connection, callback, disconnection and event CRUD. `server/calendar/service.ts` exports the same UID-scoped operations for an authenticated MCP layer. Neither interface accepts a caller-selected user ID or calendar ID. Existing Firebase accounts and board data require no migration and are not automatically turned into Calendar events.

Personal, non-recurring events can be created, edited and deleted. Events with attendees, hidden attendees, a different organizer, recurrence or special event types are displayed read-only. This avoids accidental invitation/cancellation email and series-wide changes. Event updates and deletes use Google ETags with `If-Match`; HTTP and MCP callers must supply the ETag they last read. Calendar sharing/ACLs, calendar deletion and arbitrary Google API proxying are deliberately absent.

## Security design

- Firebase Admin validates the browser's Firebase ID token. Only the verified UID is used for document lookup. An MCP caller must independently authenticate and validate its active Firebase user before calling this service.
- The Google OAuth code exchange and refresh flow run on the server using `google-auth-library`. Requests include offline access, S256 PKCE and cryptographically random state. The ten-minute state is hashed as the Firestore document ID, bound to a host-only HttpOnly browser cookie, consumed atomically once, and tied to the current connection revision. The PKCE verifier is encrypted at rest.
- Google ID tokens are verified for issuer/signature/audience by the official library, then their `sub` is compared with the Firebase Google-provider UID. Email strings and browser-supplied UIDs never establish account ownership.
- Refresh tokens use AES-256-GCM with a fresh 96-bit nonce and authenticated UID context. Changing the UID or ciphertext makes decryption fail. Access tokens stay transient on the server. Neither token type is returned to the browser or MCP client. Secrets are never intentionally logged.
- Connection revisions prevent an older callback from restoring a connection after disconnect, or overwriting a newer connection. A refresh checks the current revision again before an event request.
- Mutating browser routes require exact same-origin `Origin` and JSON, enforce body size, disallow extra parameters, and derive all Google endpoints on the server. Callback redirects use only the configured origin. Responses are `no-store`, `no-referrer`, non-frameable and return sanitized errors.
- Missing configuration leaves Calendar unavailable without changing Firebase sign-in. `invalid_grant` transitions to `reconnect_required`; it does not repeatedly request consent or loop on refresh.

## Google permission scope

The implemented scopes are `openid` and `https://www.googleapis.com/auth/calendar.events.owned`. Google grants event access to the user's owned calendars as a category, **not exactly one existing calendar**. This implementation adds its own hard server-side restriction to `primary`. The UI discloses that distinction. A future dedicated app-created secondary calendar could use `calendar.app.created`, but that is a different product choice and is not silently created here. No calendar-list or full-calendar scope is requested. Existing broader Google grants are not automatically reduced merely by changing requested scopes.

Source: [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

## Disconnect and revocation

Disconnect requires explicit acknowledgement of Google's project-wide revocation behavior. The connection is disabled locally **before** the provider call. After successful revocation its encrypted refresh token is removed, while a token-free revision tombstone prevents stale callbacks from reconnecting it. If Google is unavailable, state remains `revocation_pending`: no event calls or reconnect are allowed, and the encrypted credential is retained only to retry revocation. The UI clearly reports that provider revocation has not completed and offers a retry.

Google revocation affects that user's grants and tokens across OAuth clients in the same Google Cloud project. A second client ID alone is not an isolation boundary. Use a separate Google Cloud project if independent Calendar grant/revocation lifecycle is essential. Existing Firebase sessions are a separate credential system, but other Google API features may require authorization again. Calendar events are not deleted by disconnect. Any Google request already submitted before revocation cannot be recalled, and Google revocation propagation may take time.

Sources: [Google web-server OAuth and revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke), [token storage best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

## Required operator setup, not performed by this change

1. Review whether Calendar needs a separate production Google Cloud project to isolate consent/revocation. Keep development/testing in a separate project. Do not move the existing production Firebase login project back to Testing.
2. Enable the Calendar API and configure a Web application OAuth client. Register the **exact** callback `${CALENDAR_APP_ORIGIN}/api/calendar?action=callback`. `CALENDAR_APP_ORIGIN` is an origin only, without path or trailing slash. HTTPS is required except explicit localhost development.
3. Review the actual scope classification in Google Cloud Console Data Access. Complete relevant brand/domain/privacy-policy and sensitive-scope verification before broad public launch. Publishing In production does not itself grant verification. The privacy policy must explain Calendar data usage, server token storage, retention/deletion and any downstream MCP access.
4. Configure server-only environment variables through an approved secret store: `FIREBASE_PROJECT_ID`, `CALENDAR_APP_ORIGIN`, `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `CALENDAR_TOKEN_ENCRYPTION_KEY` (exactly 32 random bytes, canonical base64). Never use `VITE_` for secrets, tokens, encryption keys or service-account credentials. Existing public Firebase web config is not a substitute for backend credentials.
5. Supply Firebase Admin Application Default Credentials using approved workload identity or host configuration. Prefer Vercel OIDC with GCP Workload Identity Federation where supported, avoiding long-lived JSON service-account keys. Use minimum IAM permissions. Creating grants/trust or entering credentials for persistent access requires separate operator approval.
6. Review and deploy appropriately restrictive Firestore rules before enabling this feature. `calendarConnections/{uid}` and `calendarOAuthStates/{hashedState}` must have **no** matching client allow rule, including broad recursive rules. An explicit deny does not override another allow. The supplied `security/firestore.rules.draft` is a review artifact and has not been deployed. Admin SDK bypasses client rules, so server UID enforcement is mandatory.
7. Optionally configure Firestore TTL on `calendarOAuthStates.expireAt`. Logical expiry is enforced even without TTL, but TTL is needed to remove abandoned attempts automatically. Do not print state, token, authorization-code or callback query values into logs. Protect backups of encrypted tokens and their encryption key separately.
8. Preserve the encryption key securely. This version uses one `v1` encryption key and does not implement online key-ring rotation: replacing it without a controlled migration makes existing connections undecryptable. Plan and test migration/reconnection before rotating; do not casually overwrite it.
9. Review host rate limits, error monitoring and retention for abandoned/pending-revocation records before public launch. Do not automatically retry ambiguous event mutations; refresh the event list first.

Testing-mode Calendar consent is limited to up to 100 listed test users and expires after seven days, including refresh tokens. The basic-profile-only exception does not apply once Calendar is requested. Unapproved sensitive scopes in production can still show warnings and have a project lifetime user cap. Workspace administrator restrictions can independently block authorization.

Sources: [app audience and testing](https://support.google.com/cloud/answer/15549945?hl=en), [verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), [Vercel workload identity](https://vercel.com/docs/oidc/gcp), [Firebase ID tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [Firestore server/rules boundary](https://firebase.google.com/docs/firestore/security/rules-conditions), [Vite environment exposure](https://vite.dev/guide/env-and-mode).

## MCP boundary

Calendar OAuth is the app's downstream Google grant. It is **not** authorization for an arbitrary MCP client to use the app. The MCP layer must authenticate its own credential, scope reads/writes, derive UID from that credential, verify the active account and never accept/pass through Google tokens. A manually configured personal-token MCP endpoint is not a complete automatic OAuth onboarding implementation. If remote MCP OAuth is added, provide resource metadata, resource/audience-bound access tokens, PKCE, exact registered redirect validation and per-client user consent. Google consent alone does not authorize a new MCP client.

Sources: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [MCP token audience and PKCE](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations), [MCP confused-deputy protections](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices).

## API and pagination

- `GET ?action=status`: safe connection/configuration status.
- `POST ?action=connect` with `{}`: authorization URL and short-lived browser cookie.
- `GET ?action=callback`: Google redirect, validates state/cookie and returns to `/?calendar=...`.
- `POST ?action=disconnect` with `{ "confirmProjectRevocation": true }`: explicit project-wide revocation acknowledgement.
- `GET ?action=events`: bounded list, default past 30/future 90 days, at most 100 per page. Response includes `timeMin`, `timeMax`, optional `nextPageToken`. Reuse **all three** for the next page; maximum range is 366 days.
- `POST ?action=events`: `{ summary, description?, location?, start, end }`.
- `PATCH ?action=events`: `{ eventId, etag, event: <event input> }`.
- `DELETE ?action=events`: `{ eventId, etag }`.

Dates are `{date: "YYYY-MM-DD"}` for all-day events with an exclusive end date, or `{dateTime: <ISO time with offset>, timeZone?: <IANA zone>}`. UI times use the device's local timezone. Calendar reminders follow Google's existing event/calendar defaults; this implementation does not change those settings.

## Verification and release gate

Local tests cover encryption/tamper/UID binding, PKCE/state, wrong-account linking, missing scopes/refresh tokens, refresh preservation, revocation failure, callback/disconnect races, pagination boundaries, personal-event restrictions, HTTP auth/origin/parameter checks, and UI account switching and disconnect cancellation. They use local fixtures rather than live Google data.

Run `npm test`, `npm run test:ui`, `npm run typecheck`, `npm run lint`, `npm run build`. Before enabling for real users, separately verify the approved deployment configuration, exact callback, real consent/cancellation, seven-day test-grant behavior, Firestore transaction/rules isolation in the deployed environment, actual Google refresh/revoke and two distinct test accounts. No real Google grant, credential, permission change, external event mutation or deployment was performed by this implementation.
