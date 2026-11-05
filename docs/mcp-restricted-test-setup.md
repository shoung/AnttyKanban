# Current direction

The user stopped Auth0 onboarding and selected Firebase-backed Antty OAuth. This file retains the earlier provider preparation as historical context; its signup/configuration steps must not be executed. Use [mcp-firebase-oauth.md](mcp-firebase-oauth.md) for the current flow and activation gates. An earlier Google/Auth0 sign-in reached profile onboarding; full registration/tenant creation was not confirmed. No new Auth0 setup is authorized.

---

# Restricted Auth0 test: registration, credentials and manual cleanup

Prepared 2026-11-05 after the owner approved **preparation** of a seven-day `maps:read` pilot with synthetic mind-map data. Account submission, actual credential creation, persistent access and deployment remain action-specific approval gates. No signup, identity, credential, consent grant, billing change or deployment has been performed.

## Observed existing access

- No Auth0 administration connector or Antty MCP tools are available in this hosted conversation.
- Opening `https://manage.auth0.com/` in the connected browser returned **Log in | Auth0 Dashboard**, with an empty email field. No field was filled and no sign-in/social-login button was clicked. This establishes that no usable signed-in Dashboard session was observed; it does not establish that the owner has no Auth0 account.
- Read-only, non-decrypted Vercel environment metadata again contains `FIREBASE_PROJECT_ID` but no returned MCP/Auth0/Descope configuration keys.
- Existing Vercel project `antty_kanban` has no custom environments and only the verified `anttykanban.vercel.app` project domain returned. Protection metadata is enabled with `deploymentType=all_except_custom_domains`. Do not assume a new preview is accessible to ChatGPT or change this setting silently.
- Current Admin WIF configuration explicitly requires `VERCEL_ENV=production` (`server/adminCredentials.ts`). Preview cannot reuse it by changing an environment label: the cloud trust conditions must also be appropriate. A separate staging route would require separately approved identity/trust setup.

## Registration: what the actual public page requires

The [current signup page](https://auth0.com/signup) offers email, GitHub, Google and Microsoft signup and advertises no credit card requirement. It states that continuing agrees to the [Auth0 Self Service PSS](https://www.okta.com/legal/auth0-pss-self-service/) and [Okta Privacy Policy](https://www.okta.com/legal/privacy-policy/). Do not click Continue or transmit an email/social identity on the owner's behalf until the specific identity, destination and applicable agreement are confirmed. The owner should enter passwords/MFA and review/accept the terms themselves; never ask them to paste passwords, OTPs or OAuth tokens into chat.

If an account already exists, the owner can sign in at [Auth0 Dashboard](https://manage.auth0.com/) rather than create another account. No CLI login or Management API token is needed for the Dashboard setup below. Any additional onboarding agreement, personal-data field, paid-plan selection or credit-card request is a new stop point.

After login, the tenant wizard asks for a unique immutable name and region. Proposed **uncreated** test tenant: `antty-mcp-test-20261105`, locality **Japan (JP)**. Name availability has not been checked; do not automatically select another name/region if unavailable. Auth0 documents that tenant names cannot be changed or reused after deletion, and region controls the tenant's hosted locality. Confirm the actual name/region before Create. Standard provider domains suffice; no custom domain or paid feature is required by this design. [Tenant setup and regions](https://auth0.com/docs/get-started/auth0-overview/create-tenants).

## Exact identity and credential inventory

| Item                                 | Who chooses/creates it, and where it is used                                                                                          | Required access / handling                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth0 administrator account          | Owner chooses an existing account or a controlled administrator email; owner completes login/signup                                   | Administers only the dedicated test tenant. Email/identity is sent to Auth0 only after confirmation; password/MFA stays in the owner's login/password manager                                                                                                                                                                |
| Firebase test identity               | Owner names an **existing dedicated Google test account** to sign into Antty; Firebase UID is obtained from verified authentication   | Existing UI uses Google login and Google reauthentication. An Auth0 database account alone cannot sign into Firebase. Do not enable Firebase email/password, create a Google account, migrate the main account or infer a UID from an email                                                                                  |
| Auth0 database test identity         | Owner confirms a controlled test email; create it in a dedicated database connection after the explicit account-creation confirmation | A separate test password, entered by the owner. Same database connection enabled for both OAuth applications, public signup restricted. A matching email is never the link proof. No new Google social OAuth client                                                                                                          |
| `Antty Identity Link` application    | After its own approval, Dashboard → Applications → Applications → Create Application → manually create a public SPA                   | Auth0-generated **public client ID** → `ANTTY_MCP_LINK_CLIENT_ID`. Authorization Code + S256 PKCE, RS256 ID tokens, first-party OIDC, token endpoint auth `none`, only `openid`; no client-secret/refresh/client-credentials use in Antty                                                                                    |
| `ChatGPT Antty Personal` application | After its own approval, create the separate predefined OAuth application compatible with the actual ChatGPT setup                     | Public client ID → Antty's one-element `ANTTY_MCP_OAUTH_CLIENT_IDS` and ChatGPT. Exact redirect copied from the actual ChatGPT screen. If confidential authentication is required, the generated client secret belongs only in Auth0 and protected ChatGPT configuration; never the Antty frontend, repository, logs or chat |
| Auth0 API `Antty MCP`                | After its own approval, Dashboard → Applications → APIs → Create API                                                                  | Exact approved HTTPS MCP resource identifier, RS256, RFC 9068 (`rfc9068_profile`), ≤3600-second access token, only `maps:read`, offline access off, consent skipping off. Resource and issuer-response compatibility toggles on in this tenant                                                                               |
| Issuer and JWKS URI                  | Read from the actual created tenant and its public discovery document                                                                 | Public configuration → `ANTTY_MCP_OAUTH_ISSUER` and `ANTTY_MCP_OAUTH_JWKS_URI`; no private signing key is copied or generated by Antty                                                                                                                                                                                       |
| Binding and ephemeral tokens         | Only after approved environment activation and the user's explicit link/OAuth consent                                                 | Firebase ID token and OIDC proof are transient; provider tokens are discarded by linking. Only a finite seven-day `maps:read` binding persists. No `offline_access`/refresh token, Management API key, service-account JSON, extra IAM role or Google Calendar grant is requested                                            |

Creating an application is itself a new persistent registration, even if its client ID is public. A confidential application's secret may be assigned on creation; obtain approval **before** Create, not just before revealing/copying the secret. Do not use sample tokens or Test tabs to mint broader management credentials.

Official Dashboard instructions: [create applications](https://auth0.com/docs/get-started/auth0-overview/create-applications), [public/confidential applications](https://auth0.com/docs/get-started/applications/confidential-and-public-applications), [application credentials](https://auth0.com/docs/get-started/applications/credentials), [access-token profile](https://auth0.com/docs/get-started/apis/configure-access-token-profile), [create database users](https://auth0.com/docs/manage-users/user-accounts/create-users).

## Deployment must be selected before registering exact callbacks

The current draft's documented production candidate is:

- MCP resource: `https://anttykanban.vercel.app/api/mcp`
- Linking callback: `https://anttykanban.vercel.app/api/mcp-link?action=callback`
- Linking web origin: `https://anttykanban.vercel.app`

These are **not authorization to activate production**. Production is unchanged. A distinct test deployment needs its own actual fixed HTTPS origin; use that origin consistently for resource, linking callback, allowed origins, server config and tokens. No test hostname is currently approved or provisioned, so no replacement URI is invented here. ChatGPT's callback is a separate value taken from its actual connection screen, never guessed.

A staging choice also requires verifying Firebase Authorized Domains for Google popup reauthentication and existing Admin WIF trust. Do not add domains, allow preview identities, disable Vercel protection or create bypass secrets without the corresponding explicit approval. ChatGPT cannot be assumed to supply a Vercel SSO session/custom bypass header. Reusing the existing production origin avoids guessing staging trust but requires **separate production deployment/activation approval** and a reviewed test-UID boundary for the pilot routes; the existing link scope alone is not a global test-UID allowlist. Production has not been selected automatically.

Source boundaries: [Firebase Google authentication](https://firebase.google.com/docs/auth/web/google-signin), [Vercel protection](https://vercel.com/docs/deployment-protection), [hosted MCP authentication](https://developers.openai.com/plugins/build/auth). Actual deployed Firebase rules and allowlisted domains remain uninspected; no new Google scope or IAM change is assumed.

## Cleanup without paid TTL or an automatic job

Selected preparation: **manual, bounded, dry-run-first cleanup** using `scripts/mcp-link-cleanup.ts`. No TTL policy, scheduler, cron route, API endpoint or billing upgrade is created. Ordinary Firestore reads/deletes still consume normal project usage; this is not a promise of zero hosting/database charges.

The operator utility:

- accepts only explicit `antboard-2025`, one verified test UID, a precise UTC cutoff at least one hour old and at most 100 owner-filtered records per run;
- reads only `ownerUid`, `createdAt`, `expiresAt` plus document version for planning; no PKCE verifier/nonce/browser hash is printed;
- proposes only well-formed five-minute attempts expired before that cutoff, with an exact plan hash and optional cursor;
- defaults to **no writes**; applying requires the exact reviewed hash, and a transaction rechecks owner, expiry and document version before each delete;
- never modifies identity bindings, revocation epochs, maps, boards, events or another UID's attempts. Expired/revoked binding records and owner epochs are intentionally retained; they prevent subject reassignment and stale callbacks;
- refuses missing arguments, emulator/project mismatches and missing existing approved Admin configuration. It does not log in, create credentials, switch authentication mode, grant IAM access or enable billing;
- reports a changed plan before writes, skips concurrently modified/deleted candidates, and sanitizes failures. An interrupted apply can be partial; inspect a fresh dry-run rather than blindly retry.

Prepared command template (not executed against a live project):

```text
node --import tsx scripts/mcp-link-cleanup.ts --project antboard-2025 --owner-uid VERIFIED_TEST_UID --expired-before YYYY-MM-DDTHH:mm:ss.sssZ
```

After that specific live dry-run is authorized and its target UID, cutoff, counts and hash are reviewed, an **individually approved deletion** adds:

```text
--apply --expected-plan-hash REVIEWED_SHA256
```

If a page is full, review the next page with its returned `--after` cursor; each apply needs its own reviewed hash. The script must run in an existing approved Admin operator environment. Availability of such an environment for live manual operation has **not** been established; do not spoof `VERCEL_ENV`, export WIF tokens or create ADC/service-account credentials to make it run. The synthetic emulator test injects a local-only database instead. Logical attempt expiry remains five minutes independently of physical cleanup.

## Concrete next approvals and stop points

1. **Registration/login:** owner supplies the intended administrator identity or signs in themselves, reviews the linked PSS/privacy notice, and confirms the proposed tenant name/region before its creation. No credentials are collected in chat.
2. **Test identity:** identify the approved dedicated Google/Firebase account and the controlled Auth0 database test email; confirm account creation, without enabling additional Firebase providers.
3. **Hosting route:** choose and approve production activation versus separately scoped staging infrastructure. Confirm actual HTTPS origin, WIF/domain/protection requirements and the manual-cleanup execution environment. Until then, do not finalize API identifiers/callbacks or deploy.
4. **Persistent registrations:** review the actual tenant, resource and two application settings above; confirm each concrete Create action and any required ChatGPT secret. No open DCR, arbitrary clients or automatic grant creation.
5. **Live acceptance:** after separately approved deployment/rules/configuration and explicit seven-day link/OAuth consent, seed only the approved test UID's synthetic map, call hosted `mindmaps_list`/`mindmaps_get`, verify write/board/calendar denial, then revoke and verify next-request denial. No production read of ordinary user data is needed for this test.

Preparation approval does not remove these action-specific gates. This document and the local cleanup tests are deliverables, not evidence that the provider, test identities or hosted MCP connection already exist.
