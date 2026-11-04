# Backend activation: production is intentionally not enabled by this patch

Code alone does not grant access. The current deployed functions had unresolved native ESM imports; the regression now compiles NodeNext output and invokes all three handlers in a separate native Node process. A Vite build or a tsx test alone does not exercise that deployment failure.

## 1. Approve and configure Firebase Admin identity

Target Firebase project: `antboard-2025`. Verify its numeric project ID in Google Cloud before configuring it. Create a dedicated runtime service account only after approval. Prefer Vercel OIDC + Google Workload Identity Federation, not a downloadable service-account private key.

Configure a Google workload identity pool/provider for the verified Vercel team issuer and permit only the `antty_kanban` **production** subject. Verify actual claims before binding them. Do not use an owner-wide, project-wildcard, or preview trust rule. Grant that principal `roles/iam.workloadIdentityUser` on the dedicated service account only. Enable required STS/IAM Credentials APIs only if absent and approved.

The backend needs Firestore document CRUD and Firebase Auth user reads (revocation/disabled-user checks). A practical starting point is `roles/datastore.user` and a custom role containing `firebaseauth.users.get`; `roles/firebaseauth.viewer` is a broader read-only alternative. Do not grant Owner, Editor, Firebase Admin, or Storage Admin. Firestore IAM access is database-wide: Admin SDK bypasses browser rules, so application UID checks remain essential. Review the deployed rules for server-only collections before activation.

Production-only environment variables:

- `FIREBASE_PROJECT_ID=antboard-2025`
- `FIREBASE_ADMIN_AUTH_MODE=vercel-wif`
- `GCP_PROJECT_NUMBER` (verified numeric project ID)
- `GCP_SERVICE_ACCOUNT_EMAIL` (approved dedicated service account in that project)
- `GCP_WORKLOAD_IDENTITY_POOL_ID`
- `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`

Vercel supplies `VERCEL_ENV`. This adapter intentionally refuses preview/development WIF. Local tests may explicitly select `FIREBASE_ADMIN_AUTH_MODE=application-default` only outside production/Vercel. There is no automatic ADC fallback on Vercel. WIF exchanges use fixed Google endpoints and short-lived tokens; no private key is stored. The Google cloud-platform scope does not itself grant IAM access.

Official setup reference: https://vercel.com/docs/oidc/gcp

## 2. Approve and configure Calendar authorization

Firebase sign-in is not Calendar authorization. Enable Google Calendar API, configure the consent screen, and create a Web OAuth client only after approval. A dedicated Calendar OAuth project isolates token revocation from other Google integrations; a second client in the same project does not. Keep the Firebase data project unchanged. Do not switch an existing production consent project to Testing. Testing-mode Calendar refresh tokens expire after seven days; production scope verification/warnings and Workspace restrictions must be checked in the actual console.

Exact redirect: `https://anttykanban.vercel.app/api/calendar?action=callback`

Scopes: `openid` and `https://www.googleapis.com/auth/calendar.events.owned`. Google grants access to owned calendars, not one arbitrarily chosen calendar; this application enforces `primary` on the server. It does not modify invitations, recurring events, or special event types.

Configure server-only values in the approved production secret store:

- `CALENDAR_APP_ORIGIN=https://anttykanban.vercel.app`
- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET`
- `CALENDAR_TOKEN_ENCRYPTION_KEY` (32 random bytes, base64)

Never place these secrets in `VITE_` variables, source control, or chat. After a reviewed deployment, the user chooses Calendar → Connect Google Calendar, reviews Google's consent, and connects the same Google identity as their Firebase sign-in. Test reads first; write tests require an explicitly approved test event. Disconnect may revoke other grants in the same Google Cloud project.

## 3. AI connection: distinguish PAT from ChatGPT OAuth

The existing personal access token endpoint requires `ANTTY_MCP_ENABLED=true` and `ANTTY_APP_ORIGIN=https://anttykanban.vercel.app`, plus working Admin credentials. Enable only after backend validation. Create a scoped, expiring token in Agent Access after user approval. Store it in the compatible client's secret/environment store, not in chat. Use read-only scopes for the first test; revoke unused tokens.

Endpoint: `https://anttykanban.vercel.app/api/mcp`.

Codex clients that support `bearer_token_env_var` can use a PAT. ChatGPT web custom MCP plugins cannot present arbitrary API keys/PATs. They need a separate OAuth provider integration; do not disable MCP authentication as a workaround. This patch does not implement that hosted OAuth connection. Calendar OAuth is a different grant and cannot substitute for MCP authorization.

References: https://developers.openai.com/plugins/build/auth and https://learn.chatgpt.com/docs/extend/mcp

## Approval and rollout order

Review this code PR, then separately approve: (1) WIF/provider/service-account/IAM changes; (2) OAuth client, consent and Calendar API setup; (3) secret creation/storage and production deployment; (4) the user's actual Calendar grant and any AI persistent-access token/provider connection. Merely approving the code PR does not approve those security changes.

After deployment verify unauthenticated endpoints fail safely, ordinary Firebase login/boards still work, server credentials can access only the intended project, and tokens/secrets never appear in logs or bundles. Keep Calendar and MCP disabled until their prerequisites are verified. No external setting or credential was created by this patch.

## Vercel CommonJS / ESM compatibility regression

The production Node 26 instrumentation rejected synchronous `require('jose')` inside `jwks-rsa@4.1.0`, although vanilla Node 24 allowed it. The repository carries a narrow, reviewed `patch-package` patch: remove that top-level require and use `await import('jose')` inside the existing asynchronous key-loading function and its callback-based Passport integration. JOSE remains the supported v6; no old cryptography package is substituted. `postinstall` applies the patch with `--error-on-fail --error-on-warn`, so upstream version/patch drift fails the build rather than silently removing the repair.

Native regression processes explicitly disable experimental `require(ESM)`, exercise actual emitted API handlers, and check RSA/EC JWK public-key conversion and rejection of private/encryption-only keys. CI runs both Node 22 and Node 26. This models the observed incompatibility but is not a substitute for testing the deployed Vercel functions after each rollout. Remove the patch once the upstream dependency or verified platform runtime handles asynchronous ESM loading correctly.

Build installation must include devDependencies, because patch-package is a development build tool. An omit-dev production installation is intentionally unsupported and fails rather than shipping unpatched dependencies. Vercel builds use the standard npm install/ci path with build dependencies present.
