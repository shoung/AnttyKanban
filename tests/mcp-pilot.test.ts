import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getFirebaseOAuthConfig } from '../server/mcpFirebaseOAuth.ts';
import { createMcpHandler } from '../api/mcp.ts';
import { createAgentTokenHandler } from '../api/agent-tokens.ts';
import type { McpDataService } from '../server/mcpServer.ts';
import type { McpScope } from '../server/mcpPolicy.ts';
import { env, settings, oauthFixture } from './fixtures/firebase-oauth.ts';
import { listenForFetch } from './fixtures/listen-fetch.ts';

test('enabled first-party OAuth requires one exact test UID and never falls back to unrestricted access', () => {
  const configured = { ...env, ANTTY_MCP_FIREBASE_OAUTH_TEST_UID: 'alice' };
  assert.equal(getFirebaseOAuthConfig(settings, configured)!.testUid, 'alice');
  for (const uid of [undefined, '', '../escape', ' alice ', 'a'.repeat(129)])
    assert.throws(() =>
      getFirebaseOAuthConfig(settings, { ...configured, ANTTY_MCP_FIREBASE_OAUTH_TEST_UID: uid }),
    );
  assert.equal(
    getFirebaseOAuthConfig(settings, { ANTTY_MCP_FIREBASE_OAUTH_ENABLED: 'false' }),
    null,
  );
});

test('pilot excludes other identities before backend reads, blocks existing foreign grants, and preserves owner revocation', async () => {
  const f = oauthFixture();
  const { code } = await f.approve(),
    token = await f.exchange(code);
  const [grant] = await f.service.list('alice');
  const pending = await f.begin(),
    next = await f.approve();
  f.state.accountFailure = new Error('must-not-query-account-for-excluded-uid');
  for (const call of [
    () => f.service.details({ ...f.identity, uid: 'bob' }, pending.id, pending.browserSecret),
    () => f.service.decide({ ...f.identity, uid: 'bob' }, pending.id, pending.browserSecret, true),
    () => f.service.list('bob'),
  ])
    await assert.rejects(call(), (e: unknown) => (e as { status: number }).status === 403);
  f.state.accountFailure = undefined;
  f.config.testUid = 'bob';
  await assert.rejects(
    f.service.authenticate(token.access_token),
    (e: unknown) => (e as { status: number }).status === 401,
  );
  await assert.rejects(
    f.exchange(next.code),
    (e: unknown) => (e as { status: number }).status === 403,
  );
  await f.service.revoke('alice', grant.id);
  f.config.testUid = 'alice';
  await assert.rejects(f.service.authenticate(token.access_token));
});

test('pilot gateway rejects foreign PATs and narrows same-owner PAT scopes; disabling pilot preserves normal PAT policy', async () => {
  const f = oauthFixture();
  let uid = 'bob',
    pilot = true,
    dataCalls = 0,
    configCalls = 0;
  let origin = '';
  const handler = createMcpHandler({
    config: () => ({ origin, host: new URL(origin).host }),
    authenticate: async () => ({
      uid,
      scopes: ['maps:read', 'maps:write', 'boards:read'] as McpScope[],
    }),
    quota: async () => {},
    data: () => {
      dataCalls++;
      return {} as McpDataService;
    },
    firebaseOauth: {
      config: () => {
        configCalls++;
        return pilot ? f.config : null;
      },
      authenticate: async () => {
        throw new Error('PAT must not use OAuth verification');
      },
    },
  });
  const server = createServer((req, res) => void handler(req, res));
  origin = await listenForFetch(server);
  const clients: Client[] = [];
  const connect = async () => {
    const client = new Client({ name: 'pilot-pat-test', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin), {
        requestInit: { headers: { Authorization: `Bearer antty_${'p'.repeat(43)}` } },
      }),
    );
    return client;
  };
  try {
    const denied = await fetch(origin, {
      method: 'POST',
      headers: {
        Authorization: `Bearer antty_${'p'.repeat(43)}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    assert.equal(dataCalls, 0);
    assert.ok(configCalls > 0);
    uid = 'alice';
    const allowed = await connect();
    assert.deepEqual((await allowed.listTools()).tools.map((t) => t.name).sort(), [
      'mindmaps_get',
      'mindmaps_list',
    ]);
    pilot = false;
    uid = 'bob';
    const normal = await connect();
    assert.ok((await normal.listTools()).tools.some((t) => t.name === 'boards_get'));
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('pilot cannot mint new PAT access for other UIDs, wider scopes or longer than seven days', async () => {
  const f = oauthFixture();
  let uid = 'bob',
    origin = '',
    issues = 0;
  const handler = createAgentTokenHandler({
    config: () => ({ origin, host: new URL(origin).host }),
    authenticate: async () => ({ uid }),
    quota: async () => {},
    pilot: () => f.config,
    tokens: () => ({
      list: async () => [],
      revoke: async () => {},
      issue: async (owner, input) => {
        assert.equal(owner, 'alice');
        assert.deepEqual(input, { name: 'pilot', scopes: ['maps:read'], days: 7 });
        issues++;
        return { token: 'synthetic-only' };
      },
    }),
  });
  const server = createServer((req, res) => void handler(req, res));
  origin = await listenForFetch(server);
  const request = (scopes = ['maps:read'], days = 7) =>
    fetch(origin, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pilot', scopes, days }),
    });
  try {
    assert.equal((await request()).status, 403);
    uid = 'alice';
    assert.equal((await request(['maps:write'])).status, 403);
    assert.equal((await request(['maps:read'], 30)).status, 403);
    assert.equal(issues, 0);
    assert.equal((await request()).status, 201);
    assert.equal(issues, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
