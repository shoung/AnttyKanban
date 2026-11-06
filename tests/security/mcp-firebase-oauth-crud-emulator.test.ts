import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { firestoreOAuthRepository } from '../../server/mcpFirebaseOAuthStore.ts';
import { firestoreWorkspaceStore } from '../../server/mcpData.ts';
import { tokenHash, type McpScope } from '../../server/mcpPolicy.ts';
import { createMapRecord, mapRecordForStorage, type MapRecord } from '../../services/mapPolicy.ts';
import type { BoardDocument } from '../../services/boardSafety.ts';
import {
  call,
  denied,
  firebaseOAuthMcpFixture,
  type OAuthMcpSession,
} from '../fixtures/firebase-oauth-mcp.ts';

const mapScopes: McpScope[] = ['maps:read', 'maps:write'];
const boardScopes: McpScope[] = ['boards:read', 'boards:write'];
const workspaceScopes = [...mapScopes, ...boardScopes];
type Harness = Awaited<ReturnType<typeof firebaseOAuthMcpFixture>>;
type Mutation = { id: string; revision: number };

async function fixture(scopes: McpScope[]) {
  // Unconditional isolation: never discover ambient credentials or target a real project.
  assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(?:127\.0\.0\.1|localhost):\d+$/);
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-antty-security');
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: 'owner', expiry_date: Date.now() + 3_600_000 });
  const db = new Firestore({
    projectId: 'demo-antty-security',
    host: process.env.FIRESTORE_EMULATOR_HOST,
    ssl: false,
    auth: new GoogleAuth({ projectId: 'demo-antty-security', authClient }),
  });
  const uid = `oauth-crud-${randomUUID()}`;
  let h: Harness;
  try {
    h = await firebaseOAuthMcpFixture(
      firestoreOAuthRepository(db),
      firestoreWorkspaceStore(db),
      uid,
      scopes,
    );
  } catch (error) {
    await db.terminate();
    throw error;
  }
  return {
    db,
    uid,
    h,
    close: async () => {
      try {
        await h.close();
      } finally {
        await db.terminate();
      }
    },
  };
}

async function snapshot(db: Firestore, uid: string) {
  const [maps, boards] = await Promise.all(
    ['mindmaps', 'boards'].map((name) =>
      db.collection(`users/${uid}/${name}`).orderBy('__name__').get(),
    ),
  );
  return {
    maps: maps.docs.map((d) => [d.id, d.data()]),
    boards: boards.docs.map((d) => [d.id, d.data()]),
  };
}
async function grantFor(db: Firestore, session: OAuthMcpSession) {
  const token = (await db.doc(`mcpAuthTokens/${tokenHash(session.token)}`).get()).data()!;
  assert.ok(token);
  const ref = db.doc(`mcpAuthGrants/${token.grantId}`);
  return { token, ref, grant: (await ref.get()).data()! };
}
async function unauthorized(h: Harness, session: OAuthMcpSession, id: string) {
  const before = h.operations.length;
  for (const name of ['mindmaps_get', 'mindmaps_update']) {
    const args =
      name === 'mindmaps_get'
        ? { id }
        : {
            id,
            title: 'Forbidden change',
            root: { id: 'root', text: 'Forbidden', children: [] },
            expectedRevision: 1,
          };
    await assert.rejects(
      session.client.callTool({ name, arguments: args }),
      (error: unknown) => (error as { code?: number }).code === 401,
    );
    const response = await h.rpc(session, 'tools/call', { name, arguments: args });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata=/);
  }
  assert.equal(
    h.operations.length,
    before,
    'authentication failures must not reach workspace storage',
  );
}
async function persistedMap(db: Firestore, uid: string, map: MapRecord) {
  const stored = (await db.doc(`users/${uid}/mindmaps/${map.id}`).get()).data()!;
  assert.equal(stored.ownerUid, uid);
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.id, map.id);
  assert.equal(stored.revision, map.revision);
  assert.equal(stored.title, map.title);
  assert.deepEqual(JSON.parse(stored.rootJson), map.root);
  assert.equal('root' in stored, false);
  return stored;
}

test(
  'Firebase OAuth S256 → SDK HTTP mindmap CRUD persists revisions and trees in demo Firestore',
  { timeout: 60_000 },
  async () => {
    const { db, uid, h, close } = await fixture(mapScopes);
    try {
      const writer = await h.connect(mapScopes, true);
      const { token, grant } = await grantFor(db, writer);
      assert.equal(grant.ownerUid, uid);
      assert.deepEqual(grant.scopes, mapScopes);
      assert.equal(grant.resource, h.config.resource);
      assert.equal(token.expiresAt - token.createdAt, 3_600_000);
      assert.equal(grant.expiresAt - grant.createdAt, 7 * 86_400_000);
      const tools = (await writer.client.listTools()).tools;
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        'mindmaps_create',
        'mindmaps_delete',
        'mindmaps_get',
        'mindmaps_list',
        'mindmaps_update',
      ]);
      for (const tool of tools) {
        const readOnly = ['mindmaps_get', 'mindmaps_list'].includes(tool.name);
        assert.equal(tool.annotations?.readOnlyHint, readOnly);
        assert.deepEqual(tool._meta?.securitySchemes, [
          { type: 'oauth2', scopes: [readOnly ? 'maps:read' : 'maps:write'] },
        ]);
      }
      const root = {
        id: 'root',
        text: 'Synthetic root',
        children: [{ id: 'child', text: 'Child', children: [] }],
      };
      const created = await call<MapRecord>(writer, 'mindmaps_create', {
        title: 'Synthetic map',
        root,
      });
      assert.equal(created.title, 'Synthetic map');
      assert.deepEqual(created.root, root);
      await persistedMap(db, uid, created);
      assert.deepEqual(await call<MapRecord>(writer, 'mindmaps_get', { id: created.id }), created);
      const second = await call<MapRecord>(writer, 'mindmaps_create', { title: 'Second map' });
      const page = await call<{ items: { id: string }[]; nextAfter: string }>(
        writer,
        'mindmaps_list',
        { limit: 1 },
      );
      assert.equal(page.items.length, 1);
      assert.equal(page.nextAfter, page.items[0].id);
      const next = await call<{ items: { id: string }[]; nextAfter?: string }>(
        writer,
        'mindmaps_list',
        {
          limit: 1,
          after: page.nextAfter,
        },
      );
      assert.equal(next.items.length, 1);
      assert.notEqual(next.items[0].id, page.items[0].id);
      assert.equal(next.nextAfter, undefined);
      assert.deepEqual(
        new Set([...page.items, ...next.items].map((m) => m.id)),
        new Set([created.id, second.id]),
      );
      const updated = await call<MapRecord>(writer, 'mindmaps_update', {
        id: created.id,
        title: 'Updated',
        root: { ...root, text: 'Updated root' },
        expectedRevision: 1,
      });
      assert.equal(updated.revision, 2);
      assert.equal(updated.title, 'Updated');
      assert.deepEqual(updated.root, { ...root, text: 'Updated root' });
      await persistedMap(db, uid, updated);
      const before = await snapshot(db, uid);
      await denied(writer, 'mindmaps_update', {
        id: created.id,
        title: 'Stale',
        root,
        expectedRevision: 1,
      });
      await denied(writer, 'mindmaps_delete', { id: created.id, expectedRevision: 1 });
      assert.deepEqual(await snapshot(db, uid), before);
      const competing = await Promise.all(
        ['Left', 'Right'].map((title) =>
          writer.client.callTool({
            name: 'mindmaps_update',
            arguments: { id: created.id, title, root, expectedRevision: 2 },
          }),
        ),
      );
      assert.equal(competing.filter((r) => r.isError === true).length, 1);
      const winner = await call<MapRecord>(writer, 'mindmaps_get', { id: created.id });
      assert.equal(winner.revision, 3);
      assert.ok(['Left', 'Right'].includes(winner.title));
      assert.deepEqual(winner.root, root);
      await persistedMap(db, uid, winner);
      await denied(writer, 'mindmaps_delete', { id: created.id, expectedRevision: 2 });
      await persistedMap(db, uid, winner);
      await call(writer, 'mindmaps_delete', { id: created.id, expectedRevision: 3 });
      assert.equal((await db.doc(`users/${uid}/mindmaps/${created.id}`).get()).exists, false);
      await denied(writer, 'mindmaps_get', { id: created.id });
      await call(writer, 'mindmaps_delete', { id: second.id, expectedRevision: 1 });
      assert.equal((await db.collection(`users/${uid}/mindmaps`).get()).size, 0);
      assert.ok(h.operations.every((path) => path.includes(`users/${uid}/mindmaps`)));
    } finally {
      await close();
    }
  },
);

test(
  'Firebase OAuth → SDK HTTP board project/column/task CRUD and replacement use real Firestore revisions',
  { timeout: 60_000 },
  async () => {
    const { db, uid, h, close } = await fixture(boardScopes);
    try {
      const writer = await h.connect(boardScopes, true);
      assert.ok(
        (await writer.client.listTools()).tools.every((tool) => tool.name.startsWith('boards_')),
      );
      assert.equal((await call<BoardDocument>(writer, 'boards_get')).revision, 0);
      const project = await call<Mutation>(writer, 'boards_project_create', {
        name: 'Synthetic board',
        expectedRevision: 0,
      });
      const column = await call<Mutation>(writer, 'boards_column_create', {
        projectId: project.id,
        title: 'Todo',
        expectedRevision: 1,
      });
      const task = await call<Mutation>(writer, 'boards_task_create', {
        projectId: project.id,
        columnId: column.id,
        title: 'Synthetic task',
        expectedRevision: 2,
      });
      const ref = db.doc(`users/${uid}/boards/default`);
      const original = (await ref.get()).data()!;
      assert.equal(original.ownerUid, uid);
      assert.equal(original.schemaVersion, 1);
      assert.equal(original.revision, 3);
      assert.equal(project.revision, 1);
      assert.equal(column.revision, 2);
      assert.equal(task.revision, 3);
      assert.equal(original.projects[0].id, project.id);
      assert.equal(original.projects[0].name, 'Synthetic board');
      assert.equal(original.projects[0].columns[0].id, column.id);
      assert.equal(original.projects[0].columns[0].title, 'Todo');
      assert.equal(original.projects[0].tasks[0].id, task.id);
      assert.equal(original.projects[0].tasks[0].title, 'Synthetic task');
      assert.equal(original.projects[0].tasks[0].columnId, column.id);
      await denied(writer, 'boards_column_delete', {
        projectId: project.id,
        columnId: column.id,
        expectedRevision: 3,
      });
      await denied(writer, 'boards_task_update', {
        projectId: project.id,
        taskId: task.id,
        patch: { title: 'Stale' },
        expectedRevision: 2,
      });
      assert.deepEqual((await ref.get()).data(), original);
      await call(writer, 'boards_task_update', {
        projectId: project.id,
        taskId: task.id,
        patch: { title: 'Updated task' },
        expectedRevision: 3,
      });
      await call(writer, 'boards_column_update', {
        projectId: project.id,
        columnId: column.id,
        title: 'Working',
        expectedRevision: 4,
      });
      await call(writer, 'boards_project_update', {
        projectId: project.id,
        name: 'Updated board',
        expectedRevision: 5,
      });
      const board = await call<BoardDocument>(writer, 'boards_get');
      assert.equal(board.revision, 6);
      assert.equal(board.projects[0].name, 'Updated board');
      assert.equal(board.projects[0].columns[0].title, 'Working');
      assert.equal(board.projects[0].tasks[0].title, 'Updated task');
      assert.deepEqual((await ref.get()).data()?.projects, board.projects);
      const competing = await Promise.all(
        ['One', 'Two'].map((title) =>
          writer.client.callTool({
            name: 'boards_task_update',
            arguments: {
              projectId: project.id,
              taskId: task.id,
              patch: { title },
              expectedRevision: 6,
            },
          }),
        ),
      );
      assert.equal(competing.filter((r) => r.isError === true).length, 1);
      assert.equal((await ref.get()).data()?.revision, 7);
      assert.ok(['One', 'Two'].includes((await ref.get()).data()?.projects[0].tasks[0].title));
      await call(writer, 'boards_task_delete', {
        projectId: project.id,
        taskId: task.id,
        expectedRevision: 7,
      });
      await call(writer, 'boards_column_delete', {
        projectId: project.id,
        columnId: column.id,
        expectedRevision: 8,
      });
      await call(writer, 'boards_project_delete', { projectId: project.id, expectedRevision: 9 });
      assert.deepEqual((await ref.get()).data()?.projects, []);
      await call(writer, 'boards_replace', {
        projects: [{ id: 'replacement', name: 'Replacement', columns: [], tasks: [] }],
        expectedRevision: 10,
      });
      assert.equal((await ref.get()).data()?.projects[0].id, 'replacement');
      await call(writer, 'boards_replace', { projects: [], expectedRevision: 11 });
      const writeOnly = await h.connect(['boards:write']);
      assert.equal(
        (await writeOnly.client.listTools()).tools.some((tool) => tool.name === 'boards_get'),
        false,
      );
      await denied(writeOnly, 'boards_get');
      const compact = await call<Mutation>(writeOnly, 'boards_project_create', {
        name: 'Write-only',
        expectedRevision: 12,
      });
      assert.deepEqual(Object.keys(compact).sort(), ['id', 'revision']);
      await call(writeOnly, 'boards_project_delete', {
        projectId: compact.id,
        expectedRevision: 13,
      });
      assert.equal((await ref.get()).data()?.revision, 14);
      assert.deepEqual((await ref.get()).data()?.projects, []);
      assert.ok(h.operations.every((path) => path.includes(`users/${uid}/boards/default`)));
    } finally {
      await close();
    }
  },
);

test(
  'OAuth HTTP revocation and exact token/code expiry stop already-connected clients before workspace access',
  { timeout: 60_000 },
  async () => {
    const { db, uid, h, close } = await fixture(mapScopes);
    try {
      const writer = await h.connect(mapScopes);
      const sibling = await h.connect(['maps:read']);
      const map = await call<MapRecord>(writer, 'mindmaps_create', { title: 'Protected sentinel' });
      const before = await snapshot(db, uid);
      const grant = await grantFor(db, writer);
      assert.equal((await h.revoke(writer)).status, 200);
      assert.equal((await grant.ref.get()).data()?.enabled, false);
      await unauthorized(h, writer, map.id);
      assert.equal(
        (await call<MapRecord>(sibling, 'mindmaps_get', { id: map.id })).title,
        map.title,
      );
      assert.equal((await grantFor(db, sibling)).grant.enabled, true);
      const expiring = await h.connect(mapScopes);
      h.state.now = (await grantFor(db, expiring)).token.expiresAt;
      await unauthorized(h, expiring, map.id);
      const existingIds = new Set(
        (await db.collection('mcpAuthGrants').where('ownerUid', '==', uid).get()).docs.map(
          (d) => d.id,
        ),
      );
      const flow = await h.start(mapScopes);
      assert.equal((await flow.details()).status, 200);
      await flow.approve();
      const codeGrant = (
        await db.collection('mcpAuthGrants').where('ownerUid', '==', uid).get()
      ).docs.find((d) => !existingIds.has(d.id))!;
      assert.ok(codeGrant);
      h.state.now += 60_000;
      const expiredCode = await flow.exchange();
      assert.equal(expiredCode.status, 400);
      assert.deepEqual(await expiredCode.json(), { error: 'invalid_grant' });
      assert.equal(
        (await db.collection('mcpAuthTokens').where('grantId', '==', codeGrant.id).get()).size,
        0,
      );
      assert.deepEqual(await snapshot(db, uid), before);
    } finally {
      await close();
    }
  },
);

test(
  'OAuth scope ceilings and persisted consent narrowing apply on every MCP request without broadening old consent',
  { timeout: 60_000 },
  async () => {
    const { db, uid, h, close } = await fixture(workspaceScopes);
    try {
      const writer = await h.connect(workspaceScopes);
      const map = await call<MapRecord>(writer, 'mindmaps_create', { title: 'Scope sentinel' });
      await call(writer, 'boards_project_create', { name: 'Scope board', expectedRevision: 0 });
      const before = await snapshot(db, uid);
      h.config.scopes = ['maps:read'];
      // Reducing the server ceiling invalidates a broader grant in full, including reads.
      await unauthorized(h, writer, map.id);
      const reader = await h.connect(['maps:read']);
      assert.equal(
        (await call<MapRecord>(reader, 'mindmaps_get', { id: map.id })).title,
        map.title,
      );
      h.config.scopes = [...workspaceScopes];
      assert.deepEqual((await reader.client.listTools()).tools.map((t) => t.name).sort(), [
        'mindmaps_get',
        'mindmaps_list',
      ]);
      await denied(reader, 'mindmaps_create', { title: 'Forbidden' });
      await denied(reader, 'mindmaps_update', {
        id: map.id,
        title: 'Forbidden',
        root: map.root,
        expectedRevision: 1,
      });
      await denied(reader, 'mindmaps_delete', { id: map.id, expectedRevision: 1 });
      await denied(reader, 'boards_get');
      await denied(reader, 'boards_project_create', { name: 'Forbidden', expectedRevision: 1 });
      assert.deepEqual((await grantFor(db, reader)).grant.scopes, ['maps:read']);
      // Simulate a trusted server-side consent reduction, only in this demo database.
      const granted = await grantFor(db, writer);
      await granted.ref.update({ scopes: ['maps:read'] });
      assert.deepEqual((await writer.client.listTools()).tools.map((t) => t.name).sort(), [
        'mindmaps_get',
        'mindmaps_list',
      ]);
      assert.equal(
        (await call<MapRecord>(writer, 'mindmaps_get', { id: map.id })).title,
        map.title,
      );
      await denied(writer, 'mindmaps_delete', { id: map.id, expectedRevision: 1 });
      await denied(writer, 'boards_project_create', { name: 'Forbidden', expectedRevision: 1 });
      assert.deepEqual(await snapshot(db, uid), before);
    } finally {
      await close();
    }
  },
);

test(
  'OAuth pilot UID, workspace ownership and account revocation reject cross-account access in demo Firestore',
  { timeout: 60_000 },
  async () => {
    const { db, uid, h, close } = await fixture(workspaceScopes);
    const other = `oauth-crud-other-${randomUUID()}`;
    try {
      const writer = await h.connect(workspaceScopes);
      const own = await call<MapRecord>(writer, 'mindmaps_create', { title: 'Own sentinel' });
      await call(writer, 'boards_project_create', { name: 'Own board', expectedRevision: 0 });
      const foreign = createMapRecord(other, 'foreign-map', { title: 'Foreign sentinel' });
      await db.doc(`users/${other}/mindmaps/${foreign.id}`).set(mapRecordForStorage(foreign));
      await db.doc(`users/${other}/boards/default`).set({
        ownerUid: other,
        schemaVersion: 1,
        revision: 1,
        projects: [{ id: 'foreign-project', name: 'Foreign board', columns: [], tasks: [] }],
      });
      const before = await snapshot(db, uid),
        otherBefore = await snapshot(db, other);
      assert.deepEqual(
        (await call<{ items: { id: string }[] }>(writer, 'mindmaps_list')).items.map((m) => m.id),
        [own.id],
      );
      await denied(writer, 'mindmaps_get', { id: foreign.id });
      await denied(writer, 'mindmaps_update', {
        id: foreign.id,
        title: 'Forbidden',
        root: foreign.root,
        expectedRevision: 1,
      });
      await denied(writer, 'mindmaps_delete', { id: foreign.id, expectedRevision: 1 });
      await denied(writer, 'mindmaps_get', { id: own.id, uid: other });
      await denied(writer, 'mindmaps_update', {
        id: own.id,
        ownerUid: other,
        title: 'Forbidden',
        root: own.root,
        expectedRevision: 1,
      });
      await denied(writer, 'mindmaps_get', { id: `../${foreign.id}` });
      await denied(writer, 'boards_get', { uid: other });
      await denied(writer, 'boards_project_delete', {
        projectId: 'foreign-project',
        expectedRevision: 1,
      });
      assert.deepEqual(await snapshot(db, uid), before);
      assert.deepEqual(await snapshot(db, other), otherBefore);
      assert.ok(h.operations.every((path) => path.includes(`users/${uid}/`)));
      h.identity.uid = other;
      const forbiddenConsent = await h.start(mapScopes);
      assert.equal((await forbiddenConsent.details()).status, 403);
      assert.equal(
        (await db.collection('mcpAuthGrants').where('ownerUid', '==', other).get()).size,
        0,
      );
      // Model a token issued to another formerly allowed pilot UID, then restore Alice's boundary.
      h.config.testUid = other;
      const otherSession = await h.connect(workspaceScopes);
      assert.equal(
        (await call<MapRecord>(otherSession, 'mindmaps_get', { id: foreign.id })).title,
        foreign.title,
      );
      h.config.testUid = uid;
      h.identity.uid = uid;
      await unauthorized(h, otherSession, foreign.id);
      h.state.disabled = true;
      await unauthorized(h, writer, own.id);
      h.state.disabled = false;
      h.state.cutoff = h.state.now + 1;
      await unauthorized(h, writer, own.id);
      h.state.cutoff = 0;
      const corruptRef = db.doc(`users/${uid}/mindmaps/wrong-owner`);
      await corruptRef.set(mapRecordForStorage({ ...foreign, id: 'wrong-owner' }));
      const corrupt = (await corruptRef.get()).data();
      await denied(writer, 'mindmaps_get', { id: 'wrong-owner' });
      await denied(writer, 'mindmaps_update', {
        id: 'wrong-owner',
        title: 'Forbidden',
        root: foreign.root,
        expectedRevision: 1,
      });
      await denied(writer, 'mindmaps_delete', { id: 'wrong-owner', expectedRevision: 1 });
      assert.deepEqual((await corruptRef.get()).data(), corrupt);
      assert.deepEqual(await snapshot(db, other), otherBefore);
      assert.deepEqual(
        (await db.doc(`users/${uid}/mindmaps/${own.id}`).get()).data(),
        before.maps[0][1],
      );
      assert.deepEqual(
        (await db.doc(`users/${uid}/boards/default`).get()).data(),
        before.boards[0][1],
      );
    } finally {
      await close();
    }
  },
);
