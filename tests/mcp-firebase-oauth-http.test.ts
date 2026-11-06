import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { listenForFetch } from './fixtures/listen-fetch.ts';
import { withVercelFormBody } from './fixtures/vercel-form.ts';
import { createFirebaseOAuthHandler } from '../api/mcp-auth.ts';
import { oauthFixture, settings } from './fixtures/firebase-oauth.ts';

test('OAuth HTTP serves discovery and bounded public token exchange while requiring browser origin for consent', async () => {
  const f = oauthFixture();
  let quota = 0;
  const handler = createFirebaseOAuthHandler({
    config: () => f.config,
    service: () => f.service,
    authenticate: async () => f.identity,
    quota: async () => {
      quota++;
    },
  });
  const server = createServer((req, res) => {
    req.headers.host = settings.host;
    void handler(req, res);
  });
  const base = await listenForFetch(server);
  try {
    const metadata = await fetch(`${base}/oauth/metadata`);
    const body = await metadata.json();
    assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(body.token_endpoint_auth_methods_supported, ['none']);
    assert.equal(body.issuer, settings.origin);
    assert.equal('testUid' in body, false);
    assert.doesNotMatch(JSON.stringify(body), /alice/);
    assert.equal('registration_endpoint' in body, false);
    assert.equal(
      (await fetch(`${base}/oauth/metadata`, { headers: { Origin: 'https://chatgpt.com' } }))
        .status,
      200,
    );
    const invalid = await fetch(`${base}/oauth/authorize?client_id=evil`, { redirect: 'manual' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('location'), null);
    // The real hosted ChatGPT client includes this optional presentation hint.
    f.parameters.set('ui_locales', 'zh-CN');
    const start = await fetch(`${base}/oauth/authorize?${f.parameters}`, { redirect: 'manual' });
    assert.equal(start.status, 303);
    const cookie = start.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    const location = new URL(start.headers.get('location')!);
    assert.equal(location.pathname, '/mcp/consent');
    const id = location.searchParams.get('request')!;
    const headers = { 'Content-Type': 'application/json', Cookie: cookie.split(';')[0] };
    const refused = await fetch(`${base}/oauth/consent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request: id, approve: true }),
    });
    assert.equal(refused.status, 403);
    const details = await fetch(`${base}/oauth/consent?request=${id}`, {
      headers: { ...headers, Origin: settings.origin },
    });
    assert.equal(details.status, 200);
    const approve = await fetch(`${base}/oauth/consent`, {
      method: 'POST',
      headers: { ...headers, Origin: settings.origin },
      body: JSON.stringify({ request: id, approve: true }),
    });
    const redirect = new URL((await approve.json()).redirectUri);
    const code = redirect.searchParams.get('code')!;
    const missing = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 415);
    const duplicated = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: 'x', grant_type: 'authorization_code' }),
    });
    assert.equal(duplicated.status, 400);
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'chatgpt-personal',
      redirect_uri: 'https://chatgpt.com/callback',
      resource: f.config.resource,
      code,
      code_verifier: 'v'.repeat(43),
    });
    f.state.accountFailure = Object.assign(new Error('private-upstream-network'), {
      code: 'auth/network-request-failed',
    });
    const failedExchange = await fetch(`${base}/oauth/token`, { method: 'POST', body: form });
    assert.equal(failedExchange.status, 503);
    assert.deepEqual(await failedExchange.json(), { error: 'temporarily_unavailable' });
    assert.equal(failedExchange.headers.get('www-authenticate'), null);
    f.state.accountFailure = undefined;
    const retriedExchange = await fetch(`${base}/oauth/token`, { method: 'POST', body: form });
    assert.equal(retriedExchange.status, 200);
    const token = await retriedExchange.json();
    assert.equal((await f.service.authenticate(token.access_token)).uid, 'alice');
    assert.equal((await fetch(`${base}/oauth/revoke`)).status, 405);
    const revoke = (value: string, client = 'chatgpt-personal') =>
      fetch(`${base}/oauth/revoke`, {
        method: 'POST',
        body: new URLSearchParams({ token: value, client_id: client }),
      });
    f.config.clients.push({
      id: 'other-approved-client',
      name: 'Other test client',
      redirectUris: ['https://chatgpt.com/other-callback'],
    });
    assert.equal((await revoke(token.access_token, 'other-approved-client')).status, 200);
    assert.equal((await f.service.authenticate(token.access_token)).uid, 'alice');
    assert.equal((await revoke(`anttyoa_${'x'.repeat(43)}`)).status, 200);
    const ambiguous = new URLSearchParams({
      token: token.access_token,
      client_id: 'chatgpt-personal',
    });
    ambiguous.append('client_id', 'other-approved-client');
    assert.equal(
      (await fetch(`${base}/oauth/revoke`, { method: 'POST', body: ambiguous })).status,
      400,
    );
    const foreignOrigin = await fetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: new URLSearchParams({ token: token.access_token, client_id: 'chatgpt-personal' }),
    });
    assert.equal(foreignOrigin.status, 403);
    assert.equal((await f.service.authenticate(token.access_token)).uid, 'alice');
    const revoked = await revoke(token.access_token);
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), {});
    await assert.rejects(
      f.service.authenticate(token.access_token),
      (e: unknown) => (e as { status: number }).status === 401,
    );
    assert.equal((await revoke(token.access_token)).status, 200);
    assert.ok(quota >= 3);
    assert.equal(approve.headers.get('cache-control'), 'no-store');
    assert.equal(approve.headers.get('referrer-policy'), 'no-referrer');
    const oversized = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({ code: 'x'.repeat(9000) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  'Vercel form replay preserves raw token/revoke bytes, duplicate rejection and size limits',
  { timeout: 10_000 },
  async () => {
    const f = oauthFixture();
    const handler = createFirebaseOAuthHandler({
      config: () => f.config,
      service: () => f.service,
      authenticate: async () => f.identity,
      quota: async () => {},
    });
    const server = createServer(async (req, res) => {
      req.headers.host = settings.host;
      await withVercelFormBody(req);
      // Exercise raw replay limits even without a Content-Length header.
      delete req.headers['content-length'];
      void handler(req, res);
    });
    const base = await listenForFetch(server);
    const post = (action: string, body: string) =>
      fetch(`${base}/oauth/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    try {
      const { code } = await f.approve();
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'chatgpt-personal',
        redirect_uri: 'https://chatgpt.com/callback',
        resource: f.config.resource,
        code,
        code_verifier: 'v'.repeat(43),
      });
      for (const [key, value] of form) {
        for (const separator of ['&', '&'.repeat(1000)]) {
          const response = await post(
            'token',
            `${form}${separator}${key}=${encodeURIComponent(value)}`,
          );
          assert.equal(response.status, 400);
          assert.deepEqual(await response.json(), { error: 'invalid_request' });
        }
      }
      assert.equal((await post('token', `${form}${'&'.repeat(1000)}unexpected=value`)).status, 400);
      assert.equal((await post('token', `${form}${'&'.repeat(8192)}`)).status, 413);
      // Rejected requests cannot consume the legitimate code.
      const exchanged = await post(
        'token',
        `${form}${'&'.repeat(8192 - Buffer.byteLength(form.toString()))}`,
      );
      assert.equal(exchanged.status, 200);
      const token = await exchanged.json();
      assert.equal((await f.service.authenticate(token.access_token)).uid, 'alice');
      const revoke = new URLSearchParams({
        client_id: 'chatgpt-personal',
        token: token.access_token,
      });
      const duplicate = await post('revoke', `${revoke}${'&'.repeat(1000)}token=another`);
      assert.equal(duplicate.status, 400);
      assert.equal((await f.service.authenticate(token.access_token)).uid, 'alice');
      assert.equal((await post('revoke', revoke.toString())).status, 200);
      await assert.rejects(f.service.authenticate(token.access_token));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test('OAuth raw form reader rejects aborted, errored and oversized streams without exposing errors', async () => {
  for (const failure of ['aborted', 'already-aborted', 'error', 'oversized']) {
    const f = oauthFixture();
    const handler = createFirebaseOAuthHandler({
      config: () => f.config,
      service: () => f.service,
      authenticate: async () => f.identity,
      quota: async () => {},
    });
    const req = Object.assign(new PassThrough(), {
      headers: { host: settings.host, 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      url: '/oauth/token',
      socket: { remoteAddress: '127.0.0.1' },
      aborted: failure === 'already-aborted',
    });
    let output = '';
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body: string) {
        output = body;
      },
    };
    const handling = handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    await Promise.resolve();
    if (failure === 'aborted') req.emit('aborted');
    if (failure === 'error') req.emit('error', new Error('private-upstream-body'));
    if (failure === 'oversized') req.end('x'.repeat(8193));
    await handling;
    assert.equal(res.statusCode, failure === 'oversized' ? 413 : 400);
    assert.deepEqual(JSON.parse(output), { error: 'invalid_request' });
    req.destroy();
  }
});
