# Antty personal workspaces

The user selected Antty as the single host, Firebase as the backend, per-account boards and mindmaps, and a Google Calendar workspace with CRUD. AI MCP must cover all three. Preserve the existing Firebase Google login and the existing standalone mindmap deployment.

## Selected architecture

Keep Vite/React and Firebase Auth, reuse the existing React Flow mindmap core and editing UX, and add Vercel serverless services. Use users/{uid}/boards/default and users/{uid}/mindmaps/{id}; enforce account ownership and revision transactions. Server identity comes from verified credentials, never request fields. UI and MCP use the same document validation and Calendar service. Calendar connection is explicit, separate from login, with encrypted server-only offline tokens and primary-calendar restriction. Do not add guests, sharing, or calendar ACL features.

Alternatives rejected by the user's selection: retaining independent NextAuth/Blob apps duplicates login and backend; migrating all Antty to Next.js imposes avoidable rewrite. Serverless functions are required for confidential Google credentials and MCP.

## Safety and rollout

Existing boards/default has no authoritative owner. Leave it and all legacy attachments untouched; no automatic import, ownership claim or deletion. Rules drafts require deployed-rule inspection and approval before rollout. No production deploy, OAuth credentials, secrets, grants or live security changes in this implementation. Missing configuration disables new integration capabilities. Account switches must immediately clear private state. Conflicts must never silently overwrite concurrent edits. Tests use synthetic data only.
