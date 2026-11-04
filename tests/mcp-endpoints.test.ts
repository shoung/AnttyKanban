import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMcpHandler } from '../api/mcp.ts';
import { createAgentTokenHandler } from '../api/agent-tokens.ts';
import type { McpDataService } from '../server/mcpServer.ts';

async function serve(factory: (origin: () => string) => ReturnType<typeof createMcpHandler>) {
  let origin = '';
  const server = createServer(factory(() => origin));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('MCP HTTP requires bearer authentication, rejects cross-origin, and supports stateless initialization', async () => {
  let authentications = 0;
  const app = await serve((origin) =>
    createMcpHandler({
      config: () => ({ origin: origin(), host: new URL(origin()).host }),
      async authenticate(token) {
        authentications++;
        if (token !== 'valid')
          throw Object.assign(new Error('Authentication required'), { status: 401 });
        return { uid: 'alice', scopes: ['maps:read'] };
      },
      async quota() {},
      data: () => ({}) as McpDataService,
    }),
  );
  try {
    const request = (headers: Record<string, string> = {}, body: unknown = {}) =>
      fetch(app.origin, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await request()).status, 401);
    assert.equal(
      (await request({ Authorization: 'Bearer valid', Origin: 'https://evil.example' })).status,
      403,
    );
    assert.equal(authentications, 0);
    const initialized = await request(
      { Authorization: 'Bearer valid' },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      },
    );
    assert.equal(initialized.status, 200);
    assert.equal(initialized.headers.get('mcp-session-id'), null);
    assert.equal((await initialized.json()).result.serverInfo.name, 'antty-personal-workspace');
    assert.equal(
      (await fetch(app.origin, { headers: { Authorization: 'Bearer valid' } })).status,
      405,
    );
  } finally {
    await app.close();
  }
});

test('Token endpoint binds CRUD to Firebase identity and requires same-origin explicit creation', async () => {
  const operations: { uid: string; method: string; input?: unknown }[] = [];
  const app = await serve((origin) =>
    createAgentTokenHandler({
      config: () => ({ origin: origin(), host: new URL(origin()).host }),
      async authenticate(req) {
        if (req.headers.authorization !== 'Bearer firebase')
          throw Object.assign(new Error('Authentication required'), { status: 401 });
        return { uid: 'alice' };
      },
      async quota() {},
      tokens: () => ({
        async list(uid: string) {
          operations.push({ uid, method: 'list' });
          return [];
        },
        async issue(uid: string, input: unknown) {
          operations.push({ uid, method: 'issue', input });
          return { token: 'secret-once', id: 'a'.repeat(64) };
        },
        async revoke(uid: string, id: string) {
          operations.push({ uid, method: 'revoke', input: id });
        },
      }),
    }),
  );
  try {
    const input = { name: 'agent', scopes: ['maps:read'], days: 30 };
    const post = (body: unknown, origin?: string) =>
      fetch(app.origin, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer firebase',
          'Content-Type': 'application/json',
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post(input)).status, 403);
    assert.equal((await post({ ...input, userId: 'bob' }, app.origin)).status, 400);
    assert.equal(operations.length, 0);
    const created = await post(input, app.origin);
    assert.equal(created.status, 201);
    assert.equal((await created.json()).token, 'secret-once');
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.deepEqual(operations, [{ uid: 'alice', method: 'issue', input }]);
  } finally {
    await app.close();
  }
});
