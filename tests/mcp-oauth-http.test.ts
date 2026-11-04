import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  request as httpRequest,
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler } from '../api/mcp.ts';
import { createMcpOAuthMetadataHandler } from '../api/mcp-oauth-metadata.ts';
import type { McpOAuthConfig } from '../server/mcpOAuth.ts';
import type { McpDataService } from '../server/mcpServer.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
async function serve(factory: (origin: () => string) => Handler) {
  let origin = '';
  const server = createServer(factory(() => origin));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
const oauthConfig = (origin: string): McpOAuthConfig => ({
  issuer: 'https://identity.example/tenant/',
  jwksUri: 'https://identity.example/tenant/jwks',
  resource: `${origin}/api/mcp`,
  metadataUrl: `${origin}/.well-known/oauth-protected-resource/api/mcp`,
  scopes: ['boards:read'],
  clientIds: ['approved-client'],
  algorithm: 'RS256',
});
const settings = (origin: string) => ({ origin, host: new URL(origin).host });
const data = {
  async getBoard(uid: string) {
    return { ownerUid: uid, projects: [], revision: 0 };
  },
} as McpDataService;

test('public OAuth metadata serves only configured resource/issuer/scopes without authentication or writes', async () => {
  let enabled = true;
  const app = await serve((origin) =>
    createMcpOAuthMetadataHandler({
      config: () => settings(origin()),
      oauth: () => (enabled ? oauthConfig(origin()) : null),
    }),
  );
  try {
    const response = await fetch(app.origin, { headers: { Origin: 'https://chatgpt.com' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      resource: `${app.origin}/api/mcp`,
      authorization_servers: ['https://identity.example/tenant/'],
      scopes_supported: ['boards:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'Antty personal workspace',
    });
    assert.equal((await fetch(app.origin, { method: 'POST' })).status, 405);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest(app.origin, { headers: { Host: 'attacker.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on('error', reject)
        .end();
    });
    assert.equal(badHost, 403);
    enabled = false;
    assert.equal((await fetch(app.origin)).status, 404);
  } finally {
    await app.close();
  }
});

test('MCP 401 advertises OAuth discovery and a failed OAuth token never falls back to PAT', async () => {
  let patCalls = 0;
  const app = await serve((origin) =>
    createMcpHandler({
      config: () => settings(origin()),
      async authenticate() {
        patCalls++;
        throw Object.assign(new Error('invalid PAT'), { status: 401 });
      },
      oauth: {
        config: () => oauthConfig(origin()),
        async authenticate() {
          throw Object.assign(new Error('Invalid or unavailable OAuth access'), { status: 401 });
        },
      },
      async quota() {},
      data: () => data,
    }),
  );
  try {
    const headerCases: Record<string, string>[] = [
      {},
      { Authorization: 'Bearer invalid.jwt.token' },
    ];
    for (const headers of headerCases) {
      const response = await fetch(app.origin, { method: 'POST', headers });
      assert.equal(response.status, 401);
      assert.match(
        response.headers.get('www-authenticate')!,
        /resource_metadata="http:\/\/127.0.0.1:\d+\/.well-known\/oauth-protected-resource\/api\/mcp"/,
      );
      assert.match(response.headers.get('www-authenticate')!, /scope="boards:read"/);
    }
    assert.equal(patCalls, 0);
  } finally {
    await app.close();
  }
});

test('valid PAT access is preserved even when the independent OAuth configuration is incomplete', async () => {
  let oauthCalls = 0;
  const app = await serve((origin) =>
    createMcpHandler({
      config: () => settings(origin()),
      async authenticate(value) {
        assert.equal(value, 'antty_synthetic_fixture');
        return { uid: 'pat-owner', scopes: ['boards:read'] };
      },
      oauth: {
        config() {
          oauthCalls++;
          throw Object.assign(new Error('OAuth access is not configured'), { status: 503 });
        },
        async authenticate() {
          throw new Error('must not run');
        },
      },
      async quota() {},
      data: () => data,
    }),
  );
  const client = new Client({ name: 'synthetic-pat', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.origin), {
        requestInit: { headers: { Authorization: 'Bearer antty_synthetic_fixture' } },
      }),
    );
    const result = await client.callTool({ name: 'boards_get', arguments: {} });
    assert.match(JSON.stringify(result), /pat-owner/);
    assert.equal(oauthCalls, 0);
  } finally {
    await client.close();
    await app.close();
  }
});

test('OAuth HTTP initializes, advertises protected scopes and reads only its bound owner', async () => {
  let authentications = 0;
  const app = await serve((origin) =>
    createMcpHandler({
      config: () => settings(origin()),
      async authenticate() {
        throw new Error('PAT must not handle OAuth');
      },
      oauth: {
        config: () => oauthConfig(origin()),
        async authenticate(token) {
          assert.equal(token, 'synthetic.oauth.fixture');
          authentications++;
          return { uid: 'oauth-owner', scopes: ['boards:read'], authentication: 'oauth' };
        },
      },
      async quota() {},
      data: () => data,
    }),
  );
  const client = new Client({ name: 'synthetic-oauth', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.origin), {
        requestInit: { headers: { Authorization: 'Bearer synthetic.oauth.fixture' } },
      }),
    );
    const list = await client.listTools();
    assert.deepEqual(
      list.tools.map((tool) => tool.name),
      ['boards_get'],
    );
    assert.deepEqual(list.tools[0]._meta?.securitySchemes, [
      { type: 'oauth2', scopes: ['boards:read'] },
    ]);
    const result = await client.callTool({ name: 'boards_get', arguments: {} });
    assert.match(JSON.stringify(result), /oauth-owner/);
    const forbidden = await client.callTool({
      name: 'boards_replace',
      arguments: { projects: [], expectedRevision: 0 },
    });
    assert.equal(forbidden.isError, true);
    assert.ok(authentications >= 4, 'authentication must run on every HTTP request');
    const crossOrigin = await fetch(app.origin, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer synthetic.oauth.fixture',
        Origin: 'https://attacker.example',
      },
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    await client.close();
    await app.close();
  }
});
