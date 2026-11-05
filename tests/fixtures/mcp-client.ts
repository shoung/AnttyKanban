import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler } from '../../api/mcp.ts';
import { createMcpDataService, type WorkspaceStore } from '../../server/mcpData.ts';
import { createMcpAuthenticator, type McpTokenRepository } from '../../server/mcpTokens.ts';
import { tokenHash, allowedScopes, type McpTokenRecord } from '../../server/mcpPolicy.ts';
import {
  CalendarService,
  CalendarError,
  CALENDAR_SCOPE,
  type CalendarStore,
  type CalendarConnection,
  type OAuthAttempt,
  type GoogleGateway,
} from '../../server/calendar/core.ts';
import { createCipher } from '../../server/calendar/security.ts';

function memoryStorage(): WorkspaceStore {
  const rows = new Map<string, unknown>();
  return {
    async read(path) {
      return structuredClone(rows.get(path) ?? null);
    },
    async list(path, input) {
      return [...rows]
        .filter(
          ([key]) =>
            key.startsWith(`${path}/`) && (!input.after || key.split('/').at(-1)! > input.after),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, input.limit)
        .map(([key, value]) => ({ id: key.split('/').at(-1)!, value: structuredClone(value) }));
    },
    async mutate(path, operation) {
      const output = operation(structuredClone(rows.get(path) ?? null));
      if (output.next === null) rows.delete(path);
      else rows.set(path, structuredClone(output.next));
      return output.result;
    },
  };
}
function calendarFixture(uid: string) {
  const events = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const create = (channel: 'ui' | 'agent') => {
    const connections = new Map<string, CalendarConnection>();
    const attempts = new Map<string, OAuthAttempt>();
    const store: CalendarStore = {
      async getConnection(owner) {
        return connections.get(owner) ?? null;
      },
      async saveConnection(owner, value, revision) {
        if ((connections.get(owner)?.revision ?? 0) !== revision) return false;
        connections.set(owner, value);
        return true;
      },
      async createAttempt(key, value) {
        attempts.set(key, value);
      },
      async consumeAttempt(key, binding, now) {
        const value = attempts.get(key);
        if (!value || value.bindingHash !== binding || value.expiresAt <= now) return null;
        attempts.delete(key);
        return value;
      },
    };
    const google: GoogleGateway = {
      authorizationUrl({ state }) {
        return `https://synthetic.example/authorize?state=${state}`;
      },
      async exchangeCode() {
        return {
          subject: `google-${uid}`,
          refreshToken: `synthetic-${channel}`,
          grantedScopes: [CALENDAR_SCOPE],
        };
      },
      async refreshAccessToken() {
        return 'synthetic-access';
      },
      async revokeToken() {},
      async request(_token, path, method, body, etag) {
        calls.push(`${channel}:${method}`);
        const url = new URL(path, 'https://synthetic.example');
        const id = url.pathname.split('/')[4];
        if (method === 'GET' && !id) return { items: [...events.values()] };
        if (method === 'POST') {
          const id = randomUUID();
          const value = {
            ...(body as object),
            id,
            etag: '"v1"',
            organizer: { self: true },
            attendees: [],
          };
          events.set(id, value);
          return value;
        }
        const value = events.get(id);
        if (!value) throw new CalendarError('EVENT_NOT_FOUND', 404);
        if (method === 'GET') return value;
        if (etag !== value.etag) throw new CalendarError('EVENT_CHANGED', 409);
        if (method === 'DELETE') {
          events.delete(id);
          return;
        }
        const updated = { ...value, ...(body as object), etag: '"v2"' };
        events.set(id, updated);
        return updated;
      },
    };
    return new CalendarService({
      context: { channel, clientId: `synthetic-${channel}`, projectId: `synthetic-${channel}` },
      store,
      google,
      cipher: createCipher(Buffer.alloc(32, channel === 'ui' ? 1 : 2).toString('base64')),
      expectedGoogleSubject: async (owner) => `google-${owner}`,
    });
  };
  const ui = create('ui');
  const agent = create('agent');
  async function connect(service: CalendarService) {
    const { authorizationUrl } = await service.beginConnect(uid, 'synthetic-browser');
    await service.completeConnect(
      new URL(authorizationUrl).searchParams.get('state')!,
      'synthetic-browser',
      'synthetic-code',
    );
  }
  return { ui, agent, events, calls, connect };
}

/** Actual SDK → TCP HTTP → production MCP/auth/data/Calendar core; synthetic credentials/provider only. */
export async function runMcpCrudAcceptance(storage = memoryStorage()) {
  const uid = `mcp-test-${randomUUID()}`;
  const other = `mcp-test-${randomUUID()}`;
  const calendar = calendarFixture(uid);
  const data = createMcpDataService(storage, {
    getCalendarStatus: (owner) => calendar.agent.getStatus(owner),
    listCalendarEvents: (owner, input) => calendar.agent.listEvents(owner, input),
    createCalendarEvent: (owner, input) => calendar.agent.createEvent(owner, input),
    updateCalendarEvent: (owner, id, input, etag) =>
      calendar.agent.updateEvent(owner, id, input, etag),
    deleteCalendarEvent: (owner, id, etag) => calendar.agent.deleteEvent(owner, id, etag),
  });
  const now = Date.now();
  const writer = `antty_${'a'.repeat(43)}`;
  const reader = `antty_${'b'.repeat(43)}`;
  const stranger = `antty_${'c'.repeat(43)}`;
  const boardWriter = `antty_${'d'.repeat(43)}`;
  const records = new Map<string, McpTokenRecord>([
    [
      tokenHash(writer),
      {
        ownerUid: uid,
        name: 'synthetic writer',
        scopes: [...allowedScopes],
        createdAt: now,
        expiresAt: now + 60_000,
        revoked: false,
      },
    ],
    [
      tokenHash(reader),
      {
        ownerUid: uid,
        name: 'synthetic reader',
        scopes: ['maps:read'],
        createdAt: now,
        expiresAt: now + 60_000,
        revoked: false,
      },
    ],
    [
      tokenHash(stranger),
      {
        ownerUid: other,
        name: 'synthetic other',
        scopes: [...allowedScopes],
        createdAt: now,
        expiresAt: now + 60_000,
        revoked: false,
      },
    ],
  ]);
  records.set(tokenHash(boardWriter), {
    ownerUid: other,
    name: 'synthetic write only',
    scopes: ['boards:write'],
    createdAt: now,
    expiresAt: now + 60_000,
    revoked: false,
  });
  const repository = {
    async get(hash: string) {
      return records.get(hash) ?? null;
    },
  } as McpTokenRepository;
  const authenticate = createMcpAuthenticator(repository, async () => ({
    disabled: false,
    tokensValidAfterTime: new Date(0).toISOString(),
  }));
  let origin = '';
  const handler = createMcpHandler({
    config: () => ({ origin, host: new URL(origin).host }),
    authenticate,
    async quota() {},
    data: () => data,
  });
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  const client = async (token: string) => {
    const value = new Client({ name: 'antty-sdk-acceptance', version: '1' });
    await value.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
      }),
    );
    clients.push(value);
    return value;
  };
  const call = async <T = Record<string, unknown>>(
    value: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const result = await value.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === 'text',
    )?.text;
    assert.ok(text);
    return JSON.parse(text) as T;
  };
  const denied = async (value: Client, name: string, args: Record<string, unknown>) =>
    assert.equal((await value.callTool({ name, arguments: args })).isError, true, name);
  try {
    const a = await client(writer);
    assert.match(a.getInstructions() ?? '', /expectedRevision.*etag/);
    const b = await client(stranger);
    const read = await client(reader);
    const catalog = await a.listTools();
    assert.ok(catalog.tools.some((t) => t.name === 'boards_task_update'));
    assert.deepEqual((await read.listTools()).tools.map((t) => t.name).sort(), [
      'mindmaps_get',
      'mindmaps_list',
    ]);
    await denied(read, 'mindmaps_create', { title: 'forbidden' });
    const root = {
      id: 'root',
      text: 'Synthetic root',
      children: [{ id: 'child', text: 'Child', children: [] }],
    };
    const map = await call<{ id: string; revision: number }>(a, 'mindmaps_create', {
      title: 'Synthetic map',
      root,
    });
    const found = await call<{ root: unknown }>(a, 'mindmaps_get', { id: map.id });
    assert.deepEqual(found.root, root);
    await denied(b, 'mindmaps_get', { id: map.id });
    await denied(a, 'mindmaps_get', { id: map.id, uid: other });
    const secondMap = await call<{ id: string }>(a, 'mindmaps_create', {
      title: 'Second synthetic map',
    });
    const list = await call<{ items: Array<{ id: string }>; nextAfter: string }>(
      a,
      'mindmaps_list',
      { limit: 1 },
    );
    assert.ok(list.nextAfter);
    const secondPage = await call<{ items: Array<{ id: string }> }>(a, 'mindmaps_list', {
      limit: 1,
      after: list.nextAfter,
    });
    assert.deepEqual(
      new Set([list.items[0].id, secondPage.items[0].id]),
      new Set([map.id, secondMap.id]),
    );
    await call(a, 'mindmaps_update', {
      id: map.id,
      title: 'Changed',
      root: { ...root, text: 'Changed' },
      expectedRevision: 1,
    });
    await denied(a, 'mindmaps_delete', { id: map.id, expectedRevision: 1 });
    await call(a, 'mindmaps_delete', { id: map.id, expectedRevision: 2 });
    await denied(a, 'mindmaps_get', { id: map.id });
    await call(a, 'mindmaps_delete', { id: secondMap.id, expectedRevision: 1 });

    assert.equal((await call<{ revision: number }>(a, 'boards_get')).revision, 0);
    const project = await call<{ id: string }>(a, 'boards_project_create', {
      name: 'Synthetic board',
      expectedRevision: 0,
    });
    const column = await call<{ id: string }>(a, 'boards_column_create', {
      projectId: project.id,
      title: 'Todo',
      expectedRevision: 1,
    });
    const task = await call<{ id: string }>(a, 'boards_task_create', {
      projectId: project.id,
      columnId: column.id,
      title: 'Synthetic task',
      expectedRevision: 2,
    });
    await denied(a, 'boards_column_delete', {
      projectId: project.id,
      columnId: column.id,
      expectedRevision: 3,
    });
    await denied(a, 'boards_task_update', {
      projectId: project.id,
      taskId: task.id,
      patch: { title: 'Stale' },
      expectedRevision: 2,
    });
    await call(a, 'boards_task_update', {
      projectId: project.id,
      taskId: task.id,
      patch: { title: 'Updated' },
      expectedRevision: 3,
    });
    await call(a, 'boards_column_update', {
      projectId: project.id,
      columnId: column.id,
      title: 'Working',
      expectedRevision: 4,
    });
    await call(a, 'boards_project_update', {
      projectId: project.id,
      name: 'Updated board',
      expectedRevision: 5,
    });
    const board = await call<{ projects: Array<{ tasks: Array<{ title: string }> }> }>(
      a,
      'boards_get',
    );
    assert.equal(board.projects[0].tasks[0].title, 'Updated');
    assert.equal((await call<{ revision: number }>(b, 'boards_get')).revision, 0);
    await call(a, 'boards_task_delete', {
      projectId: project.id,
      taskId: task.id,
      expectedRevision: 6,
    });
    await call(a, 'boards_column_delete', {
      projectId: project.id,
      columnId: column.id,
      expectedRevision: 7,
    });
    await call(a, 'boards_project_delete', { projectId: project.id, expectedRevision: 8 });

    const competing = await Promise.all(
      ['One', 'Two'].map((name) =>
        a.callTool({ name: 'boards_project_create', arguments: { name, expectedRevision: 9 } }),
      ),
    );
    assert.equal(
      competing.filter((r) => r.isError === true).length,
      1,
      'only one concurrent revision may commit',
    );
    const success = competing.find((r) => r.isError !== true)!;
    const createdProject = JSON.parse((success.content as Array<{ text: string }>)[0].text) as {
      id: string;
    };
    await call(a, 'boards_project_delete', { projectId: createdProject.id, expectedRevision: 10 });

    await data.replaceBoard(
      other,
      [{ id: 'private', name: 'Private sentinel', columns: [], tasks: [] }],
      0,
    );
    const writeOnly = await client(boardWriter);
    assert.equal(
      (await writeOnly.listTools()).tools.some((t) => t.name === 'boards_get'),
      false,
    );
    await denied(writeOnly, 'boards_get', {});
    const compact = await call<{ id: string; revision: number }>(
      writeOnly,
      'boards_project_create',
      { name: 'New', expectedRevision: 1 },
    );
    assert.deepEqual(Object.keys(compact).sort(), ['id', 'revision']);
    assert.equal(JSON.stringify(compact).includes('Private sentinel'), false);
    assert.equal(
      (await call<{ projects: Array<{ id: string }> }>(b, 'boards_get')).projects[0].id,
      'private',
    );
    await call(writeOnly, 'boards_project_delete', { projectId: compact.id, expectedRevision: 2 });

    await calendar.connect(calendar.ui);
    assert.equal((await call<{ status: string }>(a, 'calendar_status')).status, 'disconnected');
    const event = {
      summary: 'Synthetic event',
      start: { date: '2026-11-05' },
      end: { date: '2026-11-06' },
    };
    await denied(a, 'calendar_create', { event });
    assert.equal(calendar.calls.length, 0, 'UI grant must never substitute for agent grant');
    await calendar.connect(calendar.agent);
    const created = await call<{ id: string; etag: string }>(a, 'calendar_create', { event });
    const page = await call<{ events: Array<{ id: string; etag: string }> }>(a, 'calendar_list', {
      timeMin: '2026-11-01T00:00:00Z',
      timeMax: '2026-12-01T00:00:00Z',
    });
    assert.equal(page.events[0].id, created.id);
    await denied(a, 'calendar_update', { eventId: created.id, etag: '"stale"', event });
    const updated = await call<{ etag: string }>(a, 'calendar_update', {
      eventId: created.id,
      etag: created.etag,
      event: { ...event, summary: 'Changed' },
    });
    calendar.events.set('invited', {
      ...event,
      id: 'invited',
      etag: '"v1"',
      attendees: [{ email: 'synthetic@example.test' }],
    });
    await denied(a, 'calendar_delete', { eventId: 'invited', etag: '"v1"' });
    await call(a, 'calendar_delete', { eventId: created.id, etag: updated.etag });
    assert.ok(calendar.calls.every((c) => c.startsWith('agent:')));
    records.get(tokenHash(writer))!.revoked = true;
    await assert.rejects(a.listTools(), (error) => {
      assert.equal((error as { code: number }).code, 401);
      return true;
    });
    return { uid, other, tools: catalog.tools.length };
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
