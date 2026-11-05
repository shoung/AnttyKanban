# Legacy Rules and MCP Pilot Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation.

**Goal:** Prepare minimal legacy owner rules and a fail-closed single-UID MCP trial without changing production.

**Architecture:** A pure renderer adds exact owner-only legacy matches to existing rule drafts. A required first-party OAuth test UID gates consent/token use and the MCP gateway gates every bearer path and narrows scopes during the trial.

**Tech Stack:** TypeScript, Firebase rules, Firebase emulators, existing OAuth/MCP SDK.

**Spec:** `docs/superpowers/specs/2026-11-05-legacy-rules-mcp-pilot-design.md`

## Global Constraints

- No live rule/data/IAM/credential/env changes, migration, backup creation or deployment.
- No actual owner/test UID is inferred or committed.
- Preserve current owner-scoped validation, Calendar human/AI split and token revocation.
- Branch automatic deployment disabled before any remote push.

## Review Focus

- Overlapping legacy allows must be replaced, never masked with a deny.
- Missing UID must fail closed; PATs must not bypass the trial or widen scopes.
- Existing bearer image URLs do not become private when SDK rules tighten.
- Older browser/deployment clients may need owner legacy writes until migration completes.
- Rollback must not overwrite newer application records or accidentally reopen public legacy access.

## Tasks

- [x] Read production backup/recovery settings and current/historical legacy dependencies; record precise verification limits.
- [x] Write failing rule-renderer/unit and demo-emulator tests, then implement minimal explicit-owner rendering without deploying.
- [x] Write failing single-UID and PAT bypass tests, then implement config, lifecycle and gateway checks.
- [x] Run full checks and independent review; document owner/backup/cutover/rollback and exact activation confirmation.
- [ ] Create draft PR only; no merge/deploy or live access configuration.

## Execution ledger

Reused task checkout on new branch `fix/legacy-rules-and-mcp-pilot` from deployed `origin/main` 5c3e58b. The user explicitly authorized implementation preparation, so no extra design approval loop is needed. The legacy owner UID remains an approval gate; rendering is synthetic-only until that identity is verified.

Read-only findings: current and historical legacy SDK paths/URL rendering verified in code; Firebase/GCP UI show PITR and scheduled backups disabled and backup table empty. No private-backups directory exists in this checkout; no external/offline backup is disproven or restore verified. No live export/copy/migration or rules change occurred.

Ruling: use exact reviewed-base SHA256 pins rather than a partial Rules parser. Independent review demonstrated a wildcard/read-only overlap bypass in the first renderer; the regression failed then passed after pinning. Future base policy updates must be reviewed and re-pinned; otherwise preparation fails closed.

Ruling: apply the trial boundary to PAT redemption and new PAT issuance as well as OAuth. Otherwise enabling the global MCP flag would let another Firebase account bypass the test through a PAT. Existing revocation/listing remains owner-bound; normal PAT policy returns only when the pilot is off. New trial PATs must fit the configured scopes and at most seven days.

Ruling: run security files serially because the installed Storage test library writes emulator-global /internal/setRules without a project namespace. The isolated rule tests passed3/3; parallel full testing reproduced a rule-overwrite failure, and serial full emulator testing passed12/12. Separate demo namespaces still isolate Firestore fixture data.

Final local verification:188 unit/native,73 UI,12 serial emulator checks passed; typecheck/lint/production build and diff checks passed. Existing vendor-comment/bundle-size warnings only. Independent overlap finding fixed by failing-first wildcard regressions and reviewed-base hashes. No real owner/test UID, rule deployment, migration, backup/export, data mutation, IAM or credential change.
