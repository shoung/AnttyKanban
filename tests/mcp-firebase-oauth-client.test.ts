import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenForFetch } from './fixtures/listen-fetch.ts';
import { withVercelFormBody } from './fixtures/vercel-form.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFirebaseOAuthHandler } from '../api/mcp-auth.ts';
import { createMcpHandler } from '../api/mcp.ts';
import { createMcpOAuthMetadataHandler } from '../api/mcp-oauth-metadata.ts';
import type { McpDataService } from '../server/mcpServer.ts';
import { memoryOAuthRepository, oauthFixture, settings } from './fixtures/firebase-oauth.ts';
import type { OAuthRepository } from '../server/mcpFirebaseOAuth.ts';

test('real SDK discovers first-party OAuth, performs S256 code exchange, reads synthetic maps and fails after revoke', async () => {
  const backing = memoryOAuthRepository();
  let repositoryFailure: unknown;
  const repository: OAuthRepository = {
    ...backing,
    transaction: (work) =>
      repositoryFailure ? Promise.reject(repositoryFailure) : backing.transaction(work),
  };
  const f = oauthFixture(repository);
  let reads = 0;
  const oauth = createFirebaseOAuthHandler({
    config: () => f.config,
    service: () => f.service,
    authenticate: async () => f.identity,
    quota: async () => {},
  });
  const metadata = createMcpOAuthMetadataHandler({ config: () => settings, oauth: () => f.config });
  const mcp = createMcpHandler({
    config: () => settings,
    authenticate: async () => {
      throw new Error('No PAT fallback');
    },
    quota: async () => {},
    firebaseOauth: {
      config: () => f.config,
      authenticate: (token) => f.service.authenticate(token),
    },
    data: () =>
      ({
        listMaps: async (uid: string) => {
          assert.equal(uid, 'alice');
          reads++;
          return { items: [{ id: 'synthetic', title: 'Synthetic map', revision: 1 }] };
        },
        getMap: async (uid: string) => {
          assert.equal(uid, 'alice');
          reads++;
          return {
            id: 'synthetic',
            title: 'Synthetic map',
            revision: 1,
            root: { id: 'root', text: 'Test', children: [] },
          };
        },
      }) as unknown as McpDataService,
  });
  const server = createServer(async (req, res) => {
    await withVercelFormBody(req);
    req.headers.host = settings.host;
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      if (req.rawHeaders[i].toLowerCase() === 'host') req.rawHeaders[i + 1] = settings.host;
    if (req.url?.startsWith('/.well-known/oauth-protected-resource')) void metadata(req, res);
    else if (req.url?.startsWith('/.well-known/oauth-authorization-server')) {
      req.url = '/oauth/metadata';
      void oauth(req, res);
    } else if (req.url?.startsWith('/api/mcp')) void mcp(req, res);
    else void oauth(req, res);
  });
  const local = await listenForFetch(server);
  const localFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, settings.origin, 'test must never reach an external service');
    return fetch(`${local}${url.pathname}${url.search}`, init);
  };
  let authorizationRedirects = 0;
  let tokens: OAuthTokens | undefined,
    verifier = '',
    authorization: URL | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: 'https://chatgpt.com/callback',
    clientMetadata: {
      redirect_uris: ['https://chatgpt.com/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'maps:read',
    },
    clientInformation: () => ({ client_id: 'chatgpt-personal', issuer: settings.origin }),
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
    state: () => 'synthetic-client-state',
    redirectToAuthorization: (url) => {
      authorizationRedirects++;
      authorization = url;
    },
  };
  const client = new Client({ name: 'firebase-oauth-acceptance', version: '1.0' });
  try {
    assert.equal(
      await auth(provider, { serverUrl: f.config.resource, fetchFn: localFetch }),
      'REDIRECT',
    );
    assert.ok(authorization);
    // Reproduce the hosted ChatGPT request shape without using live credentials.
    authorization.searchParams.set('ui_locales', 'zh-CN');
    const start = await localFetch(authorization, { redirect: 'manual' });
    assert.equal(start.status, 303);
    const cookie = start.headers.get('set-cookie')!.split(';')[0],
      pending = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const headers = { Cookie: cookie, Origin: settings.origin, 'Content-Type': 'application/json' };
    assert.equal(
      (await localFetch(`${settings.origin}/oauth/consent?request=${pending}`, { headers })).status,
      200,
    );
    const decision = await localFetch(`${settings.origin}/oauth/consent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request: pending, approve: true }),
    });
    const callback = new URL((await decision.json()).redirectUri);
    assert.equal(callback.searchParams.get('state'), 'synthetic-client-state');
    assert.equal(
      await auth(provider, {
        serverUrl: f.config.resource,
        authorizationCode: callback.searchParams.get('code')!,
        fetchFn: localFetch,
      }),
      'AUTHORIZED',
    );
    assert.ok(tokens?.access_token);
    assert.equal(tokens?.refresh_token, undefined);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.config.resource), {
        authProvider: provider,
        fetch: localFetch,
        requestInit: { headers: { Authorization: `Bearer ${tokens!.access_token}` } },
      }),
    );
    const list = await client.listTools();
    assert.deepEqual(list.tools.map((t) => t.name).sort(), ['mindmaps_get', 'mindmaps_list']);
    assert.equal(
      (await client.callTool({ name: 'mindmaps_list', arguments: {} })).isError,
      undefined,
    );
    assert.equal(
      (await client.callTool({ name: 'mindmaps_get', arguments: { id: 'synthetic' } })).isError,
      undefined,
    );
    assert.equal(reads, 2);
    for (const dependency of ['repository', 'account']) {
      if (dependency === 'repository')
        repositoryFailure = Object.assign(new Error('private-upstream-db'), { code: 14 });
      else
        f.state.accountFailure = Object.assign(new Error('private-upstream-auth'), {
          code: 'auth/network-request-failed',
        });
      const unavailable = await localFetch(f.config.resource, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens!.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
      });
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.headers.get('www-authenticate'), null);
      assert.doesNotMatch(await unavailable.text(), /private-upstream/);
      await assert.rejects(client.listTools());
      assert.equal(authorizationRedirects, 1);
      assert.equal(reads, 2);
      repositoryFailure = undefined;
      f.state.accountFailure = undefined;
      assert.equal((await client.listTools()).tools.length, 2);
      assert.equal(authorizationRedirects, 1);
    }
    const revoked = await localFetch(`${settings.origin}/oauth/revoke`, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: 'chatgpt-personal',
        token: tokens!.access_token,
        token_type_hint: 'access_token',
      }),
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), {});
    await assert.rejects(client.listTools());
    assert.equal(reads, 2);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
