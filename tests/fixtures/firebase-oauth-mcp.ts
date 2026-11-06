import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createFirebaseOAuthHandler } from '../../api/mcp-auth.ts';
import { createMcpHandler } from '../../api/mcp.ts';
import { createMcpOAuthMetadataHandler } from '../../api/mcp-oauth-metadata.ts';
import { createMcpDataService, type WorkspaceStore } from '../../server/mcpData.ts';
import type { OAuthRepository } from '../../server/mcpFirebaseOAuth.ts';
import type { McpScope } from '../../server/mcpPolicy.ts';
import { oauthFixture, settings } from './firebase-oauth.ts';
import { listenForFetch } from './listen-fetch.ts';
import { withVercelFormBody } from './vercel-form.ts';

export interface OAuthMcpSession {
  client: Client;
  token: string;
}

/** Real protocol/auth/data code with explicitly synthetic Firebase identity/account checks.
 * Callers inject stores; the emulator suite injects both real Firestore adapters.
 * No PAT path, Calendar backend, real Firebase login, or external fetch is permitted.
 */
export async function firebaseOAuthMcpFixture(
  repository: OAuthRepository,
  storage: WorkspaceStore,
  uid: string,
  scopes: McpScope[],
) {
  const f = oauthFixture(repository, uid);
  f.config.scopes = [...scopes];
  const operations: string[] = [];
  const audited: WorkspaceStore = {
    read: (path) => {
      operations.push(`read:${path}`);
      return storage.read(path);
    },
    list: (path, input) => {
      operations.push(`list:${path}`);
      return storage.list(path, input);
    },
    mutate: (path, work) => {
      operations.push(`mutate:${path}`);
      return storage.mutate(path, work);
    },
  };
  const noCalendar = async (): Promise<never> => assert.fail('Calendar must not be invoked');
  const data = createMcpDataService(audited, {
    getCalendarStatus: noCalendar,
    listCalendarEvents: noCalendar,
    createCalendarEvent: noCalendar,
    updateCalendarEvent: noCalendar,
    deleteCalendarEvent: noCalendar,
  });
  const oauth = createFirebaseOAuthHandler({
    config: () => f.config,
    service: () => f.service,
    authenticate: async () => f.identity,
    quota: async () => {},
  });
  const metadata = createMcpOAuthMetadataHandler({ config: () => settings, oauth: () => f.config });
  const mcp = createMcpHandler({
    config: () => settings,
    authenticate: async () => assert.fail('PAT fallback must not be used'),
    quota: async () => {},
    data: () => data,
    firebaseOauth: {
      config: () => f.config,
      authenticate: (token) => f.service.authenticate(token),
    },
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
    assert.equal(
      url.origin,
      settings.origin,
      'OAuth/MCP tests must never fetch an external service',
    );
    return fetch(`${local}${url.pathname}${url.search}`, { redirect: 'error', ...init });
  };
  const request = (path: string, init?: RequestInit) =>
    localFetch(`${settings.origin}${path}`, init);
  const clients: Client[] = [];
  async function start(requested: McpScope[]) {
    let authorization: URL | undefined,
      verifier = '',
      code = '',
      tokens: OAuthTokens | undefined;
    f.identity.authTime = f.state.now;
    const provider: OAuthClientProvider = {
      redirectUrl: 'https://chatgpt.com/callback',
      clientMetadata: {
        redirect_uris: ['https://chatgpt.com/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: requested.join(' '),
      },
      clientInformation: () => ({ client_id: 'chatgpt-personal', issuer: settings.origin }),
      tokens: () => tokens,
      saveTokens: (value) => {
        tokens = value;
      },
      codeVerifier: () => verifier,
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      state: () => 'synthetic-emulator-state',
      redirectToAuthorization: (url) => {
        authorization = url;
      },
    };
    assert.equal(
      await auth(provider, {
        serverUrl: f.config.resource,
        scope: requested.join(' '),
        fetchFn: localFetch,
      }),
      'REDIRECT',
    );
    assert.ok(authorization);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('scope'), requested.join(' '));
    authorization.searchParams.set('ui_locales', 'zh-CN');
    const begun = await localFetch(authorization, { redirect: 'manual' });
    assert.equal(begun.status, 303);
    const id = new URL(begun.headers.get('location')!).searchParams.get('request')!;
    const headers = {
      Cookie: begun.headers.get('set-cookie')!.split(';')[0],
      Origin: settings.origin,
      'Content-Type': 'application/json',
    };
    return {
      details: () => request(`/oauth/consent?request=${id}`, { headers }),
      async approve() {
        const response = await request('/oauth/consent', {
          method: 'POST',
          headers,
          body: JSON.stringify({ request: id, approve: true }),
        });
        assert.equal(response.status, 200);
        const callback = new URL((await response.json()).redirectUri);
        assert.equal(callback.origin, 'https://chatgpt.com');
        assert.equal(callback.searchParams.get('state'), 'synthetic-emulator-state');
        code = callback.searchParams.get('code')!;
      },
      exchange: (patch: Record<string, string> = {}) =>
        request('/oauth/token', {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: 'chatgpt-personal',
            redirect_uri: 'https://chatgpt.com/callback',
            resource: f.config.resource,
            code,
            code_verifier: verifier,
            ...patch,
          }),
        }),
      async finish(): Promise<OAuthMcpSession> {
        assert.equal(
          await auth(provider, {
            serverUrl: f.config.resource,
            scope: requested.join(' '),
            authorizationCode: code,
            fetchFn: localFetch,
          }),
          'AUTHORIZED',
        );
        assert.ok(tokens?.access_token);
        assert.equal(tokens.refresh_token, undefined);
        assert.equal(tokens.scope, requested.join(' '));
        assert.equal(tokens.expires_in, 3600);
        const client = new Client({ name: 'oauth-emulator-crud', version: '1' });
        clients.push(client);
        // No authProvider here: a revoked token must fail, never trigger automatic reauthorization.
        await client.connect(
          new StreamableHTTPClientTransport(new URL(f.config.resource), {
            fetch: localFetch,
            requestInit: {
              headers: { Authorization: `Bearer ${tokens.access_token}` },
              redirect: 'error',
            },
          }),
        );
        return { client, token: tokens.access_token };
      },
    };
  }
  return {
    config: f.config,
    state: f.state,
    identity: f.identity,
    operations,
    request,
    start,
    async connect(requested: McpScope[], checkPkce = false) {
      const flow = await start(requested);
      const details = await flow.details();
      assert.equal(details.status, 200);
      assert.deepEqual((await details.json()).scopes, requested);
      await flow.approve();
      if (checkPkce) {
        const wrong = await flow.exchange({ code_verifier: 'wrong'.repeat(16) });
        assert.equal(wrong.status, 400);
        assert.deepEqual(await wrong.json(), { error: 'invalid_grant' });
      }
      return flow.finish();
    },
    rpc: (session: OAuthMcpSession, method: string, params: unknown) =>
      request('/api/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    revoke: (session: OAuthMcpSession) =>
      request('/oauth/revoke', {
        method: 'POST',
        body: new URLSearchParams({ client_id: 'chatgpt-personal', token: session.token }),
      }),
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function call<T>(
  session: OAuthMcpSession,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await session.client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  const text = (result.content as Array<{ type: string; text?: string }>).find(
    (c) => c.type === 'text',
  )?.text;
  assert.ok(text);
  return JSON.parse(text) as T;
}
export async function denied(
  session: OAuthMcpSession,
  name: string,
  args: Record<string, unknown> = {},
) {
  assert.equal((await session.client.callTool({ name, arguments: args })).isError, true, name);
}
