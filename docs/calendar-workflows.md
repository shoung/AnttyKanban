# Human and AI Calendar authorization

Google's current OAuth guidance requires separate client IDs for traditional interactive features and AI/automated/MCP workflows. This integration now treats the two as separate authorizations, even when they belong to the same signed-in person.

Official references:

- https://support.google.com/cloud/answer/15549257?hl=en (Configure OAuth Clients for AI Agents)
- https://developers.google.com/workspace/guides/create-credentials
- https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke

## Boundaries

The existing Calendar workspace performs personal event CRUD using only the human/UI grant. MCP Calendar tools use only the separately authorized agent grant. The AI grant management panel requires normal Firebase browser authentication; MCP cannot initiate or complete consent. Missing agent configuration or consent never falls back to the human grant.

Human and agent OAuth states, browser cookies, stored grants, revisions and authenticated encryption context are isolated. Callback state cannot be moved between the two endpoints. Both Google accounts must match the verified Firebase Google-provider subject. Neither workflow accepts a caller-selected user or calendar ID. Both retain the primary-calendar restriction, ETags, and existing restrictions on attendee/recurring/special events.

Existing unbound legacy records are not copied into an agent grant, deleted, or silently reinterpreted. Where a legacy human record exists, the person must explicitly reconnect before the new bound grant is used. Disconnecting an untouched legacy grant is refused with `LEGACY_CALENDAR_GRANT`; reconnect explicitly or deliberately revoke old access in Google account settings instead of reporting a false revocation. Changing the configured client/project/encryption key after a bound grant exists fails closed with an operator-repair state, rather than overwriting or revoking the old grant under different settings.

## Operator setup, separate approval required

1. Verify the actual ownership and configuration of existing Google projects and clients first. Do not create duplicates, copy credentials into chat, or commit credential files.
2. Use separate Google projects for the human and agent workflows. Prefer dedicated projects that are also distinct from the existing Firebase/sign-in project, so Calendar revocation does not couple to unrelated Google grants there. The application checks human versus agent project declarations; it does not independently prove project ownership or guarantee isolation from every other integration. Enable the Calendar API in each. Create a standard Web application client for human UI and a distinct Web application client marked for AI-powered agents for the agent workflow. The console's agent classification must be verified by the operator; code cannot prove this from a client ID.
3. Human callback: `<APP_ORIGIN>/api/calendar?action=callback`.
4. Agent callback: `<APP_ORIGIN>/api/calendar-agent?action=callback`.
5. Both request only `openid` and `https://www.googleapis.com/auth/calendar.events.owned`. Google grants access to owned calendars as a category; the server further limits use to `primary`. Do not add full-calendar, sharing, attendee, or calendar-list permissions as a workaround.
6. Store server-only credentials in the approved production secret store. Human configuration uses `GOOGLE_CALENDAR_PROJECT_ID`, `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `CALENDAR_TOKEN_ENCRYPTION_KEY`. Agent configuration uses `GOOGLE_CALENDAR_AGENT_PROJECT_ID`, `GOOGLE_CALENDAR_AGENT_CLIENT_ID`, `GOOGLE_CALENDAR_AGENT_CLIENT_SECRET`, `CALENDAR_AGENT_TOKEN_ENCRYPTION_KEY`, and `GOOGLE_CALENDAR_AGENT_CLIENT_CONFIRMED=true` only after console verification. `CALENDAR_APP_ORIGIN` is the shared canonical HTTPS origin. Never use `VITE_` prefixes for these values.
7. Client IDs, declared project IDs and encryption keys must differ. Project declarations are configuration checks, not independent evidence of Google client ownership; verify both clients in the console. Preserve encryption keys securely; replacing them is not a migration.
8. Verify deployed Firestore rules deny all browser access to Calendar connection/state documents and descendants. A blanket explicit deny does not override another matching allow. Firebase Admin bypasses those client rules.
9. Review consent branding, support contact, privacy disclosures and the current scope classifications. Testing mode with Calendar scopes expires refresh-token grants after seven days. A personal-use production exception is not public verification and may still show warnings or encounter user caps/Workspace restrictions.

## Revocation and consent

The person authorizes each workflow separately. Authorizing human Calendar access does not authorize an AI client, and the Google agent grant is not a substitute for the MCP client's own authentication and scopes.

Google token revocation can affect every OAuth client in the same Google project. A different client ID alone is not a revocation boundary. Separate projects reduce this coupling, but revoking a workflow can still affect other grants within that workflow's Google project. The UI retains that warning; it never promises arbitrary Google integrations are unaffected. Local grant disablement precedes the provider request, and a provider failure remains revocation_pending rather than reporting success.

## Verification before activation

- Run unit, UI, native-runtime, typecheck, lint, build and rules-emulator checks on the exact commit.
- Review configured scopes, agent client classification, exact callbacks, project declarations, encryption-key separation and production rules without exposing secret values.
- Deploy only with approval. Confirm missing configuration leaves ordinary Firebase login, boards and maps intact.
- Have the person explicitly connect human and agent workflows separately; first verify read-only status/list behavior. Prove UI-only consent cannot enable an MCP Calendar read.
- Test cancellation, wrong Google account, replayed/cross-workflow callback, config drift, account switch and independent local disconnect state.
- Any real event create/update/delete or provider revocation test needs explicit approval for its effects. Do not mutate real calendar data solely to prove setup works.
- No credential, cloud setting, real grant or deployment is created by this code change.
