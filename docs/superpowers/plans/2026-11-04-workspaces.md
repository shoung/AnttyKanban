# Personal Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Combine personal boards, mindmaps, Google Calendar and authenticated AI tools in Antty.
**Architecture:** Firebase UID namespaces and transaction revisions, reusable React Flow UI, confidential Vercel functions for Calendar and MCP.
**Tech Stack:** Vite, React, TypeScript, Firebase, React Flow, Vercel functions.
**Spec:** ../specs/2026-11-04-workspaces-design.md

## Global Constraints

- No live legacy data migration, production deploy or security configuration mutation.
- Never publish credentials or user data; authenticate server calls and enforce UID ownership.
- Traditional Chinese UI, Calendar is explicitly opt-in, no guest invitations.

## Review Focus

- Account switch during async reads/saves must not leak old user state.
- Concurrent browser/MCP saves reject stale revisions.
- Deep/oversize/untrusted JSON must fail validation.
- Calendar expired consent and OAuth replay must fail closed.
- Workspace navigation must protect unsaved editing and not share global CSS.

## Tasks

- [x] Board worker: services/boardStore.ts, board validation, App.tsx account lifecycle, owned attachments, rules drafts, isolation/conflict tests.
- [x] Calendar worker: server/calendar/\*, api/calendar.ts, components/CalendarWorkspace.tsx, security validation and service tests. Consume server/firebase.ts getAdminAuth/getAdminDb/authenticateRequest. Export UID-bound Calendar service for MCP.
- [x] Integrator: recover and adapt mindmap model/tree/Workspace from pinned source; Firebase transactional mapStore, same model validation, account-safe remount and scoped CSS; reuse core/UI tests.
- [x] Integrator: server/firebase.ts verified Firebase bearer auth for UI, API document services, user-scoped MCP access with explicit consent/revocation and bounded tools. Test unauthenticated and cross-user access, malformed requests and revisions.
- [ ] Integrator: workspace navigation, missing-config UI, documentation, lint/typecheck/unit/UI/build verification, independent review, draft PR only.

For each task: write a failing behavioral test, run and record failure, implement minimum behavior, rerun focused tests, then full checks after integration. Preserve upstream mindmap regression tests for delayed loads and IME editing. No test needs real account credentials.
