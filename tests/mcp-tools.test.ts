import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type McpDataService } from '../server/mcpServer.ts';

function service() {
  const calls: { name: string; uid: string; args: unknown[] }[] = [];
  const data = new Proxy(
    {},
    {
      get:
        (_target, name: string) =>
        async (uid: string, ...args: unknown[]) => {
          calls.push({ name, uid, args });
          return { ok: true };
        },
    },
  ) as McpDataService;
  return { calls, data };
}
async function session(
  scopes: (
    | 'maps:read'
    | 'maps:write'
    | 'boards:read'
    | 'boards:write'
    | 'calendar:read'
    | 'calendar:write'
  )[],
) {
  const { calls, data } = service();
  const server = createMcpServer({ uid: 'alice', scopes }, data);
  const client = new Client({ name: 'test-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    calls,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test('MCP only advertises and permits tools within token scopes', async () => {
  const connection = await session(['maps:read']);
  try {
    const listing = await connection.client.listTools();
    assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), [
      'mindmaps_get',
      'mindmaps_list',
    ]);
    const denied = await connection.client.callTool({
      name: 'boards_replace',
      arguments: { expectedRevision: 0, projects: [] },
    });
    assert.equal(denied.isError, true);
    assert.equal(connection.calls.length, 0);
    await connection.client.callTool({ name: 'mindmaps_get', arguments: { id: 'map-one' } });
    assert.deepEqual(connection.calls, [{ name: 'getMap', uid: 'alice', args: ['map-one'] }]);
  } finally {
    await connection.close();
  }
});

test('MCP rejects account injection and stale-write requests without revisions or etags', async () => {
  const connection = await session(['maps:read', 'maps:write', 'boards:write', 'calendar:write']);
  try {
    for (const call of [
      { name: 'mindmaps_get', arguments: { id: 'map-one', uid: 'bob' } },
      { name: 'mindmaps_get', arguments: { id: '../bob' } },
      { name: 'mindmaps_delete', arguments: { id: 'map-one' } },
      { name: 'boards_replace', arguments: { projects: [] } },
      { name: 'calendar_delete', arguments: { eventId: 'event-one' } },
      {
        name: 'calendar_create',
        arguments: {
          event: {
            summary: 'x',
            start: { date: '2026-11-04' },
            end: { date: '2026-11-05' },
            attendees: [],
          },
        },
      },
    ])
      assert.equal((await connection.client.callTool(call)).isError, true, call.name);
    assert.equal(connection.calls.length, 0);
    await connection.client.callTool({
      name: 'boards_replace',
      arguments: { expectedRevision: 1, projects: [] },
    });
    await connection.client.callTool({
      name: 'calendar_delete',
      arguments: { eventId: 'event-one', etag: '"v1"' },
    });
    assert.deepEqual(connection.calls, [
      { name: 'replaceBoard', uid: 'alice', args: [[], 1] },
      { name: 'deleteCalendarEvent', uid: 'alice', args: ['event-one', '"v1"'] },
    ]);
  } finally {
    await connection.close();
  }
});

test('MCP tools label writes as destructive and calendar writes as external effects', async () => {
  const connection = await session(['maps:write', 'boards:write', 'calendar:write']);
  try {
    const { tools } = await connection.client.listTools();
    assert.equal(
      tools.find((tool) => tool.name === 'calendar_delete')?.annotations?.destructiveHint,
      true,
    );
    assert.equal(
      tools.find((tool) => tool.name === 'calendar_create')?.annotations?.openWorldHint,
      true,
    );
    assert.equal(
      tools.find((tool) => tool.name === 'boards_replace')?.annotations?.readOnlyHint,
      false,
    );
  } finally {
    await connection.close();
  }
});
