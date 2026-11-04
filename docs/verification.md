# Verification · 2026-11-04

## Local results

- `npm test`: 72/72 passed.
- `npm run test:ui`: 23/23 passed across 5 files.
- `npm run typecheck`: passed.
- `npm run lint`: passed, no warnings.
- `npm run build`: passed. Warnings remain for the existing approximately 796 KB main chunk and harmless Zod PURE-comment annotations; mindmap and Calendar are separate lazy-loaded chunks.
- Firestore/Storage demo-project emulator suite: 5 groups passed, including cross-account denial, revision checks, server-only and legacy path denial, immutable scoped image uploads, depth-32 serialized maps.
- Independent review also exercised an actual local HTTP MCP initialize / scoped tools-list / allowed board-read / denied board-write sequence.
- Public-source secret-pattern review found no new private key, OAuth secret, live token, backup, or private fixture. The existing Firebase browser API identifier remains client configuration, not an Admin credential. Logs, .env files and private backups are ignored.

## Regression fixes verified

1. Close/reopen during attachment upload resets busy state and discards stale upload results.
2. Remote board changes during a modal session preserve the local draft and its original revision; stale saves conflict instead of overwriting.
3. Disconnecting Calendar during event preflight blocks subsequent PATCH/DELETE, including provider revocation failure.
4. Mindmap storage uses rootJson to avoid Firestore's nested-map depth ceiling; final persisted-envelope size is validated before writes.
5. Map and board MCP writes require current revisions; Google event modifications require current ETags.
6. Token authorization rejects expired/revoked scopes and disabled/deleted/revoked Firebase accounts; listings are bounded/paginated.

## Not executed / not yet verified

No production deployment, production rules change, Google client or token setup, IAM grant, actual Calendar write, legacy-data migration, or user credential generation was performed. Live two-account Firebase/OAuth tests, authenticated Storage CORS and real-browser React Flow gesture/layout smoke tests remain deployment gates. Unit/UI tests use synthetic data and a React Flow test adapter, not a visual browser certification.

Remote MCP currently supports explicit per-user bearer PAT clients, not an OAuth discovery/consent server. ChatGPT-only OAuth connector compatibility is not claimed.

`npm audit --omit=dev` after the full installation reports 10 moderate findings in the Firestore/Google transitive rimraf/glob/minimatch chain, zero high and zero critical. Compatible gRPC/protobuf/websocket patch overrides are locked; replacing upstream major dependencies solely to silence remaining reports was not attempted.
